import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTelemetryFixture, telemetryDiagnostic, telemetryResult, telemetrySnapshot } from '../fixtures/telemetry-store.js';

const fixtures = [];
const fixture = () => { const f = createTelemetryFixture(); fixtures.push(f); return f; };
const range = { start: 0, end: 2000 };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

test('migration 20 preserves v19 telemetry and rolls back a late index failure before a safe retry', () => {
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
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 20);
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
