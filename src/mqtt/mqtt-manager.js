import { EventEmitter } from 'node:events';
import { MqttBroker } from './mqtt-broker.js';

/**
 * Owns an arbitrary configured list of independent brokers. One broker
 * being down/retrying must never prevent publishing to the others, per
 * docs/project_plan.spec.md Section 16. Emits "broker.connected" (with the
 * broker id) each time any individual broker (re)connects, so a caller can
 * republish retained state to it specifically.
 */
export class MqttManager extends EventEmitter {
  #brokers;
  #logger;

  /**
   * @param {(brokerConfig: object) => {getUsername?: Function, getPassword?: Function}} [getCredentialHooks]
   * Per-broker async credential resolvers (used for LetsMesh's on-device-
   * signed token auth; see index.js). Keeping this a caller-supplied
   * function, rather than anything MqttManager/MqttBroker know about JWTs
   * directly, is what keeps LetsMesh's auth seam separate from generic MQTT
   * connection code per docs/project_plan.spec.md Section 20.
   */
  constructor({
    config,
    logger,
    createBroker = (options) => new MqttBroker(options),
    getCredentialHooks = () => ({})
  }) {
    super();
    this.#logger = logger;
    this.#brokers = config.brokers.map((brokerConfig) =>
      createBroker({
        config: brokerConfig,
        logger,
        onConnect: () => this.emit('broker.connected', brokerConfig.id),
        ...getCredentialHooks(brokerConfig)
      })
    );
  }

  getBroker(id) {
    return this.#brokers.find((broker) => broker.id === id) ?? null;
  }

  /**
   * @param {{topic: string, payload: string, qos?: number, retain?: boolean}} [will] see MqttBroker#connect
   */
  connectAll(will = null) {
    for (const broker of this.#brokers) {
      broker.connect(will);
    }
  }

  async closeAll() {
    await Promise.all(this.#brokers.map((broker) => broker.close()));
  }

  getStates() {
    return Object.fromEntries(this.#brokers.map((broker) => [broker.id, broker.getState()]));
  }

  hasAnyConnected() {
    return this.#brokers.some((broker) => broker.isConnected());
  }

  /**
   * Publishes to every currently connected broker independently. A broker
   * that isn't connected is silently skipped (it will publish once it
   * reconnects, for the next call); a broker whose publish call fails logs
   * a warning but never affects the others.
   */
  async publish(topic, payload, options) {
    const connectedBrokers = this.#brokers.filter((broker) => broker.isConnected());
    const results = await Promise.allSettled(
      connectedBrokers.map((broker) => broker.publish(topic, payload, options))
    );

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.#logger.warn('services.mqtt', 'publish to broker failed', {
          broker: connectedBrokers[index].id,
          error: result.reason?.message
        });
      }
    });
  }
}
