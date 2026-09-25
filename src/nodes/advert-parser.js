import { Packet, Advert } from '@liamcottle/meshcore.js';

const PAYLOAD_TYPE_ADVERT = 0x04;

/**
 * Extracts a meshcore.js `Advert` instance from one already-decoded packet
 * (the flat compatibility shape from packet-decoder.js), or `null` if it
 * isn't an ADVERT packet or the payload can't be parsed as one. Never
 * throws - a malformed/truncated advert payload is a routine occurrence on
 * a real mesh, not a pipeline failure.
 *
 * Returns the live `Advert` instance rather than a plain object: callers
 * that intend to trust anything in it (in particular the node registry)
 * must call `await advert.isVerified()` themselves before doing so - this
 * module only parses, it never vouches for authenticity.
 *
 * @param {{raw: string}} decodedPacket
 * @returns {import('@liamcottle/meshcore.js').Advert | null}
 */
export function parseAdvertFromPacket(decodedPacket) {
  // PacketPipeline has already decoded the payload type. Most receptions
  // are not adverts, so avoid rebuilding and reparsing their frame here.
  // Keep the fallback for callers that provide only `raw`; the parsed packet
  // below remains the authority before an advert is returned.
  if (decodedPacket.packet_type !== undefined && decodedPacket.packet_type !== String(PAYLOAD_TYPE_ADVERT)) {
    return null;
  }

  let packet;
  try {
    packet = Packet.fromBytes(Buffer.from(decodedPacket.raw, 'hex'));
  } catch {
    return null;
  }

  if (packet.payload_type !== PAYLOAD_TYPE_ADVERT) {
    return null;
  }

  try {
    return Advert.fromBytes(Buffer.from(packet.payload));
  } catch {
    return null;
  }
}
