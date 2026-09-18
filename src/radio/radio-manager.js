import { EventEmitter } from 'node:events';
import { BufferUtils, Constants } from '@liamcottle/meshcore.js';
import { CommandQueue } from './command-queue.js';
import { computeBackoffDelay } from './backoff.js';
import { syncDeviceClock } from './clock-sync.js';
import { openSerialConnection } from './transports/serial-transport.js';
import { openTcpConnection } from './transports/tcp-transport.js';

const HANDSHAKE_TIMEOUT_MS = 5000;

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
  #connection = null;
  #deviceInfo = null;
  #running = false;
  #retryTimer = null;
  #attempt = 0;

  constructor({ config, logger, commandQueue = new CommandQueue(), openTransport = defaultOpenTransport }) {
    super();
    this.#config = config;
    this.#logger = logger;
    this.#commandQueue = commandQueue;
    this.#openTransport = openTransport;
  }

  start() {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#attempt = 0;
    this.#attemptConnect();
  }

  async stop() {
    this.#running = false;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    const connection = this.#connection;
    this.#connection = null;
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        this.#logger.warn('services.radio', 'error closing radio connection during shutdown', {
          error: err.message
        });
      }
    }
  }

  isConnected() {
    return this.#connection !== null;
  }

  getDeviceInfo() {
    return this.#deviceInfo;
  }

  /**
   * Runs a device command through the shared command queue. All Companion
   * command traffic (channel operations, signing, stats, etc.) from every
   * module must go through this method rather than calling the connection
   * directly, so exactly one command transaction is ever in flight.
   *
   * @param {(connection: object) => Promise<any>} fn
   */
  runCommand(fn) {
    if (!this.#connection) {
      return Promise.reject(new Error('radio is not connected'));
    }
    const connection = this.#connection;
    return this.#commandQueue.run(() => fn(connection));
  }

  async #attemptConnect() {
    if (!this.#running) {
      return;
    }

    let connection;
    try {
      connection = await this.#openTransport(this.#config.radio, this.#logger);
      const selfInfo = await this.#commandQueue.run(() => connection.getSelfInfo(HANDSHAKE_TIMEOUT_MS));

      if (!this.#running) {
        await connection.close();
        return;
      }

      this.#connection = connection;
      this.#deviceInfo = normalizeSelfInfo(selfInfo);
      this.#attempt = 0;
      this.#wireConnection(connection);

      await syncDeviceClock({ connection, commandQueue: this.#commandQueue, logger: this.#logger });
      await this.#fetchDeviceQuery(connection);

      this.#logger.info('services.radio', 'radio connected', { publicKey: this.#deviceInfo.publicKey });
      this.emit('radio.connected', this.#deviceInfo);
    } catch (err) {
      if (connection) {
        try {
          await connection.close();
        } catch {
          // already unusable; nothing to clean up
        }
      }
      this.#logger.warn('services.radio', 'radio connect attempt failed', { error: err.message });
      this.emit('radio.error', { phase: 'connect', message: err.message });
      this.#scheduleRetry();
    }
  }

  /**
   * Best-effort device/firmware query for the MQTT status payload's
   * model/firmware_version fields. Failure is non-fatal, matching clock
   * sync's tolerance for older/unresponsive firmware.
   */
  async #fetchDeviceQuery(connection) {
    try {
      const deviceInfoResponse = await this.#commandQueue.run(() =>
        connection.deviceQuery(Constants.SupportedCompanionProtocolVersion)
      );
      // manufacturerModel is documented as "remainder of frame" - on real
      // firmware this includes trailing null-padding and an extra packed
      // git-describe string after the model name (confirmed live), so only
      // the text up to the first null byte is the actual model name.
      this.#deviceInfo.model = deviceInfoResponse.manufacturerModel
        ? deviceInfoResponse.manufacturerModel.split('\0')[0].trim() || null
        : null;
      this.#deviceInfo.firmwareVersion = deviceInfoResponse.firmware_build_date
        ? `${deviceInfoResponse.firmwareVer} (${deviceInfoResponse.firmware_build_date})`
        : String(deviceInfoResponse.firmwareVer ?? '');
    } catch (err) {
      this.#logger.warn('services.radio', 'device query failed', { error: err.message });
    }
  }

  #scheduleRetry() {
    if (!this.#running) {
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

  #wireConnection(connection) {
    connection.once('disconnected', () => {
      if (this.#connection !== connection) {
        return;
      }
      this.#connection = null;
      this.#logger.warn('services.radio', 'radio disconnected');
      this.emit('radio.disconnected');
      if (this.#running) {
        this.#attempt = 0;
        this.#attemptConnect();
      }
    });

    // LogRxData (not RawData) is what Companion firmware actually emits for
    // general received-packet capture, confirmed empirically against a real
    // device - RawData never fired even with confirmed live RF traffic.
    connection.on(Constants.PushCodes.LogRxData, (logRxData) => this.emit('radio.packet', logRxData));
    connection.on(Constants.ResponseCodes.ChannelMsgRecv, (message) => this.emit('radio.channelMessage', message));
  }
}
