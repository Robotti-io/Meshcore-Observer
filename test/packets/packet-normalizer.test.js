import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRawPacketEvent, InvalidRawPacketEventError } from '../../src/packets/packet-normalizer.js';

test('normalizes a LogRxData push into the validated event shape', () => {
  const event = normalizeRawPacketEvent(
    { lastSnr: -2.25, lastRssi: -110, raw: Buffer.from([0x15, 0x00, 0xab, 0xcd]) },
    { now: () => Date.parse('2024-01-01T00:00:00.000Z') }
  );

  assert.equal(event.receivedAt, '2024-01-01T00:00:00.000Z');
  assert.equal(event.snr, -2.25);
  assert.equal(event.rssi, -110);
  assert.equal(event.frameHex, '1500ABCD');
});

test('accepts an empty payload', () => {
  const event = normalizeRawPacketEvent({ lastSnr: 0, lastRssi: 0, raw: Buffer.alloc(0) });
  assert.equal(event.frameHex, '');
});

test('rejects a push with a non-numeric snr', () => {
  assert.throws(
    () => normalizeRawPacketEvent({ lastSnr: 'nope', lastRssi: -100, raw: Buffer.from([0x01]) }),
    InvalidRawPacketEventError
  );
});

test('rejects a push missing rssi', () => {
  assert.throws(
    () => normalizeRawPacketEvent({ lastSnr: 1, raw: Buffer.from([0x01]) }),
    InvalidRawPacketEventError
  );
});
