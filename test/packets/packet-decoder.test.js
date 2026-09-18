import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePacket, PacketDecodeError } from '../../src/packets/packet-decoder.js';
import { calculatePacketHash } from '../../src/packets/packet-hash.js';
import { buildRawFrame, RouteType, PayloadType } from '../fixtures/packet-frames.js';

const OBSERVER = { origin: 'Test Observer', originId: 'deadbeef' };

function normalizedEventFor(frame, overrides = {}) {
  return {
    receivedAt: '2024-01-01T00:00:00.000Z',
    snr: -2.25,
    rssi: -110,
    frameHex: frame.toString('hex').toUpperCase(),
    ...overrides
  };
}

const cases = [
  {
    name: 'ANON_REQ over FLOOD with a single-byte hop path',
    frame: buildRawFrame({
      payloadType: PayloadType.ANON_REQ,
      routeType: RouteType.FLOOD,
      pathHashSize: 1,
      hops: ['a1'],
      payload: Buffer.from('anon-req-payload')
    }),
    expectedPacketType: '7',
    expectedRoute: 'F'
  },
  {
    name: 'GRP_TXT over DIRECT with a two-byte hop path (two hops)',
    frame: buildRawFrame({
      payloadType: PayloadType.GRP_TXT,
      routeType: RouteType.DIRECT,
      pathHashSize: 2,
      hops: ['a1b2', 'c3d4'],
      payload: Buffer.from('cab3b15626481a5ba64247ab25766e4', 'hex')
    }),
    expectedPacketType: '5',
    expectedRoute: 'D'
  },
  {
    name: 'PATH over TRANSPORT_DIRECT',
    frame: buildRawFrame({
      payloadType: PayloadType.PATH,
      routeType: RouteType.TRANSPORT_DIRECT,
      transportCodes: [0x1234, 0x5678],
      pathHashSize: 1,
      hops: ['ff'],
      payload: Buffer.from([0x01, 0x02])
    }),
    expectedPacketType: '8',
    expectedRoute: 'T'
  },
  {
    name: 'TXT_MSG over FLOOD with no path (zero hops)',
    frame: buildRawFrame({
      payloadType: PayloadType.TXT_MSG,
      routeType: RouteType.FLOOD,
      pathHashSize: 1,
      hops: [],
      payload: Buffer.from('hello world')
    }),
    expectedPacketType: '2',
    expectedRoute: 'F'
  },
  {
    name: 'ADVERT over TRANSPORT_FLOOD with a three-byte hop path',
    frame: buildRawFrame({
      payloadType: PayloadType.ADVERT,
      routeType: RouteType.TRANSPORT_FLOOD,
      transportCodes: [0x0001, 0x0002],
      pathHashSize: 3,
      hops: ['a1b2c3'],
      payload: Buffer.alloc(32, 0xab)
    }),
    expectedPacketType: '4',
    expectedRoute: 'F'
  }
];

for (const { name, frame, expectedPacketType, expectedRoute } of cases) {
  test(`decodes ${name}`, () => {
    const normalizedEvent = normalizedEventFor(frame);
    const packet = decodePacket(normalizedEvent, OBSERVER);

    assert.equal(packet.origin, 'Test Observer');
    assert.equal(packet.origin_id, 'DEADBEEF');
    assert.equal(packet.timestamp, '2024-01-01T00:00:00.000Z');
    assert.equal(packet.type, 'PACKET');
    assert.equal(packet.direction, 'rx');
    assert.equal(packet.len, String(frame.length));
    assert.equal(packet.packet_type, expectedPacketType);
    assert.equal(packet.route, expectedRoute);
    assert.equal(packet.raw, frame.toString('hex').toUpperCase());
    assert.equal(packet.SNR, '-2.25');
    assert.equal(packet.RSSI, '-110');
    assert.match(packet.hash, /^[0-9A-F]{16}$/);
  });
}

test('payload_len reflects only the payload portion, excluding header/path/transport bytes', () => {
  const payload = Buffer.from('exactly-seventeen'); // 17 bytes
  const frame = buildRawFrame({
    payloadType: PayloadType.TXT_MSG,
    routeType: RouteType.DIRECT,
    pathHashSize: 2,
    hops: ['a1b2', 'c3d4', 'e5f6'],
    payload
  });

  const packet = decodePacket(normalizedEventFor(frame), OBSERVER);
  assert.equal(packet.payload_len, 17);
  // full frame = header(1) + pathLenByte(1) + hops(3*2=6) + payload(17) = 25
  assert.equal(packet.len, '25');
});

test('hash matches an independent computation from the same payload type/pathLen/payload', () => {
  const payload = Buffer.from('some payload bytes');
  const frame = buildRawFrame({
    payloadType: PayloadType.GRP_TXT,
    routeType: RouteType.FLOOD,
    pathHashSize: 1,
    hops: ['11', '22'],
    payload
  });

  const packet = decodePacket(normalizedEventFor(frame), OBSERVER);
  // pathLen byte for hashSize=1 (top bits 00), count=2 -> 0b00000010 = 0x02
  const expected = calculatePacketHash(PayloadType.GRP_TXT, 0x02, payload);
  assert.equal(packet.hash, expected);
});

test('throws PacketDecodeError for a truncated/unparseable frame', () => {
  assert.throws(() => decodePacket(normalizedEventFor(Buffer.from([])), OBSERVER), PacketDecodeError);
});
