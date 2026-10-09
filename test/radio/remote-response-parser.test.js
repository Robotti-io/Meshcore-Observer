import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { SerialConnection, TCPConnection, Constants } from '@liamcottle/meshcore.js';
import { parseRemoteResponseFrame, assertRemoteResponseEnvelope } from '../../src/radio/remote-response-parser.js';
import { REMOTE_FRAME_MAX_BYTES, REMOTE_BODY_MAX_BYTES } from '../../src/radio/remote-request-schemas.js';
import { remoteFrame, remoteFrames } from '../fixtures/remote-frames.js';

const parse = (hex) => parseRemoteResponseFrame(remoteFrame(hex));
class FixtureSerialConnection extends SerialConnection {}

test('pinned Sent frames retain exact route, unsigned tag and millisecond estimate', () => {
  for (const [hex, route] of [[remoteFrames.sentDirect, 'direct'], [remoteFrames.sentFlood, 'flood']]) {
    assert.deepEqual(parse(hex), { status: 'accepted', envelope: {
      kind: 'sent', route, tag: 0x12345678, estimatedTimeoutMs: 5000
    } });
  }
  assert.deepEqual(parse('06000000000000000000').envelope, {
    kind: 'sent', route: 'direct', tag: 0, estimatedTimeoutMs: 0
  });
  assert.deepEqual(parse('0601FFFFFFFFFFFFFFFF').envelope, {
    kind: 'sent', route: 'flood', tag: 0xFFFFFFFF, estimatedTimeoutMs: 0xFFFFFFFF
  });
});

test('binary response preserves body and tag without fabricating target identity or decoding semantics', () => {
  const result = parse(remoteFrames.emptyRegions);
  assert.deepEqual(result, { status: 'accepted', envelope: {
    kind: 'binary-response', tag: 0x12345678, body: [4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0]
  } });
  assert.equal(parse(remoteFrames.wrongTag).envelope.tag, 0x12345679);
  assert.deepEqual(parse('8C000000000000').envelope, { kind: 'binary-response', tag: 0, body: [0] });
  assert.deepEqual(parse('8C00FFFFFFFFFF').envelope, { kind: 'binary-response', tag: 0xFFFFFFFF, body: [255] });
  for (const body of [[0, 255, 0, 128, 0], [...Buffer.from('*,Be,be-vlg\0')], [255, 255, 255, 255]]) {
    const frame = { bytes: [0x8C, 0, 1, 0, 0, 0, ...body] };
    const parsed = parseRemoteResponseFrame(frame);
    assert.deepEqual(parsed.envelope.body, body);
    frame.bytes[6] = 123;
    assert.deepEqual(parsed.envelope.body, body);
    assert.deepEqual(Object.keys(parsed.envelope).sort(), ['body', 'kind', 'tag']);
  }
});

test('bounded binary bodies reject an empty envelope and oversized application frame', () => {
  assert.equal(REMOTE_FRAME_MAX_BYTES, 176);
  assert.equal(REMOTE_BODY_MAX_BYTES, 170);
  assert.deepEqual(parse('8C0078563412'), { status: 'malformed' });
  const maximum = { bytes: [0x8C, 0, 0x78, 0x56, 0x34, 0x12, ...Array(170).fill(255)] };
  assert.equal(parseRemoteResponseFrame(maximum).envelope.body.length, 170);
  assert.deepEqual(parseRemoteResponseFrame({ bytes: [...maximum.bytes, 0] }), { status: 'malformed' });
});

test('Err codes preserve known meanings and unknown codes without raw error text', () => {
  for (const [hex, errorCode, reason] of [
    [remoteFrames.unsupported, 1, 'unsupported'], [remoteFrames.notFound, 2, 'not-found'],
    [remoteFrames.tableFull, 3, 'table-full'], ['0104', 4, 'bad-state'], ['0105', 5, 'file-io'],
    ['0106', 6, 'illegal-argument'], ['0100', 0, 'unknown'], ['01FF', 255, 'unknown']
  ]) assert.deepEqual(parse(hex), { status: 'accepted', envelope: { kind: 'error', errorCode, reason } });
});

test('malformed owned layouts never perform unsafe offset reads or retain input', () => {
  for (const hex of ['06', '0600', '060078563412881300', remoteFrames.sentDirect + '00',
    '06027856341288130000', '0600785634128813000000', '01', '010100',
    '8C', '8C00', '8C0078563412', '8C017856341200']) {
    assert.deepEqual(parse(hex), { status: 'malformed' }, hex);
  }
  const valid = remoteFrame(remoteFrames.sentDirect).bytes;
  for (let count = 0; count < valid.length; count++) {
    assert.deepEqual(parseRemoteResponseFrame({ bytes: valid.slice(0, count) }), { status: 'malformed' });
  }
});

test('strict frame schema rejects coercion, sparse arrays, unknown metadata and invalid representations', () => {
  for (const value of [undefined, null, [], {}, { raw: remoteFrames.sentDirect },
    { bytes: [] }, { bytes: new Array(10) }, { bytes: '0600' }, { bytes: Buffer.from('0600', 'hex') },
    { bytes: new Uint8Array([6, 0]) }, { bytes: [6, 0], targetPublicKey: 'AC'.repeat(32) },
    { bytes: [6, 0], password: 'DO-NOT-ECHO' }, { bytes: Array(177).fill(0) }]) {
    assert.deepEqual(parseRemoteResponseFrame(value), { status: 'malformed' });
  }
  for (const value of [-1, 256, 1.5, '6', null, undefined, NaN, Infinity]) {
    const bytes = remoteFrame(remoteFrames.sentDirect).bytes; bytes[3] = value;
    assert.deepEqual(parseRemoteResponseFrame({ bytes }), { status: 'malformed' });
  }
});

test('legacy login/status/telemetry and unrelated valid frames are ignored without consuming data', () => {
  for (const hex of ['00', 'FF', '8500ACACACACACAC', '8600ACACACACACAC',
    '8700ACACACACACAC0000', '8B00ACACACACACAC0174014A', '8D000000']) {
    assert.deepEqual(parse(hex), { status: 'ignored' });
  }
});

test('derived envelope schema rejects identity claims, mismatched error reasons and invalid bounds', () => {
  const sent = parse(remoteFrames.sentDirect).envelope;
  const binary = parse(remoteFrames.emptyRegions).envelope;
  const error = parse(remoteFrames.tableFull).envelope;
  for (const value of [
    { ...sent, tag: -1 }, { ...sent, tag: 0x100000000 }, { ...sent, estimatedTimeoutMs: '5000' },
    { ...sent, estimatedTimeoutMs: NaN }, { ...sent, route: 'zero-hop' }, { ...sent, tag: 0.5 },
    { ...sent, targetPublicKey: 'AC'.repeat(32) }, { ...binary, body: [] },
    { ...binary, body: Array(171).fill(0) }, { ...binary, body: [256] },
    { ...binary, targetPublicKey: 'AC'.repeat(32) }, { ...binary, requestId: 'fabricated' },
    { ...error, reason: 'not-found' }, { ...error, errorCode: 256 },
    { ...error, reason: 'unknown' }, { kind: 'error', errorCode: 255, reason: 'table-full' },
    { ...error, rawError: 'DO-NOT-ECHO' }
  ]) assert.throws(() => assertRemoteResponseEnvelope(value), /Invalid remote response envelope:/);
});

test('installed serial and TCP framing deliver identical validated application arrays without sockets or hardware', async () => {
  vi.useFakeTimers();
  try {
    for (const connection of [new FixtureSerialConnection(), new TCPConnection('unused', 0)]) {
      const observed = [];
      const onRx = (bytes) => observed.push(parseRemoteResponseFrame({ bytes }));
      connection.on('rx', onRx);
      for (const hex of [remoteFrames.sentDirect, remoteFrames.wrongTag, remoteFrames.emptyRegions]) {
        const frame = Buffer.from(hex, 'hex');
        const header = Buffer.from([Constants.SerialFrameTypes.Incoming, frame.length & 255, frame.length >> 8]);
        const wire = Buffer.concat([header, frame]);
        if (connection instanceof TCPConnection) {
          connection.onSocketDataReceived(wire.subarray(0, 2));
          connection.onSocketDataReceived(wire.subarray(2));
        } else {
          await connection.onDataReceived(wire.subarray(0, 2));
          await connection.onDataReceived(wire.subarray(2));
        }
      }
      await vi.runAllTimersAsync();
      assert.deepEqual(observed, [parse(remoteFrames.sentDirect), parse(remoteFrames.wrongTag), parse(remoteFrames.emptyRegions)]);
      connection.off('rx', onRx);
      assert.equal(connection.eventListenersMap.get('rx').length, 0);
      assert.equal(connection.readBuffer.length, 0);
      assert.equal(vi.getTimerCount(), 0);
    }
  } finally { vi.useRealTimers(); }
});
