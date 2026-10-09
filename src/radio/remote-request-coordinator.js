import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { assertRemoteRequest, prepareRemoteRequest } from './remote-request.js';
import { parseRemoteResponseFrame } from './remote-response-parser.js';
import { remoteResponseFrameSchema } from './remote-request-schemas.js';
import { remoteCoordinatorLimitsSchema, remoteDispatchOptionsSchema, remoteBinaryHeaderSchema, REMOTE_REQUEST_DEFAULTS } from './remote-coordinator-schemas.js';
import { RemoteRequestBudget } from './remote-request-budget.js';

const limitsValid = compileSchema(remoteCoordinatorLimitsSchema);
const optionsValid = compileSchema(remoteDispatchOptionsSchema);
const frameValid = compileSchema(remoteResponseFrameSchema);
const binaryHeaderValid = compileSchema(remoteBinaryHeaderSchema);
const recoveryStatuses = new Set(['reset', 'stale-generation', 'close-failed', 'close-timeout']);

/** One remote lease, separate from the command queue's short ACK transaction.
 * No polls, automatic retries, contacts or storage ownership here.
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

  constructor({ radio, airtimeCoordinator, hasForegroundWork, logger,
    ackTimeoutMs = REMOTE_REQUEST_DEFAULTS.ackTimeoutMs,
    responseTimeoutMaxMs = REMOTE_REQUEST_DEFAULTS.responseTimeoutMaxMs,
    minIntervalMs = REMOTE_REQUEST_DEFAULTS.minIntervalMs, maxPerMinute = REMOTE_REQUEST_DEFAULTS.maxPerMinute,
    now = () => performance.now(), uniquenessBytes = () => Array.from(randomBytes(4)), budget }) {
    const limits = { ackTimeoutMs, responseTimeoutMaxMs, minIntervalMs, maxPerMinute };
    if (!limitsValid(limits)) throw new Error(`Invalid remote request limits: ${formatErrors(limitsValid.errors)}`);
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
    // The injectable policy isolates ownership tests. Runtime always creates
    // the validated bounded budget here; producer DTOs cannot replace it.
    this.#budget = budget ?? new RemoteRequestBudget({ minIntervalMs, maxPerMinute, now: () => this.#time() });
  }

  /** Trusted eligibility is executable policy, separate from the DTO.
   * The promise settles once, including deferral. Admission reserves
   * synchronously, so two callers cannot both enqueue a remote operation.
   */
  tryRequest(request, options = {}, isEligible = () => true) {
    assertRemoteRequest(request);
    if (!optionsValid(options)) throw new Error(`Invalid remote dispatch options: ${formatErrors(optionsValid.errors)}`);
    const descriptor = Object.freeze({ ...request, params: Object.freeze({ ...request.params }) });
    const expectedRoute = options.expectedRoute;
    if (descriptor.operation === 'anonymous-regions') {
      return Promise.resolve({ status: 'unsupported', reason: 'anonymous-adapter-unavailable' });
    }
    if (this.#stopped) return this.#defer('stopped');
    if (this.#recoveryFailed) return this.#defer('recovery-failed');
    // Keep one bounded tombstone until a cancelled shared-queue callback
    // drains. Repeated expiry must not accumulate callbacks behind a hang.
    if (this.#current || this.#commandPending) return this.#defer('busy');
    const snapshot = this.#radio.getConnectionSnapshot();
    if (snapshot.generation === null) return this.#defer('disconnected');
    if (!snapshot.ready) return this.#defer('not-ready');
    const admission = this.#admissionReason();
    if (admission) return this.#defer(admission);
    if (!this.#airtime.canRunWhenQuiet()) return this.#defer('quiet-air');
    try { if (isEligible(descriptor, snapshot) !== true) return this.#defer('ineligible'); }
    catch {
      this.#logger.warn('services.remoteRequests', 'remote request eligibility check failed', {
        requestId: descriptor.requestId, operation: descriptor.operation, phase: 'admission', outcome: 'eligibility-error'
      });
      return Promise.resolve({ status: 'failed', reason: 'eligibility-error' });
    }
    if (this.#stopped) return this.#defer('stopped');
    if (this.#current || this.#commandPending) return this.#defer('busy');
    if (!this.#isGeneration(snapshot.generation)) return this.#defer('disconnected');
    const prepared = prepareRemoteRequest(descriptor, this.#uniquenessBytes());
    let resolveCompletion;
    let releaseCommand;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const acknowledgement = new Promise((resolve) => { releaseCommand = resolve; });
    const context = Object.freeze({ requestId: descriptor.requestId, targetPublicKey: descriptor.targetPublicKey,
      operation: descriptor.operation, params: descriptor.params,
      generation: snapshot.generation, observerPublicKey: snapshot.observerPublicKey });
    const current = { descriptor, expectedRoute, isEligible, prepared, context,
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
    if (current.phase === 'ack') this.#recover(current, 'stopped', 'request-cancelled');
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

  #dispatch(current, connection, transaction) {
    if (this.#current !== current || current.phase !== 'queued' || this.#expired(current)) return;
    if (transaction.generation !== current.context.generation || transaction.signal.aborted || !this.#isGeneration(current.context.generation)) {
      this.#finish(current, 'failed', 'disconnected');
      return;
    }
    const admission = this.#admissionReason();
    if (admission) { this.#finish(current, 'deferred', admission); return; }
    const attempt = this.#airtime.tryRunWhenQuiet(() => this.#send(current, connection, transaction));
    if (!attempt) { this.#finish(current, 'deferred', 'quiet-air'); return; }
    return attempt;
  }

  #send(current, connection, transaction) {
    // Airtime's callback is deferred by a microtask. Check again at the
    // physical-send boundary so new priority work or stop cannot slip past.
    if (this.#current !== current || current.phase !== 'queued' || this.#expired(current)) return;
    if (transaction.signal.aborted || !this.#isGeneration(current.context.generation)) {
      this.#finish(current, 'failed', 'disconnected'); return;
    }
    const admission = this.#admissionReason();
    if (admission) { this.#finish(current, 'deferred', admission); return; }
    try {
      if (current.isEligible(current.descriptor, this.#radio.getConnectionSnapshot()) !== true) {
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
    if (!this.#budget.recordAttempt()) { this.#finish(current, 'deferred', 'rate-limited'); return; }
    current.phase = 'ack';
    current.connection = connection;
    current.signal = transaction.signal;
    current.onAbort = () => {
      if (this.#current === current && current.phase !== 'recovery') this.#finish(current, 'failed', 'disconnected');
    };
    current.onFrame = (bytes) => this.#onFrame(current, bytes);
    transaction.signal.addEventListener('abort', current.onAbort, { once: true });
    connection.on('rx', current.onFrame);
    this.#arm(current, this.#limits.ackTimeoutMs, () => this.#recover(current, 'ack-timeout', 'ack-timeout'));
    try {
      const command = current.prepared.command;
      // Sent/Err is authoritative even if the SDK write promise is late.
      // Observe rejection without holding the command queue for an RF reply.
      Promise.resolve(connection.sendCommandSendBinaryReq(Array.from(Buffer.from(command.targetPublicKey, 'hex')),
        command.requestBytes)).catch(() => {
        if (this.#current === current && current.phase === 'ack') this.#recover(current, 'write-error', 'write-error');
      });
    } catch { this.#recover(current, 'write-error', 'write-error'); }
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
    if (this.#expired(current)) return;
    const frame = { bytes };
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
      ...(current.tag !== null ? { tag: current.tag, route: current.route } : {}), ...extra });
  }

  #recover(current, reason, invalidationReason) {
    if (this.#current !== current || current.phase === 'recovery') return;
    current.phase = 'recovery';
    this.#detach(current);
    const explanations = {
      'ack-timeout': 'Remote request acknowledgement timed out; the captured radio connection is being reset to prevent incorrect command attribution.',
      'write-error': 'Remote request write failed; the captured radio connection is being reset because acknowledgement ownership is uncertain.',
      'protocol-error': 'Remote request acknowledgement was malformed; the captured radio connection is being reset to prevent incorrect command attribution.',
      'request-cancelled': 'Remote request stopped before acknowledgement; the captured radio connection is being reset because acknowledgement ownership is uncertain.'
    };
    this.#logger.warn('services.remoteRequests', explanations[invalidationReason], {
      requestId: current.context.requestId, operation: current.context.operation,
      generation: current.context.generation, phase: 'ack', outcome: reason
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
