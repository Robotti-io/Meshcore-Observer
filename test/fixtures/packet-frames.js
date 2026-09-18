// Synthetic MeshCore over-the-air frame builder, following the wire format
// documented in @liamcottle/meshcore.js's Packet class exactly (header bit
// layout, pathLen hash-size/count packing, optional transport codes).
//
// These are hand-constructed, not captured from the reference Python
// observer: its own test suite has no concrete ANON_REQ or PATH byte
// examples (confirmed by research before writing this file), and its GRP_TXT
// example decrypts payload content our decoder never inspects (only frame
// boundaries/header fields matter here). Route/payload-type/version
// constants below mirror Packet's own static fields 1:1.

export const RouteType = {
  TRANSPORT_FLOOD: 0x00,
  FLOOD: 0x01,
  DIRECT: 0x02,
  TRANSPORT_DIRECT: 0x03
};

export const PayloadType = {
  REQ: 0x00,
  RESPONSE: 0x01,
  TXT_MSG: 0x02,
  ACK: 0x03,
  ADVERT: 0x04,
  GRP_TXT: 0x05,
  GRP_DATA: 0x06,
  ANON_REQ: 0x07,
  PATH: 0x08,
  TRACE: 0x09,
  RAW_CUSTOM: 0x0f
};

/**
 * @param {object} options
 * @param {number} [options.payloadVersion]
 * @param {number} options.payloadType one of PayloadType
 * @param {number} options.routeType one of RouteType
 * @param {[number, number]} [options.transportCodes] required iff routeType is a TRANSPORT_* variant
 * @param {number} [options.pathHashSize] 1, 2, or 3 bytes per hop
 * @param {string[]} [options.hops] hex strings, each exactly pathHashSize bytes long
 * @param {Buffer|Uint8Array} options.payload
 * @returns {Buffer} a complete raw frame
 */
export function buildRawFrame({
  payloadVersion = 0,
  payloadType,
  routeType,
  transportCodes = null,
  pathHashSize = 1,
  hops = [],
  payload
}) {
  const header = ((payloadVersion & 0x03) << 6) | ((payloadType & 0x0f) << 2) | (routeType & 0x03);
  const parts = [Buffer.from([header])];

  const isTransportRoute = routeType === RouteType.TRANSPORT_FLOOD || routeType === RouteType.TRANSPORT_DIRECT;
  if (isTransportRoute) {
    if (!transportCodes) {
      throw new Error('transportCodes are required for TRANSPORT_FLOOD/TRANSPORT_DIRECT routes');
    }
    const transportBuffer = Buffer.alloc(4);
    transportBuffer.writeUInt16LE(transportCodes[0], 0);
    transportBuffer.writeUInt16LE(transportCodes[1], 2);
    parts.push(transportBuffer);
  }

  const pathLenByte = (((pathHashSize - 1) & 0x03) << 6) | (hops.length & 0x3f);
  parts.push(Buffer.from([pathLenByte]));

  for (const hop of hops) {
    const hopBytes = Buffer.from(hop, 'hex');
    if (hopBytes.length !== pathHashSize) {
      throw new Error(`hop "${hop}" is not ${pathHashSize} byte(s)`);
    }
    parts.push(hopBytes);
  }

  parts.push(Buffer.from(payload));

  return Buffer.concat(parts);
}
