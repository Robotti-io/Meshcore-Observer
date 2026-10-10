import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as s from '../../src/telemetry/telemetry-schemas.js';
import { assertTelemetryInput as valid, assertTelemetryResult, telemetryVariantKey } from '../../src/telemetry/telemetry-validation.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const key = 'AB'.repeat(32);
const clone = value => JSON.parse(JSON.stringify(value));
const variants = {
  status: { component: 'status', params: {}, profile: { layout: 'common48', evidence: 'established' } },
  sensors: { component: 'sensors', params: { permissionMask: 0 } },
  neighbours: { component: 'neighbours', params: { version: 0, count: 8, offset: 0, orderBy: 0, prefixLength: 8 } }
};
function statusData() {
  return { ...Object.fromEntries(Object.keys(s.TELEMETRY_STATUS_FIELDS).map(name => [name, 0])),
    rxAirtimeSeconds: null, receiveErrors: null, lastSnrDb: 0 };
}
function observation(component = 'status') {
  return { observedAt: 1500, decoderVersion: 1, provenance: 'companion-tag-attributed', coverage: 'response-only',
    quality: 'decoded', bodyBytes: component === 'status' ? 48 : component === 'sensors' ? 1 : 4,
    decodedBytes: component === 'status' ? 48 : component === 'sensors' ? 0 : 4,
    paddingBytes: component === 'sensors' ? 1 : 0, uninterpretedBytes: 0, diagnostic: null,
    variant: clone(variants[component]), data: component === 'status' ? statusData()
      : component === 'sensors' ? { emitterProfile: 'positive-channels', readings: [] }
        : { reportedTotal: 0, receivedCount: 0, entries: [] } };
}
function result(component = 'status') {
  return { decoderVersion: 1, outcome: { requestId: uuid, runId: uuid, observerPublicKey: key, targetPublicKey: 'CD'.repeat(32),
    variant: clone(variants[component]), startedAt: 1000, completedAt: 2000, receivedAt: 1500,
    clockAnomaly: false, tag: 0, route: 'direct', status: 'answered', reason: null }, observation: observation(component) };
}
const rejects = (schema, value) => assert.throws(() => valid(schema, value), /^Error: Invalid telemetry data$/);
const rejectResult = value => rejects(s.telemetryResultSchema, value);
const changed = (value, mutate) => { const copy = clone(value); mutate(copy); return copy; };
function reading(type = 116, rawValue = 0, channel = 1, order = 0, byteOffset = 0, occurrence = 0) {
  const field = s.TELEMETRY_SENSOR_FIELDS[type];
  return { channel, type, name: field.name, order, occurrence, byteOffset, rawValue,
    divisor: field.divisor, unit: field.unit, value: rawValue / field.divisor };
}

test('valid terminal components preserve true zeros, explicit empty pages and fixed source semantics', () => {
  for (const component of Object.keys(variants)) {
    assertTelemetryResult(result(component)); valid(s.telemetryObservationSchema, observation(component));
    valid(s.telemetryOutcomeSchema, result(component).outcome);
  }
  assert.equal(result().observation.data.batteryMillivolts, 0);
  for (const reason of s.TELEMETRY_FAILURE_REASONS) {
    const input = result(); input.outcome.status = 'failed'; input.outcome.reason = reason; delete input.observation;
    assertTelemetryResult(input);
    input.outcome.receivedAt = null; input.outcome.tag = null; input.outcome.route = null; assertTelemetryResult(input);
  }
  for (const reason of ['unsupported', 'unsupported-layout', 'unsupported-profile']) {
    const input = result(); input.outcome.status = 'unsupported'; input.outcome.reason = reason; delete input.observation;
    assertTelemetryResult(input);
  }
  for (const mutate of [v => { v.outcome.status = 'failed'; v.outcome.reason = 'response-timeout'; },
    v => { delete v.observation; }, v => { v.outcome.status = 'partial'; }, v => { v.outcome.reason = 'SECRET'; },
    v => { v.outcome.receivedAt = null; }, v => { v.outcome.tag = null; }, v => { v.outcome.route = null; }]) {
    rejectResult(changed(result(), mutate));
  }
});

test('strict trust-boundary shapes reject coercion, identifiers, secrets and location without echoing values', () => {
  for (const field of ['requestId', 'runId']) for (const value of [uuid + '\n', uuid.toUpperCase().replace('11111111', 'AAAAAAAA'), 'prefix', 17]) {
    rejectResult(changed(result(), v => { v.outcome[field] = value; }));
  }
  for (const field of ['observerPublicKey', 'targetPublicKey']) for (const value of [key.toLowerCase(), key + '\n', key.slice(2), 'GG'.repeat(32)]) {
    rejectResult(changed(result(), v => { v.outcome[field] = value; }));
  }
  for (const path of [v => v, v => v.outcome, v => v.outcome.variant, v => v.outcome.variant.params,
    v => v.observation, v => v.observation.data, v => v.observation.variant.profile]) {
    for (const field of ['password', 'token', 'credentialReference', 'latitude', 'rawError', 'sql']) {
      rejectResult(changed(result(), v => { path(v)[field] = 'SECRET'; }));
    }
  }
  for (const value of [Infinity, NaN, '0', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    rejectResult(changed(result(), v => { v.outcome.completedAt = value; }));
  }
  rejects({}, result());
});

test('request and observation component/variant, receipt time and decode quality must agree', () => {
  for (const mutate of [v => { v.observation.variant = variants.sensors; },
    v => { v.observation.observedAt++; }, v => { v.observation.variant.profile.evidence = 'unknown'; },
    v => { v.observation.decoderVersion = 2; }, v => { v.observation.coverage = 'complete-inventory'; },
    v => { v.observation.provenance = 'authenticated-repeater'; }]) rejectResult(changed(result(), mutate));
  const input = result('sensors'); input.observation.variant.params.permissionMask = 1; rejectResult(input);
  const page = result('neighbours'); page.observation.variant.params.offset = 1; rejectResult(page);
});

test('original anomalous time is preserved explicitly and never silently normalized', () => {
  for (const mutate of [v => { v.outcome.completedAt = 500; }, v => { v.outcome.receivedAt = 999; v.observation.observedAt = 999; },
    v => { v.outcome.receivedAt = 2001; v.observation.observedAt = 2001; }]) {
    const input = changed(result(), mutate); rejectResult(input); input.outcome.clockAnomaly = true; assertTelemetryResult(input);
    valid(s.telemetryOutcomeSchema, input.outcome);
  }
  const input = result().outcome; input.completedAt = 999; rejects(s.telemetryOutcomeSchema, input);
});

test('status profiles cannot infer extension zeros from padded lengths or unknown evidence', () => {
  for (const layout of ['common48', 'current56']) {
    const input = result(); input.outcome.variant.profile = { layout, evidence: 'unknown' };
    input.observation.variant.profile = { layout, evidence: 'unknown' };
    input.outcome.status = 'partial'; input.observation.quality = 'prefix-only';
    input.observation.diagnostic = { code: 'status-profile-unknown' };
    for (const length of [48, 60, 71]) {
      input.observation.bodyBytes = length; input.observation.uninterpretedBytes = length - 48;
      assertTelemetryResult(input);
    }
    rejectResult(changed(input, v => { v.observation.data.rxAirtimeSeconds = 0; }));
    rejectResult(changed(input, v => { v.observation.paddingBytes = 15; v.observation.uninterpretedBytes = 8; }));
  }
  const current = result(); current.outcome.variant.profile.layout = 'current56'; current.observation.variant.profile.layout = 'current56';
  current.observation.bodyBytes = 60; current.observation.decodedBytes = 56; current.observation.paddingBytes = 4;
  current.observation.data.rxAirtimeSeconds = 0; current.observation.data.receiveErrors = 0; assertTelemetryResult(current);
  for (const field of ['rxAirtimeSeconds', 'receiveErrors']) rejectResult(changed(current, v => { v.observation.data[field] = null; }));
  rejectResult(changed(current, v => { v.observation.data.lastSnrDb = .25; }));
  for (const [name, field] of Object.entries(s.TELEMETRY_STATUS_FIELDS)) {
    const minimum = field.signed ? -(2 ** (field.width * 8 - 1)) : 0;
    const maximum = 2 ** (field.width * 8 - (field.signed ? 1 : 0)) - 1;
    for (const value of [minimum, maximum]) {
      const input = changed(current, v => { v.observation.data[name] = value;
        if (name === 'lastSnrQuarterDb') v.observation.data.lastSnrDb = value / 4; });
      assertTelemetryResult(input);
    }
    for (const value of [minimum - 1, maximum + 1, .5]) rejectResult(changed(current, v => { v.observation.data[name] = value; }));
  }
});

test('raw decoder inputs are byte-bounded and capture profiles/operation parameters exactly', () => {
  for (const component of Object.keys(variants)) {
    const input = { variant: variants[component], body: Array(component === 'status' ? 48 : component === 'neighbours' ? 4 : 1).fill(0),
      ...(component === 'sensors' ? { emitterProfile: 'positive-channels' } : {}) };
    valid(s.telemetryDecoderInputSchema, input);
    for (const body of [[], Array(171).fill(0), [-1], [256], ['0'], [.5]]) rejects(s.telemetryDecoderInputSchema, { ...input, body });
    rejects(s.telemetryDecoderInputSchema, { ...input, password: 'SECRET' });
    rejects(s.telemetryDecoderInputSchema, { ...input, variant: { ...input.variant, params: { password: 'SECRET' } } });
  }
  for (const layout of ['common48', 'current56']) for (const evidence of ['established', 'unknown']) {
    const variant = { ...variants.status, profile: { layout, evidence } };
    const width = evidence === 'established' && layout === 'current56' ? 56 : 48;
    const max = evidence === 'established' ? width + 15 : 71;
    for (const size of [width, max]) valid(s.telemetryDecoderInputSchema, { variant, body: Array(size).fill(0) });
    for (const size of [width - 1, max + 1]) rejects(s.telemetryDecoderInputSchema, { variant, body: Array(size).fill(0) });
  }
});

test('sensor fields retain signed extrema and raw/scaled units without physical plausibility guesses', () => {
  for (const [type, field] of Object.entries(s.TELEMETRY_SENSOR_FIELDS)) {
    const min = field.signed ? -(2 ** (field.width * 8 - 1)) : 0;
    const max = 2 ** (field.width * 8 - (field.signed ? 1 : 0)) - 1;
    for (const raw of [min, 0, max]) {
      const input = observation('sensors'); input.data.readings = [reading(Number(type), raw)];
      input.bodyBytes = input.decodedBytes = 2 + field.width; input.paddingBytes = 0;
      valid(s.telemetryObservationSchema, input);
      for (const mutate of [v => { v.data.readings[0].value += .01; }, v => { v.data.readings[0].rawValue = max + 1; },
        v => { v.data.readings[0].unit = 'battery-percent'; }, v => { v.data.readings[0].divisor++; },
        v => { v.data.readings[0].channel = 0; }, v => { v.data.readings[0].value = Infinity; },
        v => { v.data.readings[0].latitude = 0; }]) rejects(s.telemetryObservationSchema, changed(input, mutate));
    }
  }
});

test('sensor order, repeated channel/type occurrences, consumed bytes and partial diagnostics are explicit', () => {
  const input = observation('sensors'); input.data.readings = [reading(116), reading(116, -100, 1, 1, 4, 1)];
  input.bodyBytes = input.decodedBytes = 8; input.paddingBytes = 0; valid(s.telemetryObservationSchema, input);
  for (const mutate of [v => { v.data.readings[1].order = 0; }, v => { v.data.readings[1].byteOffset = 0; },
    v => { v.data.readings[1].occurrence = 0; }, v => { v.decodedBytes = v.bodyBytes = 7; },
    v => { v.bodyBytes = v.decodedBytes = 9; }, v => { v.quality = 'partial'; },
    v => { v.data.emitterProfile = 'unknown'; }]) rejects(s.telemetryObservationSchema, changed(input, mutate));
  input.quality = 'partial'; input.bodyBytes = 10; input.uninterpretedBytes = 2;
  input.diagnostic = { code: 'unsupported-sensor-type', type: 250, byteOffset: 8, remainingBytes: 2 };
  valid(s.telemetryObservationSchema, input);
  for (const mutate of [v => { v.diagnostic.type = 116; }, v => { v.diagnostic.byteOffset = 7; },
    v => { v.diagnostic.remainingBytes = 1; }, v => { v.paddingBytes = 1; v.bodyBytes++; },
    v => { v.diagnostic.rawTail = 'SECRET'; }, v => { v.quality = 'prefix-only'; }]) rejects(s.telemetryObservationSchema, changed(input, mutate));
  const firstUnknown = observation('sensors'); firstUnknown.quality = 'partial'; firstUnknown.paddingBytes = 0;
  firstUnknown.bodyBytes = firstUnknown.uninterpretedBytes = 2;
  firstUnknown.diagnostic = { code: 'unsupported-sensor-type', type: 250, byteOffset: 0, remainingBytes: 2 };
  valid(s.telemetryObservationSchema, firstUnknown);
  const unknownProfile = changed(firstUnknown, v => { v.data.emitterProfile = 'unknown'; v.diagnostic = { code: 'sensor-profile-unknown' }; });
  valid(s.telemetryObservationSchema, unknownProfile);
  const excluded = changed(input, v => { v.bodyBytes = v.decodedBytes = 19; v.uninterpretedBytes = 0;
    v.diagnostic = { code: 'excluded-sensor-type', type: 136, byteOffset: 8, remainingBytes: 11 }; });
  valid(s.telemetryObservationSchema, excluded);
  rejects(s.telemetryObservationSchema, changed(excluded, v => { v.diagnostic.type = 250; }));
  rejects(s.telemetryObservationSchema, changed(excluded, v => { v.decodedBytes = v.bodyBytes = 18; v.diagnostic.remainingBytes = 10; }));
  const ambiguous = changed(firstUnknown, v => { v.diagnostic.code = 'ambiguous-channel'; v.diagnostic.type = 116; });
  valid(s.telemetryObservationSchema, ambiguous);
  rejects(s.telemetryObservationSchema, changed(ambiguous, v => { v.bodyBytes = v.uninterpretedBytes = v.diagnostic.remainingBytes = 1; }));
});

test('maximum neighbour page, partial terminal results and diagnostics obey byte and quality invariants', () => {
  const input = result('neighbours'); const obs = input.observation;
  input.outcome.variant.params.count = obs.variant.params.count = 255;
  input.outcome.variant.params.prefixLength = obs.variant.params.prefixLength = 1;
  obs.data.reportedTotal = obs.data.receivedCount = 27;
  obs.data.entries = Array.from({ length: 27 }, (_, order) => ({ order, prefix: '00', heardSecondsAgo: 0,
    snrQuarterDb: 127, snrDb: 31.75 }));
  obs.bodyBytes = 170; obs.decodedBytes = 166; obs.paddingBytes = 4; assertTelemetryResult(input);
  rejectResult(changed(input, v => { v.observation.data.entries.push({ ...v.observation.data.entries[0], order: 27 }); }));
  const partial = result('sensors'); partial.outcome.status = 'partial';
  partial.observation.quality = 'partial'; partial.observation.bodyBytes = partial.observation.uninterpretedBytes = 2;
  partial.observation.paddingBytes = 0; partial.observation.diagnostic = { code: 'unsupported-sensor-type', type: 250, byteOffset: 0, remainingBytes: 2 };
  assertTelemetryResult(partial);
  for (const mutate of [v => { v.outcome.status = 'answered'; }, v => { v.observation.diagnostic = null; },
    v => { v.observation.diagnostic.code = 'status-profile-unknown'; }, v => { v.observation.bodyBytes = 3; }]) {
    rejectResult(changed(partial, mutate));
  }
  rejects(s.telemetryDecoderInputSchema, { variant: variants.neighbours, body: [0, 0, 0] });
});

test('neighbour pages preserve remote prefix/relative age and exact request width without certifying identity', () => {
  for (const prefixLength of [1, 8, 32]) {
    const input = observation('neighbours'); input.variant.params.prefixLength = prefixLength;
    input.data = { reportedTotal: 65535, receivedCount: 1,
      entries: [{ order: 0, prefix: 'AB'.repeat(prefixLength), heardSecondsAgo: 0xFFFFFFFF, snrQuarterDb: -128, snrDb: -32 }] };
    input.bodyBytes = input.decodedBytes = 4 + prefixLength + 5; valid(s.telemetryObservationSchema, input);
    for (const mutate of [v => { v.data.entries[0].prefix += 'AB'; }, v => { v.data.entries[0].prefix = 'ab'.repeat(prefixLength); },
      v => { v.data.receivedCount = 2; }, v => { v.data.entries[0].snrDb = 0; }, v => { v.data.entries[0].order = 1; },
      v => { v.data.entries[0].heardAt = 1500; }, v => { v.data.entries[0].verifiedPublicKey = key; },
      v => { v.variant.params.offset = 65535; }, v => { v.quality = 'partial'; v.diagnostic = { code: 'status-profile-unknown' }; }]) {
      rejects(s.telemetryObservationSchema, changed(input, mutate));
    }
  }
  const empty = observation('neighbours'); empty.variant.params.offset = 7; empty.data.reportedTotal = 3;
  valid(s.telemetryObservationSchema, empty);
});

test('canonical variants validate every operation and preserve scope distinctions independent of property order', () => {
  assert.equal(telemetryVariantKey(variants.status), 'status:common48:established');
  assert.equal(telemetryVariantKey(variants.sensors), 'sensors:0');
  assert.equal(telemetryVariantKey(variants.neighbours), 'neighbours:0:8:0:0:8');
  assert.equal(telemetryVariantKey({ params: { prefixLength: 8, orderBy: 0, offset: 0, count: 8, version: 0 }, component: 'neighbours' }), telemetryVariantKey(variants.neighbours));
  for (const [field, value] of [['count', 0], ['count', 256], ['offset', 65536], ['orderBy', 4], ['prefixLength', 0], ['prefixLength', 33], ['version', 1]]) {
    assert.throws(() => telemetryVariantKey({ ...variants.neighbours, params: { ...variants.neighbours.params, [field]: value } }), /Invalid telemetry data/);
  }
  for (const value of [-1, 256, '0']) assert.throws(() => telemetryVariantKey({ ...variants.sensors, params: { permissionMask: value } }), /Invalid telemetry data/);
  assert.notEqual(telemetryVariantKey(variants.status), telemetryVariantKey({ ...variants.status, profile: { layout: 'common48', evidence: 'unknown' } }));
});

test('range/latest contracts require explicit times/scope and bound rows/offset without coercion or SQL', () => {
  const page = { start: 1000, end: 2000, limit: 200, offset: 0, observerPublicKey: key, targetPublicKey: key, runId: uuid,
    component: 'sensors', variant: variants.sensors };
  for (const schema of [s.telemetryObservationPageSchema, s.telemetryOutcomePageSchema]) {
    valid(schema, page); valid(schema, { start: 2000, end: 2000 });
    for (const changes of [{ start: 2001 }, { end: '2000' }, { limit: 201 }, { limit: 0 }, { offset: -1 },
      { offset: 0x80000000 }, { component: 'status' }, { sql: 'SECRET' }, { targetPublicKey: 'AB' }]) rejects(schema, { ...page, ...changes });
    rejects(schema, {});
  }
  valid(s.telemetryOutcomePageSchema, { ...page, status: 'partial' });
  rejects(s.telemetryObservationPageSchema, { ...page, status: 'partial' });
  rejects(s.telemetryOutcomePageSchema, { ...page, status: 'healthy' });
  const latest = { observerPublicKey: key, targetPublicKey: key, variant: variants.status, now: 2000, windowMs: 72 * 3600000 };
  valid(s.telemetryLatestQuerySchema, latest);
  for (const changes of [{ windowMs: 0 }, { windowMs: 3600001 }, { windowMs: 8761 * 3600000 }, { now: -1 },
    { now: NaN }, { variant: 'status:common48' }, { pollIntervalMs: 1000 }]) rejects(s.telemetryLatestQuerySchema, { ...latest, ...changes });
});

test('maximum supported response/result stays bounded; unknown fields cannot expand canonical JSON', () => {
  const input = result('sensors'); const obs = input.observation;
  obs.data.readings = Array.from({ length: s.TELEMETRY_MAX_READINGS }, (_, index) => reading(104, 255, 255, index, index * 3, index));
  obs.bodyBytes = obs.decodedBytes = 168; obs.paddingBytes = 0; assertTelemetryResult(input);
  assert.equal(s.TELEMETRY_BODY_MAX_BYTES, 170); assert.equal(s.TELEMETRY_MAX_READINGS, 56);
  assert.equal(s.TELEMETRY_MAX_NEIGHBOURS, 27); assert.equal(s.TELEMETRY_RESULT_MAX_BYTES, 16384);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < s.TELEMETRY_RESULT_MAX_BYTES);
  rejectResult(changed(input, v => { v.observation.data.readings.push(reading(104, 255, 255, 56, 168, 56)); }));
  rejectResult(changed(input, v => { v.observation.raw = 'x'.repeat(s.TELEMETRY_RESULT_MAX_BYTES); }));
  rejectResult(changed(input, v => { v.observation.bodyBytes = 171; }));
  rejects(s.telemetryObservationSchema, changed(observation(), v => { v.paddingBytes = 16; v.bodyBytes += 16; }));
});
