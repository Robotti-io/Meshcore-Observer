import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseStatusResponseBody as parse } from '../../src/telemetry/status-parser.js';
import { assertTelemetryInput } from '../../src/telemetry/telemetry-validation.js';
import { telemetryObservationSchema } from '../../src/telemetry/telemetry-schemas.js';
import { parseRemoteResponseFrame } from '../../src/radio/remote-response-parser.js';
import { telemetryWire, telemetryBytes, telemetryInput } from '../fixtures/telemetry-wire.js';

const expectedCommon = {
  batteryMillivolts: 3300, txQueueLength: 2, noiseFloorDbm: -110, lastRssiDbm: -75,
  packetsReceived: 0x01020304, packetsSent: 0x11223344, txAirtimeSeconds: 600, uptimeSeconds: 86400,
  sentFlood: 10, sentDirect: 11, receivedFlood: 12, receivedDirect: 13,
  errorEventFlags: 3, lastSnrQuarterDb: -16, directDuplicates: 2, floodDuplicates: 5,
  rxAirtimeSeconds: null, receiveErrors: null, lastSnrDb: -4
};
const input = (hex = telemetryWire.status48, padding = 0, options = {}) => telemetryInput('status', telemetryBytes(hex, padding), options);

test('reviewed legacy/current byte fixtures normalize exact signed/unsigned fields and units', () => {
  const legacy = parse(input()); assert.equal(legacy.status, 'accepted');
  assert.deepEqual(legacy.observation.data, expectedCommon);
  assert.equal(legacy.observation.quality, 'decoded'); assert.equal(legacy.observation.observedAt, 1500);
  assert.equal(legacy.observation.coverage, 'response-only');
  assert.equal(legacy.observation.provenance, 'companion-tag-attributed');
  const current = parse(input(telemetryWire.status56, 4, { layout: 'current56' }));
  assert.deepEqual(current.observation.data, { ...expectedCommon, rxAirtimeSeconds: 1000, receiveErrors: 17 });
  assert.equal(current.observation.decodedBytes, 56); assert.equal(current.observation.paddingBytes, 4);
  assertTelemetryInput(telemetryObservationSchema, current.observation);
});

test('equal encrypted host lengths cannot distinguish a legacy prefix from the current extensions', () => {
  for (const [hex, padding] of [[telemetryWire.status48, 12], [telemetryWire.status56, 4]]) {
    const body = telemetryBytes(hex, padding); assert.equal(body.length, 60);
    const envelope = parseRemoteResponseFrame({ bytes: [0x8C, 0, 0x78, 0x56, 0x34, 0x12, ...body] }).envelope;
    assert.equal(envelope.tag, 0x12345678);
    for (const layout of ['common48', 'current56']) {
      const response = parse(telemetryInput('status', envelope.body, { layout, evidence: 'unknown' }));
      assert.equal(response.status, 'accepted'); assert.equal(response.observation.quality, 'prefix-only');
      assert.deepEqual(response.observation.data, expectedCommon);
      assert.equal(response.observation.paddingBytes, 0); assert.equal(response.observation.uninterpretedBytes, 12);
      assert.deepEqual(response.observation.diagnostic, { code: 'status-profile-unknown' });
    }
  }
});

test('structural zeros, signed minima/maxima, flags and uint32 counter extrema are never trimmed or guessed', () => {
  for (const width of [48, 56]) {
    const response = parse(telemetryInput('status', Array(width).fill(0), { layout: width === 48 ? 'common48' : 'current56' }));
    assert.equal(response.status, 'accepted'); assert.equal(response.observation.data.lastSnrDb, 0);
    assert.equal(response.observation.data.batteryMillivolts, 0);
    assert.equal(response.observation.data.receiveErrors, width === 48 ? null : 0);
  }
  const bytes = Buffer.alloc(56, 0xFF);
  bytes.writeInt16LE(-32768, 4); bytes.writeInt16LE(32767, 6); bytes.writeInt16LE(-32768, 42);
  const response = parse(telemetryInput('status', [...bytes], { layout: 'current56' }));
  assert.equal(response.observation.data.packetsReceived, 0xFFFFFFFF);
  assert.equal(response.observation.data.rxAirtimeSeconds, 0xFFFFFFFF);
  assert.equal(response.observation.data.errorEventFlags, 65535);
  assert.equal(response.observation.data.lastSnrDb, -8192);
  assert.equal(response.observation.data.lastRssiDbm, 32767);
  bytes.writeInt16LE(32767, 42);
  assert.equal(parse(telemetryInput('status', [...bytes], { layout: 'current56' })).observation.data.lastSnrDb, 8191.75);
});

test('established profiles accept only bounded zero padding after all fields, without modulo assumptions', () => {
  for (const [hex, layout] of [[telemetryWire.status48, 'common48'], [telemetryWire.status56, 'current56']]) {
    for (let padding = 0; padding <= 15; padding++) {
      const response = parse(input(hex, padding, { layout }));
      assert.equal(response.status, 'accepted'); assert.equal(response.observation.paddingBytes, padding);
    }
    const extra = input(hex, 1, { layout }); extra.response.body[extra.response.body.length - 1] = 1;
    assert.deepEqual(parse(extra), { status: 'malformed', reason: 'invalid-padding' });
    assert.deepEqual(parse(input(hex, 16, { layout })), { status: 'malformed', reason: 'invalid-input' });
  }
  const unknown = input(telemetryWire.status48, 23, { evidence: 'unknown' }); unknown.response.body[70] = 255;
  const response = parse(unknown); assert.equal(response.observation.uninterpretedBytes, 23);
  assert.equal(response.observation.data.receiveErrors, null);
});

test('short or unsupported profiles fail atomically, even with valid earlier structural bytes', () => {
  for (let length = 0; length < 48; length++) {
    assert.deepEqual(parse(telemetryInput('status', Array(length).fill(0))), { status: 'malformed', reason: 'invalid-input' });
  }
  for (let length = 48; length < 56; length++) {
    assert.equal(parse(telemetryInput('status', Array(length).fill(0), { layout: 'current56' })).status, 'malformed');
  }
  const bad = input(); bad.response.variant.profile.layout = 'length-auto';
  assert.deepEqual(parse(bad), { status: 'malformed', reason: 'invalid-input' });
  assert.deepEqual(parse(telemetryInput('sensors', [1, 104, 0])), { status: 'malformed', reason: 'wrong-component' });
});

test('inputs remain immutable and outputs do not alias caller variants, bytes or prior results', () => {
  const request = input(); const before = JSON.stringify(request); const response = parse(request);
  response.observation.variant.profile.layout = 'current56'; response.observation.data.batteryMillivolts = 1;
  assert.equal(JSON.stringify(request), before); assert.deepEqual(parse(request).observation.data, expectedCommon);
});
