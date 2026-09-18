import { Packet } from '@liamcottle/meshcore.js';
import { calculatePacketHash } from './packet-hash.js';

// Mirrors the reference Python observer's route_map exactly (both flood
// variants collapse to "F"; only TRANSPORT_DIRECT gets its own code).
const ROUTE_CODES = {
  TRANSPORT_FLOOD: 'F',
  FLOOD: 'F',
  DIRECT: 'D',
  TRANSPORT_DIRECT: 'T'
};

function routeCode(routeTypeString) {
  return ROUTE_CODES[routeTypeString] ?? 'U';
}

export class PacketDecodeError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'PacketDecodeError';
  }
}

/**
 * Decodes a validated normalized raw radio event into the compatibility
 * packet shape (see docs/project_plan.spec.md Section 14): origin,
 * origin_id, timestamp, type, direction, len, packet_type, route,
 * payload_len, raw, SNR, RSSI, hash. Field names/formats intentionally
 * match the reference Python observer's MQTT contract.
 *
 * @param {{receivedAt: string, snr: number, rssi: number, frameHex: string}} normalizedEvent
 * @param {{origin: string, originId: string}} observer this device's identity
 */
export function decodePacket(normalizedEvent, observer) {
  let frameBytes;
  let packet;
  try {
    frameBytes = Buffer.from(normalizedEvent.frameHex, 'hex');
    packet = Packet.fromBytes(frameBytes);
  } catch (err) {
    throw new PacketDecodeError(`Failed to parse packet frame: ${err.message}`, { cause: err });
  }

  return {
    origin: observer.origin,
    origin_id: observer.originId.toUpperCase(),
    timestamp: normalizedEvent.receivedAt,
    type: 'PACKET',
    direction: 'rx',
    len: String(frameBytes.length),
    packet_type: String(packet.payload_type),
    route: routeCode(packet.route_type_string),
    payload_len: packet.payload.length,
    raw: normalizedEvent.frameHex,
    SNR: String(normalizedEvent.snr),
    RSSI: String(normalizedEvent.rssi),
    hash: calculatePacketHash(packet.payload_type, packet.pathLen, packet.payload)
  };
}
