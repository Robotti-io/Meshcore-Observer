import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compileSchema } from '../validation/ajv.js';
import { telemetryPollConfigSchema } from './polling-schemas.js';
import { telemetryOwnerSnapshotSchema, telemetryOwnerClockSchema, telemetryOwnerContextSchema,
  telemetryAuthenticationRecordSchema } from './telemetry-owner-schemas.js';
import { telemetryRecoverySchema, telemetryStatePolicySchema, assertTelemetryState } from './poll-state-schemas.js';
import { telemetryPollingResult, validateTelemetryCompletion } from './polling-result.js';

const configValid = compileSchema(telemetryPollConfigSchema), snapshotValid = compileSchema(telemetryOwnerSnapshotSchema);
const clockValid = compileSchema(telemetryOwnerClockSchema), authValid = compileSchema(telemetryAuthenticationRecordSchema);
const contextValid = compileSchema(telemetryOwnerContextSchema);
const AUTH = Object.freeze({ component: 'guest-login', params: Object.freeze({}) });
const TRANSIENT = new Set(['foreground', 'quiet-air', 'rate-limited', 'background-turn', 'busy', 'queue-timeout',
  'ineligible', 'reservation-unavailable', 'stopped', 'disconnected', 'not-ready']);
const MAX_TIME = Number.MAX_SAFE_INTEGER;
const add = (time, delay) => Math.min(MAX_TIME, time + delay);

/** One producer, no RF replay queue. The shared owner retains session authority;
 * the store retains deadlines. Exactly one terminal can await a local save. */
export class TelemetryPollingScheduler {
  #config; #excluded; #policy; #store; #runId; #radio; #coordinator; #logger; #wall; #mono; #createId;
  #started = false; #stopped = false; #timer = null; #pending = null;
  #cursor = null; #observer = null; #recoveryCursor = null; #recovered = false;
  #anchor = null; #lastMono = 0; #highWater = 0; #clockPaused = false;
  #unsaved = null; #unconfirmed = false; #fault = null; #pausedGeneration = null;

  constructor({ config, store, runId, radio, coordinator, logger, wallNow = Date.now,
    monotonicNow = () => performance.now(), createId = randomUUID }) {
    if (!configValid(config)) throw new Error('Invalid telemetry polling configuration');
    this.#policy = Object.fromEntries(Object.keys(telemetryStatePolicySchema.properties).map(k => [k, config[k]]));
    assertTelemetryState(telemetryRecoverySchema, { runId, observedAt: 0, policy: this.#policy });
    this.#config = config; this.#excluded = new Set(config.excludedTargets ?? []); this.#store = store; this.#runId = runId; this.#radio = radio;
    this.#coordinator = coordinator; this.#logger = logger; this.#wall = wallNow; this.#mono = monotonicNow; this.#createId = createId;
  }
  start() {
    if (this.#started || this.#stopped || !this.#config.enabled) return;
    this.#started = true;
    try { this.#clock(); } catch { this.#warn('selection'); }
    this.#arm(this.#config.startupDelayMs);
  }
  stop() { this.#stopped = true; clearTimeout(this.#timer); this.#timer = null; this.#cursor = null; }
  async drain() {
    await this.#pending;
    this.#persist();
    if (this.#unsaved || this.#unconfirmed) throw new Error('Telemetry terminal result was not persisted; clean shutdown cannot be confirmed');
  }
  #arm(delay) {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#pending = this.#pass().catch(() => this.#warn(this.#unconfirmed ? 'completion' : 'selection')).finally(() => {
        this.#pending = null; this.#arm(this.#config.tickIntervalMs);
      });
    }, delay);
    this.#timer.unref();
  }
  #warn(reason) {
    if (this.#fault === reason) return;
    this.#fault = reason;
    this.#logger.warn('services.telemetryPolling', reason === 'persistence'
      ? 'Telemetry result could not be saved. Polling is paused while this one result is retried locally; its durable deadline remains in place.'
      : reason === 'completion' ? 'Telemetry reservation has no validated terminal result. Polling is paused; clean shutdown cannot be confirmed.'
        : 'Telemetry polling deferred because trusted scheduling data could not be read or validated; no new RF permission was granted.', { outcome: reason });
  }
  #clock() {
    const sample = { wall: this.#wall(), monotonic: this.#mono() };
    if (!clockValid(sample)) throw new Error('Invalid telemetry polling clock');
    const monoRollback = sample.monotonic < this.#lastMono;
    this.#lastMono = Math.max(this.#lastMono, sample.monotonic);
    this.#anchor ??= { wall: sample.wall, monotonic: this.#lastMono };
    const projected = add(this.#anchor.wall, Math.floor((this.#lastMono - this.#anchor.monotonic) / 1000) * 1000);
    this.#highWater = Math.max(this.#highWater, projected, this.#store.getTelemetryPollHighWater());
    const paused = monoRollback || sample.wall < this.#highWater;
    if (paused !== this.#clockPaused) {
      this.#logger[paused ? 'warn' : 'info']('services.telemetryPolling', paused
        ? 'Telemetry polling paused until wall time agrees with durable and monotonic clock evidence.'
        : 'Telemetry polling clock agreement restored.', { outcome: paused ? 'clock-rollback' : 'clock-restored' });
      this.#clockPaused = paused;
    }
    if (!paused && sample.wall > projected) this.#anchor = { wall: sample.wall, monotonic: this.#lastMono };
    this.#highWater = Math.max(this.#highWater, sample.wall);
    return { wall: sample.wall, paused };
  }
  #snapshot() {
    const value = this.#radio.getConnectionSnapshot();
    if (!snapshotValid(value)) throw new Error('Invalid telemetry radio context');
    return { ...value, observerPublicKey: value.observerPublicKey?.toUpperCase() ?? null };
  }
  #variants(target) {
    const profile = this.#config.targetProfiles.find(p => p.targetPublicKey === target);
    return ['status', 'sensors', 'neighbours'].filter(c => this.#config.components[c]).map(component => ({ component,
      params: component === 'status' ? {} : component === 'sensors' ? { permissionMask: 0 } : { ...this.#config.neighbourParams },
      ...(component === 'status' ? { profile: { ...(profile?.statusProfile ?? this.#config.statusProfile) } } : {}) }));
  }
  #scope(target, variant) { return { observerPublicKey: this.#observer, targetPublicKey: target, variant }; }
  #due(scope, now, requestId) {
    const state = this.#store.getTelemetryPollState(scope);
    if (!state) return true;
    if (state.reason === 'reserved') return state.requestId === requestId;
    // Mirror the store's conservative current-cycle deadline BEFORE a login
    // is considered. A slower override must not spend RF merely to learn that
    // the following data reservation is still blocked.
    const policy = Object.fromEntries(Object.keys(this.#policy).map(k => [k, k === 'maxAttempts'
      ? Math.min(state.policy[k], this.#policy[k]) : Math.max(state.policy[k], this.#policy[k])]));
    const delay = state.reason === 'auth-cooldown' ? policy.authCooldownMs
      : ['answered', 'partial', 'unsupported', 'exhausted'].includes(state.reason) || state.cycleAttempts >= policy.maxAttempts
        ? policy.refreshIntervalMs : Math.min(policy.retryMaxMs, policy.retryBaseMs * 2 ** Math.max(0, state.cycleAttempts - 1));
    return Math.max(state.nextDueAt, state.requestId ? add(state.lastCompletedAt ?? state.reservedAt, delay) : 0) <= now;
  }
  #eligible(request, current, admitted, variant, reservation) {
    if (!snapshotValid(current) || this.#stopped || this.#unsaved || (this.#unconfirmed && !reservation)) return false;
    if (this.#excluded.has(request.targetPublicKey)) return false;
    if (!current.ready || current.generation !== admitted.generation
      || current.observerPublicKey?.toUpperCase() !== admitted.observerPublicKey) return false;
    const clock = this.#clock();
    if (clock.paused) return false;
    const scope = { observerPublicKey: admitted.observerPublicKey, targetPublicKey: request.targetPublicKey };
    const auth = this.#store.getTelemetryPollState({ ...scope, variant: AUTH });
    if (auth?.reason === 'auth-cooldown' && clock.wall < auth.nextDueAt) return false;
    return Boolean(this.#store.getTelemetryEligibility({ ...scope, now: clock.wall,
      windowMs: this.#config.evidenceWindowMs, radius: this.#config.radius }))
      && this.#due({ ...scope, variant }, clock.wall, reservation?.requestId);
  }
  #initialize(scope, now) {
    // A stable reporter/target/component phase in this startup's cadence;
    // saved phases survive restart and policy edits without sliding forward.
    const offset = createHash('sha256').update(JSON.stringify(scope)).digest().readUInt32BE(0) / 0x100000000;
    this.#store.deferTelemetryPoll({ ...scope, runId: this.#runId, observedAt: now,
      nextDueAt: Math.max(now, add(this.#anchor.wall, Math.floor(offset * this.#config.refreshIntervalMs))),
      reason: 'rate-limited', policy: this.#policy });
  }
  async #pass() {
    this.#persist();
    if (this.#stopped || this.#unsaved || this.#unconfirmed) return;
    const clock = this.#clock();
    if (clock.paused) return;
    if (!this.#recovered) {
      const page = this.#store.recoverTelemetryPollReservations({ runId: this.#runId, observedAt: clock.wall,
        policy: this.#policy, limit: 100, ...(this.#recoveryCursor ? { afterRequestId: this.#recoveryCursor } : {}) });
      this.#recoveryCursor = page.nextCursor; this.#recovered = page.exhausted && !page.clockRollback;
      if (!this.#recovered) return;
    }
    const snapshot = this.#snapshot();
    if (!snapshot.ready || snapshot.generation === null || !snapshot.observerPublicKey
      || this.#pausedGeneration === snapshot.generation) return;
    if (this.#observer !== snapshot.observerPublicKey) { this.#observer = snapshot.observerPublicKey; this.#cursor = null; }
    const page = this.#store.queryTelemetryPollCandidates({ observerPublicKey: this.#observer, now: clock.wall,
      windowMs: this.#config.evidenceWindowMs, radius: this.#config.radius, limit: 16,
      ...(this.#cursor ? { afterPublicKey: this.#cursor } : {}) });
    if (page.clockRollback) return;
    let selected = null;
    for (const candidate of page.candidates) {
      this.#cursor = candidate.targetPublicKey;
      if (this.#excluded.has(candidate.targetPublicKey)) continue;
      for (const variant of this.#variants(candidate.targetPublicKey)) {
        const scope = this.#scope(candidate.targetPublicKey, variant);
        if (!this.#store.getTelemetryPollState(scope)) this.#initialize(scope, clock.wall);
        if (!selected && this.#due(scope, clock.wall)) selected = { target: candidate.targetPublicKey, variant };
      }
      if (selected) break;
    }
    if (!selected) { if (page.exhausted) this.#cursor = null; return; }
    const response = await this.#request(selected, snapshot, false);
    if (response.reason === 'guest-session-unavailable' && response.dispatchedAt === undefined && !this.#stopped) {
      if (this.#due(this.#scope(selected.target, AUTH), this.#clock().wall)) await this.#request(selected, snapshot, true);
    }
  }
  async #request(selected, admitted, login) {
    const variant = login ? AUTH : selected.variant;
    const request = { requestId: this.#createId(), targetPublicKey: selected.target,
      ...(!login ? { operation: variant.component === 'sensors' ? 'telemetry' : variant.component, params: variant.params } : {}) };
    let reservation = null;
    const hooks = {
      isEligible: (dto, current) => this.#eligible(dto, current, admitted, variant, reservation),
      reserve: context => {
        if (!contextValid(context) || context.requestId !== request.requestId || context.targetPublicKey !== request.targetPublicKey
          || context.observerPublicKey !== admitted.observerPublicKey || context.generation !== admitted.generation) return false;
        if (!this.#eligible(request, this.#snapshot(), admitted, variant, null)) return false;
        const input = { observerPublicKey: admitted.observerPublicKey, targetPublicKey: selected.target, variant,
          runId: this.#runId, requestId: request.requestId, reservedAt: this.#clock().wall,
          policy: this.#policy, radius: this.#config.radius, windowMs: this.#config.evidenceWindowMs };
        if (!this.#store.reserveTelemetryPoll(input).reserved) return false;
        reservation = input; this.#unconfirmed = true; return true;
      },
      getReplayHighWater: context => {
        if (!contextValid(context) || context.requestId !== request.requestId || context.generation !== admitted.generation
          || context.observerPublicKey !== admitted.observerPublicKey || context.targetPublicKey !== selected.target)
          throw new Error('Invalid telemetry replay ownership');
        return this.#store.getTelemetryAuthReplayState({ observerPublicKey: context.observerPublicKey, targetPublicKey: context.targetPublicKey }).serverTimestamp;
      },
      recordAuthentication: record => {
        if (!authValid(record) || !reservation || record.context.requestId !== request.requestId
          || record.context.generation !== admitted.generation || record.context.operation !== 'guest-login'
          || record.context.observerPublicKey !== admitted.observerPublicKey || record.context.targetPublicKey !== selected.target)
          throw new Error('Invalid telemetry authentication ownership');
        // Capture the validated terminal BEFORE any save attempt. A failed save
        // cannot grant a session and cannot lose the sole retryable terminal.
        this.#unsaved = { kind: 'auth', input: { runId: this.#runId, record: JSON.parse(JSON.stringify(record)), policy: this.#policy } };
        let clock;
        try { clock = this.#clock(); } catch { clock = { paused: true }; }
        if (record.status === 'completed' && (clock.paused || record.dispatchedAt < reservation.reservedAt)) {
          this.#unsaved.input.record.status = 'failed'; this.#unsaved.input.record.reason = 'clock-anomaly';
          this.#persist(); return false;
        }
        return this.#persist();
      }
    };
    const response = await (login ? this.#coordinator.tryGuestLogin(request, this.#config, hooks)
      : this.#coordinator.tryTelemetryRequest(request, this.#config, hooks));
    if (!validateTelemetryCompletion(response) || (response.context && (response.context.requestId !== request.requestId
      || response.context.observerPublicKey !== admitted.observerPublicKey || response.context.targetPublicKey !== selected.target
      || response.context.generation !== admitted.generation))) throw new Error('Invalid telemetry owner completion');
    if (response.dispatchedAt === undefined) {
      // Reservation without physical dispatch remains a conservative block
      // until restart recovery. It is never written as a fabricated outcome.
      this.#unconfirmed = false;
      if (response.recovery || response.reason === 'preflight-paused') this.#pausedGeneration = admitted.generation;
      if (!reservation && response.reason && !TRANSIENT.has(response.reason) && response.reason !== 'guest-session-unavailable') {
        const clock = this.#clock();
        if (!clock.paused) this.#store.deferTelemetryPoll({ ...this.#scope(selected.target, variant), runId: this.#runId,
          observedAt: clock.wall, nextDueAt: add(clock.wall, this.#policy.retryBaseMs), reason: response.reason, policy: this.#policy });
      }
      return response;
    }
    if (!reservation) throw new Error('Telemetry dispatch lacks durable reservation');
    if (login) {
      if (this.#unconfirmed && !this.#unsaved) throw new Error('Telemetry authentication terminal was not captured');
      return response;
    }
    // Capture original completion before a store clock read can fail. Unknown
    // clock agreement marks the outcome anomalous; it never drops a valid terminal.
    const sample = { wall: this.#wall(), monotonic: this.#mono() };
    if (!clockValid(sample)) throw new Error('Invalid telemetry completion clock');
    let clock;
    try { clock = this.#clock(); } catch { clock = { paused: true }; }
    const profile = this.#config.targetProfiles.find(p => p.targetPublicKey === selected.target);
    this.#unsaved = { kind: 'data', input: { policy: this.#policy, result: telemetryPollingResult({ response, reservation,
      variant, emitterProfile: profile?.emitterProfile ?? this.#config.emitterProfile,
      completedAt: sample.wall, clockAnomaly: clock.paused }) } };
    this.#persist();
    return response;
  }
  #persist() {
    if (!this.#unsaved) return true;
    try {
      const saved = this.#unsaved.kind === 'auth' ? this.#store.completeTelemetryAuthentication(this.#unsaved.input)
        : this.#store.completeTelemetryPoll(this.#unsaved.input);
      if (!saved.completed && saved.reason !== 'already-completed') throw new Error('Telemetry terminal reservation no longer owned');
      this.#unsaved = null; this.#unconfirmed = false; this.#fault = null;
      return true;
    } catch { this.#warn('persistence'); return false; }
  }
}
