import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseSensorResponseBody as parse } from '../../src/telemetry/sensor-parser.js';
import { assertTelemetryInput } from '../../src/telemetry/telemetry-validation.js';
import { telemetryObservationSchema } from '../../src/telemetry/telemetry-schemas.js';
import { telemetryWire, telemetryBytes, telemetryInput } from '../fixtures/telemetry-wire.js';

const input = (hex = telemetryWire.sensors, padding = 0, options = {}) => telemetryInput('sensors', telemetryBytes(hex, padding), options);

test('pinned encoder examples preserve supported raw values, units, channels and record positions', () => {
  const response = parse(input(telemetryWire.sensors, 9)); assert.equal(response.status, 'accepted');
  assert.deepEqual(response.observation.data.readings, [
    { channel: 1, type: 116, name: 'voltage', order: 0, occurrence: 0, byteOffset: 0, rawValue: 330, divisor: 100, unit: 'V', value: 3.3 },
    { channel: 1, type: 117, name: 'current', order: 1, occurrence: 0, byteOffset: 4, rawValue: 123, divisor: 1000, unit: 'A', value: .123 },
    { channel: 2, type: 103, name: 'temperature', order: 2, occurrence: 0, byteOffset: 8, rawValue: 250, divisor: 10, unit: 'degC', value: 25 },
    { channel: 3, type: 104, name: 'humidity', order: 3, occurrence: 0, byteOffset: 12, rawValue: 50, divisor: 2, unit: '%', value: 25 },
    { channel: 4, type: 115, name: 'pressure', order: 4, occurrence: 0, byteOffset: 15, rawValue: 1013, divisor: 10, unit: 'hPa', value: 101.3 }
  ]);
  assert.equal(response.observation.decodedBytes, 19); assert.equal(response.observation.paddingBytes, 9);
  assert.equal(response.observation.quality, 'decoded'); assert.equal(response.observation.coverage, 'response-only');
  assertTelemetryInput(telemetryObservationSchema, response.observation);
});

test('signed high bits and complete wire extrema remain measurements without calibration guesses', () => {
  for (const [hex, type, raw, value] of [
    ['FF748000', 116, -32768, -327.68], ['FF747FFF', 116, 32767, 327.67],
    ['FF758000', 117, -32768, -32.768], ['FF757FFF', 117, 32767, 32.767],
    ['FF678000', 103, -32768, -3276.8], ['FF677FFF', 103, 32767, 3276.7],
    ['FF68FF', 104, 255, 127.5], ['FF73FFFF', 115, 65535, 6553.5]
  ]) {
    const reading = parse(input(hex)).observation.data.readings[0];
    assert.equal(reading.type, type); assert.equal(reading.rawValue, raw); assert.equal(reading.value, value);
    assert.equal(reading.channel, 255);
  }
});

test('zero measurements and duplicate channels/types survive; order/occurrences are per channel/type', () => {
  const response = parse(input('0174000001740000017500000267000001680001740000', 2));
  const readings = response.observation.data.readings;
  assert.deepEqual(readings.map(value => value.value), Array(6).fill(0));
  assert.deepEqual(readings.map(value => value.occurrence), [0, 1, 0, 0, 0, 2]);
  assert.deepEqual(readings.map(value => value.order), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(readings.map(value => value.byteOffset), [0, 4, 8, 12, 16, 19]);
  assert.equal(response.observation.paddingBytes, 2);
});

test('unknown types stop safely at first/middle record and preserve only preceding supported measurements', () => {
  for (const prefix of ['', '0174014A']) {
    const response = parse(input(prefix + '09FA1122330175007B'));
    assert.equal(response.status, 'accepted'); assert.equal(response.observation.quality, 'partial');
    assert.equal(response.observation.data.readings.length, prefix ? 1 : 0);
    assert.deepEqual(response.observation.diagnostic, { code: 'unsupported-sensor-type', type: 250,
      byteOffset: prefix.length / 2, remainingBytes: 9 });
    assert.equal(response.observation.uninterpretedBytes, 9); assert.equal(response.observation.paddingBytes, 0);
    assert.equal(response.observation.decodedBytes, prefix.length / 2);
    assert.equal('rawTail' in response.observation, false);
  }
});

test('every truncated known sensor/GPS field fails the whole response instead of returning an earlier sample', () => {
  for (const record of ['0274ABCD', '0275ABCD', '0267ABCD', '026812', '0273ABCD', telemetryWire.excludedGps]) {
    const bytes = telemetryBytes(record);
    for (let length = 2; length < bytes.length; length++) {
      assert.deepEqual(parse(telemetryInput('sensors', [...telemetryBytes('0174014A'), ...bytes.slice(0, length)])),
        { status: 'malformed', reason: 'truncated-field' });
    }
  }
  for (const hex of ['01', '0174014A02']) assert.deepEqual(parse(input(hex)), { status: 'malformed', reason: 'truncated-field' });
  assert.deepEqual(parse(input('0067AB')), { status: 'malformed', reason: 'truncated-field' });
});

test('GPS exclusion uses reviewed width only, leaves no location/opaque bytes and continues later readings', () => {
  const response = parse(input('0174014A' + telemetryWire.excludedGps + '0175007B', 4));
  assert.equal(response.status, 'accepted'); assert.equal(response.observation.quality, 'partial');
  assert.deepEqual(response.observation.data.readings.map(reading => reading.type), [116, 117]);
  assert.deepEqual(response.observation.data.readings.map(reading => reading.order), [0, 2]);
  assert.deepEqual(response.observation.data.readings.map(reading => reading.byteOffset), [0, 15]);
  assert.deepEqual(response.observation.diagnostic, { code: 'excluded-sensor-type', type: 136, byteOffset: 4, remainingBytes: 19 });
  assert.equal(response.observation.decodedBytes, 19); assert.equal(response.observation.paddingBytes, 4);
  const serialized = JSON.stringify(response);
  for (const forbidden of ['latitude', 'longitude', 'altitude', '112233445566778899', 'rawValue":1122867']) assert.equal(serialized.includes(forbidden), false);
  const only = parse(input(telemetryWire.excludedGps));
  assert.deepEqual(only.observation.data.readings, []); assert.equal(only.observation.quality, 'partial');
  const laterUnknown = parse(input(telemetryWire.excludedGps + '09FA1234'));
  assert.equal(laterUnknown.observation.diagnostic.code, 'unsupported-sensor-type');
  assert.equal(laterUnknown.observation.decodedBytes, 11);
});

test('bounded padding is accepted only at record boundaries in the positive-channel profile', () => {
  for (let padding = 1; padding <= 15; padding++) {
    const empty = parse(input('', padding)); assert.equal(empty.status, 'accepted');
    assert.equal(empty.observation.quality, 'decoded'); assert.deepEqual(empty.observation.data.readings, []);
    assert.equal(empty.observation.paddingBytes, padding);
    const zero = parse(input('01740000', padding)); assert.equal(zero.observation.data.readings[0].value, 0);
    assert.equal(zero.observation.paddingBytes, padding);
  }
  const long = parse(input('0174014A', 16)); assert.equal(long.observation.quality, 'partial');
  assert.equal(long.observation.diagnostic.code, 'ambiguous-channel'); assert.equal(long.observation.uninterpretedBytes, 16);
  const zeroChannel = parse(input('0074014A')); assert.equal(zeroChannel.observation.quality, 'partial');
  assert.deepEqual(zeroChannel.observation.data.readings, []);
  assert.deepEqual(zeroChannel.observation.diagnostic, { code: 'ambiguous-channel', type: 116, byteOffset: 0, remainingBytes: 4 });
});

test('unknown emitter data never certifies padding, complete decode or a measured empty response', () => {
  const unknown = { emitterProfile: 'unknown' };
  for (const [hex, padding] of [['', 1], ['', 8], ['01740000', 0], ['0174014A', 1], ['0174014A', 8]]) {
    const response = parse(input(hex, padding, unknown)); assert.equal(response.status, 'accepted');
    assert.equal(response.observation.quality, 'partial'); assert.equal(response.observation.paddingBytes, 0);
    assert.equal(response.observation.data.emitterProfile, 'unknown');
    if (padding) assert.equal(response.observation.uninterpretedBytes, padding);
  }
  const excluded = parse(input(telemetryWire.excludedGps, 0, unknown));
  assert.equal(excluded.observation.quality, 'partial'); assert.equal(excluded.observation.diagnostic.code, 'excluded-sensor-type');
});

test('maximum supported reading count fits the host envelope without a firmware-completeness claim', () => {
  const response = parse(input('0168FF'.repeat(56), 2)); assert.equal(response.status, 'accepted');
  assert.equal(response.observation.data.readings.length, 56); assert.equal(response.observation.bodyBytes, 170);
  assert.equal(response.observation.data.readings[55].occurrence, 55);
  assert.equal(response.observation.data.readings[55].value, 127.5);
  assert.equal(response.observation.coverage, 'response-only');
  assert.deepEqual(parse(input('0168FF'.repeat(57))), { status: 'malformed', reason: 'invalid-input' });
});

test('sensor inputs/output are detached and operation/profile/secret mismatches reject before parsing', () => {
  const request = input(); const before = JSON.stringify(request); const response = parse(request);
  response.observation.data.readings[0].value = 0; response.observation.variant.params.permissionMask = 255;
  assert.equal(JSON.stringify(request), before); assert.equal(parse(request).observation.data.readings[0].value, 3.3);
  const secret = input(); secret.response.password = 'SECRET';
  assert.deepEqual(parse(secret), { status: 'malformed', reason: 'invalid-input' });
  const profile = input(); profile.response.emitterProfile = 'auto'; assert.equal(parse(profile).status, 'malformed');
  assert.deepEqual(parse(telemetryInput('neighbours', [0, 0, 0, 0])), { status: 'malformed', reason: 'wrong-component' });
});
