import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createTelemetryFixture, telemetryResult, telemetrySnapshot } from '../fixtures/telemetry-store.js';

const fixtures = [];
const fixture = () => { const f = createTelemetryFixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const ids = db => db.prepare('SELECT id FROM telemetry_observations ORDER BY id').all().map(row => row.id);

test('shared pruning protects latest useful/decoded and requires BOTH receipt and completion strictly older than cutoff', () => {
  const f = fixture();
  const old = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 100 }));
  const completeEquality = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 200, completedAt: 1000 }));
  const receiptEquality = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 1000 }));
  const decoded = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 1100 }));
  const partial = f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 1200, body: [1, 250] }));
  const empty = f.store.recordTelemetryResult(telemetryResult(f.run, { component: 'neighbours', observedAt: 50, body: [0, 0, 0, 0] }));
  const failedOld = telemetryResult(f.run, { status: 'failed', observedAt: 100, completedAt: 999 }); f.store.recordTelemetryResult(failedOld);
  const failedEquality = telemetryResult(f.run, { status: 'failed', observedAt: 100, completedAt: 1000 }); f.store.recordTelemetryResult(failedEquality);
  const failedReceiptEquality = telemetryResult(f.run, { status: 'failed', observedAt: 0, receivedAt: 1000, completedAt: 100, clockAnomaly: true });
  f.store.recordTelemetryResult(failedReceiptEquality);
  f.store.pruneOlderThan(1000); f.close(); f.inspect(db => {
    const remaining = ids(db); assert.ok(!remaining.includes(old.observationId));
    for (const kept of [completeEquality, receiptEquality, decoded, partial, empty]) assert.ok(remaining.includes(kept.observationId));
    const outcomes = db.prepare('SELECT request_id FROM telemetry_query_outcomes').all().map(row => row.request_id);
    assert.ok(!outcomes.includes(failedOld.outcome.requestId));
    assert.ok(outcomes.includes(failedEquality.outcome.requestId)); assert.ok(outcomes.includes(failedReceiptEquality.outcome.requestId));
  });
  f.open(); f.store.pruneOlderThan(1001); f.close(); f.inspect(db => {
    assert.ok(!ids(db).includes(completeEquality.observationId));
    assert.equal(db.prepare("SELECT count(*) AS n FROM telemetry_query_outcomes WHERE status='failed'").get().n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('stale latest pointers and their clean source run survive; only wholly unreferenced ended runs are removed', () => {
  const f = fixture(), disposableRun = f.run;
  f.store.recordTelemetryResult(telemetryResult(disposableRun, { observedAt: 10, clockAnomaly: true }));
  f.store.endObserverRun({ runId: disposableRun.runId, observedAt: 20, observedDurationMs: 20, reason: 'SIGINT' }); f.close();
  f.open(); const protectedRun = f.start(30);
  const decoded = f.store.recordTelemetryResult(telemetryResult(protectedRun, { observedAt: 40, startedAt: 30 }));
  const partial = f.store.recordTelemetryResult(telemetryResult(protectedRun, { observedAt: 50, startedAt: 30, body: [1, 250] }));
  f.store.endObserverRun({ runId: protectedRun.runId, observedAt: 60, observedDurationMs: 30, reason: 'SIGINT' }); f.close();
  f.open(); f.start(70); f.store.pruneOlderThan(1000);
  assert.equal(f.store.getObserverRun({ runId: disposableRun.runId }), null);
  assert.ok(f.store.getObserverRun({ runId: protectedRun.runId })); f.close(); f.inspect(db => {
    assert.deepEqual(ids(db), [decoded.observationId, partial.observationId]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM telemetry_query_outcomes WHERE run_id=?').get(protectedRun.runId).n, 2);
  });
});

test('unclean source runs remain protected until their latest references are actually superseded and pruned', () => {
  const f = fixture(), source = f.run;
  f.store.recordTelemetryResult(telemetryResult(source, { observedAt: 10 })); f.close(); f.open(); f.start(20);
  f.store.pruneOlderThan(1000); assert.equal(f.store.getObserverRun({ runId: source.runId }).state, 'unclean');
  f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 30, startedAt: 20 }));
  f.store.pruneOlderThan(1000); assert.equal(f.store.getObserverRun({ runId: source.runId }), null);
});

test('pruning old collision peers never erases ambiguity from the retained latest snapshot', () => {
  const f = fixture();
  f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 100 }));
  f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 100 })); f.store.pruneOlderThan(1000); f.close();
  f.inspect(db => { assert.equal(ids(db).length, 1);
    assert.equal(db.prepare('SELECT observation_time_conflict FROM telemetry_observations').get().observation_time_conflict, 1); });
});

for (const point of ['telemetry_observations', 'telemetry_query_outcomes', 'observer_runs']) {
  test(`shared cleanup failure at ${point} rolls back all telemetry and source-run deletions`, () => {
    const f = fixture(), source = f.run;
    f.store.recordTelemetryResult(telemetryResult(source, { observedAt: 10, clockAnomaly: true }));
    f.store.endObserverRun({ runId: source.runId, observedAt: 20, observedDurationMs: 20, reason: 'SIGINT' }); f.close();
    const prior = f.inspect(db => { const prior = telemetrySnapshot(db); db.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON ${point}
      BEGIN SELECT RAISE(ABORT,'cleanup fixture'); END`); return prior; });
    f.open(); f.start(30); assert.throws(() => f.store.pruneOlderThan(1000), /cleanup fixture/); f.close();
    f.inspect(db => { assert.deepEqual(telemetrySnapshot(db), prior);
      assert.equal(db.prepare('SELECT state FROM observer_runs WHERE id=?').get(source.runId).state, 'clean');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); });
  });
}

test('shared region pruning failure rolls back already attempted telemetry cleanup on the same connection', () => {
  const f = fixture(); f.store.recordTelemetryResult(telemetryResult(f.run, { observedAt: 10, clockAnomaly: true })); f.close();
  const prior = f.inspect(db => { const prior = telemetrySnapshot(db); db.exec(`CREATE TRIGGER fail_region BEFORE DELETE ON region_query_outcomes
    BEGIN SELECT RAISE(ABORT,'region cleanup fixture'); END`); return prior; });
  f.open(); f.start();
  f.store.recordRegionResult({ outcome: { requestId: f.run.runId, runId: f.run.runId,
    observerPublicKey: 'AB'.repeat(32), targetPublicKey: 'CD'.repeat(32), startedAt: 0, completedAt: 10,
    clockAnomaly: false, status: 'failed', reason: 'response-timeout', route: null } });
  assert.throws(() => f.store.pruneOlderThan(1000), /region cleanup fixture/); f.close();
  f.inspect(db => assert.deepEqual(telemetrySnapshot(db), prior));
});
