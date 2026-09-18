import { EventEmitter } from 'node:events';
import { normalizeRawPacketEvent } from './packet-normalizer.js';
import { decodePacket } from './packet-decoder.js';
import { PacketDeduplicator } from './packet-deduplicator.js';

/**
 * The single pipeline raw radio packet events pass through: normalize -> AJV
 * validate -> decode -> deduplicate -> emit "packet" for downstream
 * consumers (MQTT publisher, echo bot). Business logic must never consume
 * a raw radio event directly.
 */
export class PacketPipeline extends EventEmitter {
  #logger;
  #getObserverIdentity;
  #deduplicator;

  constructor({ logger, getObserverIdentity, deduplicator = new PacketDeduplicator() }) {
    super();
    this.#logger = logger;
    this.#getObserverIdentity = getObserverIdentity;
    this.#deduplicator = deduplicator;
  }

  handleRawPacket(rawPush) {
    let normalized;
    try {
      normalized = normalizeRawPacketEvent(rawPush);
    } catch (err) {
      this.#logger.warn('services.packetCapture', 'dropped invalid raw packet event', { error: err.message });
      return;
    }

    const observer = this.#getObserverIdentity();
    if (!observer) {
      this.#logger.warn('services.packetCapture', 'dropped packet received before device identity was known');
      return;
    }

    let packet;
    try {
      packet = decodePacket(normalized, observer);
    } catch (err) {
      this.#logger.warn('services.packetCapture', 'failed to decode packet', { error: err.message });
      return;
    }

    if (this.#deduplicator.isDuplicate(packet.hash)) {
      this.#logger.debug('services.packetCapture', 'dropped duplicate packet', { hash: packet.hash });
      return;
    }

    this.#logger.info('services.packetCapture', 'packet captured', {
      packet_type: packet.packet_type,
      route: packet.route,
      hash: packet.hash
    });
    this.emit('packet', packet);
  }
}
