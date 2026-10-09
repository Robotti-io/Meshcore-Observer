import { test } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseTopologyFrame, assertTopologyEvidence } from '../../src/nodes/topology-parser.js';
import { buildRawFrame } from '../fixtures/packet-frames.js';

const frame = (raw) => ({ raw, runId: randomUUID(), observerPublicKey: 'CD'.repeat(32), receivedAt: 1000 });
const parse = (raw) => parseTopologyFrame(frame(raw));
test('versioned header fixtures preserve width, order and transport context without payload data', () => {
  for (const [raw, width, route, prefixes, codes] of [
    ['0D43AC019905E85C01020304', 2, 1, ['AC01', '9905', 'E85C'], null],
    ['0E43AC019905E85C01020304', 2, 2, ['AC01', '9905', 'E85C'], null],
    ['0C3412785643AC019905E85C01020304', 2, 0, ['AC01', '9905', 'E85C'], [0x1234, 0x5678]],
    ['0F3412785643AC019905E85C01020304', 2, 3, ['AC01', '9905', 'E85C'], [0x1234, 0x5678]],
    ['0D03AC99E801020304', 1, 1, ['AC', '99', 'E8'], null],
    ['0D83AC0102990506E85C0701020304', 3, 1, ['AC0102', '990506', 'E85C07'], null]
  ]) {
    const result = parse(raw); assert.equal(result.status, 'accepted');
    assert.equal(result.evidence.hashWidth, width); assert.equal(result.evidence.route, route);
    assert.deepEqual(result.evidence.prefixes, prefixes); assert.deepEqual(result.evidence.transportCodes, codes);
    assert.equal(result.evidence.kind, route <= 1 ? 'flood-traversed' : 'direct-remaining');
    assert.equal(result.evidence.containsRepeatedPrefix, false);
    assert.doesNotMatch(JSON.stringify(result.evidence), /"payload"|"raw"|"hash"|SNR|RSSI|01020304/);
  }
});
test('no-relay, repeated prefixes, TRACE and reserved formats have explicit classifications', () => {
  assert.equal(parse('0D0001020304').status, 'noRelay');
  assert.equal(parse('0D03AC99AC01020304').evidence.containsRepeatedPrefix, true);
  for (const raw of ['2543AC019905E85C01020304', '3141AC0101', '3541AC0101', '3941AC0101',
    '4D014401', '8D014401', 'CD014401', '0DC14401020304']) assert.equal(parse(raw).status, 'unsupported', raw);
});
test('binary bounds reject truncated library slices and effective path/payload limits', () => {
  for (const raw of ['0D43AC019905', '0C34127856', '0C3412', '0D41AC', '0D' + '41AC01' + '00'.repeat(185),
    '0D61' + '00'.repeat(66), '0D96' + '00'.repeat(66), '0D01' + '00'.repeat(254)]) {
    assert.equal(parse(raw).status, 'malformed', raw);
  }
  for (const [width, count] of [[1, 63], [2, 32], [3, 21]]) {
    const raw = buildRawFrame({ payloadType: 3, routeType: 1, pathHashSize: width,
      hops: Array.from({ length: count }, (_, i) => i.toString(16).padStart(width * 2, '0')), payload: Buffer.alloc(184) }).toString('hex');
    assert.equal(parse(raw).status, 'accepted');
  }
});
test('strict local and derived schemas reject unknown fields, identity/time and mismatched path claims', () => {
  for (const changes of [{ extra: true }, { raw: 'xyz' }, { raw: '' }, { raw: '0d1' }, { runId: 'bad' },
    { receivedAt: -1 }, { receivedAt: NaN }, { receivedAt: 1.1 }, { observerPublicKey: 'cd'.repeat(32) }]) {
    assert.equal(parseTopologyFrame({ ...frame('0D014401'), ...changes }).status, 'malformed');
  }
  const evidence = parse('0D014401').evidence;
  for (const changes of [{ raw: 'secret' }, { hashWidth: 2 }, { route: 2 }, { transportCodes: [1, 2] },
    { containsRepeatedPrefix: true }, { prefixes: [] }, { prefixes: Array(33).fill('ABCD'), hashWidth: 2 }]) {
    assert.throws(() => assertTopologyEvidence({ ...evidence, ...changes }), /Invalid topology evidence/);
  }
});
