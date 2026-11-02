import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTelemetryFixture, telemetryResult } from '../fixtures/telemetry-store.js';

const fixtures = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

test('refuses a compatible-looking newer schema before configuration or data writes and closes its handle', () => {
  const fixture = createTelemetryFixture();
  fixtures.push(fixture);
  fixture.store.recordTelemetryResult(telemetryResult(fixture.run));
  fixture.close();
  const before = fixture.inspect(db => {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA user_version=999;');
    return {
      runs: db.prepare('SELECT * FROM observer_runs').all(),
      outcomes: db.prepare('SELECT * FROM telemetry_query_outcomes').all(),
      schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()
    };
  });
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
  const close = vi.spyOn(DatabaseSync.prototype, 'close');

  assert.throws(() => fixture.open(), error => {
    assert.equal(error.code, 'OBSERVER_DATABASE_NEWER_SCHEMA');
    assert.match(error.message, /schema 999 is newer than supported schema 23/);
    assert.match(error.message, /compatible Observer version or restore a compatible backup/);
    return true;
  });
  assert.equal(exec.mock.calls.length, 0, 'refusal must precede journal configuration and migrations');
  assert.equal(close.mock.calls.length, 1, 'failed construction releases the connection');
  vi.restoreAllMocks();

  fixture.inspect(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 999);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.deepEqual(db.prepare('SELECT * FROM observer_runs').all(), before.runs);
    assert.deepEqual(db.prepare('SELECT * FROM telemetry_query_outcomes').all(), before.outcomes);
    assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), before.schema);
  });
});
