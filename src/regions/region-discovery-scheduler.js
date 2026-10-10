import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assertRegionQueryInput } from './region-query-validation.js';
import { regionQueryConfigSchema, regionQueryPolicySchema, regionSchedulerOptionsSchema,
  regionSchedulerClockSchema, regionSchedulerJitterSchema, regionSchedulerSnapshotSchema,
  regionSchedulerResponseSchema, REGION_PREFLIGHT_DEFERRALS } from './region-query-schemas.js';
import { parseRegionResponseBody } from './region-response-parser.js';
import { compileSchema } from '../validation/ajv.js';
import { regionPublicationBrokerIdsSchema } from '../mqtt/region-publication-schemas.js';
const destinationsValid=compileSchema(regionPublicationBrokerIdsSchema);

/** One opt-in producer. The coordinator owns radio state; the store owns
 * schedules. Only a single unsaved terminal result can be held for retry. */
export class RegionDiscoveryScheduler {
  #config; #policy; #store; #radio; #coordinator; #logger; #runId; #window;
  #wallNow; #monotonicNow; #jitter; #createId;
  #timer = null; #pending = null; #started = false; #stopped = false;
  #cursor = null; #observer = null; #pausedGeneration = null;
  #anchor = null; #lastMonotonic = 0; #highWater = 0; #clockPaused = false;
  #fault = null; #unsaved = null; #unconfirmed = false;
  #brokerIds;

  constructor({ config, store, runId, directHeardWindowMs, radio, coordinator, logger,
    wallNow = Date.now, monotonicNow = () => performance.now(),
    jitter = () => Math.random() / 10, createId = randomUUID,brokerIds=[] }) {
    assertRegionQueryInput(regionQueryConfigSchema, config);
    assertRegionQueryInput(regionSchedulerOptionsSchema, { runId, directHeardWindowMs });
    if(!destinationsValid(brokerIds)) throw new Error('Invalid region publication destinations');
    this.#brokerIds=Object.freeze([...brokerIds]);
    this.#config = Object.freeze({ ...config });
    this.#policy = Object.freeze(Object.fromEntries(Object.keys(regionQueryPolicySchema.properties)
      .map(key => [key, config[key]])));
    this.#store = store; this.#runId = runId; this.#window = directHeardWindowMs;
    this.#radio = radio; this.#coordinator = coordinator; this.#logger = logger;
    this.#wallNow = wallNow; this.#monotonicNow = monotonicNow;
    this.#jitter = jitter; this.#createId = createId;
  }

  start() {
    if (this.#started || this.#stopped || !this.#config.discoveryEnabled) return;
    this.#started = true;
    try { this.#clock(); } catch { this.#warn('clock'); }
    this.#arm(this.#config.queryStartupDelayMs);
  }

  // Synchronous admission stop MUST precede coordinator cancellation.
  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer); this.#timer = null; this.#cursor = null;
  }

  async drain() {
    await this.#pending;
    this.#persist();
    if (this.#unsaved || this.#unconfirmed) throw new Error('Region discovery terminal result was not persisted; clean shutdown cannot be confirmed');
  }

  #arm(delay) {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#pending = this.#pass().catch(() => this.#warn(this.#unconfirmed ? 'completion' : 'selection')).finally(() => {
        this.#pending = null;
        this.#arm(this.#config.queryTickIntervalMs);
      });
    }, delay);
    this.#timer.unref();
  }

  #warn(reason) {
    if (this.#fault === reason) return;
    this.#fault = reason;
    this.#logger.warn('services.regionDiscovery',
      reason === 'persistence'
        ? 'Region result could not be saved. Discovery is paused while this one result is retried locally; its durable cooldown remains in place.'
        : reason === 'completion'
          ? 'Region request reservation has no validated completion. Discovery is paused; clean shutdown cannot be confirmed.'
          : 'Region discovery deferred because trusted scheduling data could not be read or validated; no new RF permission was granted.',
      { outcome: reason });
  }

  #clock() {
    const sample = { wall: this.#wallNow(), monotonic: this.#monotonicNow() };
    assertRegionQueryInput(regionSchedulerClockSchema, sample);
    this.#lastMonotonic = Math.max(this.#lastMonotonic, sample.monotonic);
    this.#anchor ??= { wall: sample.wall, monotonic: this.#lastMonotonic };
    // Whole-second elapsed lower bound avoids sub-millisecond clock sampling
    // noise. Saved deadlines/evidence still use the original millisecond wall.
    const projected = this.#anchor.wall + Math.floor((this.#lastMonotonic - this.#anchor.monotonic) / 1000) * 1000;
    this.#highWater = Math.max(this.#highWater, projected, this.#store.getRegionPollHighWater());
    const paused = sample.wall < this.#highWater;
    if (paused !== this.#clockPaused) {
      this.#logger[paused ? 'warn' : 'info']('services.regionDiscovery', paused
        ? 'Region discovery paused until wall time agrees with durable and monotonic clock evidence.'
        : 'Region discovery clock agreement restored.', { outcome: paused ? 'clock-rollback' : 'clock-restored' });
      this.#clockPaused = paused;
    }
    if (!paused && sample.wall > projected) this.#anchor = { wall: sample.wall, monotonic: this.#lastMonotonic };
    this.#highWater = Math.max(this.#highWater, sample.wall);
    return { wall: sample.wall, paused };
  }

  #snapshot() {
    const snapshot = this.#radio.getConnectionSnapshot();
    assertRegionQueryInput(regionSchedulerSnapshotSchema, snapshot);
    return { ...snapshot, observerPublicKey: snapshot.observerPublicKey?.toUpperCase() ?? null };
  }

  #ratio() {
    const input = { jitterRatio: this.#jitter() };
    assertRegionQueryInput(regionSchedulerJitterSchema, input);
    return input.jitterRatio;
  }

  #eligible(request, snapshot, admitted) {
    if (this.#stopped) return false;
    assertRegionQueryInput(regionSchedulerSnapshotSchema, snapshot);
    if (!snapshot.ready || snapshot.generation !== admitted.generation
      || snapshot.observerPublicKey?.toUpperCase() !== admitted.observerPublicKey) return false;
    const clock = this.#clock();
    if (clock.paused) return false;
    if (!this.#store.queryDirectHeardEligibility({ publicKeyHex: request.targetPublicKey,
      now: clock.wall, windowMs: this.#window }).eligible) return false;
    const scope = { observerPublicKey: admitted.observerPublicKey, targetPublicKey: request.targetPublicKey };
    const state = this.#store.getRegionPollState(scope);
    return !state || clock.wall >= state.nextDueAt;
  }

  async #pass() {
    this.#persist();
    if (this.#unsaved || this.#unconfirmed || this.#stopped) return;
    const snapshot = this.#snapshot();
    if (!snapshot.ready || snapshot.generation === null || snapshot.observerPublicKey === null) return;
    if (this.#pausedGeneration === snapshot.generation) return;
    if (snapshot.observerPublicKey !== this.#observer) {
      this.#observer = snapshot.observerPublicKey; this.#cursor = null;
    }
    const clock = this.#clock();
    if (clock.paused) return;
    const page = this.#store.queryRegionPollCandidates({ observerPublicKey: this.#observer,
      now: clock.wall, windowMs: this.#window, limit: 100,
      ...(this.#cursor ? { afterPublicKey: this.#cursor } : {}) }, this.#policy);
    if (page.clockRollback) return;
    const candidate = page.candidates[0];
    if (!candidate) { this.#cursor = null; return; }
    // Advance after the selected key, not the end of the unread page.
    this.#cursor = candidate.targetPublicKey;
    const request = { requestId: this.#createId(), targetPublicKey: candidate.targetPublicKey,
      operation: 'anonymous-regions', params: {} };
    const identity = { observerPublicKey: snapshot.observerPublicKey,
      targetPublicKey: request.targetPublicKey, runId: this.#runId, requestId: request.requestId };
    let reservation = null;
    const response = await this.#coordinator.tryRequest(request, { expectedRoute: 'direct' },
      (dto, current) => this.#eligible(dto, current, snapshot), context => {
        if (context.requestId !== request.requestId || context.targetPublicKey !== identity.targetPublicKey
          || context.observerPublicKey !== identity.observerPublicKey || context.generation !== snapshot.generation) return false;
        if (!this.#eligible(request, this.#snapshot(), snapshot)) return false;
        const reservedAt = this.#clock().wall;
        try {
          const input = { ...identity, reservedAt, policy: this.#policy, jitterRatio: this.#ratio() };
          if (this.#store.reserveRegionPoll(input).reserved !== true) return false;
          reservation = input; this.#unconfirmed = true; return true;
        } catch { this.#warn('reservation'); return false; }
      });
    // No identity is inferred from a binary body. Validate before mapping.
    assertRegionQueryInput(regionSchedulerResponseSchema, response);
    if (response.context && (response.context.requestId !== identity.requestId
      || response.context.targetPublicKey !== identity.targetPublicKey
      || response.context.observerPublicKey !== identity.observerPublicKey
      || response.context.generation !== snapshot.generation)) throw new Error('Invalid region completion ownership');
    if (response.dispatchedAt === undefined) {
      if (response.reason === 'preflight-unsupported' || response.reason === 'preflight-paused'
        || response.recovery !== undefined) this.#pausedGeneration = snapshot.generation;
      if (REGION_PREFLIGHT_DEFERRALS.includes(response.reason) && !reservation) {
        const observed = this.#clock();
        if (!observed.paused) this.#store.deferRegionPoll({ ...identityWithoutRequest(identity),
          reason: response.reason, observedAt: observed.wall,
          nextDueAt: Math.min(Number.MAX_SAFE_INTEGER, observed.wall + this.#policy.queryRetryBaseMs) }, this.#policy);
      }
      this.#unconfirmed = false;
      return; // An unused saved reservation is a cooldown, not RF evidence.
    }
    if (!reservation || !response.context || !['failed', 'completed'].includes(response.status)) throw new Error('Invalid region dispatch evidence');
    const completed = this.#clock();
    const parsed = response.status === 'completed' ? parseRegionResponseBody({ body: response.body }) : null;
    if (response.status === 'completed' && (response.receivedAt === undefined || response.route !== 'direct')) throw new Error('Invalid region receipt evidence');
    const answered = parsed?.status === 'accepted';
    const unsupported = response.reason === 'command-error' && response.errorReason === 'unsupported';
    const outcome = { ...identity, startedAt: response.dispatchedAt, completedAt: completed.wall,
      clockAnomaly: completed.paused || response.dispatchedAt < reservation.reservedAt
        || completed.wall < response.dispatchedAt || (response.receivedAt !== undefined
          && (response.receivedAt < response.dispatchedAt || response.receivedAt > completed.wall)),
      status: answered ? 'answered' : unsupported ? 'unsupported' : 'failed',
      reason: answered ? null : unsupported ? 'unsupported' : parsed ? 'malformed-response' : response.reason,
      route: response.route ?? null };
    this.#unsaved = { ...identity, policy: this.#policy, jitterRatio: reservation.jitterRatio,
      result: { outcome, ...(answered ? { answer: { ...parsed.answer, observedAt: response.receivedAt } } : {}),
        brokerIds:answered && !outcome.clockAnomaly ? [...this.#brokerIds] : [] } };
    this.#persist();
  }

  #persist() {
    if (!this.#unsaved) return;
    try {
      const saved = this.#store.completeRegionPoll(this.#unsaved);
      if (!saved.completed) this.#logger.warn('services.regionDiscovery',
        'Region completion no longer owns its durable reservation; retained history was not replaced.', { outcome: saved.reason });
      this.#unsaved = null; this.#unconfirmed = false; this.#fault = null;
    } catch { this.#warn('persistence'); }
  }
}

function identityWithoutRequest({ observerPublicKey, targetPublicKey, runId }) {
  return { observerPublicKey, targetPublicKey, runId };
}
