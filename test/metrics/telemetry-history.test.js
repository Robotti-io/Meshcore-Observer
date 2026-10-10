import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTelemetryFixture, telemetryResult, telemetrySnapshot } from '../fixtures/telemetry-store.js';
import { telemetryBytes, telemetryWire } from '../fixtures/telemetry-wire.js';

const fixtures = [];
const fixture = () => { const f = createTelemetryFixture(); fixtures.push(f); return f; };
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.cleanup(); });
const clone = value => JSON.parse(JSON.stringify(value));
const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;

test('all three decoded components persist exact normalized fields, context, receipt and owned run', () => {
  const f = fixture(); const inputs = [];
  for (const component of ['status', 'sensors', 'neighbours']) {
    const input = telemetryResult(f.run, { component }); inputs.push(input);
    const recorded = f.store.recordTelemetryResult(input);
    assert.equal(recorded.duplicate, false); assert.equal(recorded.latestUpdated, true); assert.equal(recorded.decodedLatestUpdated, true);
  }
  f.close(); f.inspect(db => {
    const data = telemetrySnapshot(db);
    assert.equal(data.telemetry_query_outcomes.length, 3); assert.equal(data.telemetry_observations.length, 3);
    assert.equal(data.telemetry_latest.length, 3);
    for (const [index, input] of inputs.entries()) {
      const o = data.telemetry_query_outcomes[index], sample = data.telemetry_observations[index];
      assert.deepEqual(JSON.parse(sample.normalized_json), input.observation);
      assert.deepEqual(JSON.parse(o.variant_json), input.outcome.variant);
      assert.equal(o.run_id, f.run.runId); assert.equal(o.request_id, input.outcome.requestId);
      assert.equal(o.received_at, input.observation.observedAt); assert.equal(o.tag, 0x12345678);
      assert.equal(sample.observation_time_conflict, 0); assert.equal(sample.latest_eligible, 1);
    }
    assert.doesNotMatch(JSON.stringify(data), /password|credential|latitude|longitude|rawTail|"body":/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('immutable replay ignores object property ordering but rejects changed context/time/observation content', () => {
  const f = fixture(), input = telemetryResult(f.run), original = f.store.recordTelemetryResult(input);
  const duplicate = f.store.recordTelemetryResult(reorder(input));
  assert.deepEqual(duplicate, { ...original, duplicate: true, latestUpdated: false, decodedLatestUpdated: false });
  for (const mutate of [v => { v.outcome.completedAt++; }, v => { v.outcome.tag++; }, v => { v.outcome.route = 'flood'; },
    v => { v.outcome.targetPublicKey = 'EF'.repeat(32); }, v => { v.outcome.variant.params.permissionMask = 1; v.observation.variant.params.permissionMask = 1; },
    v => { v.observation.data.readings[0].rawValue = 0; v.observation.data.readings[0].value = 0; }]) {
    const changed = clone(input); mutate(changed);
    assert.throws(() => f.store.recordTelemetryResult(changed), /^Error: Telemetry result request identity conflict$/);
  }
  f.close(); f.inspect(db => {
    const data = telemetrySnapshot(db); assert.equal(data.telemetry_query_outcomes.length, 1);
    assert.equal(data.telemetry_observations.length, 1); assert.equal(data.telemetry_latest[0].observation_id, original.observationId);
    assert.deepEqual(JSON.parse(data.telemetry_observations[0].normalized_json), input.observation);
  });
});

test('failed/unsupported requests replay without observations and never replace previously useful/decoded data', () => {
  const f = fixture(), first = f.store.recordTelemetryResult(telemetryResult(f.run));
  for (const status of ['failed', 'unsupported']) {
    const input = telemetryResult(f.run, { status, observedAt: 3000 });
    assert.equal(f.store.recordTelemetryResult(input).observationId, null);
    assert.equal(f.store.recordTelemetryResult(input).duplicate, true);
    const changed = clone(input); changed.outcome.completedAt++;
    assert.throws(() => f.store.recordTelemetryResult(changed), /identity conflict/);
  }
  f.close(); f.inspect(db => {
    const data = telemetrySnapshot(db); assert.equal(data.telemetry_query_outcomes.length, 3);
    assert.equal(data.telemetry_observations.length, 1);
    assert.equal(data.telemetry_latest[0].observation_id, first.observationId);
    assert.equal(data.telemetry_latest[0].decoded_observation_id, first.observationId);
  });
});

test('newer partial observations retain separately aged decoded data and never merge fields', () => {
  const f = fixture();
  const decoded = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 1000 }));
  const partialInput = telemetryResult(f.run, { observedAt: 3000, body: telemetryBytes('0174000001FA') });
  const partial = f.store.recordTelemetryResult(partialInput);
  assert.equal(partial.latestUpdated, true); assert.equal(partial.decodedLatestUpdated, false);
  const lateDecoded = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 2000 }));
  assert.equal(lateDecoded.latestUpdated, false); assert.equal(lateDecoded.decodedLatestUpdated, true);
  const older = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 500 }));
  assert.equal(older.latestUpdated, false); assert.equal(older.decodedLatestUpdated, false);
  f.close(); f.inspect(db => {
    const data = telemetrySnapshot(db); assert.equal(data.telemetry_latest[0].observation_id, partial.observationId);
    assert.equal(data.telemetry_latest[0].decoded_observation_id, lateDecoded.observationId);
    const saved = JSON.parse(data.telemetry_observations.find(row => row.id === partial.observationId).normalized_json);
    assert.deepEqual(saved, partialInput.observation); assert.equal(saved.data.readings.length, 1);
    assert.equal(saved.data.readings[0].value, 0); assert.notEqual(decoded.observationId, lateDecoded.observationId);
  });
});

test('a scope can begin with a partial/unknown-prefix observation without a fabricated decoded snapshot', () => {
  const f = fixture();
  const partial = f.store.recordTelemetryResult(telemetryResult(f.run, { body: [1, 250] }));
  const prefix = f.store.recordTelemetryResult(telemetryResult(f.run, { component: 'status', evidence: 'unknown' }));
  assert.equal(partial.decodedLatestUpdated, false); assert.equal(prefix.decodedLatestUpdated, false);
  f.close(); f.inspect(db => {
    const data = telemetrySnapshot(db); assert.ok(data.telemetry_latest.every(row => row.decoded_observation_id === null));
    assert.equal(JSON.parse(data.telemetry_observations[0].normalized_json).data.readings.length, 0);
    assert.equal(JSON.parse(data.telemetry_observations[1].normalized_json).data.receiveErrors, null);
  });
});

test('equal receipt times from distinct requests mark ambiguity even for identical data; UUID ties are arrival-independent', () => {
  const f = fixture();
  const low = '11111111-1111-4111-8111-111111111111', high = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const second = f.store.recordTelemetryResult(telemetryResult(f.run, { requestId: high }));
  const first = f.store.recordTelemetryResult(telemetryResult(f.run, { requestId: low }));
  assert.equal(first.observationTimeConflict, true); assert.equal(first.latestUpdated, false);
  assert.equal(f.store.recordTelemetryResult(telemetryResult(f.run, { requestId: high })).observationTimeConflict, true);
  f.close(); f.inspect(db => {
    const data = telemetrySnapshot(db); assert.deepEqual(data.telemetry_observations.map(row => row.observation_time_conflict), [1, 1]);
    assert.equal(data.telemetry_latest[0].observation_id, second.observationId);
  });
  f.open(); f.start();
  const later = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 2000 }));
  assert.equal(later.observationTimeConflict, false); f.close();
  f.inspect(db => assert.equal(db.prepare('SELECT observation_id FROM telemetry_latest').get().observation_id, later.observationId));
});

test('reporter, target, component, permission/profile and neighbour page variants remain independent scopes', () => {
  const f = fixture();
  const options = [{}, { observer: 'EE'.repeat(32) }, { target: 'FF'.repeat(32) }, { permissionMask: 7 },
    { component: 'status' }, { component: 'status', evidence: 'unknown' },
    { component: 'status', layout: 'current56', body: telemetryBytes(telemetryWire.status56) },
    { component: 'neighbours' }, { component: 'neighbours', offset: 1, body: [2, 0, 0, 0] },
    { component: 'neighbours', prefixLength: 1, body: [0, 0, 0, 0] }];
  for (const option of options) {
    const saved = f.store.recordTelemetryResult(telemetryResult(f.run, option));
    assert.equal(saved.latestUpdated, true); assert.equal(saved.observationTimeConflict, false);
  }
  f.close(); f.inspect(db => { assert.equal(db.prepare('SELECT count(*) AS n FROM telemetry_latest').get().n, options.length);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); });
});

test('impossible receipt order and explicit request anomalies stay history-only without timestamp rewriting', () => {
  const f = fixture(), original = f.store.recordTelemetryResult(telemetryResult(f.run));
  for (const options of [{ observedAt: 3000, completedAt: 2000, clockAnomaly: true },
    { observedAt: 4000, startedAt: 5000, clockAnomaly: true }, { observedAt: 6000, clockAnomaly: true }]) {
    const input = telemetryResult(f.run, options), saved = f.store.recordTelemetryResult(input);
    assert.equal(saved.latestUpdated, false); assert.equal(saved.decodedLatestUpdated, false);
  }
  f.close(); f.inspect(db => {
    const data = telemetrySnapshot(db); assert.equal(data.telemetry_latest[0].observation_id, original.observationId);
    assert.deepEqual(data.telemetry_observations.map(row => row.latest_eligible), [1, 0, 0, 0]);
    assert.deepEqual(data.telemetry_observations.map(row => row.observed_at), [1000, 3000, 4000, 6000]);
  });
});

test('known run-clock anomalies and requests before run start also preserve history without advancing latest', () => {
  const f = fixture(); f.store.checkpointObserverRun({ runId: f.run.runId, observedAt: 5000, observedDurationMs: 1000 });
  const anomalous = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 6000 }));
  assert.equal(anomalous.latestUpdated, false); f.close(); f.open(); f.start(1000);
  const beforeRun = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 999, startedAt: 900 }));
  assert.equal(beforeRun.latestUpdated, false); f.close(); f.inspect(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM telemetry_latest').get().n, 0);
    assert.ok(db.prepare('SELECT latest_eligible FROM telemetry_observations').all().every(row => row.latest_eligible === 0));
  });
});

test('validation/ownership reject before transaction and reopening grants no write authority over a saved run', () => {
  const f = fixture(), input = telemetryResult(f.run); f.store.recordTelemetryResult(input);
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
  for (const bad of [null, { ...input, password: 'SECRET' }, { ...input, outcome: { ...input.outcome, runId: randomUUID() } }]) {
    assert.throws(() => f.store.recordTelemetryResult(bad), /Invalid telemetry data|active owned run/);
  }
  assert.equal(exec.mock.calls.length, 0); exec.mockRestore();
  f.close(); f.open(); assert.throws(() => f.store.recordTelemetryResult(input), /active owned run/);
  f.start(); assert.throws(() => f.store.recordTelemetryResult(input), /active owned run/);
  const stolen = clone(input); stolen.outcome.runId = f.run.runId;
  assert.throws(() => f.store.recordTelemetryResult(stolen), /identity conflict/);
  f.store.endObserverRun({ runId: f.run.runId, observedAt: 1000, observedDurationMs: 1000, reason: 'SIGINT' });
  assert.throws(() => f.store.recordTelemetryResult(telemetryResult(f.run)), /active owned run/);
});

for (const [point, event] of [['telemetry_query_outcomes', 'INSERT'], ['telemetry_observations', 'INSERT'],
  ['telemetry_observations', 'UPDATE'], ['telemetry_latest', 'INSERT'], ['telemetry_latest', 'UPDATE']]) {
  test(`failure at ${point} ${event} rolls back outcomes, observation, collisions and both pointers`, () => {
    const f = fixture(); f.store.recordTelemetryResult(telemetryResult(f.run)); f.close();
    const prior = f.inspect(db => { const prior = telemetrySnapshot(db); db.exec(`CREATE TRIGGER fail_telemetry BEFORE ${event} ON ${point}
      BEGIN SELECT RAISE(ABORT,'telemetry fixture'); END`); return prior; });
    f.open(); f.start();
    // Equal-time insertion exercises collision marking; latest UPDATE needs
    // a strictly newer receipt so its execution is independent of UUID order.
    const input = telemetryResult(f.run, { observedAt: point === 'telemetry_latest' ? 2000 : 1000 });
    assert.throws(() => f.store.recordTelemetryResult(input), /telemetry fixture/); f.close();
    f.inspect(db => { assert.deepEqual(telemetrySnapshot(db), prior); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); });
  });
}

test('database FKs/checks reject cross-scope, history-only and partial decoded-pointer corruption', () => {
  const f = fixture(); f.store.recordTelemetryResult(telemetryResult(f.run));
  const partial = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 2000, body: [1, 250] }));
  const anomaly = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 3000, clockAnomaly: true })); f.close();
  f.inspect(db => {
    for (const sql of ["UPDATE telemetry_query_outcomes SET run_id='missing'", "UPDATE telemetry_query_outcomes SET status='failed' WHERE status='answered'",
      "UPDATE telemetry_observations SET normalized_json='{}'", "UPDATE telemetry_observations SET target_public_key='EE'",
      `UPDATE telemetry_latest SET decoded_observation_id=${partial.observationId}`, `UPDATE telemetry_latest SET observation_id=${anomaly.observationId}`,
      'UPDATE telemetry_latest SET latest_eligible=0']) assert.throws(() => db.exec(sql), /constraint/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('clean and unclean reopen preserve immutable observations/pointers and original source-run provenance', () => {
  const f = fixture(), input = telemetryResult(f.run), saved = f.store.recordTelemetryResult(input), originalRun = f.run.runId;
  f.store.endObserverRun({ runId: originalRun, observedAt: 2000, observedDurationMs: 2000, reason: 'SIGINT' }); f.close();
  const prior = f.inspect(telemetrySnapshot); f.open(); f.start(3000); f.close();
  f.open(); f.start(4000); f.close(); f.inspect(db => {
    assert.deepEqual(telemetrySnapshot(db), prior); assert.equal(prior.telemetry_observations[0].id, saved.observationId);
    assert.equal(prior.telemetry_query_outcomes[0].run_id, originalRun);
    assert.equal(JSON.parse(prior.telemetry_observations[0].normalized_json).observedAt, 1000);
  });
});

test('ordered future/extreme receipt evidence stays original; age interpretation remains the later read contract', () => {
  const f = fixture(), at = Number.MAX_SAFE_INTEGER - 1;
  const input = telemetryResult(f.run, { observedAt: at, completedAt: Number.MAX_SAFE_INTEGER, tag: 0xFFFFFFFF });
  const saved = f.store.recordTelemetryResult(input); assert.equal(saved.latestUpdated, true); f.close();
  f.inspect(db => {
    const data = telemetrySnapshot(db); assert.equal(data.telemetry_observations[0].observed_at, at);
    assert.equal(data.telemetry_query_outcomes[0].completed_at, Number.MAX_SAFE_INTEGER);
    assert.equal(data.telemetry_query_outcomes[0].tag, 0xFFFFFFFF);
    assert.deepEqual(JSON.parse(data.telemetry_observations[0].normalized_json), input.observation);
  });
});

test('corrupt saved normalized content cannot pass replay validation or disclose private diagnostic content', () => {
  const f = fixture(), input = telemetryResult(f.run); f.store.recordTelemetryResult(input); f.close();
  f.inspect(db => db.exec("UPDATE telemetry_observations SET normalized_json=json_set(normalized_json,'$.diagnostic','SECRET')"));
  f.open(); f.start();
  const replay = clone(input); replay.outcome.runId = f.run.runId;
  assert.throws(() => f.store.recordTelemetryResult(replay), /^Error: Invalid stored telemetry data$/);
});
