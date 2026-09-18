import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePacketHash } from '../../src/packets/packet-hash.js';

const PAYLOAD_TYPE_TXT_MSG = 0x02;
const PAYLOAD_TYPE_TRACE = 0x09;

test('is deterministic for the same input', () => {
  const a = calculatePacketHash(PAYLOAD_TYPE_TXT_MSG, 0x41, Buffer.from('hello', 'utf8'));
  const b = calculatePacketHash(PAYLOAD_TYPE_TXT_MSG, 0x41, Buffer.from('hello', 'utf8'));
  assert.equal(a, b);
});

test('produces a 16-character uppercase hex string', () => {
  const hash = calculatePacketHash(PAYLOAD_TYPE_TXT_MSG, 0x41, Buffer.from('hello', 'utf8'));
  assert.match(hash, /^[0-9A-F]{16}$/);
});

test('different payload bytes produce different hashes', () => {
  const a = calculatePacketHash(PAYLOAD_TYPE_TXT_MSG, 0x41, Buffer.from('hello', 'utf8'));
  const b = calculatePacketHash(PAYLOAD_TYPE_TXT_MSG, 0x41, Buffer.from('world', 'utf8'));
  assert.notEqual(a, b);
});

test('different payload types produce different hashes for the same payload bytes', () => {
  const payload = Buffer.from('hello', 'utf8');
  const a = calculatePacketHash(PAYLOAD_TYPE_TXT_MSG, 0x41, payload);
  const b = calculatePacketHash(0x05, 0x41, payload);
  assert.notEqual(a, b);
});

test('TRACE packets fold pathLen into the hash, unlike other types', () => {
  const payload = Buffer.from('hello', 'utf8');
  const traceA = calculatePacketHash(PAYLOAD_TYPE_TRACE, 0x41, payload);
  const traceB = calculatePacketHash(PAYLOAD_TYPE_TRACE, 0x42, payload);
  assert.notEqual(traceA, traceB);

  // Non-TRACE types ignore pathLen entirely.
  const txtA = calculatePacketHash(PAYLOAD_TYPE_TXT_MSG, 0x41, payload);
  const txtB = calculatePacketHash(PAYLOAD_TYPE_TXT_MSG, 0x42, payload);
  assert.equal(txtA, txtB);
});
