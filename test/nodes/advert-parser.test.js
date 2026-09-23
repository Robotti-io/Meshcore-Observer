import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Advert } from '@liamcottle/meshcore.js';
import { parseAdvertFromPacket } from '../../src/nodes/advert-parser.js';
import { buildRawFrame, PayloadType, RouteType } from '../fixtures/packet-frames.js';

// Hand-built per Advert's own wire format (advert.js): 32-byte public key,
// 4-byte LE timestamp, 64-byte signature, then appData (a flags byte
// followed by whichever optional fields the flags declare present - here
// just a name, the only field advert-parser.js/node-registry.js care
// about). The signature bytes are structurally present but not a real
// ed25519 signature - parsing never validates it, only isVerified() does,
// and that's exercised (via a stub) in node-registry.test.js instead.
function buildAdvertPayload({
  publicKeyHex,
  timestamp = 1700000000,
  type = Advert.ADV_TYPE_REPEATER,
  name = 'Summit Repeater'
}) {
  const publicKey = Buffer.from(publicKeyHex, 'hex');
  const timestampBuffer = Buffer.alloc(4);
  timestampBuffer.writeUInt32LE(timestamp, 0);
  const signature = Buffer.alloc(64, 0x11);
  const flags = (type & 0x0f) | Advert.ADV_NAME_MASK;
  const appData = Buffer.concat([Buffer.from([flags]), Buffer.from(name, 'utf8')]);
  return Buffer.concat([publicKey, timestampBuffer, signature, appData]);
}

function decodedPacketFor(frame) {
  return { raw: frame.toString('hex') };
}

test('extracts publicKey/name/type from a valid ADVERT payload', () => {
  const publicKeyHex = 'E85C'.repeat(16);
  const payload = buildAdvertPayload({ publicKeyHex, name: 'Summit Repeater' });
  const frame = buildRawFrame({ payloadType: PayloadType.ADVERT, routeType: RouteType.FLOOD, pathHashSize: 1, payload });

  const advert = parseAdvertFromPacket(decodedPacketFor(frame));

  assert.ok(advert, 'expected a parsed Advert instance');
  assert.equal(Buffer.from(advert.publicKey).toString('hex').toUpperCase(), publicKeyHex.toUpperCase());
  assert.equal(advert.parsed.name, 'Summit Repeater');
  assert.equal(advert.parsed.type, 'REPEATER');
});

test('returns null for a packet that is not an ADVERT', () => {
  const frame = buildRawFrame({
    payloadType: PayloadType.TXT_MSG,
    routeType: RouteType.FLOOD,
    pathHashSize: 1,
    payload: Buffer.from('hello')
  });

  assert.equal(parseAdvertFromPacket(decodedPacketFor(frame)), null);
});

test('returns null for a truncated advert payload instead of throwing', () => {
  const tooShort = Buffer.alloc(10); // needs 32+4+64=100 bytes before appData even starts
  const frame = buildRawFrame({ payloadType: PayloadType.ADVERT, routeType: RouteType.FLOOD, pathHashSize: 1, payload: tooShort });

  assert.equal(parseAdvertFromPacket(decodedPacketFor(frame)), null);
});

test('returns null when the frame bytes cannot be parsed as a packet at all', () => {
  assert.equal(parseAdvertFromPacket({ raw: '' }), null);
});
