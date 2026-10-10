import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseNeighbourResponseBody as parse } from '../../src/telemetry/neighbour-parser.js';
import { assertTelemetryInput } from '../../src/telemetry/telemetry-validation.js';
import { telemetryObservationSchema } from '../../src/telemetry/telemetry-schemas.js';
import { telemetryWire, telemetryBytes, telemetryInput, neighbourPage } from '../fixtures/telemetry-wire.js';

const input = (body = telemetryBytes(telemetryWire.neighbours), options = {}) => telemetryInput('neighbours', body, options);

test('pinned v0 fixture preserves page parameters, remote prefix, relative age and signed quarter-dB SNR', () => {
  const response = parse(input()); assert.equal(response.status, 'accepted');
  assert.deepEqual(response.observation.data, { reportedTotal: 1, receivedCount: 1,
    entries: [{ order: 0, prefix: '1122334455667788', heardSecondsAgo: 5, snrQuarterDb: -16, snrDb: -4 }] });
  assert.deepEqual(response.observation.variant.params, { version: 0, count: 8, offset: 0, orderBy: 0, prefixLength: 8 });
  assert.equal(response.observation.quality, 'decoded'); assert.equal(response.observation.coverage, 'response-only');
  assert.equal(response.observation.observedAt, 1500); assertTelemetryInput(telemetryObservationSchema, response.observation);
});

test('1/8/32-byte prefixes remain remote-reported observations, including all-zero/full-key values', () => {
  for (const prefixLength of [1, 8, 32]) {
    const body = neighbourPage([{ prefix: '00'.repeat(prefixLength), age: 0, snr: 0 },
      { prefix: 'FF'.repeat(prefixLength), age: 0xFFFFFFFF, snr: -128 }], { prefixLength });
    const response = parse(input(body, { prefixLength })); assert.equal(response.status, 'accepted');
    assert.deepEqual(response.observation.data.entries, [
      { order: 0, prefix: '00'.repeat(prefixLength), heardSecondsAgo: 0, snrQuarterDb: 0, snrDb: 0 },
      { order: 1, prefix: 'FF'.repeat(prefixLength), heardSecondsAgo: 0xFFFFFFFF, snrQuarterDb: -128, snrDb: -32 }
    ]);
    for (const entry of response.observation.data.entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['heardSecondsAgo', 'order', 'prefix', 'snrDb', 'snrQuarterDb']);
    }
  }
  const response = parse(input(neighbourPage([{ prefix: 'AB'.repeat(8), age: 0, snr: 127 }])));
  assert.equal(response.observation.data.entries[0].snrDb, 31.75);
});

test('entry order, duplicate prefixes and all requested sort modes are preserved without inventory deduplication', () => {
  const entries = [{ prefix: '01'.repeat(8), age: 10, snr: -16 }, { prefix: '01'.repeat(8), age: 5, snr: -4 },
    { prefix: 'FF'.repeat(8), age: 12, snr: -100 }];
  for (const orderBy of [0, 1, 2, 3]) {
    const response = parse(input(neighbourPage(entries, { total: 12 }), { orderBy, offset: 2, count: 3 }));
    assert.equal(response.status, 'accepted'); assert.equal(response.observation.variant.params.orderBy, orderBy);
    assert.deepEqual(response.observation.data.entries.map(entry => entry.heardSecondsAgo), [10, 5, 12]);
    assert.equal(response.observation.data.entries.length, 3);
  }
});

test('empty/nonzero-offset pages preserve reported totals and do not certify an empty complete table', () => {
  for (const [total, offset] of [[0, 0], [8, 0], [8, 8], [8, 65535]]) {
    const response = parse(input(neighbourPage([], { total }), { offset }));
    assert.equal(response.status, 'accepted'); assert.equal(response.observation.data.reportedTotal, total);
    assert.deepEqual(response.observation.data.entries, []); assert.equal(response.observation.coverage, 'response-only');
    assert.equal(response.observation.variant.params.offset, offset);
  }
});

test('counts and full expected width are checked before reading or returning any entry', () => {
  const body = telemetryBytes(telemetryWire.neighbours);
  for (let length = 4; length < body.length; length++) {
    assert.deepEqual(parse(input(body.slice(0, length))), { status: 'malformed', reason: 'truncated-field' });
  }
  assert.deepEqual(parse(input([0, 0, 1, 0])), { status: 'malformed', reason: 'invalid-counts' });
  assert.deepEqual(parse(input([2, 0, 2, 0], { count: 1 })), { status: 'malformed', reason: 'invalid-counts' });
  assert.deepEqual(parse(input(body, { offset: 1 })), { status: 'malformed', reason: 'invalid-counts' });
  assert.deepEqual(parse(input([255, 255, 255, 255], { count: 255, prefixLength: 1 })), { status: 'malformed', reason: 'invalid-counts' });
  assert.deepEqual(parse(input([255, 255, 255, 0], { count: 255, prefixLength: 32 })), { status: 'malformed', reason: 'truncated-field' });
  assert.deepEqual(parse(input(body, { prefixLength: 32 })), { status: 'malformed', reason: 'truncated-field' });
  assert.deepEqual(parse(input(body, { prefixLength: 1 })), { status: 'malformed', reason: 'invalid-padding' });
});

test('zero padding follows complete records only, is bounded and independent of host modulo framing', () => {
  for (let padding = 0; padding <= 15; padding++) {
    for (const entries of [[], [{ prefix: '00'.repeat(8), age: 0, snr: 0 }]]) {
      const response = parse(input(neighbourPage(entries, { padding })));
      assert.equal(response.status, 'accepted'); assert.equal(response.observation.paddingBytes, padding);
      assert.equal(response.observation.decodedBytes, 4 + entries.length * 13);
    }
  }
  assert.deepEqual(parse(input(neighbourPage([], { padding: 16 }))), { status: 'malformed', reason: 'invalid-padding' });
  assert.deepEqual(parse(input([...telemetryBytes(telemetryWire.neighbours), 0, 1])), { status: 'malformed', reason: 'invalid-padding' });
});

test('pinned 130-byte export examples and the host maximum are distinct budgets, not completeness evidence', () => {
  for (const [prefixLength, count] of [[8, 10], [32, 3], [1, 27]]) {
    const entries = Array.from({ length: count }, (_, n) => ({ prefix: 'AB'.repeat(prefixLength), age: n, snr: 0 }));
    const body = neighbourPage(entries, { total: 65535, prefixLength });
    const response = parse(input(body, { count, prefixLength })); assert.equal(response.status, 'accepted');
    assert.equal(response.observation.data.receivedCount, count); assert.equal(response.observation.data.reportedTotal, 65535);
    assert.equal(response.observation.coverage, 'response-only');
  }
  const overflow = neighbourPage(Array(28).fill({ prefix: 'AB', age: 0, snr: 0 }), { prefixLength: 1 });
  assert.deepEqual(parse(input(overflow, { count: 28, prefixLength: 1 })), { status: 'malformed', reason: 'invalid-input' });
});

test('changing page totals, request offsets and captured receipt times are not stitched or carried forward', () => {
  const first = parse(input(neighbourPage([{ prefix: 'AB'.repeat(8), age: 12, snr: -4 }], { total: 12 }), { count: 1 }));
  const second = parse(input(neighbourPage([{ prefix: 'AB'.repeat(8), age: 10, snr: -8 }], { total: 5 }), { offset: 1, count: 1, observedAt: 1600 }));
  assert.equal(first.observation.data.reportedTotal, 12); assert.equal(second.observation.data.reportedTotal, 5);
  assert.equal(second.observation.variant.params.offset, 1); assert.equal(second.observation.observedAt, 1600);
  assert.equal(second.observation.data.entries[0].heardSecondsAgo, 10);
  assert.equal('heardAt' in second.observation.data.entries[0], false);
  assert.equal(first.observation.data.entries[0].snrDb, -1);
});

test('page outputs do not alias input request scopes and component/schema violations remain safe', () => {
  const request = input(), before = JSON.stringify(request), response = parse(request);
  response.observation.variant.params.offset = 2; response.observation.data.entries[0].prefix = 'FF'.repeat(8);
  assert.equal(JSON.stringify(request), before); assert.equal(parse(request).observation.data.entries[0].prefix, '1122334455667788');
  const secret = input(); secret.response.variant.params.token = 'SECRET';
  assert.deepEqual(parse(secret), { status: 'malformed', reason: 'invalid-input' });
  assert.deepEqual(parse(telemetryInput('sensors', [1, 104, 0])), { status: 'malformed', reason: 'wrong-component' });
});
