import { randomBytes } from 'node:crypto';
import { Constants } from '@liamcottle/meshcore.js';
import { performance } from 'node:perf_hooks';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { assertRemoteRequest, prepareRemoteRequest } from './remote-request.js';
import { parseRemoteResponseFrame } from './remote-response-parser.js';
import { remoteResponseFrameSchema } from './remote-request-schemas.js';
import { remoteCoordinatorLimitsSchema, remoteDispatchOptionsSchema, remoteBinaryHeaderSchema, remotePreflightLimitsSchema, REMOTE_REQUEST_DEFAULTS } from './remote-coordinator-schemas.js';
import { RemoteRequestBudget } from './remote-request-budget.js';
import { REGION_QUERY_DEFAULTS, regionQueryTargetSchema } from '../regions/region-query-schemas.js';
import { parseRegionContactFrame, prepareRegionContactRead } from '../regions/region-radio-adapter.js';
import { createBackgroundAdmissions } from './background-admissions.js';
import { compileSchema as compile } from '../validation/ajv.js';
import { telemetryPollConfigSchema } from '../telemetry/polling-schemas.js';
import { withTelemetryGuestPassword } from '../telemetry/polling-config.js';
import { createTelemetryGuestSessions } from '../telemetry/telemetry-guest-sessions.js';
import { createTelemetryContactInventory } from '../telemetry/telemetry-contact-inventory.js';
import { reconcileTelemetryContact } from '../telemetry/telemetry-contact-manager.js';
import { prepareTelemetryContactInventory, prepareTelemetryContactRead, parseTelemetryContactFrame,
  parseTelemetryGuestLogin, parseTelemetryLoginAck, withPreparedTelemetryGuestLogin } from '../telemetry/telemetry-radio-adapter.js';
import * as ownerSchemas from '../telemetry/telemetry-owner-schemas.js';

const ownerValidators = new Map(Object.entries(ownerSchemas).filter(([name]) => name.endsWith('Schema'))
  .map(([, schema]) => [schema, compile(schema)]));
const pollingValid = compile(telemetryPollConfigSchema);
function ownerValid(schema, value) { return ownerValidators.get(schema)(value); }
function assertOwner(schema, value) {
  if (!ownerValid(schema, value)) throw new Error('Invalid telemetry owner data');
}

const limitsValid = compileSchema(remoteCoordinatorLimitsSchema);
const optionsValid = compileSchema(remoteDispatchOptionsSchema);
const frameValid = compileSchema(remoteResponseFrameSchema);
const binaryHeaderValid = compileSchema(remoteBinaryHeaderSchema);
const preflightLimitsValid = compileSchema(remotePreflightLimitsSchema);
const targetValid = compileSchema(regionQueryTargetSchema);
const recoveryStatuses = new Set(['reset', 'stale-generation', 'close-failed', 'close-timeout']);
function synchronousPermission(callback, ...args) {
  const value = callback(...args);
  if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
  return value === true;
}

/** One remote lease, separate from the command queue's short ACK transaction.
 * Anonymous contact preflight is read-only. No polls, automatic retries,
 * contact mutation or storage ownership here.
 */
export class RemoteRequestCoordinator {
  #radio;
  #limits;
  #now;
  #lastTime = -Infinity;
  #uniquenessBytes;
  #current = null;
  #commandPending = false;
  #retired = new Map();
  #stopped = false;
  #recoveryFailed = false;
  #recoveryGeneration = null;
  #recoveryClearable = false;
  #airtime;
  #hasForegroundWork;
  #budget;
  #logger;
  #preflightTimeoutMs;
  #wallNow;
  #pausedGeneration = null;
  #background;
  #guestSessions;
  #guestScope = null;
  #sessionOnChange = null;
  #exchange = null;

  #responseTimeout(current, estimatedTimeoutMs) {
    const routed = Boolean(current.telemetry);
    const hopCount = routed ? current.routeEvidence?.path?.length ?? 0 : 0;
    // Companion ACK estimates are commonly shorter than the complete routed
    // request/response exchange. Leave a hop-scaled window for both directions.
    const hopAllowanceMs = routed ? 4000 + hopCount * 5000 : 1000;
    const timeoutMs = Math.min(this.#limits.responseTimeoutMaxMs,
      Math.max(estimatedTimeoutMs + 1000, hopAllowanceMs,
        current.exchange && !current.telemetry.login ? current.telemetry.config.responseWaitMs : 0));
    current.responseTimeoutMs = timeoutMs;
    return timeoutMs;
  }

  constructor({ radio, airtimeCoordinator, hasForegroundWork, logger,
    ackTimeoutMs = REMOTE_REQUEST_DEFAULTS.ackTimeoutMs,
    responseTimeoutMaxMs = REMOTE_REQUEST_DEFAULTS.responseTimeoutMaxMs,
    minIntervalMs = REMOTE_REQUEST_DEFAULTS.minIntervalMs, maxPerMinute = REMOTE_REQUEST_DEFAULTS.maxPerMinute,
    preflightTimeoutMs = REGION_QUERY_DEFAULTS.queryPreflightTimeoutMs, wallNow = () => Date.now(),
    now = () => performance.now(), uniquenessBytes = () => Array.from(randomBytes(4)), budget }) {
    const limits = { ackTimeoutMs, responseTimeoutMaxMs, minIntervalMs, maxPerMinute };
    if (!limitsValid(limits)) throw new Error(`Invalid remote request limits: ${formatErrors(limitsValid.errors)}`);
    if (!preflightLimitsValid({ preflightTimeoutMs })) throw new Error('Invalid remote preflight limits');
    if (typeof airtimeCoordinator?.canRunWhenQuiet !== 'function'
      || typeof airtimeCoordinator?.tryRunWhenQuiet !== 'function'
      || typeof hasForegroundWork !== 'function' || typeof logger?.warn !== 'function' || typeof logger?.info !== 'function') {
      throw new Error('Remote request coordination requires shared airtime, foreground policy and structured logging');
    }
    this.#radio = radio;
    this.#limits = limits;
    this.#now = now;
    this.#uniquenessBytes = uniquenessBytes;
    this.#airtime = airtimeCoordinator;
    this.#hasForegroundWork = hasForegroundWork;
    this.#logger = logger;
    this.#preflightTimeoutMs = preflightTimeoutMs;
    this.#wallNow = wallNow;
    // The injectable policy isolates ownership tests. Runtime always creates
    // the validated bounded budget here; producer DTOs cannot replace it.
    this.#budget = budget ?? new RemoteRequestBudget({ minIntervalMs, maxPerMinute, now: () => this.#time() });
    this.#background = createBackgroundAdmissions({ now: () => this.#time(),
      lifetimeMs: Math.max(minIntervalMs * 2, ackTimeoutMs + responseTimeoutMaxMs) });
    this.#guestSessions = createTelemetryGuestSessions({ now: this.#now,
      quarantineMs: ackTimeoutMs + responseTimeoutMaxMs + 60000 });
  }

  /** Internal producer demand, coalesced into two expiring slots. */
  noteBackgroundDemand(input) { this.#background.note(input); }

  /** A private target/generation-scoped pacing capability, never guest authority. */
  beginTelemetryExchange(request, config) {
    assertOwner(ownerSchemas.telemetryGuestRequestSchema, request);
    if (!pollingValid(config) || !config.enabled) throw new Error('Invalid telemetry exchange configuration');
    if (this.#stopped || this.#current || this.#commandPending || this.#exchange
      || config.exchangeMaxRequests < 2 || typeof this.#budget.beginExchange !== 'function') return null;
    const snapshot = this.#radio.getConnectionSnapshot();
    if (!ownerValid(ownerSchemas.telemetryOwnerSnapshotSchema, snapshot) || !snapshot.ready
      || snapshot.generation === null || !snapshot.observerPublicKey) return null;
    if (this.#recoveryFailed && !this.#clearRecovery()) return null;
    this.#background.note({ source: 'telemetry' });
    if (!this.#background.allowed('telemetry')) return null;
    if (this.#admissionReason()) return null;
    const token = this.#budget.beginExchange({ maxRequests: config.exchangeMaxRequests,
      windowMs: config.exchangeWindowMs, stepMs: config.exchangeStepMs, restMs: config.exchangeRestMs });
    if (!token) return null;
    this.#exchange = { token, config, target: request.targetPublicKey, generation: snapshot.generation,
      observer: snapshot.observerPublicKey.toUpperCase() };
    this.#watchGuestSessions({ ...snapshot, observerPublicKey: snapshot.observerPublicKey.toUpperCase() });
    return token;
  }

  endTelemetryExchange(token) {
    if (this.#exchange?.token !== token) return;
    this.#budget.endExchange(token); this.#exchange = null;
  }

  hasTelemetryExchangeCapacity(token) {
    return Boolean(this.#exchange && this.#exchange.token === token && this.#budget.hasExchangeCapacity(token));
  }

  #matchingExchange(telemetry, request, snapshot) {
    const e = this.#exchange;
    return telemetry && e && e.config === telemetry.config && e.target === request.targetPublicKey
      && e.generation === snapshot.generation && e.observer === snapshot.observerPublicKey?.toUpperCase() ? e : null;
  }

  #backgroundAllowed(current) { return Boolean(current.exchange) || this.#background.allowed(current.source); }

  async tryGuestLogin(request, config, hooks) {
    assertOwner(ownerSchemas.telemetryGuestRequestSchema, request);
    const descriptor = Object.freeze({ ...request, operation: 'guest-login', params: Object.freeze({}) });
    this.#assertTelemetry(config, hooks, true);
    hooks = { ...hooks };
    try { await withTelemetryGuestPassword(config, { targetPublicKey: descriptor.targetPublicKey }, () => true); }
    catch { return { status: 'deferred', reason: 'credential-unavailable' }; }
    return this.#ownedTelemetry(descriptor, config, hooks, true);
  }

  tryTelemetryRequest(request, config, hooks) {
    assertOwner(ownerSchemas.telemetryOwnedRequestSchema, request);
    this.#assertTelemetry(config, hooks, false);
    const component = request.operation === 'telemetry' ? 'sensors' : request.operation;
    if (!config.components[component] || (component === 'neighbours'
      && Object.keys(config.neighbourParams).some(key => request.params[key] !== config.neighbourParams[key]))) {
      return this.#defer('ineligible');
    }
    return this.#ownedTelemetry(request, config, hooks, false);
  }

  #assertTelemetry(config, hooks, login) {
    if (!pollingValid(config) || !config.enabled || typeof hooks?.isEligible !== 'function'
      || typeof hooks?.reserve !== 'function' || (login && (typeof hooks.getReplayHighWater !== 'function'
      || typeof hooks.recordAuthentication !== 'function'))) throw new Error('Telemetry owner requires enabled validated policy and synchronous trusted gates');
  }

  #telemetryScope(snapshot) {
    if (!ownerValid(ownerSchemas.telemetryOwnerSnapshotSchema, snapshot)) { this.#clearGuestSessions(); return false; }
    const scope = snapshot.ready && snapshot.generation !== null && snapshot.observerPublicKey
      ? `${snapshot.generation}:${snapshot.observerPublicKey.toUpperCase()}` : null;
    if (this.#guestScope && scope !== this.#guestScope) this.#clearGuestSessions();
    return this.#guestSessions.observe(snapshot);
  }

  async #traceTelemetryRoute(current, connection, route) {
    const path = route.path;
    const targetPrefix = current.context.targetPublicKey.slice(0, 4);
    if (!ownerValid(ownerSchemas.telemetryTraceRequestSchema, { targetPublicKey: current.context.targetPublicKey, path })
      || route.target?.publicKeyHex !== current.context.targetPublicKey || path.includes(targetPrefix)
      || targetPrefix === current.context.observerPublicKey.slice(0, 4)
      || path.includes(current.context.observerPublicKey.slice(0, 4))) {
      current.traceOutcome = 'invalid-route';
      current.routeEvidence = null; // Invalid provider data must not escape through diagnostics.
      return { status: 'deferred', reason: 'ineligible' };
    }
    // Contact paths exclude their destination. TRACE needs a full loop ending
    // with the last relay's transmission back to this non-forwarding companion.
    const tracePath = [...path, targetPrefix, ...path.toReversed()];
    const tagBytes = randomBytes(4);
    const tag = tagBytes.readUInt32LE(0);
    const pathBytes = Buffer.from(tracePath.join(''), 'hex');
    const frame = Buffer.from([Constants.CommandCodes.SendTracePath, ...tagBytes, 0, 0, 0, 0, 1, ...pathBytes]);
    const timeoutMs = Math.min(this.#limits.responseTimeoutMaxMs, 15000 + tracePath.length * 5000);
    current.traceOutcome = 'pending';
    current.traceAttemptedPath = tracePath;
    current.traceTimeoutMs = timeoutMs;
    this.#logger.info('services.remoteRequests', 'Telemetry route trace started.', {
      requestId: current.context.requestId, operation: current.context.operation,
      generation: current.context.generation, phase: 'preflight', preflightKind: 'trace',
      targetPublicKey: current.context.targetPublicKey, routeCandidatePath: path,
      routeEvidenceSource: route.evidenceSource ?? null, hashWidth: 2, timeoutMs
    });
    let finish;
    let timer;
    let acknowledged = false;
    const result = new Promise(resolve => { finish = resolve; });
    const onFrame = bytes => {
      if (this.#current !== current || current.finishing || current.signal?.aborted
        || current.traceOutcome !== 'pending') return;
      const frame = { bytes: bytes instanceof Uint8Array ? Array.from(bytes) : bytes };
      if (current.traceDispatchedAt === undefined) return;
      // The exclusive command lease owns untagged errors until the matching
      // Sent ACK. A serial write alone does not prove RF transmission.
      if (!acknowledged && frameValid(frame)) {
        const parsed = parseRemoteResponseFrame(frame);
        if (parsed.status === 'accepted' && parsed.envelope.kind === 'error') {
          const { errorCode, reason: errorReason } = parsed.envelope;
          finish({ status: 'failed', reason: 'command-error', errorCode, errorReason });
          return;
        }
        if (parsed.status === 'accepted' && parsed.envelope.kind === 'sent' && parsed.envelope.tag === tag) {
          if (parsed.envelope.route !== 'direct') {
            finish({ status: 'failed', reason: 'trace-malformed' }); return;
          }
          acknowledged = true;
          clearTimeout(timer);
          current.traceTimeoutMs = Math.min(this.#limits.responseTimeoutMaxMs,
            Math.max(timeoutMs, parsed.envelope.estimatedTimeoutMs + 1000));
          timer = setTimeout(() => finish({ status: 'failed', reason: 'trace-timeout' }),
            current.traceTimeoutMs);
        }
      }
      if (!acknowledged) return;
      if (!ownerValid(ownerSchemas.telemetryTraceFrameSchema, frame)
        || frame.bytes[0] !== Constants.PushCodes.TraceData) return;
      const raw = Buffer.from(frame.bytes);
      const pathLengthBytes = raw[2];
      const flags = raw[3];
      if (raw.readUInt32LE(4) !== tag || raw.readUInt32LE(8) !== 0) return;
      if (raw[1] !== 0 || flags !== 1 || pathLengthBytes !== pathBytes.length
        || raw.length !== 13 + pathLengthBytes + tracePath.length
        || !raw.subarray(12, 12 + pathLengthBytes).equals(pathBytes)) {
        finish({ status: 'failed', reason: 'trace-malformed' });
        return;
      }
      const hashes = raw.subarray(12, 12 + pathLengthBytes);
      const hopCount = pathLengthBytes / 2;
      const snrBytes = raw.subarray(12 + pathLengthBytes, 12 + pathLengthBytes + hopCount + 1);
      finish({ status: 'completed', pathHashes: Array.from({ length: hopCount }, (_, index) =>
        hashes.subarray(index * 2, index * 2 + 2).toString('hex').toUpperCase()),
      snrQuarterDb: [...snrBytes].map(value => value > 127 ? value - 256 : value) });
    };
    const onAbort = () => finish({ status: 'failed', reason: 'trace-disconnected' });
    connection.on('rx', onFrame);
    current.signal?.addEventListener('abort', onAbort, { once: true });
    const startedAt = this.#now();
    let sent;
    try {
      sent = this.#airtime.tryRunWhenQuiet(async () => {
        if (this.#current !== current || current.signal?.aborted || !this.#currentScope(current)) {
          return { status: 'failed', reason: 'trace-disconnected' };
        }
        if (this.#admissionReason(current)) return { status: 'deferred', reason: 'foreground' };
        if (current.source && !this.#backgroundAllowed(current))
          return { status: 'deferred', reason: 'background-turn' };
        if (!synchronousPermission(current.reserve, current.context))
          return { status: 'deferred', reason: 'reservation-unavailable' };
        current.traceReserved = true;
        if (current.exchange && !this.#budget.recordAttempt(current.exchange.token))
          return { status: 'deferred', reason: 'rate-limited' };
        current.traceDispatchedAt = this.#wallNow();
        timer = setTimeout(() => finish({ status: 'failed', reason: 'ack-timeout' }), this.#limits.ackTimeoutMs);
        await connection.sendToRadioFrame(frame);
        return result;
      });
    } catch {
      sent = Promise.resolve({ status: 'failed', reason: 'trace-write-error' });
    }
    if (!sent) finish({ status: 'deferred', reason: 'quiet-air' });
    let outcome;
    try { outcome = await Promise.resolve(sent ?? result); }
    catch { outcome = { status: 'failed', reason: 'trace-write-error' }; }
    clearTimeout(timer);
    connection.off('rx', onFrame);
    current.signal?.removeEventListener('abort', onAbort);
    current.traceOutcome = outcome.status === 'completed' ? 'response'
      : outcome.status === 'deferred' ? outcome.reason === 'quiet-air' ? 'quiet-air' : 'trace-not-sent'
        : ['command-error', 'ack-timeout'].includes(outcome.reason) ? 'trace-failed' : outcome.reason ?? 'trace-failed';
    current.tracePathHashes = outcome.pathHashes ?? [];
    current.traceSnrQuarterDb = outcome.snrQuarterDb ?? [];
    this.#logger[outcome.status === 'completed' ? 'info' : 'warn'](
      'services.remoteRequests', outcome.status === 'completed'
        ? 'Telemetry route trace response received.' : 'Telemetry route trace did not verify the candidate route.', {
        requestId: current.context.requestId, operation: current.context.operation,
        generation: current.context.generation, phase: 'preflight', preflightKind: 'trace',
        targetPublicKey: current.context.targetPublicKey, routeCandidatePath: path,
        routeHopWeights: route.hopWeights ?? [],
        traceOutcome: current.traceOutcome, tracePathHashes: current.tracePathHashes,
        traceSnrQuarterDb: current.traceSnrQuarterDb, elapsedMs: Math.max(0, this.#now() - startedAt)
      });
    return outcome;
  }

  #clearGuestSessions() {
    if (this.#exchange) this.endTelemetryExchange(this.#exchange.token);
    this.#guestSessions.clear(); this.#guestScope = null;
    if (this.#sessionOnChange) {
      this.#radio.off('radio.connected', this.#sessionOnChange);
      this.#radio.off('radio.disconnected', this.#sessionOnChange);
      this.#sessionOnChange = null;
    }
  }

  #watchGuestSessions(context) {
    this.#guestScope = `${context.generation}:${context.observerPublicKey}`;
    if (this.#sessionOnChange) return;
    this.#sessionOnChange = () => {
      const snapshot = this.#radio.getConnectionSnapshot();
      if (!ownerValid(ownerSchemas.telemetryOwnerSnapshotSchema, snapshot)) { this.#clearGuestSessions(); return; }
      const scope = snapshot.ready && snapshot.generation !== null && snapshot.observerPublicKey
        ? `${snapshot.generation}:${snapshot.observerPublicKey.toUpperCase()}` : null;
      if (scope !== this.#guestScope) this.#clearGuestSessions();
    };
    this.#radio.on('radio.connected', this.#sessionOnChange);
    this.#radio.on('radio.disconnected', this.#sessionOnChange);
  }

  #ownedTelemetry(request, config, hooks, login) {
    if (request.targetPublicKey.startsWith('00000000')) return this.#defer('unsafe-prefix');
    const snapshot = this.#radio.getConnectionSnapshot();
    if (!this.#telemetryScope(snapshot)) return this.#defer('not-ready');
    const reason = login ? this.#guestSessions.loginReason(request.targetPublicKey)
      : this.#guestSessions.has(request.targetPublicKey, config) ? null : 'guest-session-unavailable';
    if (reason) return this.#defer(reason);
    return this.#request(request, { expectedRoute: 'direct' }, hooks.isEligible, hooks.reserve,
      { config, hooks: { ...hooks }, login }).then(result => {
      assertOwner(ownerSchemas.telemetryOwnerCompletionSchema, result);
      return result;
    });
  }

  /** Trusted eligibility is executable policy, separate from the DTO.
   * The promise settles once, including deferral. Admission reserves
   * synchronously, so two callers cannot both enqueue a remote operation.
   */
  tryRequest(request, options = {}, isEligible, reserve) {
    assertRemoteRequest(request);
    return this.#request(request, options, isEligible, reserve);
  }

  #request(request, options = {}, isEligible, reserve, telemetry = null) {
    if (!optionsValid(options)) throw new Error(`Invalid remote dispatch options: ${formatErrors(optionsValid.errors)}`);
    const descriptor = Object.freeze({ ...request, params: Object.freeze({ ...request.params }) });
    const anonymous = descriptor.operation === 'anonymous-regions';
    const source = anonymous ? 'regions' : telemetry ? 'telemetry' : null;
    if (source && !this.#stopped) this.#background.note({ source });
    if (anonymous && options.expectedRoute === 'flood') throw new Error('Anonymous regions require a direct route');
    if (anonymous && (typeof isEligible !== 'function' || typeof reserve !== 'function')) return this.#defer('reservation-unavailable');
    isEligible ??= () => true;
    const expectedRoute = anonymous ? 'direct' : options.expectedRoute;
    if (this.#stopped) return this.#defer('stopped');
    if (this.#recoveryFailed && !this.#clearRecovery()) return this.#defer('recovery-failed');
    // Keep one bounded tombstone until a cancelled shared-queue callback
    // drains. Repeated expiry must not accumulate callbacks behind a hang.
    if (this.#current || this.#commandPending) return this.#defer('busy');
    const snapshot = this.#radio.getConnectionSnapshot();
    if (snapshot.generation === null) return this.#defer('disconnected');
    if (!snapshot.ready) return this.#defer('not-ready');
    if ((anonymous || telemetry) && this.#pausedGeneration === snapshot.generation) return this.#defer('preflight-paused');
    if (anonymous && !targetValid({ targetPublicKey: snapshot.observerPublicKey?.toUpperCase() })) return this.#defer('not-ready');
    const exchange = this.#matchingExchange(telemetry, descriptor, snapshot);
    const admission = this.#admissionReason({ exchange });
    if (admission) return this.#defer(admission);
    if (!this.#airtime.canRunWhenQuiet()) return this.#defer('quiet-air');
    try { if (!synchronousPermission(isEligible, descriptor, snapshot)) {
      if (source) this.#background.withdraw(source);
      return this.#defer('ineligible');
    } }
    catch {
      if (source) this.#background.withdraw(source);
      this.#logger.warn('services.remoteRequests', 'remote request eligibility check failed', {
        requestId: descriptor.requestId, operation: descriptor.operation, phase: 'admission', outcome: 'eligibility-error'
      });
      return Promise.resolve({ status: 'failed', reason: 'eligibility-error' });
    }
    if (this.#stopped) return this.#defer('stopped');
    if (this.#current || this.#commandPending) return this.#defer('busy');
    if (!this.#isGeneration(snapshot.generation)) return this.#defer('disconnected');
    const prepared = telemetry?.login ? null : prepareRemoteRequest(descriptor, anonymous ? undefined : this.#uniquenessBytes());
    let resolveCompletion;
    let releaseCommand;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const acknowledgement = new Promise((resolve) => { releaseCommand = resolve; });
    const context = Object.freeze({ requestId: descriptor.requestId, targetPublicKey: descriptor.targetPublicKey,
      operation: descriptor.operation, params: descriptor.params,
      generation: snapshot.generation, observerPublicKey: anonymous || telemetry ? snapshot.observerPublicKey.toUpperCase() : snapshot.observerPublicKey });
    const current = { descriptor, expectedRoute, isEligible, reserve, anonymous, telemetry, source, prepared, context, exchange,
      phase: 'queued', tag: null, route: null, timer: null, deadline: null, expire: null,
      connection: null, signal: null, onAbort: null, onFrame: null, resolveCompletion,
      releaseCommand, acknowledgement, completion, onChange: null,
      inventoryContactCount: null, inventoryOutcome: null, contactSyncOutcome: null, targetContactOutcome: null };
    this.#current = current;
    current.onChange = () => {
      if (current.phase !== 'recovery' && !this.#currentScope(current)) this.#finish(current, 'failed', 'disconnected');
    };
    this.#radio.on('radio.disconnected', current.onChange);
    this.#radio.on('radio.connected', current.onChange);
    this.#arm(current, this.#limits.ackTimeoutMs, () => this.#finish(current, 'deferred', 'queue-timeout'));
    this.#commandPending = true;
    // Observe both settlements even if queue expiry or stop already won.
    Promise.resolve().then(() => this.#radio.runCommand((connection, transaction) =>
      this.#dispatch(current, connection, transaction), { generation: context.generation, requireReady: true }
    )).then(() => { this.#commandPending = false; }, () => {
      this.#commandPending = false;
      if (this.#current === current && current.phase !== 'recovery') this.#finish(current, 'failed', 'disconnected');
    });
    return completion;
  }

  stop() {
    this.#stopped = true;
    this.#clearGuestSessions(); this.#background.clear();
    const current = this.#current;
    if (!current) return Promise.resolve();
    if (current.phase === 'preflight') this.#recover(current, 'stopped', 'preflight-cancelled');
    else if (current.phase === 'ack') this.#recover(current, 'stopped', 'request-cancelled');
    else if (current.phase !== 'recovery') this.#finish(current, 'failed', 'stopped');
    return current.completion.then(() => undefined);
  }

  #defer(reason) { return Promise.resolve({ status: 'deferred', reason }); }

  /** Operator-visible state; callers must not infer more than this boolean. */
  getStatus() { return Object.freeze({ recoveryFailed: this.#recoveryFailed }); }

  // Unconfirmed reset ownership blocks every remote request. Say so once, with
  // the required action, instead of deferring silently forever.
  #latchRecovery(recovery, generation) {
    if (this.#recoveryFailed) return;
    this.#recoveryFailed = true;
    this.#recoveryGeneration = generation;
    // An unconfirmed transport close makes RadioManager fail closed as well;
    // no later connection can prove the old one is gone, so require a restart.
    this.#recoveryClearable = recovery === 'failed';
    this.#logger.warn('services.remoteRequests', this.#recoveryClearable
      ? 'Remote request recovery could not confirm the radio connection was reset. Region discovery and telemetry polling are paused until the radio reconnects.'
      : 'Remote request recovery could not confirm the radio transport closed. Region discovery and telemetry polling are disabled until Observer is restarted.',
    { outcome: 'recovery-failed', recovery, generation });
  }

  // A later connection generation is a new command channel: the uncertain
  // acknowledgement ownership belonged to the retired one.
  #clearRecovery() {
    if (!this.#recoveryClearable) return false;
    const snapshot = this.#radio.getConnectionSnapshot();
    if (snapshot.generation === null || snapshot.generation === this.#recoveryGeneration) return false;
    this.#recoveryFailed = false; this.#recoveryGeneration = null; this.#recoveryClearable = false;
    this.#logger.info('services.remoteRequests',
      'Remote request recovery cleared after the radio reconnected. Region discovery and telemetry polling may resume.',
      { outcome: 'recovery-cleared', generation: snapshot.generation });
    return true;
  }

  #admissionReason(current) {
    try { if (this.#hasForegroundWork() !== false) return 'foreground'; }
    catch { return 'foreground'; } // Unknown priority state defers without RF/log storms.
    return this.#budget.canAttempt(current?.exchange?.token) ? null : 'rate-limited';
  }

  #time() {
    this.#lastTime = Math.max(this.#lastTime, this.#now());
    return this.#lastTime;
  }

  #isGeneration(generation) {
    const snapshot = this.#radio.getConnectionSnapshot();
    return snapshot.generation === generation && snapshot.ready;
  }

  #currentScope(current) {
    const snapshot = this.#radio.getConnectionSnapshot();
    if (!current.telemetry) return this.#isGeneration(current.context.generation);
    return this.#telemetryScope(snapshot) && snapshot.generation === current.context.generation
      && snapshot.observerPublicKey.toUpperCase() === current.context.observerPublicKey;
  }

  #arm(current, delay, expire) {
    clearTimeout(current.timer);
    current.deadline = this.#time() + delay;
    current.expire = expire;
    const check = () => {
      if (this.#current !== current || current.phase === 'recovery') return;
      const remaining = current.deadline - this.#time();
      if (remaining <= 0) expire();
      else current.timer = setTimeout(check, remaining);
    };
    current.timer = setTimeout(check, delay);
  }

  #expired(current) {
    if (this.#time() < current.deadline) return false;
    current.expire();
    return true;
  }

  async #dispatch(current, connection, transaction) {
    if (this.#current !== current || current.phase !== 'queued' || this.#expired(current)) return;
    if (transaction.generation !== current.context.generation || transaction.signal.aborted || !this.#currentScope(current)) {
      this.#finish(current, 'failed', 'disconnected');
      return;
    }
    const admission = this.#admissionReason(current);
    if (admission) { this.#finish(current, 'deferred', admission); return; }
    if (current.source && !this.#backgroundAllowed(current)) {
      this.#finish(current, 'deferred', 'background-turn'); return;
    }
    if (current.telemetry) {
      this.#listen(current, connection, transaction);
      if (!await this.#telemetryPreflight(current, connection)) return this.#awaitCommand(current, transaction);
      if (this.#current !== current) return;
      if (current.telemetry.login && current.traceOutcome === 'response') {
        current.phase = 'ready';
        const quietWaitMs = Math.min(this.#limits.responseTimeoutMaxMs, 30000);
        this.#arm(current, quietWaitMs, () => this.#finish(current, 'deferred', 'quiet-air'));
        if (!await this.#waitForTelemetryQuiet(current, quietWaitMs)) return this.#awaitCommand(current, transaction);
        if (this.#current !== current) return;
      }
      current.phase = 'ready';
      this.#arm(current, this.#limits.ackTimeoutMs, () => this.#finish(current, 'deferred', 'queue-timeout'));
    } else if (current.anonymous) {
      this.#listen(current, connection, transaction);
      let resolvePreflight;
      const preflight = new Promise(resolve => { resolvePreflight = resolve; });
      current.resolvePreflight = resolvePreflight;
      current.phase = 'preflight';
      this.#arm(current, this.#preflightTimeoutMs, () => this.#recover(current, 'preflight-timeout', 'preflight-timeout'));
      try {
        Promise.resolve(connection.sendToRadioFrame(prepareRegionContactRead({ targetPublicKey: current.context.targetPublicKey })))
          .catch(() => {
            // A Contact/Err already received is authoritative, even when a
            // late SDK write rejection arrives during the following ACK.
            if (this.#current === current && current.phase === 'preflight') this.#recover(current, 'write-error', 'preflight-write-error');
          });
      } catch { this.#recover(current, 'write-error', 'preflight-write-error'); }
      if (!await preflight) return this.#awaitCommand(current, transaction);
      if (this.#current !== current) return;
      current.phase = 'ready';
      this.#arm(current, this.#limits.ackTimeoutMs, () => this.#finish(current, 'deferred', 'queue-timeout'));
      const afterPreflight = this.#admissionReason(current);
      if (afterPreflight) { this.#finish(current, 'deferred', afterPreflight); return; }
    }
    const attempt = this.#airtime.tryRunWhenQuiet(() => this.#send(current, connection, transaction));
    if (!attempt) { this.#finish(current, 'deferred', 'quiet-air'); return; }
    return attempt;
  }

  #send(current, connection, transaction) {
    if (current.telemetry?.login) {
      return withPreparedTelemetryGuestLogin(current.telemetry.config, { targetPublicKey: current.context.targetPublicKey },
        frame => this.#sendPrepared(current, connection, transaction, frame)).catch(() => {
        if (this.#current === current) this.#finish(current, 'failed', 'credential-unavailable');
      });
    }
    return this.#sendPrepared(current, connection, transaction);
  }

  #sendPrepared(current, connection, transaction, privateFrame) {
    // Airtime's callback is deferred by a microtask. Check again at the
    // physical-send boundary so new priority work or stop cannot slip past.
    if (this.#current !== current || !['queued', 'ready'].includes(current.phase) || this.#expired(current)) return;
    if (transaction.signal.aborted || !this.#currentScope(current)) {
      this.#finish(current, 'failed', 'disconnected'); return;
    }
    const admission = this.#admissionReason(current);
    if (admission) { this.#finish(current, 'deferred', admission); return; }
    try {
      if (!synchronousPermission(current.isEligible, current.descriptor, this.#radio.getConnectionSnapshot())) {
        this.#finish(current, 'deferred', 'ineligible');
        return;
      }
    } catch { this.#finish(current, 'failed', 'eligibility-error'); return; }
    if (this.#current !== current || transaction.signal.aborted || !this.#currentScope(current)) {
      this.#finish(current, 'failed', 'disconnected');
      return;
    }
    // Eligibility is trusted executable policy; recheck priority after it.
    const finalAdmission = this.#admissionReason(current);
    if (finalAdmission) { this.#finish(current, 'deferred', finalAdmission); return; }
    if (this.#current !== current || transaction.signal.aborted || !this.#currentScope(current)) {
      this.#finish(current, 'failed', 'disconnected'); return;
    }
    if (this.#expired(current)) return;
    if (current.telemetry) {
      if (current.telemetry.login) {
        const proof = current.inventory.snapshot({ monotonicNow: this.#now() });
        if (proof.status !== 'complete') { this.#finish(current, 'deferred', proof.reason); return; }
      } else if (!this.#guestSessions.has(current.context.targetPublicKey, current.telemetry.config)) {
        this.#finish(current, 'deferred', 'guest-session-unavailable'); return;
      }
    }
    if (current.source && !this.#backgroundAllowed(current)) { this.#finish(current, 'deferred', 'background-turn'); return; }
    if (current.anonymous || current.telemetry) {
      try {
        // Only literal synchronous permission allows RF. Promises and failed
        // storage reservations cannot accidentally grant permission.
        if (!current.traceReserved && !synchronousPermission(current.reserve, current.context)) {
          this.#finish(current, 'deferred', 'reservation-unavailable'); return;
        }
      } catch { this.#finish(current, 'failed', 'eligibility-error'); return; }
      if (this.#current !== current || transaction.signal.aborted || !this.#currentScope(current)) return;
      const afterReservation = this.#admissionReason(current);
      if (afterReservation) { this.#finish(current, 'deferred', afterReservation); return; }
      if (this.#expired(current)) return;
      if (current.telemetry) {
        try {
          if (!synchronousPermission(current.isEligible, current.descriptor, this.#radio.getConnectionSnapshot())) {
            this.#finish(current, 'deferred', 'ineligible'); return;
          }
        } catch { this.#finish(current, 'failed', 'eligibility-error'); return; }
        if (this.#current !== current || !this.#currentScope(current)) return;
      }
    }
    if (current.telemetry) {
      try {
        const clock = { wall: this.#wallNow(), monotonic: this.#now() };
        assertOwner(ownerSchemas.telemetryOwnerClockSchema, clock);
        current.dispatchClock = clock.wall;
      } catch { this.#finish(current, 'failed', 'clock-anomaly'); return; }
      try {
        const routeEvidence = current.telemetry.hooks.getContactRoute?.(current.context) ?? null;
        if (routeEvidence && typeof routeEvidence.then === 'function') throw new Error('Contact route lookup must be synchronous');
        current.routeFailureReason = routeEvidence?.status === 'unavailable' ? routeEvidence.reason : null;
        current.routeEvidence = routeEvidence?.status === 'available' ? routeEvidence : null;
      } catch {
        // Route evidence is diagnostic here; contact preflight remains the
        // authority for whether a device contact can safely be changed.
        current.routeEvidence = null;
      }
    }
    if (!this.#budget.recordAttempt(current.exchange?.token)) { this.#finish(current, 'deferred', 'rate-limited'); return; }
    if (current.source) this.#background.sent(current.source);
    current.phase = 'ack';
    if (!current.onFrame) this.#listen(current, connection, transaction);
    this.#arm(current, this.#limits.ackTimeoutMs, () => this.#recover(current, 'ack-timeout', 'ack-timeout'));
    try {
      const command = current.prepared?.command;
      if (current.anonymous || current.telemetry) current.dispatchedAt = current.telemetry ? current.dispatchClock : this.#wallNow();
      const write = privateFrame ? connection.sendToRadioFrame(privateFrame)
        : current.anonymous ? connection.sendToRadioFrame(command.frameBytes)
        : connection.sendCommandSendBinaryReq(Array.from(Buffer.from(command.targetPublicKey, 'hex')), command.requestBytes);
      Promise.resolve(write).catch(() => {
        if (this.#current === current && current.phase === 'ack') this.#recover(current, 'write-error', 'write-error');
      });
    } catch { this.#recover(current, 'write-error', 'write-error'); }
    return this.#awaitCommand(current, transaction);
  }

  #listen(current, connection, transaction) {
    current.connection = connection;
    current.signal = transaction.signal;
    current.onAbort = () => {
      if (this.#current === current && current.phase !== 'recovery') this.#finish(current, 'failed', 'disconnected');
    };
    current.onFrame = (bytes) => this.#onFrame(current, bytes);
    transaction.signal.addEventListener('abort', current.onAbort, { once: true });
    connection.on('rx', current.onFrame);
  }

  #awaitCommand(current, transaction) {
    // Recovery may abort the generation before its close promise settles.
    // Release the airtime reservation on that proof of termination, even
    // when the uncertain ACK promise deliberately remains held fail-closed.
    if (transaction.signal.aborted) return;
    let onTerminated;
    const terminated = new Promise(resolve => {
      onTerminated = resolve;
      transaction.signal.addEventListener('abort', onTerminated, { once: true });
    });
    return Promise.race([current.acknowledgement, terminated]).finally(() =>
      transaction.signal.removeEventListener('abort', onTerminated));
  }

  async #waitForTelemetryQuiet(current, timeoutMs) {
    const deadline = this.#time() + timeoutMs;
    while (this.#current === current && this.#time() < deadline) {
      if (current.signal?.aborted || !this.#currentScope(current)) {
        this.#finish(current, 'failed', 'disconnected'); return false;
      }
      const admission = this.#admissionReason(current);
      if (admission === 'rate-limited' && current.exchange) {
        await new Promise(resolve => setTimeout(resolve, 100)); continue;
      }
      if (admission) { this.#finish(current, 'deferred', admission); return false; }
      if (current.source && !this.#backgroundAllowed(current)) {
        this.#finish(current, 'deferred', 'background-turn'); return false;
      }
      if (this.#airtime.canRunWhenQuiet()) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (this.#current === current) this.#finish(current, 'deferred', 'quiet-air');
    return false;
  }

  async #telemetryPreflight(current, connection) {
    current.phase = 'preflight';
    current.preflightStarted = this.#now();
    const timeout = current.telemetry.config.preflightTimeoutMs;
    if (current.telemetry.login) {
      const inventoryTimeout = current.telemetry.config.inventoryTimeoutMs;
      current.preflightKind = 'inventory';
      current.preflightTimeoutMs = inventoryTimeout;
      current.preflightStarted = this.#now();
      this.#logger.info('services.remoteRequests', 'Telemetry contact inventory read started.', {
        requestId: current.context.requestId, operation: current.context.operation,
        generation: current.context.generation, phase: 'preflight', preflightKind: 'inventory',
        timeoutMs: inventoryTimeout
      });
      this.#arm(current, inventoryTimeout, () => this.#recover(current, 'preflight-timeout', 'preflight-timeout'));
      current.inventory = createTelemetryContactInventory({ targetPublicKey: current.context.targetPublicKey,
        radius: current.telemetry.config.radius, startedAt: current.preflightStarted, timeoutMs: inventoryTimeout });
      if (!await this.#readTelemetryContact(current, connection, prepareTelemetryContactInventory())) return false;
      if (this.#current !== current) return false;
      if (current.inventoryProof) {
        try {
          const inferredRoute = current.telemetry.hooks.getContactRoute?.(current.context) ?? null;
          if (inferredRoute && typeof inferredRoute.then === 'function') throw new Error('Contact route lookup must be synchronous');
          current.routeFailureReason = inferredRoute?.status === 'unavailable' ? inferredRoute.reason : null;
          current.routeEvidence = inferredRoute?.status === 'available' ? inferredRoute : null;
          if (current.routeEvidence) {
            // From this point until contact proof completes, any NewAdvert
            // push invalidates the inventory proof and is drained safely.
            current.preflightKind = 'contact-sync';
            const traced = await this.#traceTelemetryRoute(current, connection, current.routeEvidence);
            if (this.#current !== current || current.phase === 'recovery' || current.finishing) return false;
            if (traced.status !== 'completed') {
              if (current.traceDispatchedAt !== undefined) current.dispatchedAt = current.traceDispatchedAt;
              if (['ack-timeout', 'trace-write-error'].includes(traced.reason)) {
                this.#recover(current, traced.reason, traced.reason === 'ack-timeout' ? 'ack-timeout' : 'preflight-write-error');
                return false;
              }
              if (traced.status === 'deferred' || current.dispatchedAt === undefined) {
                this.#finish(current, 'deferred', traced.reason === 'quiet-air' ? 'quiet-air'
                  : traced.reason === 'background-turn' ? 'background-turn'
                    : traced.reason === 'foreground' ? 'foreground'
                      : traced.reason === 'ineligible' ? 'ineligible' : 'reservation-unavailable');
              } else this.#finish(current, 'failed', traced.reason === 'trace-malformed' ? 'trace-malformed'
                : traced.reason === 'command-error' ? 'command-error' : 'trace-timeout',
              traced.reason === 'command-error' ? { errorCode: traced.errorCode, errorReason: traced.errorReason } : {});
              return false;
            }
          }
          current.preflightKind = 'contact-sync';
          const synced = await reconcileTelemetryContact({ connection, targetPublicKey: current.context.targetPublicKey,
            contacts: current.inventoryProof.contacts, route: current.routeEvidence });
          current.contactSyncOutcome = synced.evicted ? 'added-evicted' : synced.status;
          current.contactSyncChanged = synced.status === 'added' || synced.status === 'updated';
          this.#logger[synced.status === 'deferred' ? 'warn' : 'info']('services.remoteRequests',
            synced.status === 'deferred' ? 'Telemetry contact was not changed because no safe fresh route evidence was available.'
              : `Telemetry target contact ${synced.status}.`, { requestId: current.context.requestId,
              operation: current.context.operation, generation: current.context.generation, phase: 'preflight',
              preflightKind: 'contact-sync', outcome: synced.status, hopCount: synced.hopCount ?? null,
              routeReceptionCount: inferredRoute?.receptionCount ?? 0,
              routeEvidenceSource: inferredRoute?.evidenceSource ?? null,
              routeHopWeights: inferredRoute?.hopWeights ?? [],
              routeFailureReason: current.routeFailureReason,
              targetPublicKey: current.context.targetPublicKey,
              targetName: inferredRoute?.target?.name ?? null,
              routeCandidatePath: Array.isArray(inferredRoute?.path) ? inferredRoute.path : [] });
          if (current.inventoryInvalidated) {
            this.#finish(current, 'deferred', 'contacts-changed'); return false;
          }
          if (synced.status === 'deferred') {
            const reason = current.inventoryProof.contact
              ? 'unknown-contact-route' : current.inventoryProof.contactIssue ?? 'contact-missing';
            this.#finish(current, 'deferred', reason); return false;
          }
        } catch {
          current.contactSyncOutcome = 'failed';
          this.#logger.warn('services.remoteRequests', 'Telemetry target contact could not be reconciled; poll deferred without reconnecting.', {
            requestId: current.context.requestId, operation: current.context.operation,
            generation: current.context.generation, phase: 'preflight', preflightKind: 'contact-sync', outcome: 'preflight-failed'
          });
          this.#finish(current, 'deferred', 'preflight-failed'); return false;
        }
      }
    }
    current.phase = 'preflight'; current.preflightKind = 'target';
    current.preflightTimeoutMs = timeout;
    current.preflightStarted = this.#now();
    this.#arm(current, timeout, () => this.#recover(current, 'preflight-timeout', 'preflight-timeout'));
    this.#logger.info('services.remoteRequests', 'Telemetry target contact read started.', {
      requestId: current.context.requestId, operation: current.context.operation,
      generation: current.context.generation, phase: 'preflight', preflightKind: 'target', timeoutMs: timeout
    });
    return this.#readTelemetryContact(current, connection,
      prepareTelemetryContactRead({ targetPublicKey: current.context.targetPublicKey }));
  }

  #readTelemetryContact(current, connection, frame) {
    const token = Symbol('contact-read'); current.readToken = token;
    const completion = new Promise(resolve => { current.resolvePreflight = resolve; });
    try {
      Promise.resolve(connection.sendToRadioFrame(frame)).catch(() => {
        if (this.#current === current && current.phase === 'preflight' && current.readToken === token)
          this.#recover(current, 'write-error', 'preflight-write-error');
      });
    } catch { this.#recover(current, 'write-error', 'preflight-write-error'); }
    return completion;
  }

  #onTelemetryPreflight(current, bytes) {
    const config = current.telemetry.config;
    if (current.preflightKind === 'inventory') {
      const parsed = current.inventory.accept({ bytes, monotonicNow: this.#now() });
      if (parsed.status === 'pending') return;
      if (parsed.status === 'deferred') {
        current.inventoryContactCount = parsed.contactCount;
        current.inventoryOutcome = parsed.reason;
        if (parsed.reason === 'preflight-unsupported') this.#pausedGeneration = current.context.generation;
        // The inventory reducer emits this only for a terminal error response
        // or after the complete, count-checked contact stream reached its end.
        // Ownership is settled, so defer this target without reconnecting.
        this.#logger.warn('services.remoteRequests', 'Telemetry contact inventory completed without a safe target proof; poll deferred.', {
          requestId: current.context.requestId, operation: current.context.operation,
          generation: current.context.generation, phase: 'preflight', preflightKind: 'inventory',
          outcome: parsed.reason, contactCount: parsed.contactCount,
          elapsedMs: Math.max(0, this.#now() - current.preflightStarted), streamComplete: true
        });
        this.#finish(current, 'deferred', parsed.reason); return;
      }
      if (parsed.status === 'complete') {
        current.inventoryProof = parsed;
        current.inventoryContactCount = parsed.contactCount;
        current.inventoryOutcome = 'complete';
        current.preflightKind = 'between';
        current.readToken = null;
        clearTimeout(current.timer);
        this.#logger.info('services.remoteRequests', 'Telemetry contact inventory completed.', {
          requestId: current.context.requestId, operation: current.context.operation,
          generation: current.context.generation, phase: 'preflight', preflightKind: 'inventory',
          contactCount: parsed.contactCount, elapsedMs: Math.max(0, this.#now() - current.preflightStarted),
          streamComplete: true
        });
        current.resolvePreflight(true); return;
      }
      // An invalid/incomplete local stream may still be arriving. Reset
      // ownership before another command can reuse the untagged channel.
      this.#recover(current, parsed.reason, 'preflight-protocol-error'); return;
    }
    if (current.preflightKind === 'between') {
      const parsed = current.inventory.accept({ bytes, monotonicNow: this.#now() });
      if (parsed.status === 'deferred') {
        current.inventoryOutcome = parsed.reason;
        this.#logger.warn('services.remoteRequests', 'Telemetry contact inventory changed before target proof; poll deferred.', {
          requestId: current.context.requestId, operation: current.context.operation,
          generation: current.context.generation, phase: 'preflight', preflightKind: 'inventory',
          outcome: parsed.reason, contactCount: parsed.contactCount, streamComplete: true
        });
        this.#finish(current, 'deferred', parsed.reason);
      } else if (parsed.status !== 'complete' && parsed.status !== 'pending') {
        this.#recover(current, parsed.reason, 'preflight-protocol-error');
      }
      return;
    }
    if (['contact-sync', 'target'].includes(current.preflightKind) && bytes?.[0] === 0x8A) {
      current.inventoryInvalidated = true;
      return;
    }
    const parsed = parseTelemetryContactFrame({ targetPublicKey: current.context.targetPublicKey, bytes, radius: config.radius });
    if (parsed.status === 'ignored') return;
    if (parsed.status === 'malformed') { this.#recover(current, 'protocol-error', 'preflight-protocol-error'); return; }
    if (current.inventoryInvalidated) {
      current.targetContactOutcome = 'contacts-changed';
      this.#logger.warn('services.remoteRequests', 'Telemetry contact inventory changed during target lookup; poll deferred.', {
        requestId: current.context.requestId, operation: current.context.operation,
        generation: current.context.generation, phase: 'preflight', preflightKind: 'target',
        outcome: 'contacts-changed', elapsedMs: Math.max(0, this.#now() - current.preflightStarted)
      });
      this.#finish(current, 'deferred', 'contacts-changed'); return;
    }
    if (parsed.status === 'unavailable') {
      current.targetContactOutcome = parsed.reason;
      if (parsed.reason === 'preflight-unsupported') this.#pausedGeneration = current.context.generation;
      this.#logger.warn('services.remoteRequests', 'Telemetry target contact read did not produce an eligible contact; poll deferred.', {
        requestId: current.context.requestId, operation: current.context.operation,
        generation: current.context.generation, phase: 'preflight', preflightKind: 'target',
        outcome: parsed.reason, timeoutMs: current.preflightTimeoutMs,
        elapsedMs: Math.max(0, this.#now() - current.preflightStarted)
      });
      this.#finish(current, 'deferred', parsed.reason); return;
    }
    if (current.inventoryProof?.contact && !current.contactSyncChanged
      && JSON.stringify(parsed.contact.route) !== JSON.stringify(current.inventoryProof.contact.route)) {
      current.targetContactOutcome = 'contacts-changed';
      this.#logger.warn('services.remoteRequests', 'Telemetry target route changed after inventory proof; poll deferred.', {
        requestId: current.context.requestId, operation: current.context.operation,
        generation: current.context.generation, phase: 'preflight', preflightKind: 'target',
        outcome: 'contacts-changed', elapsedMs: Math.max(0, this.#now() - current.preflightStarted)
      });
      this.#finish(current, 'deferred', 'contacts-changed'); return;
    }
    current.contact = parsed.contact;
    current.targetContactOutcome = 'eligible';
    this.#logger.info('services.remoteRequests', 'Telemetry target contact read completed.', {
      requestId: current.context.requestId, operation: current.context.operation,
      generation: current.context.generation, phase: 'preflight', preflightKind: 'target',
      elapsedMs: Math.max(0, this.#now() - current.preflightStarted), outcome: 'eligible'
    });
    current.readToken = null;
    current.phase = 'ready';
    current.resolvePreflight(true);
  }

  #onGuestFrame(current, bytes) {
    const input = { targetPublicKey: current.context.targetPublicKey, bytes };
    if (current.phase === 'ack') {
      const ack = parseTelemetryLoginAck(input);
      if (ack.status === 'ignored') return;
      if (ack.status === 'malformed') { this.#recover(current, 'protocol-error', 'protocol-error'); return; }
      if (ack.status !== 'sent-proof') {
        // A Sent with the wrong target/route leaves login ownership uncertain.
        if (ack.reason !== 'login-command-error') this.#recover(current, ack.reason, 'protocol-error');
        else this.#finish(current, 'failed', 'command-error', { errorCode: ack.errorCode, errorReason: 'unknown' });
        return;
      }
      current.tag = ack.tag; current.route = ack.route;
      current.phase = 'response';
      this.#arm(current, this.#responseTimeout(current, ack.estimatedTimeoutMs),
        () => this.#finish(current, 'failed', 'response-timeout'));
      current.releaseCommand(); return;
    }
    const parsed = parseTelemetryGuestLogin(input);
    if (parsed.status === 'ignored') return;
    if (parsed.status !== 'guest-proof') { this.#finish(current, 'failed', parsed.reason); return; }
    try {
      const value = current.telemetry.hooks.getReplayHighWater(current.context);
      if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
      const state = { serverTimestamp: value };
      assertOwner(ownerSchemas.telemetryReplayReadSchema, state);
      if (state.serverTimestamp !== null && parsed.serverTimestamp <= state.serverTimestamp) {
        this.#finish(current, 'failed', 'auth-replay'); return;
      }
    } catch { this.#finish(current, 'failed', 'auth-state-unavailable'); return; }
    current.receivedAt = this.#wallNow();
    this.#finish(current, 'completed', null, { proof: Object.freeze(parsed) });
  }

  #onFrame(current, bytes) {
    if (this.#current !== current || current.phase === 'recovery' || current.finishing) return;
    if (current.traceOutcome === 'pending' && bytes?.[0] === Constants.PushCodes.TraceData) return;
    if (!this.#currentScope(current) || current.signal.aborted) {
      this.#finish(current, 'failed', 'disconnected');
      return;
    }
    if (current.telemetry && frameValid({ bytes }) && bytes[0] === 0x8A) {
      this.#clearGuestSessions();
      if (current.phase === 'preflight') {
        if (current.preflightKind === 'target') current.inventoryInvalidated = true;
        else if (current.preflightKind === 'contact-sync') current.inventoryInvalidated = true;
        else this.#onTelemetryPreflight(current, bytes);
      } else if (current.phase === 'ready') this.#finish(current, 'deferred', 'contacts-changed');
      else if (current.phase === 'ack') this.#recover(current, 'contacts-changed', 'protocol-error');
      else this.#finish(current, 'failed', 'contacts-changed');
      return;
    }
    if (current.telemetry && current.phase === 'preflight' && current.preflightKind === 'contact-sync') return;
    if (current.telemetry && frameValid({ bytes }) && bytes[0] === 3 && current.phase !== 'preflight') {
      this.#clearGuestSessions();
      if (current.phase === 'ack') this.#recover(current, 'contacts-changed', 'protocol-error');
      else this.#finish(current, 'failed', 'contacts-changed');
      return;
    }
    if (current.phase === 'ready') return; // Contact complete; RF has not started.
    if (this.#expired(current)) return;
    const frame = { bytes };
    if (current.phase === 'preflight') {
      if (current.telemetry) { this.#onTelemetryPreflight(current, bytes); return; }
      const contact = parseRegionContactFrame({ targetPublicKey: current.context.targetPublicKey, bytes });
      if (contact.status === 'ignored') return;
      if (contact.status === 'malformed') { this.#recover(current, 'protocol-error', 'preflight-protocol-error'); return; }
      if (contact.status === 'unavailable') {
        if (contact.reason === 'preflight-unsupported') this.#pausedGeneration = current.context.generation;
        this.#logger.warn('services.remoteRequests', 'Region contact preflight unavailable; anonymous query deferred without changing contacts or sending RF.', {
          generation: current.context.generation, phase: 'preflight', outcome: contact.reason
        });
        this.#finish(current, 'deferred', contact.reason); return;
      }
      clearTimeout(current.timer);
      // Close the local read immediately, before any producer continuation.
      current.phase = 'ready';
      current.resolvePreflight(true);
      return;
    }
    if (current.telemetry?.login) { this.#onGuestFrame(current, bytes); return; }
    if (!frameValid(frame)) return;
    const parsed = parseRemoteResponseFrame(frame);
    if (parsed.status === 'ignored') return;
    if (parsed.status === 'malformed') {
      if (current.phase === 'ack' && (bytes[0] === 0x06 || bytes[0] === 0x01)) {
        this.#recover(current, 'protocol-error', 'protocol-error');
      } else if (current.phase === 'response' && bytes[0] === 0x8C && binaryHeaderValid(frame)
        && Buffer.from(bytes).readUInt32LE(2) === current.tag) this.#finish(current, 'failed', 'protocol-error');
      return;
    }
    const envelope = parsed.envelope;
    if (current.phase === 'ack') {
      if (envelope.kind === 'error') {
        this.#finish(current, 'failed', 'command-error', { errorCode: envelope.errorCode, errorReason: envelope.reason });
      } else if (envelope.kind === 'sent') {
        current.tag = envelope.tag;
        current.route = envelope.route;
        this.#pruneRetired();
        if (this.#retired.has(envelope.tag)) { this.#finish(current, 'failed', 'retired-tag'); return; }
        if (current.expectedRoute && current.expectedRoute !== envelope.route) {
          this.#finish(current, 'failed', 'route-mismatch'); return;
        }
        current.phase = 'response';
        this.#arm(current, this.#responseTimeout(current, envelope.estimatedTimeoutMs),
          () => this.#finish(current, 'failed', 'response-timeout'));
        current.releaseCommand();
      }
    } else if (envelope.kind === 'binary-response' && envelope.tag === current.tag) {
      if (current.anonymous || current.telemetry) current.receivedAt = this.#wallNow();
      this.#finish(current, 'completed', null, { body: envelope.body, provenance: 'companion-tag-attributed' });
    }
  }

  #pruneRetired() {
    const now = this.#time();
    for (const [tag, expiry] of this.#retired) if (expiry <= now) this.#retired.delete(tag);
  }

  #detach(current) {
    clearTimeout(current.timer);
    current.timer = null;
    this.#radio.off('radio.disconnected', current.onChange);
    this.#radio.off('radio.connected', current.onChange);
    if (current.onFrame) current.connection.off('rx', current.onFrame);
    if (current.onAbort) current.signal.removeEventListener('abort', current.onAbort);
  }

  #finish(current, status, reason, extra = {}, releaseCommand = true) {
    if (this.#current !== current || current.finishing) return;
    current.finishing = true;
    const traceOnlyTerminal = Boolean(current.telemetry?.login && current.traceReserved
      && current.dispatchedAt === undefined && current.traceDispatchedAt !== undefined);
    if (traceOnlyTerminal) current.dispatchedAt = current.traceDispatchedAt;
    if (current.source && current.dispatchedAt === undefined && !['foreground', 'quiet-air', 'rate-limited',
      'background-turn', 'busy'].includes(reason)) this.#background.withdraw(current.source);
    if (current.telemetry) {
      if (current.telemetry.login && current.dispatchedAt !== undefined) {
        this.#guestSessions.retire(current.context.targetPublicKey);
        try {
          const completedAt = this.#wallNow();
          if (status === 'completed' && (!this.#currentScope(current) || this.#stopped)) {
            status = 'failed'; reason = 'guest-session-unavailable';
          }
          if (completedAt < current.dispatchedAt || (current.receivedAt !== undefined
            && (current.receivedAt < current.dispatchedAt || current.receivedAt > completedAt))) {
            status = 'failed'; reason = 'clock-anomaly';
          }
          const record = { context: current.context, dispatchedAt: current.dispatchedAt ?? current.traceDispatchedAt,
            completedAt, status: status === 'completed' ? 'completed' : 'failed',
            reason: status === 'completed' ? null : traceOnlyTerminal ? 'trace-login-not-dispatched'
              : reason ?? 'trace-login-not-dispatched',
            route: current.route, ...(extra.proof ? { proof: extra.proof } : {}) };
          assertOwner(ownerSchemas.telemetryAuthenticationRecordSchema, record);
          if (!synchronousPermission(current.telemetry.hooks.recordAuthentication, Object.freeze(record))) throw new Error('not saved');
          if (status === 'completed' && (!this.#currentScope(current) || this.#stopped
            || !this.#guestSessions.grant(current.context.targetPublicKey, current.telemetry.config))) {
            status = 'failed'; reason = 'guest-session-unavailable';
          }
          if (status === 'completed') this.#watchGuestSessions(current.context);
        } catch { status = 'failed'; reason = 'auth-persistence'; }
      }
      const admissionOnly = status === 'deferred' && ['foreground', 'quiet-air', 'rate-limited', 'background-turn',
        'busy', 'queue-timeout', 'reservation-unavailable', 'ineligible'].includes(reason);
      if (status !== 'completed' && !admissionOnly) this.#guestSessions.revoke(current.context.targetPublicKey);
    }
    this.#detach(current);
    if (current.tag !== null) {
      this.#pruneRetired();
      this.#retired.delete(current.tag);
      this.#retired.set(current.tag, this.#time() + this.#limits.responseTimeoutMaxMs + 60000);
      if (this.#retired.size > 32) this.#retired.delete(this.#retired.keys().next().value);
    }
    this.#current = null;
    if (releaseCommand) current.releaseCommand();
    current.resolvePreflight?.(false);
    if (status !== 'deferred') {
      this.#logger[status === 'completed' ? 'info' : 'warn']('services.remoteRequests',
        status === 'completed' ? 'remote request completed' : 'remote request failed', {
          requestId: current.context.requestId, operation: current.context.operation,
          generation: current.context.generation, phase: current.phase, outcome: reason ?? status,
          ...(current.telemetry ? { targetPublicKey: current.context.targetPublicKey,
            targetName: current.routeEvidence?.target?.name ?? null,
            routeFailureReason: current.routeFailureReason ?? null,
            routeCandidatePath: Array.isArray(current.routeEvidence?.path) ? current.routeEvidence.path : [],
            routeCandidateHopCount: current.routeEvidence?.path?.length ?? null,
            routeHopWeights: current.routeEvidence?.hopWeights ?? [],
            responseTimeoutMs: current.responseTimeoutMs ?? null,
            traceOutcome: current.traceOutcome ?? null,
            tracePathHashes: current.tracePathHashes ?? [], traceSnrQuarterDb: current.traceSnrQuarterDb ?? [],
            traceTimeoutMs: current.traceTimeoutMs ?? null,
            routeEvidenceSource: current.routeEvidence?.evidenceSource ?? null,
            routeReceptionCount: current.routeEvidence?.receptionCount ?? null } : {}),
          ...(current.route ? (current.telemetry ? { dispatchMode: current.route } : { route: current.route }) : {}),
          ...(extra.recovery ? { recovery: extra.recovery } : {})
        });
    }
    current.resolveCompletion({ status, ...(reason ? { reason } : {}), context: current.context,
      ...(current.dispatchedAt !== undefined ? { dispatchedAt: current.dispatchedAt } : {}),
      ...(current.receivedAt !== undefined ? { receivedAt: current.receivedAt } : {}),
      ...(current.tag !== null ? { tag: current.tag, route: current.route } : {}), ...extra,
      ...(current.telemetry ? { diagnostics: { phase: current.phase,
        targetName: current.routeEvidence?.target?.name ?? null,
        routeCandidatePath: Array.isArray(current.routeEvidence?.path) ? current.routeEvidence.path : [],
        routeHopWeights: current.routeEvidence?.hopWeights ?? [],
        responseTimeoutMs: current.responseTimeoutMs ?? null,
        traceOutcome: current.traceOutcome ?? null,
        tracePathHashes: current.tracePathHashes ?? [], traceSnrQuarterDb: current.traceSnrQuarterDb ?? [],
        traceTimeoutMs: current.traceTimeoutMs ?? null,
        routeEvidenceSource: current.routeEvidence?.evidenceSource ?? null,
        routeFailureReason: current.routeFailureReason ?? null,
        routeEvidenceAt: current.routeEvidence?.receivedAt ?? null,
        routeSupportCount: current.routeEvidence?.receptionCount ?? null,
        inventoryContactCount: current.inventoryContactCount, inventoryOutcome: current.inventoryOutcome,
        contactSyncOutcome: current.contactSyncOutcome, targetContactOutcome: current.targetContactOutcome,
        dispatchMode: current.route ?? null } } : {}) });
  }

  #recover(current, reason, invalidationReason) {
    if (this.#current !== current || current.phase === 'recovery') return;
    const phase = current.phase;
    if (phase === 'preflight') this.#pausedGeneration = current.context.generation;
    current.phase = 'recovery';
    this.#detach(current);
    const explanations = {
      'preflight-timeout': 'Region contact read timed out; the captured radio connection is being reset to prevent late local response attribution. Capture may pause during reconnection.',
      'preflight-write-error': 'Region contact read write failed; the captured radio connection is being reset because local response ownership is uncertain. Capture may pause during reconnection.',
      'preflight-protocol-error': 'Region contact read returned an unfamiliar or malformed response; the captured radio connection is being reset to prevent incorrect command attribution. Capture may pause during reconnection.',
      'preflight-cancelled': 'Region contact read stopped before completion; the captured radio connection is being reset because local response ownership is uncertain. Capture may pause during reconnection.',
      'ack-timeout': 'Remote request acknowledgement timed out; the captured radio connection is being reset to prevent incorrect command attribution.',
      'write-error': 'Remote request write failed; the captured radio connection is being reset because acknowledgement ownership is uncertain.',
      'protocol-error': 'Remote request acknowledgement was malformed; the captured radio connection is being reset to prevent incorrect command attribution.',
      'request-cancelled': 'Remote request stopped before acknowledgement; the captured radio connection is being reset because acknowledgement ownership is uncertain.'
    };
    const elapsedMs = current.preflightStarted === undefined ? undefined : Math.max(0, this.#now() - current.preflightStarted);
    const message = current.telemetry && phase === 'preflight'
      ? 'Telemetry contact preflight failed; the radio connection is being reset because response ownership is uncertain.'
      : explanations[invalidationReason];
    this.#logger.warn('services.remoteRequests', message, {
      requestId: current.context.requestId, operation: current.context.operation,
      generation: current.context.generation, phase, outcome: reason, invalidationReason,
      ...(current.telemetry ? { targetPublicKey: current.context.targetPublicKey,
        targetName: current.routeEvidence?.target?.name ?? null,
        routeFailureReason: current.routeFailureReason ?? null,
        routeCandidatePath: Array.isArray(current.routeEvidence?.path) ? current.routeEvidence.path : [],
        routeCandidateHopCount: current.routeEvidence?.path?.length ?? null,
        routeEvidenceSource: current.routeEvidence?.evidenceSource ?? null,
        routeReceptionCount: current.routeEvidence?.receptionCount ?? null } : {}),
      ...(current.telemetry ? { preflightKind: current.preflightKind,
        ...(current.preflightTimeoutMs ? { timeoutMs: current.preflightTimeoutMs } : {}),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}) } : {})
    });
    // T2 retires the generation before the command can settle/reuse the queue.
    Promise.resolve().then(() => this.#radio.invalidateConnection({ generation: current.context.generation,
      reason: invalidationReason })).then((result) => {
      const known = recoveryStatuses.has(result?.status);
      const recovery = known ? result.status : 'failed';
      if (recovery !== 'reset' && recovery !== 'stale-generation') this.#latchRecovery(recovery, current.context.generation);
      this.#finish(current, 'failed', reason, { recovery }, known);
    }, () => {
      this.#latchRecovery('failed', current.context.generation);
      // Without evidence of generation retirement, only RadioManager's
      // eventual abort may release the uncertain command transaction.
      this.#finish(current, 'failed', reason, { recovery: 'failed' }, false);
    });
  }
}
