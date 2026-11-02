import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTelemetryFixture, telemetryDiagnostic, telemetryResult, telemetrySnapshot } from '../fixtures/telemetry-store.js';

const fixtures = [];
const fixture = () => { const f = createTelemetryFixture(); fixtures.push(f); return f; };
const range = { start: 0, end: 2000 };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

test('migrations 20 and 21 preserve telemetry and roll back a late index failure before a safe retry', () => {
  const f = fixture();
  f.store.recordTelemetryResult(telemetryResult(f.run)); f.close();
  const before = f.inspect(db => {
    db.exec('DROP TABLE telemetry_request_diagnostics; PRAGMA user_version=19;');
    db.exec('CREATE INDEX idx_telemetry_diagnostics_target_time ON nodes(name);');
    return telemetrySnapshot(db);
  });
  assert.throws(() => f.open(), /idx_telemetry_diagnostics_target_time/);
  f.inspect(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('telemetry_request_diagnostics','idx_telemetry_diagnostics_time')").get().n, 0);
    assert.deepEqual(telemetrySnapshot(db), before);
    db.exec('DROP INDEX idx_telemetry_diagnostics_target_time');
  });
  f.open();
  assert.equal(f.store.queryTelemetryRequestDiagnostics(range).total, 0);
  f.close(); f.inspect(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 23);
    assert.deepEqual(telemetrySnapshot(db), before);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_telemetry_diagnostics_%'").get().n, 2);
  });
});

test('diagnostics retain original attribution through replay, pagination and reopen without inventing telemetry', () => {
  const f = fixture(), original = telemetryDiagnostic(f.run);
  assert.equal(f.store.recordTelemetryRequestDiagnostic(original).duplicate, false);
  assert.equal(f.store.recordTelemetryRequestDiagnostic(original).duplicate, true);
  assert.throws(() => f.store.recordTelemetryRequestDiagnostic({ ...original, reason: 'changed' }), /identity conflict/);
  const other = telemetryDiagnostic(f.run, { requestId: randomUUID(), completedAt: 1100,
    status: 'deferred', reason: 'quiet-air', dispatchedAt: null, phase: 'admission', dispatchMode: null });
  f.store.recordTelemetryRequestDiagnostic(other);
  assert.equal(f.store.queryTelemetryRequestDiagnostics({ start: 1001, end: 1100 }).total, 1);
  assert.equal(f.store.queryTelemetryRequestDiagnostics({ ...range, status: 'deferred' }).total, 1);
  assert.deepEqual(f.store.queryTelemetryRequestDiagnostics({ ...range, limit: 1, offset: 1 }).diagnostics, [original]);
  assert.equal(f.store.queryTelemetryOutcomes(range).total, 0);
  assert.equal(f.store.queryTelemetryObservations(range).total, 0);
  f.close(); f.open();
  const saved = f.store.queryTelemetryRequestDiagnostics(range);
  assert.deepEqual(saved.diagnostics, [other, original]);
  assert.equal(saved.coverage.retainedRecords, 2);
  assert.equal(saved.coverage.historyCompleteness, 'unknown');
});

test('diagnostic replay ignores object key order through reopen but preserves nested values and route order', () => {
  const f = fixture();
  const original = telemetryDiagnostic(f.run, {
    routeCandidatePath: ['ABCD', 'EF12'],
    routeHopWeights: [
      { position: 1, repeaterId: 'ABCD', anchorSuccessCount: 2, pathReceptionCount: 3 },
      { position: 2, repeaterId: 'EF12', anchorSuccessCount: 4, pathReceptionCount: 5 }
    ]
  });
  const reorder = object => Object.fromEntries(Object.entries(object).reverse());
  const reconstructed = reorder({
    ...original,
    routeHopWeights: original.routeHopWeights.map(reorder)
  });
  assert.equal(f.store.recordTelemetryRequestDiagnostic(original).duplicate, false);
  assert.equal(f.store.recordTelemetryRequestDiagnostic(reconstructed).duplicate, true);
  assert.throws(() => f.store.recordTelemetryRequestDiagnostic({
    ...reconstructed,
    routeCandidatePath: [...original.routeCandidatePath].reverse()
  }), /identity conflict/);
  assert.throws(() => f.store.recordTelemetryRequestDiagnostic({
    ...reconstructed,
    routeHopWeights: [
      { ...original.routeHopWeights[0], anchorSuccessCount: 99 },
      original.routeHopWeights[1]
    ]
  }), /identity conflict/);
  f.close();
  f.open();
  f.start(2000);
  // Durable writes remain owned by the active run; replay equivalence does
  // not grant a previous run permission after reopening.
  assert.throws(() => f.store.recordTelemetryRequestDiagnostic(reconstructed), /active owned run/);
  const saved = f.store.queryTelemetryRequestDiagnostics(range).diagnostics[0];
  assert.deepEqual(saved, original);
  const current = { ...original, requestId: randomUUID(), runId: f.run.runId, startedAt: 2000,
    dispatchedAt: 2000, completedAt: 2001 };
  assert.equal(f.store.recordTelemetryRequestDiagnostic(reorder(current)).duplicate, false);
  assert.equal(f.store.recordTelemetryRequestDiagnostic(current).duplicate, true);
});

test('invalid, secret-bearing and foreign-run diagnostics fail before storage; malformed reads are rejected', () => {
  const f = fixture(), valid = telemetryDiagnostic(f.run);
  for (const changes of [{ password: 'NEVER-SAVED' }, { completedAt: -1 }, { routeCandidatePath: ['invalid'] },
    { runId: randomUUID() }, { observerPublicKey: 'invalid' }]) {
    assert.throws(() => f.store.recordTelemetryRequestDiagnostic({ ...valid, ...changes }));
  }
  assert.equal(f.store.queryTelemetryRequestDiagnostics(range).total, 0);
  for (const changes of [{ limit: 201 }, { offset: -1 }, { extra: true }, { start: 2001 }, { status: "' OR 1=1" }]) {
    assert.throws(() => f.store.queryTelemetryRequestDiagnostics({ ...range, ...changes }));
  }
});

test('stored diagnostics support the complete validated contact inventory capacity and reject overflow', () => {
  const f = fixture();
  for (const inventoryContactCount of [350, 351, 1024]) {
    const input = telemetryDiagnostic(f.run, { inventoryContactCount });
    assert.equal(f.store.recordTelemetryRequestDiagnostic(input).duplicate, false);
  }
  assert.throws(() => f.store.recordTelemetryRequestDiagnostic(
    telemetryDiagnostic(f.run, { inventoryContactCount: 1025 })
  ), /Invalid telemetry data/);
  const saved = f.store.queryTelemetryRequestDiagnostics(range);
  assert.equal(saved.total, 3, 'over-limit diagnostics fail before persistence');
  assert.deepEqual(saved.diagnostics.map(row => row.inventoryContactCount).sort((a, b) => a - b), [350, 351, 1024]);
});
