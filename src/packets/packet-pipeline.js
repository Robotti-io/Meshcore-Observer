import { EventEmitter } from 'node:events';
import { normalizeRawPacketEvent } from './packet-normalizer.js';
import { decodePacket } from './packet-decoder.js';

/**
 * The single pipeline raw radio packet events pass through: normalize -> AJV
 * validate -> decode -> emit "packet" for downstream consumers (MQTT
 * publisher, echo bot). Business logic must never consume a raw radio event
 * directly.
 *
 * Every decoded reception is emitted, including re-hearings of the same
 * logical packet delivered via a different relay path: the mesh can (and
 * does) deliver one physical message more than once with a different
 * route/RSSI/SNR each time, and downstream consumers on the OkiMesh network
 * rely on seeing every path a packet took, not just the first one heard
 * (see docs/Code Review - 2026-09-22.md and the reference
 * agessaman/meshcore-packet-capture implementation, neither of which
 * suppress re-hearings before publish). Suppressing repeat *replies* is a
 * separate, bot-local concern handled independently by ChannelBot's own
 * PacketDeduplicator (see channel-bot.js).
 */
export class PacketPipeline extends EventEmitter {
  #logger;
  #getObserverIdentity;

  constructor({ logger, getObserverIdentity }) {
    super();
    this.#logger = logger;
    this.#getObserverIdentity = getObserverIdentity;
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

    this.#logger.info('services.packetCapture', 'packet captured', {
      packet_type: packet.packet_type,
      route: packet.route,
      hash: packet.hash
    });
    this.emit('packet', packet);
  }
}
