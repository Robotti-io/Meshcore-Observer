import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseStatusResponseBody } from '../../src/telemetry/status-parser.js';
import { parseSensorResponseBody } from '../../src/telemetry/sensor-parser.js';
import { parseNeighbourResponseBody } from '../../src/telemetry/neighbour-parser.js';
import { finishTelemetryDecode } from '../../src/telemetry/decoder-helpers.js';
import { assertTelemetryInput, assertTelemetryResult } from '../../src/telemetry/telemetry-validation.js';
import { telemetryObservationSchema, telemetryParseInputSchema } from '../../src/telemetry/telemetry-schemas.js';
import { telemetryWire, telemetryBytes, telemetryInput } from '../fixtures/telemetry-wire.js';

const decoders = { status: parseStatusResponseBody, sensors: parseSensorResponseBody, neighbours: parseNeighbourResponseBody };
const bodies = { status: telemetryBytes(telemetryWire.status48), sensors: telemetryBytes(telemetryWire.sensors),
  neighbours: telemetryBytes(telemetryWire.neighbours) };
const clone = value => JSON.parse(JSON.stringify(value));

test('AJV rejects all structured unknown/time/body inputs before decoding with no value disclosure', () => {
  for (const [component, parse] of Object.entries(decoders)) {
    const good = telemetryInput(component, bodies[component]); assertTelemetryInput(telemetryParseInputSchema, good);
    for (const request of [null, undefined, [], {}, { ...good, password: 'SECRET' },
      { ...good, observedAt: '1500' }, { ...good, observedAt: Infinity }, { ...good, observedAt: NaN },
      { ...good, observedAt: -1 }, { ...good, observedAt: 1.5 }, { ...good, observedAt: Number.MAX_SAFE_INTEGER + 1 }]) {
      assert.deepEqual(parse(request), { status: 'malformed', reason: 'invalid-input' });
    }
    for (const body of [[], Array(171).fill(0), new Array(48), Buffer.from(bodies[component]), new Uint8Array(bodies[component]),
      'SECRET', [256], [-1], [null], ['0'], [.5], [Infinity]]) {
      assert.deepEqual(parse({ ...good, response: { ...good.response, body } }), { status: 'malformed', reason: 'invalid-input' });
    }
    for (const time of [0, Number.MAX_SAFE_INTEGER]) {
      const response = parse({ ...good, observedAt: time }); assert.equal(response.observation.observedAt, time);
    }
  }
});

test('each accepted observation can form a typed owned terminal result, with matching original context/time', () => {
  for (const [component, parse] of Object.entries(decoders)) {
    const request = telemetryInput(component, bodies[component]); const { observation } = parse(request);
    const outcome = { requestId: '11111111-1111-4111-8111-111111111111', runId: '22222222-2222-4222-8222-222222222222',
      observerPublicKey: 'AB'.repeat(32), targetPublicKey: 'CD'.repeat(32), variant: clone(request.response.variant),
      startedAt: 1000, completedAt: 2000, receivedAt: 1500, clockAnomaly: false, tag: 0x12345678,
      route: 'flood', status: observation.quality === 'decoded' ? 'answered' : 'partial', reason: null };
    assertTelemetryResult({ decoderVersion: 1, outcome, observation });
    outcome.variant.params.untrusted = 'SECRET';
    assert.throws(() => assertTelemetryResult({ decoderVersion: 1, outcome, observation }), /Invalid telemetry data/);
  }
  const request = telemetryInput('sensors', [1, 250], { permissionMask: 7 }); const { observation } = parseSensorResponseBody(request);
  assert.equal(observation.quality, 'partial'); assert.equal(observation.variant.params.permissionMask, 7);
});

test('bounded deterministic byte corpus never throws, returns partial writes or invalid normalized observations', () => {
  let seed = 12345;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; };
  for (let size = 1; size <= 170; size++) {
    const body = Array.from({ length: size }, next);
    for (const [component, parse] of Object.entries(decoders)) {
      const request = telemetryInput(component, body, component === 'status' ? { evidence: 'unknown' } : {});
      const before = JSON.stringify(request); const response = parse(request);
      assert.equal(JSON.stringify(request), before);
      if (response.status === 'accepted') assertTelemetryInput(telemetryObservationSchema, response.observation);
      else { assert.equal(response.status, 'malformed'); assert.deepEqual(Object.keys(response).sort(), ['reason', 'status']); }
    }
  }
});

test('normalized output is validated again and a broken decoder result cannot escape its boundary', () => {
  const request = telemetryInput('neighbours', [0, 0, 0, 0]);
  assert.deepEqual(finishTelemetryDecode(request, { reportedTotal: 0, receivedCount: 0, entries: [], token: 'SECRET' },
    { quality: 'decoded', decodedBytes: 4, paddingBytes: 0, uninterpretedBytes: 0, diagnostic: null }),
  { status: 'malformed', reason: 'invalid-observation' });
});
