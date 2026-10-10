import mqtt from 'mqtt';

const RECONNECT_PERIOD_MS = 5000;
const CONNECT_TIMEOUT_MS = 10000;

function protocolFor(transport, tls) {
  if (transport === 'wss') {
    return tls ? 'wss' : 'ws';
  }
  return tls ? 'mqtts' : 'mqtt';
}

function randomSuffix() {
  return Math.random().toString(16).slice(2, 10);
}

/**
 * Owns one broker's MQTT.js client and its connection state (disabled,
 * connecting, connected, disconnected, retrying, failed). Reconnection is
 * delegated entirely to MQTT.js's own reconnectPeriod rather than a second,
 * competing reconnect implementation, per docs/project_plan.spec.md
 * Section 16.
 */
export class MqttBroker {
  #config;
  #logger;
  #createClient;
  #getUsername;
  #getPassword;
  #onConnect;
  #client = null;
  #state;
  #stopping = false;
  #generation = 0;
  #recoveryTimer = null;
  #lastWill = null;
  #boundedReject = null;

  /**
   * @param {{config: object, logger: object, createClient?: typeof mqtt.connect, getUsername?: () => (string|Promise<string>), getPassword?: () => (string|Promise<string>), onConnect?: () => void}} options
   * `getUsername`/`getPassword`, when given, resolve the MQTT credentials at
   * each *initial* connect() call, and may be async (LetsMesh's username is
   * derived from the device's own public key, and its password is a
   * short-lived JWT signed on-device - see letsmesh-auth.js). MQTT.js's own
   * internal reconnects reuse whatever credentials were passed to the
   * original connect() call, so a caller that needs to rotate a token before
   * it expires must close() and connect(will) again explicitly - see
   * index.js's LetsMesh token-refresh wiring.
   * `onConnect` fires every time this broker (re)connects, so a caller can
   * republish retained state (e.g. observer status) to it specifically.
   */
  constructor({ config, logger, createClient = mqtt.connect, getUsername = null, getPassword = null, onConnect = null }) {
    this.#config = config;
    this.#logger = logger;
    this.#createClient = createClient;
    this.#getUsername = getUsername;
    this.#getPassword = getPassword;
    this.#onConnect = onConnect;
    this.#state = config.enabled ? 'disconnected' : 'disabled';
  }

  get id() {
    return this.#config.id;
  }

  getState() {
    return this.#state;
  }

  isConnected() {
    return this.#state === 'connected';
  }

  /**
   * @param {{topic: string, payload: string, qos?: number, retain?: boolean}} [will]
   * MQTT Last Will, published by the broker itself if this client
   * disconnects abnormally. Must be known at connect time (MQTT.js cannot
   * change it after connecting), so callers only have a will to offer once
   * the device's identity is known - see docs/project_plan.spec.md
   * Section 18.
   */
  connect(will = null) {
    if (!this.#config.enabled) {
      return;
    }

    this.#stopping = false;
    const generation=++this.#generation;
    this.#lastWill=will;
    this.#state = 'connecting';
    this.#logger.info('services.mqtt', 'connecting to broker', { broker: this.#config.id });

    this.#resolveOptions(will)
      .then((options) => {
        if (this.#stopping || generation !== this.#generation) {
          return;
        }
        const client = this.#createClient(options);
        this.#client = client;
        this.#wireClient(client);
      })
      .catch((err) => {
        if(this.#stopping || generation !== this.#generation) return;
        this.#logger.warn('services.mqtt', 'failed to prepare broker connection', {
          broker: this.#config.id,
          error: err.message
        });
        this.#state = 'failed';
      });
  }

  async close() {
    this.#stopping = true;
    this.#generation += 1;
    clearTimeout(this.#recoveryTimer);this.#recoveryTimer=null;
    const force=Boolean(this.#boundedReject);
    this.#boundedReject?.(new Error('Region publication stopped'));
    const client = this.#client;
    this.#client = null;
    if (client) {
      await new Promise((resolve) => client.end(force, {}, resolve));
    }
    this.#state = this.#config.enabled ? 'disconnected' : 'disabled';
  }

  publish(topic, payload, { qos, retain } = {}) {
    if (!this.isConnected()) {
      return Promise.reject(new Error(`broker "${this.#config.id}" is not connected`));
    }
    return new Promise((resolve, reject) => {
      this.#client.publish(
        topic,
        payload,
        { qos: qos ?? this.#config.qos, retain: retain ?? this.#config.retain },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  /** QoS acknowledgement deadline for the durable region worker only.
   * Retire the timed-out client before a durable retry can be admitted;
   * otherwise MQTT.js could retain an unbounded collection of old attempts. */
  publishBounded(topic,payload,{ qos,retain,timeoutMs }) {
    if(!this.isConnected() || this.#boundedReject) return Promise.reject(new Error('Region broker unavailable'));
    const client=this.#client;
    return new Promise((resolve,reject)=>{
      let finished=false;
      const settle=error=>{
        if(finished) return;
        finished=true;clearTimeout(timer);this.#boundedReject=null;
        if(error) reject(error);else resolve();
      };
      const timer=setTimeout(()=>{
        if(this.#client===client) {
          this.#generation += 1;this.#client=null;this.#state='retrying';
          // Forced end discards this client's outgoing QoS queue. Late
          // callbacks/events belong to the retired client, never a new one.
          try { client.end(true,{},()=>{}); } catch { /* recovery remains bounded */ }
          this.#recoveryTimer=setTimeout(()=>{
            this.#recoveryTimer=null;
            if(!this.#stopping) this.connect(this.#lastWill);
          },RECONNECT_PERIOD_MS);
          this.#recoveryTimer.unref();
        }
        settle(new Error('Region broker acknowledgement timed out; connection retired for recovery'));
      },timeoutMs);
      timer.unref();this.#boundedReject=settle;
      try { client.publish(topic,payload,{ qos,retain },error=>settle(error)); }
      catch { settle(new Error('Region broker publish failed')); }
    });
  }

  #wireClient(client) {
    client.on('connect', () => {
      if(this.#client !== client || this.#stopping) return;
      this.#state = 'connected';
      this.#logger.info('services.mqtt', 'broker connected', { broker: this.#config.id });
      this.#onConnect?.();
    });

    client.on('reconnect', () => {
      if(this.#client !== client || this.#stopping) return;
      this.#state = 'retrying';
      this.#logger.debug('services.mqtt', 'broker reconnecting', { broker: this.#config.id });
    });

    client.on('offline', () => {
      if(this.#client !== client) return;
      if (!this.#stopping) {
        this.#state = 'retrying';
      }
    });

    client.on('error', (err) => {
      if(this.#client !== client) return;
      this.#logger.warn('services.mqtt', 'broker connection error', { broker: this.#config.id, error: err.message });
    });

    client.on('close', () => {
      if(this.#client !== client) return;
      if (this.#stopping) {
        this.#state = 'disconnected';
      }
    });
  }

  async #resolveOptions(will) {
    const options = {
      protocol: protocolFor(this.#config.transport, this.#config.tls),
      host: this.#config.host,
      port: this.#config.port,
      clientId: `${this.#config.clientIdPrefix}-${randomSuffix()}`,
      keepalive: this.#config.keepalive,
      reconnectPeriod: RECONNECT_PERIOD_MS,
      connectTimeout: CONNECT_TIMEOUT_MS
    };

    if (this.#config.websocketPath) {
      options.path = this.#config.websocketPath;
    }

    if (this.#config.auth.method === 'password') {
      options.username = this.#config.auth.username;
      options.password = this.#config.auth.password;
    } else if (this.#config.auth.method === 'token') {
      options.username = this.#getUsername ? await this.#getUsername() : (this.#config.auth.username ?? this.#config.id);
      options.password = this.#getPassword ? await this.#getPassword() : this.#config.auth.password;
    }

    if (will) {
      options.will = { topic: will.topic, payload: will.payload, qos: will.qos ?? 0, retain: will.retain ?? true };
    }

    return options;
  }
}
