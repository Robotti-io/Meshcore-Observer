import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { assertRemoteRequest, prepareRemoteRequest } from './remote-request.js';
import { parseRemoteResponseFrame } from './remote-response-parser.js';
import { remoteResponseFrameSchema } from './remote-request-schemas.js';
import { remoteCoordinatorLimitsSchema, remoteDispatchOptionsSchema, remoteBinaryHeaderSchema, remotePreflightLimitsSchema, REMOTE_REQUEST_DEFAULTS } from './remote-coordinator-schemas.js';
import { RemoteRequestBudget } from './remote-request-budget.js';
import { REGION_QUERY_DEFAULTS, regionQueryTargetSchema } from '../regions/region-query-schemas.js';
import { parseRegionContactFrame, prepareRegionContactRead } from '../regions/region-radio-adapter.js';

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
  #airtime;
  #hasForegroundWork;
  #budget;
  #logger;
  #preflightTimeoutMs;
  #wallNow;
  #pausedGeneration = null;

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
  }

  /** Trusted eligibility is executable policy, separate from the DTO.
   * The promise settles once, including deferral. Admission reserves
   * synchronously, so two callers cannot both enqueue a remote operation.
   */
  tryRequest(request, options = {}, isEligible, reserve) {
    assertRemoteRequest(request);
    if (!optionsValid(options)) throw new Error(`Invalid remote dispatch options: ${formatErrors(optionsValid.errors)}`);
    const descriptor = Object.freeze({ ...request, params: Object.freeze({ ...request.params }) });
    const anonymous = descriptor.operation === 'anonymous-regions';
    if (anonymous && options.expectedRoute === 'flood') throw new Error('Anonymous regions require a direct route');
    if (anonymous && (typeof isEligible !== 'function' || typeof reserve !== 'function')) return this.#defer('reservation-unavailable');
    isEligible ??= () => true;
    const expectedRoute = anonymous ? 'direct' : options.expectedRoute;
    if (this.#stopped) return this.#defer('stopped');
    if (this.#recoveryFailed) return this.#defer('recovery-failed');
    // Keep one bounded tombstone until a cancelled shared-queue callback
    // drains. Repeated expiry must not accumulate callbacks behind a hang.
    if (this.#current || this.#commandPending) return this.#defer('busy');
    const snapshot = this.#radio.getConnectionSnapshot();
    if (snapshot.generation === null) return this.#defer('disconnected');
    if (!snapshot.ready) return this.#defer('not-ready');
    if (anonymous && this.#pausedGeneration === snapshot.generation) return this.#defer('preflight-paused');
    if (anonymous && !targetValid({ targetPublicKey: snapshot.observerPublicKey?.toUpperCase() })) return this.#defer('not-ready');
    const admission = this.#admissionReason();
    if (admission) return this.#defer(admission);
    if (!this.#airtime.canRunWhenQuiet()) return this.#defer('quiet-air');
    try { if (!synchronousPermission(isEligible, descriptor, snapshot)) return this.#defer('ineligible'); }
    catch {
      this.#logger.warn('services.remoteRequests', 'remote request eligibility check failed', {
        requestId: descriptor.requestId, operation: descriptor.operation, phase: 'admission', outcome: 'eligibility-error'
      });
      return Promise.resolve({ status: 'failed', reason: 'eligibility-error' });
    }
    if (this.#stopped) return this.#defer('stopped');
    if (this.#current || this.#commandPending) return this.#defer('busy');
    if (!this.#isGeneration(snapshot.generation)) return this.#defer('disconnected');
    const prepared = prepareRemoteRequest(descriptor, anonymous ? undefined : this.#uniquenessBytes());
    let resolveCompletion;
    let releaseCommand;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const acknowledgement = new Promise((resolve) => { releaseCommand = resolve; });
    const context = Object.freeze({ requestId: descriptor.requestId, targetPublicKey: descriptor.targetPublicKey,
      operation: descriptor.operation, params: descriptor.params,
      generation: snapshot.generation, observerPublicKey: anonymous ? snapshot.observerPublicKey.toUpperCase() : snapshot.observerPublicKey });
    const current = { descriptor, expectedRoute, isEligible, reserve, anonymous, prepared, context,
      phase: 'queued', tag: null, route: null, timer: null, deadline: null, expire: null,
      connection: null, signal: null, onAbort: null, onFrame: null, resolveCompletion,
      releaseCommand, acknowledgement, completion, onChange: null };
    this.#current = current;
    current.onChange = () => {
      if (current.phase !== 'recovery' && !this.#isGeneration(current.context.generation)) this.#finish(current, 'failed', 'disconnected');
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
    const current = this.#current;
    if (!current) return Promise.resolve();
    if (current.phase === 'preflight') this.#recover(current, 'stopped', 'preflight-cancelled');
    else if (current.phase === 'ack') this.#recover(current, 'stopped', 'request-cancelled');
    else if (current.phase !== 'recovery') this.#finish(current, 'failed', 'stopped');
    return current.completion.then(() => undefined);
  }

  #defer(reason) { return Promise.resolve({ status: 'deferred', reason }); }

  #admissionReason() {
    try { if (this.#hasForegroundWork() !== false) return 'foreground'; }
    catch { return 'foreground'; } // Unknown priority state defers without RF/log storms.
    return this.#budget.canAttempt() ? null : 'rate-limited';
  }

  #time() {
    this.#lastTime = Math.max(this.#lastTime, this.#now());
    return this.#lastTime;
  }

  #isGeneration(generation) {
    const snapshot = this.#radio.getConnectionSnapshot();
    return snapshot.generation === generation && snapshot.ready;
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
    if (transaction.generation !== current.context.generation || transaction.signal.aborted || !this.#isGeneration(current.context.generation)) {
      this.#finish(current, 'failed', 'disconnected');
      return;
    }
    const admission = this.#admissionReason();
    if (admission) { this.#finish(current, 'deferred', admission); return; }
    if (current.anonymous) {
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
      const afterPreflight = this.#admissionReason();
      if (afterPreflight) { this.#finish(current, 'deferred', afterPreflight); return; }
    }
    const attempt = this.#airtime.tryRunWhenQuiet(() => this.#send(current, connection, transaction));
    if (!attempt) { this.#finish(current, 'deferred', 'quiet-air'); return; }
    return attempt;
  }

  #send(current, connection, transaction) {
    // Airtime's callback is deferred by a microtask. Check again at the
    // physical-send boundary so new priority work or stop cannot slip past.
    if (this.#current !== current || !['queued', 'ready'].includes(current.phase) || this.#expired(current)) return;
    if (transaction.signal.aborted || !this.#isGeneration(current.context.generation)) {
      this.#finish(current, 'failed', 'disconnected'); return;
    }
    const admission = this.#admissionReason();
    if (admission) { this.#finish(current, 'deferred', admission); return; }
    try {
      if (!synchronousPermission(current.isEligible, current.descriptor, this.#radio.getConnectionSnapshot())) {
        this.#finish(current, 'deferred', 'ineligible');
        return;
      }
    } catch { this.#finish(current, 'failed', 'eligibility-error'); return; }
    if (this.#current !== current || transaction.signal.aborted || !this.#isGeneration(current.context.generation)) {
      this.#finish(current, 'failed', 'disconnected');
      return;
    }
    // Eligibility is trusted executable policy; recheck priority after it.
    const finalAdmission = this.#admissionReason();
    if (finalAdmission) { this.#finish(current, 'deferred', finalAdmission); return; }
    if (this.#current !== current || transaction.signal.aborted || !this.#isGeneration(current.context.generation)) {
      this.#finish(current, 'failed', 'disconnected'); return;
    }
    if (this.#expired(current)) return;
    if (current.anonymous) {
      try {
        // Only literal synchronous permission allows RF. Promises and failed
        // storage reservations cannot accidentally grant permission.
        if (!synchronousPermission(current.reserve, current.context)) { this.#finish(current, 'deferred', 'reservation-unavailable'); return; }
      } catch { this.#finish(current, 'failed', 'eligibility-error'); return; }
      if (this.#current !== current || transaction.signal.aborted || !this.#isGeneration(current.context.generation)) return;
      const afterReservation = this.#admissionReason();
      if (afterReservation) { this.#finish(current, 'deferred', afterReservation); return; }
      if (this.#expired(current)) return;
    }
    if (!this.#budget.recordAttempt()) { this.#finish(current, 'deferred', 'rate-limited'); return; }
    current.phase = 'ack';
    if (!current.onFrame) this.#listen(current, connection, transaction);
    this.#arm(current, this.#limits.ackTimeoutMs, () => this.#recover(current, 'ack-timeout', 'ack-timeout'));
    try {
      const command = current.prepared.command;
      if (current.anonymous) current.dispatchedAt = this.#wallNow();
      const write = current.anonymous ? connection.sendToRadioFrame(command.frameBytes)
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

  #onFrame(current, bytes) {
    if (this.#current !== current || current.phase === 'recovery') return;
    if (!this.#isGeneration(current.context.generation) || current.signal.aborted) {
      this.#finish(current, 'failed', 'disconnected');
      return;
    }
    if (current.phase === 'ready') return; // Contact complete; RF has not started.
    if (this.#expired(current)) return;
    const frame = { bytes };
    if (current.phase === 'preflight') {
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
        this.#arm(current, Math.min(this.#limits.responseTimeoutMaxMs,
          Math.max(1000, envelope.estimatedTimeoutMs + 1000)), () => this.#finish(current, 'failed', 'response-timeout'));
        current.releaseCommand();
      }
    } else if (envelope.kind === 'binary-response' && envelope.tag === current.tag) {
      if (current.anonymous) current.receivedAt = this.#wallNow();
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
    if (this.#current !== current) return;
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
          ...(current.route ? { route: current.route } : {}),
          ...(extra.recovery ? { recovery: extra.recovery } : {})
        });
    }
    current.resolveCompletion({ status, ...(reason ? { reason } : {}), context: current.context,
      ...(current.dispatchedAt !== undefined ? { dispatchedAt: current.dispatchedAt } : {}),
      ...(current.receivedAt !== undefined ? { receivedAt: current.receivedAt } : {}),
      ...(current.tag !== null ? { tag: current.tag, route: current.route } : {}), ...extra });
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
    this.#logger.warn('services.remoteRequests', explanations[invalidationReason], {
      requestId: current.context.requestId, operation: current.context.operation,
      generation: current.context.generation, phase, outcome: reason
    });
    // T2 retires the generation before the command can settle/reuse the queue.
    Promise.resolve().then(() => this.#radio.invalidateConnection({ generation: current.context.generation,
      reason: invalidationReason })).then((result) => {
      const known = recoveryStatuses.has(result?.status);
      const recovery = known ? result.status : 'failed';
      this.#recoveryFailed = recovery !== 'reset' && recovery !== 'stale-generation';
      this.#finish(current, 'failed', reason, { recovery }, known);
    }, () => {
      this.#recoveryFailed = true;
      // Without evidence of generation retirement, only RadioManager's
      // eventual abort may release the uncertain command transaction.
      this.#finish(current, 'failed', reason, { recovery: 'failed' }, false);
    });
  }
}
