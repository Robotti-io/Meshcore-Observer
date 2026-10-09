import { EventEmitter } from 'node:events';
import { BufferUtils, Constants } from '@liamcottle/meshcore.js';
import { CommandQueue } from './command-queue.js';
import { computeBackoffDelay } from './backoff.js';
import { syncDeviceClock } from './clock-sync.js';
import { openSerialConnection } from './transports/serial-transport.js';
import { openTcpConnection } from './transports/tcp-transport.js';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { radioCommandOptionsSchema, radioInvalidationSchema, radioLifecycleOptionsSchema } from './lifecycle-schemas.js';
import { RadioConnectionError, closeConnection, waitForSettlement } from './connection-lifecycle.js';

const HANDSHAKE_TIMEOUT_MS = 5000;
const commandOptionsValid = compileSchema(radioCommandOptionsSchema);
const invalidationValid = compileSchema(radioInvalidationSchema);
const lifecycleOptionsValid = compileSchema(radioLifecycleOptionsSchema);

async function defaultOpenTransport(radioConfig, logger) {
  if (radioConfig.type === 'tcp') {
    return openTcpConnection({ host: radioConfig.tcpHost, port: radioConfig.tcpPort, logger });
  }
  return openSerialConnection({ serialPorts: radioConfig.serialPorts, logger });
}

function normalizeSelfInfo(selfInfo) {
  return {
    publicKey: BufferUtils.bytesToHex(selfInfo.publicKey),
    name: selfInfo.name,
    model: null,
    firmwareVersion: null,
    radio: {
      frequency: selfInfo.radioFreq,
      bandwidth: selfInfo.radioBw,
      spreadingFactor: selfInfo.radioSf,
      codingRate: selfInfo.radioCr,
      txPower: selfInfo.txPower,
      maxTxPower: selfInfo.maxTxPower
    }
  };
}

/**
 * Owns the lifecycle of the Companion connection: establishing the
 * configured transport, performing the handshake, detecting disconnection,
 * reconnecting with backoff, and emitting normalized application events
 * (radio.connected, radio.disconnected, radio.packet, radio.channelMessage,
 * radio.error) so the rest of the app never touches meshcore.js internals
 * directly.
 */
export class RadioManager extends EventEmitter {
  #config;
  #logger;
  #commandQueue;
  #openTransport;
  #session = null;
  #deviceInfo = null;
  #running = false;
  #retryTimer = null;
  #attempt = 0;
  #generation = 0;
  #epoch = 0;
  #connecting = null;
  #closing = null;
  #unsafeClose = null;
  #stopPromise = null;
  #stopping = false;
  #closeTimeoutMs;

  constructor({ config, logger, commandQueue = new CommandQueue(), openTransport = defaultOpenTransport,
    closeTimeoutMs = HANDSHAKE_TIMEOUT_MS }) {
    super();
    if (!lifecycleOptionsValid({ closeTimeoutMs })) {
      throw new Error(`Invalid radio lifecycle options: ${formatErrors(lifecycleOptionsValid.errors)}`);
    }
    this.#config = config;
    this.#logger = logger;
    this.#commandQueue = commandQueue;
    this.#openTransport = openTransport;
    this.#closeTimeoutMs = closeTimeoutMs;
  }

  start() {
    if (this.#running || this.#stopping || this.#unsafeClose) {
      return;
    }
    this.#running = true;
    this.#epoch += 1;
    this.#stopPromise = null;
    this.#attempt = 0;
    this.#attemptConnect();
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#running = false;
    this.#stopping = true;
    this.#epoch += 1;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    const session = this.#session;
    if (session) this.#retire(session, 'stopped');
    this.#stopPromise = Promise.resolve().then(async () => {
      if (session) await this.#closeSession(session);
      if (this.#closing) await this.#closing;
      if (this.#connecting && !await waitForSettlement(this.#connecting, this.#closeTimeoutMs)) {
        this.#failClosed('open-timeout');
      }
      if (this.#unsafeClose) throw new RadioConnectionError(this.#unsafeClose);
    }).finally(() => { this.#stopping = false; });
    return this.#stopPromise;
  }

  isConnected() {
    return Boolean(this.#session?.deviceInfo);
  }

  getDeviceInfo() {
    return this.#deviceInfo;
  }

  /** Internal immutable admission snapshot; never added to public status DTOs. */
  getConnectionSnapshot() {
    return Object.freeze({ generation: this.#session?.id ?? null,
      ready: this.#session?.ready ?? false, observerPublicKey: this.#session?.deviceInfo?.publicKey ?? null });
  }

  /**
   * Runs a device command through the shared command queue. All Companion
   * command traffic (channel operations, signing, stats, etc.) from every
   * module must go through this method rather than calling the connection
   * directly, so exactly one command transaction is ever in flight.
   *
   * @param {(connection: object, context: {generation: number, signal: AbortSignal}) => Promise<any>} fn
   */
  runCommand(fn, options = {}) {
    if (!commandOptionsValid(options)) {
      return Promise.reject(new Error(`Invalid radio command options: ${formatErrors(commandOptionsValid.errors)}`));
    }
    const session = this.#session;
    if (!session?.deviceInfo) return Promise.reject(new RadioConnectionError('not-connected'));
    if (options.generation !== undefined && options.generation !== session.id) {
      return Promise.reject(new RadioConnectionError('stale-generation'));
    }
    if (options.requireReady && !session.ready) return Promise.reject(new RadioConnectionError('not-ready'));
    return this.#queueCommand(session, fn, options.requireReady ?? false);
  }

  async invalidateConnection(request) {
    if (!invalidationValid(request)) {
      throw new Error(`Invalid radio invalidation: ${formatErrors(invalidationValid.errors)}`);
    }
    const session = this.#session;
    if (!session || session.id !== request.generation) return { status: 'stale-generation' };
    const explanations = {
      'ack-timeout': 'Remote request acknowledgement timed out; the radio connection is being reset to prevent a late acknowledgement from being assigned to another command.',
      'write-error': 'Remote request write failed; the radio connection is being reset because command acknowledgement ownership is uncertain.',
      'protocol-error': 'Remote request acknowledgement was malformed; the radio connection is being reset to prevent incorrect command attribution.'
    };
    this.#logger.warn('services.radio', explanations[request.reason], {
      generation: session.id, reason: request.reason
    });
    this.#retire(session, 'invalidated');
    const status = await this.#closeSession(session);
    if (status === 'closed') this.#scheduleRetry();
    return { status: status === 'closed' ? 'reset' : status };
  }

  #isCurrent(session) {
    return this.#running && this.#session === session && !session.controller.signal.aborted;
  }

  #assertCurrent(session) {
    if (!this.#isCurrent(session)) throw session.controller.signal.reason ?? new RadioConnectionError('stale-generation');
  }

  #queueCommand(session, fn, requireReady = false) {
    return this.#commandQueue.run(() => {
      this.#assertCurrent(session);
      if (requireReady && !session.ready) throw new RadioConnectionError('not-ready');
      const signal = session.controller.signal;
      let onAbort;
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const operation = Promise.resolve().then(() => {
        this.#assertCurrent(session);
        return fn(session.connection, session.context);
      });
      return Promise.race([operation, cancelled]).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  #retire(session, reason) {
    if (session.controller.signal.aborted) return;
    const current = this.#session === session;
    if (current) this.#session = null;
    session.ready = false;
    session.controller.abort(new RadioConnectionError(reason));
    for (const [event, handler] of session.listeners) session.connection.off(event, handler);
    session.listeners.length = 0;
    if (current && session.deviceInfo && reason !== 'stopped') {
      this.#logger.warn('services.radio', 'radio disconnected');
      this.emit('radio.disconnected');
    }
  }

  #failClosed(code, generation) {
    if (this.#unsafeClose) return;
    this.#unsafeClose = code;
    this.#running = false;
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = null; }
    const message = new RadioConnectionError(code).message;
    this.#logger.error('services.radio', message, { code, ...(generation === undefined ? {} : { generation }) });
    this.emit('radio.error', { phase: 'connect', fatal: true, message });
  }

  #closeSession(session) {
    if (session.closePromise) return session.closePromise;
    if (session.disconnected) return Promise.resolve('closed');
    session.closePromise = closeConnection(session.connection, this.#closeTimeoutMs, session.disconnectedEvidence).then((status) => {
      if (status !== 'closed') this.#failClosed(status, session.id);
      return status;
    });
    const closing = session.closePromise;
    this.#closing = closing;
    closing.then(() => { if (this.#closing === closing) this.#closing = null; });
    return closing;
  }

  #attemptConnect() {
    if (!this.#running || this.#connecting || this.#session || this.#closing || this.#unsafeClose) return;
    const connecting = this.#connect(this.#epoch);
    this.#connecting = connecting;
    connecting.then((outcome) => {
      if (this.#connecting === connecting) this.#connecting = null;
      if (!this.#running || this.#session || this.#closing || this.#unsafeClose || this.#retryTimer) return;
      if (outcome === 'disconnected') this.#attemptConnect();
      else this.#scheduleRetry();
    });
  }

  async #connect(epoch) {
    let connection;
    let session;
    try {
      connection = await this.#openTransport(this.#config.radio, this.#logger);
      const controller = new AbortController();
      let confirmDisconnected;
      const disconnectedEvidence = new Promise((resolve) => { confirmDisconnected = resolve; });
      session = { id: ++this.#generation, connection, controller, ready: false, deviceInfo: null,
        disconnected: false, disconnectedEvidence, confirmDisconnected, closePromise: null, listeners: [],
        context: Object.freeze({ generation: this.#generation, signal: controller.signal }) };
      if (!this.#running || epoch !== this.#epoch || this.#unsafeClose) {
        await this.#closeSession(session);
        return 'stopped';
      }
      this.#session = session;
      this.#wireConnection(session);
      const selfInfo = await this.#queueCommand(session, () => connection.getSelfInfo(HANDSHAKE_TIMEOUT_MS));
      this.#assertCurrent(session);
      session.deviceInfo = normalizeSelfInfo(selfInfo);
      this.#deviceInfo = session.deviceInfo;
      this.#attempt = 0;

      await syncDeviceClock({ connection, commandQueue: { run: (fn) => this.#queueCommand(session, fn) }, logger: this.#logger });
      this.#assertCurrent(session);
      await this.#fetchDeviceQuery(session);
      this.#assertCurrent(session);

      session.ready = true;
      this.#logger.info('services.radio', 'radio connected', { publicKey: this.#deviceInfo.publicKey });
      this.emit('radio.connected', this.#deviceInfo);
      return session.disconnected ? 'disconnected' : 'connected';
    } catch (err) {
      if (session) {
        this.#retire(session, 'connect-failed');
        await this.#closeSession(session);
        if (session.disconnected) return 'disconnected';
      }
      if (!this.#running || epoch !== this.#epoch) return 'stopped';
      this.#logger.warn('services.radio', 'radio connect attempt failed', { error: err.message });
      this.emit('radio.error', { phase: 'connect', message: err.message });
      return 'retry';
    }
  }

  /**
   * Best-effort device/firmware query for the MQTT status payload's
   * model/firmware_version fields. Failure is non-fatal, matching clock
   * sync's tolerance for older/unresponsive firmware.
   */
  async #fetchDeviceQuery(session) {
    try {
      const deviceInfoResponse = await this.#queueCommand(session, () =>
        session.connection.deviceQuery(Constants.SupportedCompanionProtocolVersion)
      );
      this.#assertCurrent(session);
      // manufacturerModel is documented as "remainder of frame" - on real
      // firmware this includes trailing null-padding and an extra packed
      // git-describe string after the model name (confirmed live), so only
      // the text up to the first null byte is the actual model name.
      session.deviceInfo.model = deviceInfoResponse.manufacturerModel
        ? deviceInfoResponse.manufacturerModel.split('\0')[0].trim() || null
        : null;
      session.deviceInfo.firmwareVersion = deviceInfoResponse.firmware_build_date
        ? `${deviceInfoResponse.firmwareVer} (${deviceInfoResponse.firmware_build_date})`
        : String(deviceInfoResponse.firmwareVer ?? '');
    } catch (err) {
      if (!this.#isCurrent(session)) throw err;
      this.#logger.warn('services.radio', 'device query failed', { error: err.message });
    }
  }

  #scheduleRetry() {
    if (!this.#running || this.#retryTimer || this.#unsafeClose) {
      return;
    }

    this.#attempt += 1;
    const { maxRetries, initialDelayMs, maxDelayMs } = this.#config.radio.reconnect;

    if (maxRetries !== 0 && this.#attempt > maxRetries) {
      this.#logger.error('services.radio', 'max connection retries exceeded, giving up', {
        attempts: this.#attempt - 1
      });
      this.emit('radio.error', { phase: 'connect', fatal: true, message: 'max connection retries exceeded' });
      this.#running = false;
      return;
    }

    const delayMs = computeBackoffDelay(this.#attempt, initialDelayMs, maxDelayMs);
    this.#logger.debug('services.radio', 'scheduling reconnect attempt', {
      attempt: this.#attempt,
      delayMs
    });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#attemptConnect();
    }, delayMs);
  }

  #wireConnection(session) {
    const listen = (event, handler) => {
      session.listeners.push([event, handler]);
      session.connection.on(event, handler);
    };
    listen('disconnected', () => {
      session.disconnected = true;
      session.confirmDisconnected();
      if (!this.#isCurrent(session)) return;
      this.#retire(session, 'disconnected');
      this.#attempt = 0;
      this.#attemptConnect();
    });

    // LogRxData (not RawData) is what Companion firmware actually emits for
    // general received-packet capture, confirmed empirically against a real
    // device - RawData never fired even with confirmed live RF traffic.
    listen(Constants.PushCodes.LogRxData, (logRxData) => {
      if (this.#isCurrent(session) && session.deviceInfo) this.emit('radio.packet', logRxData);
    });
    listen(Constants.ResponseCodes.ChannelMsgRecv, (message) => {
      if (this.#isCurrent(session) && session.deviceInfo) this.emit('radio.channelMessage', message);
    });
  }
}
