import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { buildRawFrame, PayloadType, RouteType } from './packet-frames.js';

// Genuine ed25519 signatures generated with Node's built-in crypto. No second
// protocol decoder or dependency is involved; the installed library verifies.
export function advertSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyBytes = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    publicKeyHex: keyBytes.toString('hex').toUpperCase(),
    payload({ timestamp = 1700000000, name = 'Repeater', type = 2 } = {}) {
      const epoch = Buffer.alloc(4);
      epoch.writeUInt32LE(timestamp);
      const appData = Buffer.concat([Buffer.from([type | (name === null ? 0 : 0x80)]),
        name === null ? Buffer.alloc(0) : Buffer.from(name)]);
      const data = Buffer.concat([keyBytes, epoch, appData]);
      return Buffer.concat([keyBytes, epoch, sign(null, data, privateKey), appData]);
    }
  };
}

export function signedAdvertPacket(payload, { receivedAt = 1000, hops = [], pathHashSize = 1,
  routeType = RouteType.FLOOD, transportCodes = null } = {}) {
  return { raw: buildRawFrame({ payloadType: PayloadType.ADVERT, payload, hops,
    pathHashSize, routeType, transportCodes }).toString('hex'),
  packet_type: '4', timestamp: new Date(receivedAt).toISOString() };
}

export function advertDigest(payload) {
  return createHash('sha256').update(payload).digest('hex');
}
