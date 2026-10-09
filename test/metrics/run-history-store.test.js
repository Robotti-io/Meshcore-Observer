import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MetricsStore } from '../../src/metrics/store.js';

const stores = new Set(); const dirs = new Set();
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.clear();
});
function open(dbPath = ':memory:') { const store = new MetricsStore({ dbPath }); stores.add(store); return store; }
function close(store) { store.close(); stores.delete(store); }
function path() { const dir = mkdtempSync(join(tmpdir(), 'observer-runs-')); dirs.add(dir); return join(dir, 'metrics.sqlite3'); }
function start(overrides = {}) {
  return { runId: randomUUID(), startedAt: 1000, observedAt: 1000, observedDurationMs: 0,
    appVersion: '2.5.0', nodeVersion: process.version, platform: process.platform, architecture: process.arch, ...overrides };
}
function evidence(runId, observedDurationMs, observedAt = 1000 + observedDurationMs) {
  return { runId, observedAt, observedDurationMs };
}

test('fresh runs store truthful metadata, checkpoints and idempotent clean endings', () => {
  const store = open();
  assert.equal(store.queryObserverRuntimeSummary().instanceId, null);
  const input = start(); const run = store.beginObserverRun(input);
  assert.match(run.instanceId, /^[a-f0-9-]{36}$/);
  assert.equal(run.state, 'running'); assert.equal(run.durationIsLowerBound, true);
  assert.equal(run.endedAt, null);
  assert.deepEqual(store.beginObserverRun(input), run);
  assert.throws(() => store.beginObserverRun(start()), /already owns/);
  assert.equal(store.checkpointObserverRun(evidence(run.runId, 500)), true);
  assert.equal(store.checkpointObserverRun(evidence(run.runId, 100)), false);
  assert.equal(store.checkpointObserverRun(evidence(run.runId, 500)), false);
  assert.equal(store.endObserverRun({ ...evidence(run.runId, 800), reason: 'SIGINT' }), true);
  assert.equal(store.endObserverRun({ ...evidence(run.runId, 900), reason: 'SIGTERM' }), false);
  assert.equal(store.checkpointObserverRun(evidence(run.runId, 1000)), false);
  const ended = store.getObserverRun({ runId: run.runId });
  assert.equal(ended.endedAt, 1800); assert.equal(ended.observedDurationMs, 800);
  assert.equal(ended.endReason, 'SIGINT'); assert.equal(ended.durationIsLowerBound, false);
});

test('restart recovers unclosed runs without inventing an end time or counting downtime', () => {
  const file = path(); let store = open(file);
  const first = store.beginObserverRun(start());
  store.checkpointObserverRun(evidence(first.runId, 500));
  close(store); store = open(file);
  const second = store.beginObserverRun(start({ startedAt: 100000, observedAt: 100000 }));
  const previous = store.getObserverRun({ runId: first.runId });
  assert.equal(second.instanceId, first.instanceId);
  assert.equal(previous.state, 'unclean'); assert.equal(previous.endedAt, null); assert.equal(previous.endReason, null);
  assert.equal(previous.lastKnownAliveAt, 1500); assert.equal(previous.observedDurationMs, 500);
  store.endObserverRun({ runId: second.runId, observedAt: 100200, observedDurationMs: 200, reason: 'SIGTERM' });
  const summary = store.queryObserverRuntimeSummary();
  assert.equal(summary.observedDurationMs, 700);
  assert.equal(summary.uncleanRuns, 1); assert.equal(summary.cleanRuns, 1);
  assert.equal(summary.durationIsLowerBound, true); assert.equal(summary.retainedHistoryOnly, true);
});

test('exclusive SQLite ownership rejects a second store before recovery and releases on close', () => {
  const file = path(); const firstStore = open(file);
  const first = firstStore.beginObserverRun(start());
  assert.throws(() => open(file), (error) => {
    assert.equal(error.code, 'OBSERVER_DATABASE_IN_USE');
    assert.match(error.message, /Only one Observer/);
    assert.match(error.message, /Stop the other Observer instance or close external SQLite tools\/scripts, then restart/);
    assert.equal(error.cause.errcode & 0xff, 5);
    return true;
  });
  assert.equal(firstStore.getObserverRun({ runId: first.runId }).state, 'running');
  close(firstStore);
  const nextStore = open(file); nextStore.beginObserverRun(start());
  assert.equal(nextStore.getObserverRun({ runId: first.runId }).state, 'unclean');
});

test('an external SQLite reader receives actionable ownership guidance without starting a run', () => {
  const file = path(); const store = open(file); const reader = new DatabaseSync(file);
  try {
    reader.exec('BEGIN; SELECT * FROM observer_runs');
    assert.throws(() => store.beginObserverRun(start()), (error) => {
      assert.equal(error.code, 'OBSERVER_DATABASE_IN_USE');
      assert.match(error.message, /close external SQLite tools\/scripts, then restart/);
      assert.match(error.message, /Locks release automatically when the owning process exits/);
      assert.equal(error.cause.errcode & 0xff, 5);
      return true;
    });
    assert.equal(store.queryObserverRuntimeSummary().runs, 0);
  } finally { reader.close(); }
  assert.equal(store.beginObserverRun(start()).state, 'running');
});

test('wall clock changes do not alter monotonic duration and are flagged in retained reads', () => {
  const store = open(); const run = store.beginObserverRun(start());
  store.checkpointObserverRun(evidence(run.runId, 500, 200));
  assert.equal(store.getObserverRun({ runId: run.runId }).lastKnownAliveAt, 200);
  assert.equal(store.getObserverRun({ runId: run.runId }).wallTimeAnomaly, true);
  store.endObserverRun({ ...evidence(run.runId, 800, 10000000), reason: 'SIGINT' });
  assert.equal(store.queryObserverRuntimeSummary().observedDurationMs, 800);
  assert.equal(store.queryObserverRuntimeSummary().wallTimeAnomaly, true);
});

test('strict run inputs reject extra fields, invalid identities, bounds and reason before mutation', () => {
  const store = open();
  for (const changes of [{ runId: 'wrong' }, { observedDurationMs: -1 }, { observedAt: NaN }, { extra: true }, { platform: '' }]) {
    assert.throws(() => store.beginObserverRun(start(changes)), /Invalid run history/);
  }
  assert.equal(store.queryObserverRuntimeSummary().runs, 0);
  assert.equal(store.queryObserverRuntimeSummary().instanceId, null);
  const run = store.beginObserverRun(start());
  assert.throws(() => store.checkpointObserverRun({ ...evidence(run.runId, 100), extra: true }), /Invalid run history/);
  assert.throws(() => store.endObserverRun({ ...evidence(run.runId, 100), reason: 'crash' }), /Invalid run history/);
  assert.equal(store.endObserverRun({ ...evidence(randomUUID(), 100), reason: 'SIGINT' }), false);
  for (const query of [{ start: 2, end: 1 }, { start: 0, end: 2000, limit: 201 }, { start: 0, end: 2000, state: 'dead' }]) {
    assert.throws(() => store.queryObserverRuns(query), /Invalid run history/);
  }
  assert.equal(store.getObserverRun({ runId: run.runId }).state, 'running');
});

test('copying a closed database copies instance history; a fresh database starts independent identity', () => {
  const firstPath = path(); const secondPath = path();
  const firstStore = open(firstPath); const first = firstStore.beginObserverRun(start()); close(firstStore);
  copyFileSync(firstPath, secondPath);
  const secondStore = open(secondPath); const second = secondStore.beginObserverRun(start());
  assert.equal(second.instanceId, first.instanceId);
  assert.equal(secondStore.getObserverRun({ runId: first.runId }).state, 'unclean');
  assert.notEqual(open().beginObserverRun(start()).instanceId, first.instanceId);
});

test('migration 11 preserves existing data and rolls back a late failure', () => {
  const file = path(); let store = open(file);
  store.upsertNode({ publicKeyHex: 'AB'.repeat(32), name: 'Offline', type: 'REPEATER', heardAt: 1000 });
  store.requestFloodAdvert(1000); close(store);
  let db = new DatabaseSync(file);
  db.exec('DROP TABLE observer_runs; DROP TABLE observer_instance; PRAGMA user_version=10');
  db.exec('CREATE INDEX idx_observer_runs_active ON nodes(last_heard_at)'); db.close();
  assert.throws(() => open(file), /idx_observer_runs_active/);
  db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('observer_runs','observer_instance')").get().n, 0);
  db.exec('DROP INDEX idx_observer_runs_active'); db.close();
  store = open(file);
  assert.equal(store.countNodesByType('REPEATER'), 1);
  assert.equal(store.getFloodAdvertState().requestedAt, 1000);
  assert.equal(store.queryObserverRuntimeSummary().runs, 0);
  store.beginObserverRun(start());
});

test('start recovery and instance creation roll back atomically on a failed insert', () => {
  const file = path(); let store = open(file);
  const first = store.beginObserverRun(start()); close(store);
  const db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER fail_run BEFORE INSERT ON observer_runs BEGIN SELECT RAISE(ABORT,'full fixture'); END"); db.close();
  store = open(file);
  assert.throws(() => store.beginObserverRun(start()), /full fixture/);
  assert.equal(store.getObserverRun({ runId: first.runId }).state, 'running');
  assert.equal(store.queryObserverRuntimeSummary().runs, 1);
  close(store);
  const repair = new DatabaseSync(file); repair.exec('DROP TRIGGER fail_run'); repair.close();
  store = open(file); store.beginObserverRun(start());
  assert.equal(store.getObserverRun({ runId: first.runId }).state, 'unclean');
});

test('shared pruning protects running and retained child-referenced runs and counts retained runtime only', () => {
  const file = path(); let store = open(file);
  const first = store.beginObserverRun(start());
  store.endObserverRun({ ...evidence(first.runId, 500), reason: 'SIGINT' }); close(store);
  store = open(file);
  const second = store.beginObserverRun(start({ startedAt: 2000, observedAt: 2000 }));
  store.checkpointObserverRun({ runId: second.runId, observedAt: 2500, observedDurationMs: 500 }); close(store);
  const db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON');
  // Future dataset fixture, created before taking exclusive ownership.
  db.exec('CREATE TABLE "future process samples"(run_id TEXT REFERENCES observer_runs(id) ON DELETE RESTRICT)');
  db.prepare('INSERT INTO "future process samples" VALUES (?)').run(first.runId); db.close();
  store = open(file); const active = store.beginObserverRun(start({ startedAt: 3000, observedAt: 3000 }));
  store.pruneOlderThan(2500); // strictly-before cutoff preserves the equality unclean run.
  assert.equal(store.queryObserverRuntimeSummary().runs, 3);
  store.pruneOlderThan(2501);
  assert.equal(store.getObserverRun({ runId: second.runId }), null);
  assert.equal(store.getObserverRun({ runId: first.runId }).state, 'clean');
  assert.equal(store.getObserverRun({ runId: active.runId }).state, 'running');
  assert.equal(store.queryObserverRuntimeSummary().observedDurationMs, 500);
  assert.equal(store.queryObserverRuntimeSummary().retainedHistoryOnly, true);
  close(store);
  const cleanup = new DatabaseSync(file); cleanup.exec('DELETE FROM "future process samples"'); cleanup.close();
  store = open(file); store.pruneOlderThan(2501);
  assert.equal(store.getObserverRun({ runId: first.runId }), null);
  assert.equal(store.getObserverRun({ runId: active.runId }).state, 'running');
  assert.equal(store.queryObserverRuntimeSummary().instanceId, first.instanceId);
});

test('run pages are bounded, deterministic and select half-open start ranges without duration proration', () => {
  const file = path(); let store = open(file);
  const first = store.beginObserverRun(start());
  store.endObserverRun({ ...evidence(first.runId, 500), reason: 'SIGINT' }); close(store);
  store = open(file); const second = store.beginObserverRun(start({ startedAt: 2000, observedAt: 2000 }));
  assert.deepEqual(store.queryObserverRuns({ start: 1000, end: 2000 }).runs.map((run) => run.runId), [first.runId]);
  assert.deepEqual(store.queryObserverRuns({ start: 2000, end: 2000 }), { total: 0, runs: [] });
  const page = store.queryObserverRuns({ start: 0, end: 3000, limit: 1, offset: 1 });
  assert.equal(page.total, 2); assert.equal(page.runs[0].runId, first.runId);
  assert.equal(page.runs[0].observedDurationMs, 500);
  assert.equal(store.queryObserverRuns({ start: 0, end: 3000, state: 'running' }).runs[0].runId, second.runId);
});
