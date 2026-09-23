import { resolveTopic, STATUS_TOPIC_TEMPLATE, PACKETS_TOPIC_TEMPLATE } from './topic-resolver.js';
import { buildObserverStatusPayload } from './observer-status.js';

/**
 * Wires captured packets and observer status to the configured MQTT
 * brokers: publishes each packet to the packets topic, and publishes a
 * retained online/offline status to the status topic.
 */
export class ObserverPublisher {
  #mqttManager;
  #iata;
  #clientVersion;

  constructor({ mqttManager, iata, clientVersion }) {
    this.#mqttManager = mqttManager;
    this.#iata = iata;
    this.#clientVersion = clientVersion;
  }

  /** @returns {Promise<{brokerId: string, outcome: 'sent'|'skipped'|'failed', error?: string}[]>} see MqttManager#publish */
  async publishPacket(packet) {
    const topic = resolveTopic(PACKETS_TOPIC_TEMPLATE, { IATA: this.#iata, PUBLIC_KEY: packet.origin_id });
    return this.#mqttManager.publish(topic, JSON.stringify(packet), { retain: false });
  }

  /** @returns {Promise<{brokerId: string, outcome: 'sent'|'skipped'|'failed', error?: string}[]>} see MqttManager#publish */
  async publishStatus(deviceInfo, status) {
    const payload = buildObserverStatusPayload({ deviceInfo, clientVersion: this.#clientVersion, status });
    // Uppercased to match the packets topic, which is always keyed by the
    // already-uppercased packet.origin_id - the same device must publish
    // both under the same-cased topic string, since MQTT topics are
    // case-sensitive.
    const topic = resolveTopic(STATUS_TOPIC_TEMPLATE, {
      IATA: this.#iata,
      PUBLIC_KEY: deviceInfo.publicKey.toUpperCase()
    });
    return this.#mqttManager.publish(topic, JSON.stringify(payload), { retain: true });
  }
}
