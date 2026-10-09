import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { MetricsStore } from '../../src/metrics/store.js';
import { ProcessMeasurements } from '../../src/metrics/process-measurements.js';
import { dropTopologySchema } from '../fixtures/topology-downgrade.js';

const stores = new Set(); const dirs = new Set();
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.clear();
});
function path() { const dir = mkdtempSync(join(tmpdir(), 'process-history-')); dirs.add(dir); return join(dir, 'metrics.sqlite3'); }
function open(file = ':memory:') { const store = new MetricsStore({ dbPath: file }); stores.add(store); return store; }
function close(store) { store.close(); stores.delete(store); }
function start(store, at = 0) {
  return store.beginObserverRun({ runId: randomUUID(), startedAt: at, observedAt: at, observedDurationMs: 0,
    appVersion: '2.5.0', nodeVersion: process.version, platform: process.platform, architecture: process.arch });
}
const measurements = { intervalMs: 1000, cpuUserUs: 200000, cpuSystemUs: 50000, cpuPercent: 25,
  rssBytes: 100, heapTotalBytes: 80, heapUsedBytes: 60, externalBytes: 20,
  eventLoopActiveMs: 250, eventLoopIdleMs: 750, eventLoopUtilization: 0.25 };
function sample(run, at, changes = {}) { return { runId: run.runId, sampleAt: at, ...measurements, suppressedEvents: 0, failedEvents: 0, ...changes }; }
function checkpoint(run, at) { return { runId: run.runId, observedAt: at, observedDurationMs: at - run.startedAt }; }
function event(run, at, changes = {}) { return { runId: run.runId, observedAt: at, kind: 'radio.connect-error', serviceId: null,
  state: null, precision: 'event', observationWindowMs: null, ...changes }; }
const range = { start: 0, end: Number.MAX_SAFE_INTEGER };

test('process samples atomically link a live owned run and survive close/reopen with typed events', () => {
  const file = path(); const store = open(file); const run = start(store);
  const id = store.recordProcessSample(sample(run, 1000, { suppressedEvents: 2, failedEvents: 1 }), checkpoint(run, 1000));
  store.recordRuntimeEvent(event(run, 1000));
  assert.equal(store.getObserverRun({ runId: run.runId }).observedDurationMs, 1000);
  close(store); const reopened = open(file);
  assert.deepEqual(reopened.queryProcessSamples(range).samples, [{ id, ...sample(run, 1000, { suppressedEvents: 2, failedEvents: 1 }) }]);
  const recorded = reopened.queryRuntimeEvents(range).events[0]; assert.equal(recorded.runId, run.runId);
  assert.equal(recorded.kind, 'radio.connect-error'); assert.equal(recorded.observationWindowMs, null);
});
test('failed sample insert rolls back its heartbeat without corrupting the run or other history', () => {
  const file = path(); const store = open(file); const db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER fail_sample BEFORE INSERT ON process_samples BEGIN SELECT RAISE(ABORT,'full fixture'); END"); db.close();
  const run = start(store);
  assert.throws(() => store.recordProcessSample(sample(run, 1000), checkpoint(run, 1000)), /full fixture/);
  assert.equal(store.getObserverRun({ runId: run.runId }).observedDurationMs, 0);
  assert.equal(store.queryProcessSamples(range).total, 0);
});
test('strict inputs, mismatched checkpoints, stale or foreign runs fail before mutation', () => {
  const store = open(); const run = start(store);
  for (const changes of [{ extra: true }, { cpuPercent: -1 }, { rssBytes: -1 }, { cpuSystemUs: null },
    { intervalMs: null }, { eventLoopUtilization: 1.1 }, { failedEvents: -1 }]) {
    assert.throws(() => store.recordProcessSample(sample(run, 1000, changes), checkpoint(run, 1000)), /Invalid process history/);
  }
  assert.throws(() => store.recordProcessSample(sample(run, 1000), checkpoint(run, 999)), /share run and observation/);
  const foreign = { ...run, runId: randomUUID() };
  assert.throws(() => store.recordProcessSample(sample(foreign, 1000), checkpoint(foreign, 1000)), /active owned run/);
  for (const changes of [{ message: 'secret' }, { kind: 'all.logs' }, { state: 'ready' }, { observedAt: -1 }]) {
    assert.throws(() => store.recordRuntimeEvent(event(run, 1000, changes)), /Invalid process history/);
  }
  assert.throws(() => store.recordRuntimeEvent(event(foreign, 1000)), /active owned run/);
  assert.equal(store.queryProcessSamples(range).total, 0); assert.equal(store.queryRuntimeEvents(range).total, 0);
  store.recordProcessSample(sample(run, 1000), checkpoint(run, 1000));
  assert.throws(() => store.recordProcessSample(sample(run, 500), checkpoint(run, 500)), /non-regressing/);
  store.endObserverRun({ ...checkpoint(run, 1100), reason: 'SIGINT' });
  assert.throws(() => store.recordProcessSample(sample(run, 1200), checkpoint(run, 1200)), /active owned run/);
  assert.throws(() => store.recordRuntimeEvent(event(run, 1200)), /active owned run/);
});
test('half-open capped pages preserve run linkage, allowlisted filters and deterministic ordering', () => {
  const store = open(); const run = start(store);
  for (const at of [1000, 2000, 3000]) {
    store.recordProcessSample(sample(run, at), checkpoint(run, at));
    store.recordRuntimeEvent(event(run, at, at === 2000 ? { kind: 'broker.state', serviceId: 'local', state: 'connected',
      precision: 'sample', observationWindowMs: 1000 } : {}));
  }
  assert.equal(store.queryProcessSamples({ start: 1000, end: 3000, limit: 1 }).total, 2);
  assert.equal(store.queryProcessSamples({ start: 1000, end: 3000, limit: 1, offset: 1 }).samples[0].sampleAt, 1000);
  assert.equal(store.queryRuntimeEvents({ start: 1000, end: 3000, kind: 'broker.state', serviceId: 'local' }).total, 1);
  assert.equal(store.queryRuntimeEvents({ ...range, serviceId: 'LOCAL' }).total, 0);
  assert.equal(store.queryProcessSamples({ ...range, runId: randomUUID() }).total, 0);
  assert.equal(store.queryRuntimeEvents({ start: 3000, end: 3000 }).total, 0);
  for (const query of [{ start: 2, end: 1 }, { ...range, limit: 201 }, { ...range, offset: -1 }, { ...range, message: 'secret' }]) {
    assert.throws(() => store.queryProcessSamples(query), /Invalid process history/);
    assert.throws(() => store.queryRuntimeEvents(query), /Invalid process history/);
  }
  assert.throws(() => store.queryProcessHistory({ ...range, maxBuckets: 1001 }), /Invalid process history/);
});
test('bucketed history weights valid CPU/ELU intervals and preserves missing measurements and empty gaps', () => {
  const store = open(); const run = start(store);
  store.recordProcessSample(sample(run, 1000, { intervalMs: null, cpuUserUs: null, cpuSystemUs: null, cpuPercent: null,
    eventLoopActiveMs: null, eventLoopIdleMs: null, eventLoopUtilization: null }), checkpoint(run, 1000));
  store.recordProcessSample(sample(run, 2000), checkpoint(run, 2000));
  store.recordProcessSample(sample(run, 5000, { intervalMs: 3000, cpuUserUs: 3000000, cpuSystemUs: 0, cpuPercent: 100,
    eventLoopActiveMs: 3000, eventLoopIdleMs: 0, eventLoopUtilization: 1, rssBytes: null }), checkpoint(run, 5000));
  let rows = store.queryProcessHistory({ start: 0, end: 10000, maxBuckets: 1 });
  assert.equal(rows.length, 1); assert.equal(rows[0].cpuPercent, 81.25);
  assert.equal(rows[0].eventLoopUtilization, 0.8125); assert.equal(rows[0].rssBytes, 100);
  assert.equal(rows[0].cpuSampleCount, 2); assert.equal(rows[0].rssSampleCount, 2);
  assert.equal(rows[0].heapUsedSampleCount, 3);
  rows = store.queryProcessHistory({ start: 1000, end: 2000, maxBuckets: 1 });
  assert.equal(rows[0].cpuPercent, null); assert.equal(rows[0].eventLoopUtilization, null);
  assert.equal(rows[0].runId, run.runId);
  assert.deepEqual(store.queryProcessHistory({ start: 6000, end: 10000 }), []);
});
test('mixed-run buckets identify scope without adding downtime or creating unbounded per-run groups', () => {
  const file = path(); let store = open(file); const first = start(store);
  store.recordProcessSample(sample(first, 1000), checkpoint(first, 1000));
  store.endObserverRun({ ...checkpoint(first, 1500), reason: 'SIGINT' }); close(store);
  store = open(file); const second = start(store, 10000);
  store.recordProcessSample(sample(second, 11000), checkpoint(second, 11000));
  const history = store.queryProcessHistory({ start: 0, end: 12000, maxBuckets: 1 });
  assert.equal(history.length, 1); assert.equal(history[0].runId, null); assert.equal(history[0].runCount, 2);
  assert.equal(history[0].cpuPercent, 25);
  assert.equal(store.queryProcessHistory({ start: 0, end: 12000, maxBuckets: 1, runId: first.runId })[0].runId, first.runId);
});
test('shared pruning expires children first, protects retained referenced parents and equality, and preserves live runs', () => {
  const file = path(); let store = open(file); const first = start(store);
  store.recordProcessSample(sample(first, 1000), checkpoint(first, 1000));
  store.recordRuntimeEvent(event(first, 1500));
  store.endObserverRun({ ...checkpoint(first, 1500), reason: 'SIGINT' }); close(store);
  store = open(file); const live = start(store, 3000);
  store.pruneOlderThan(1500); assert.equal(store.queryProcessSamples(range).total, 0);
  assert.equal(store.queryRuntimeEvents(range).total, 1); assert.ok(store.getObserverRun({ runId: first.runId }));
  store.pruneOlderThan(1501); assert.equal(store.queryRuntimeEvents(range).total, 0);
  assert.equal(store.getObserverRun({ runId: first.runId }), null);
  assert.equal(store.getObserverRun({ runId: live.runId }).state, 'running');
});
test('migration 12 adds empty histories, preserves old run/node state and rolls back a late failure', () => {
  const file = path(); let store = open(file); const run = start(store);
  store.upsertNode({ publicKeyHex: 'AB'.repeat(32), name: 'Offline', type: 'REPEATER', heardAt: 1000 }); close(store);
  let db = new DatabaseSync(file);
  db.exec(`${dropTopologySchema} DROP TABLE runtime_events; DROP TABLE process_samples; PRAGMA user_version=11`);
  db.exec('CREATE INDEX idx_runtime_events_kind_at ON nodes(last_heard_at)'); db.close();
  assert.throws(() => open(file), /idx_runtime_events_kind_at/);
  db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('process_samples','runtime_events')").get().n, 0);
  db.exec('DROP INDEX idx_runtime_events_kind_at'); db.close();
  store = open(file); assert.equal(store.queryProcessSamples(range).total, 0);
  assert.equal(store.queryRuntimeEvents(range).total, 0); assert.equal(store.countNodesByType('REPEATER'), 1);
  assert.equal(store.getObserverRun({ runId: run.runId }).state, 'running');
  const next = start(store, 10000); assert.equal(store.getObserverRun({ runId: run.runId }).state, 'unclean');
  assert.equal(next.instanceId, run.instanceId);
});
test('20,000 retained resource rows use range indexes and bound reads; report native collection/write overhead', () => {
  const file = path(); let store = open(file); const previous = start(store); close(store);
  // Batch fixture setup only. Timed observations below use normal per-sample
  // collection/checkpoint/transaction writes, including SQLite sync overhead.
  const seed = new DatabaseSync(file);
  try {
    seed.exec('PRAGMA foreign_keys=ON; BEGIN');
    const insert = seed.prepare(`INSERT INTO process_samples
      (run_id,sample_at,interval_ms,cpu_user_us,cpu_system_us,cpu_percent,rss_bytes,heap_total_bytes,heap_used_bytes,
       external_bytes,event_loop_active_ms,event_loop_idle_ms,event_loop_utilization,suppressed_events,failed_events)
      VALUES(?,?,1000,200000,50000,25,100,80,60,20,250,750,0.25,0,0)`);
    for (let index = 1; index <= 20000; index++) insert.run(previous.runId, index * 1000);
    seed.exec('COMMIT');
  } finally { seed.close(); }
  store = open(file); const run = start(store, 20000000);
  const collector = new ProcessMeasurements(); const timings = [];
  for (let index = 20001; index <= 20500; index++) {
    const before = performance.now(); const { measurements: native } = collector.collect();
    const at = index * 1000; store.recordProcessSample(sample(run, at, native), checkpoint(run, at));
    timings.push(performance.now() - before);
  }
  timings.sort((a, b) => a - b);
  const queryStarted = performance.now();
  const buckets = store.queryProcessHistory({ ...range, maxBuckets: 10 });
  assert.ok(buckets.length <= 10); assert.equal(store.queryProcessSamples({ ...range, limit: 200 }).samples.length, 200);
  console.info('Process collection/write fixture:', { retainedSamples: 20500, p95Ms: Number(timings[475].toFixed(3)),
    maximumMs: Number(timings.at(-1).toFixed(3)), boundedReadsMs: Number((performance.now() - queryStarted).toFixed(3)),
    platform: process.platform, node: process.version, targetP95Ms: 10 });
  close(store); const db = new DatabaseSync(file);
  try {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM process_samples WHERE sample_at>=? AND sample_at<?').all(1000, 2000);
    assert.match(JSON.stringify(plan), /idx_process_samples_at/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
}, 20000);
