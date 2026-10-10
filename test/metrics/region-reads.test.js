import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MetricsStore } from '../../src/metrics/store.js';
import { parseRegionResponseBody } from '../../src/regions/region-response-parser.js';

const OBSERVER = 'BE'.repeat(32), TARGET = 'AC'.repeat(32), HOUR = 3600000;
const RANGE = { start: 0, end: Number.MAX_SAFE_INTEGER };
const stores = new Set(), dirs = new Set();
afterEach(() => { for (const store of stores) store.close(); stores.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.clear(); });
function file() { const dir = mkdtempSync(join(tmpdir(), 'region-reads-')); dirs.add(dir); return join(dir, 'metrics.sqlite3'); }
function open(path = ':memory:') { const store = new MetricsStore({ dbPath: path }); stores.add(store); return store; }
function close(store) { store.close(); stores.delete(store); }
function start(store, at = 0) { return store.beginObserverRun({ runId: randomUUID(), startedAt: at, observedAt: at,
  observedDurationMs: 0, appVersion: '2.4.0', nodeVersion: process.version, platform: process.platform, architecture: process.arch }); }
function result(run, { csv = '*,Be', observedAt = 1000, completedAt = observedAt + 10, brokers = [],
  target = TARGET, observer = OBSERVER, clockAnomaly = false } = {}) {
  return { outcome: { requestId: randomUUID(), runId: run.runId, observerPublicKey: observer, targetPublicKey: target,
    startedAt: 0, completedAt, clockAnomaly, status: 'answered', reason: null, route: 'direct' },
  answer: { ...parseRegionResponseBody({ body: [0,0,0,0,...Buffer.from(csv)] }).answer, observedAt }, brokerIds: brokers };
}
function failed(run, completedAt = 2000, overrides = {}) { return { outcome: { ...result(run).outcome,
  requestId: randomUUID(), completedAt, status: 'failed', reason: 'response-timeout', route: null, ...overrides } }; }
function latest(store, now = 2000, changes = {}) { return store.getRegionLatest({ observerPublicKey: OBSERVER,
  targetPublicKey: TARGET, now, windowMs: 72 * HOUR, ...changes }); }
function claim(store, run, brokerId = 'first', now = 2000) { return store.claimRegionPublication({ brokerId, runId: run.runId, now }); }
function publish(store, saved, at) { return store.resolveRegionPublication({ answerId: saved.answerId, brokerId: saved.brokerId,
  runId: saved.runId, claimToken: saved.claimToken, status: 'published', resolvedAt: at }); }
function inspect(path, work) { const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
  try { return work(db); } finally { db.close(); } }
function snapshot(db) { return Object.fromEntries(['region_publications','region_latest','region_answers','region_query_outcomes','observer_runs','runtime_events']
  .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))])); }

test('latest separates unknown, empty, nonempty and latest terminal failure without fabricating success', () => {
  const store = open(), run = start(store);
  const absent = latest(store); assert.equal(absent.presence, 'unknown'); assert.equal(absent.freshness, 'unknown');
  assert.equal(absent.answer, null); assert.equal(absent.latestOutcome, null); assert.equal(absent.coverage.retainedRecords, 0);
  store.recordRegionResult(failed(run)); assert.equal(latest(store).latestOutcome.status, 'failed'); assert.equal(latest(store).presence, 'unknown');
  const saved = store.recordRegionResult(result(run)); store.recordRegionResult(failed(run, 3000));
  const nonempty = latest(store, 3000); assert.equal(nonempty.answer.answerId, saved.answerId); assert.equal(nonempty.presence, 'non-empty');
  assert.equal(nonempty.freshness, 'fresh'); assert.equal(nonempty.latestOutcome.status, 'failed'); assert.equal(nonempty.answer.completeness, 'unknown');
  store.recordRegionResult(result(run, { csv: '', observedAt: 4000 }));
  const empty = latest(store, 5000); assert.equal(empty.presence, 'empty'); assert.deepEqual(empty.answer.regions, []);
  assert.equal(empty.fresh, true); assert.equal(empty.answer.repeaterClock, 0);
  empty.answer.regions.push('Caller mutation'); assert.deepEqual(latest(store, 5000).answer.regions, []);
  assert.equal(latest(store, 5000, { observerPublicKey: 'DD'.repeat(32) }).presence, 'unknown');
});

test('freshness uses original receipt time with strict expiry equality and explicit whole-hour overrides', () => {
  const store = open(), run = start(store); store.recordRegionResult(result(run));
  assert.equal(latest(store, 1000 + HOUR - 1, { windowMs: HOUR }).freshness, 'fresh');
  assert.equal(latest(store, 1000 + HOUR, { windowMs: HOUR }).freshness, 'stale');
  assert.equal(latest(store, 1000 + HOUR, { windowMs: 2 * HOUR }).freshness, 'fresh');
  const stale = latest(store, 1000 + 72 * HOUR); assert.equal(stale.fresh, false); assert.equal(stale.ageMs, 72 * HOUR);
  assert.equal(stale.answer.observedAt, 1000); assert.equal(stale.answer.repeaterClock, 0);
});

test('wall-clock query high water never renews expired evidence and invalid queries cannot poison it', () => {
  const store = open(), run = start(store); store.recordRegionResult(result(run));
  assert.throws(() => latest(store, Number.MAX_SAFE_INTEGER, { unexpected: 'secret' }), /^Error: Invalid region data$/);
  assert.equal(latest(store, 2000).fresh, true);
  assert.equal(latest(store, 1000 + 72 * HOUR).freshness, 'stale');
  const rollback = latest(store, 2000); assert.equal(rollback.clockRollback, true); assert.equal(rollback.freshness, 'stale');
  assert.equal(rollback.effectiveNow, 1000 + 72 * HOUR); assert.equal(rollback.answer.observedAt, 1000);
});

test('durable last-alive evidence guards freshness after reopen and wall-clock rollback', () => {
  const path = file(); let store = open(path), run = start(store); store.recordRegionResult(result(run));
  store.checkpointObserverRun({ runId: run.runId, observedAt: 1000 + 72 * HOUR, observedDurationMs: 72 * HOUR }); close(store);
  store = open(path); const read = latest(store, 2000); assert.equal(read.clockRollback, true); assert.equal(read.freshness, 'stale');
  assert.equal(read.answer.observedAt, 1000); assert.equal(read.effectiveNow, 1000 + 72 * HOUR);
});

test('future, clock-anomaly and ambiguous observations expose flags and never claim freshness', () => {
  const store = open(), run = start(store); store.recordRegionResult(result(run, { observedAt: 5000 }));
  const future = latest(store, 2000); assert.equal(future.freshness, 'future'); assert.equal(future.futureDated, true);
  assert.equal(future.ageMs, null); assert.equal(future.fresh, false);
  store.recordRegionResult(result(run, { observedAt: 6000, clockAnomaly: true }));
  const anomaly = latest(store, 7000); assert.equal(anomaly.freshness, 'clock-anomaly'); assert.equal(anomaly.answer.clockAnomaly, true);
  store.recordRegionResult(result(run, { observedAt: 8000 })); store.recordRegionResult(result(run, { observedAt: 8000, csv: 'Different' }));
  const conflict = latest(store, 9000); assert.equal(conflict.freshness, 'ambiguous'); assert.equal(conflict.answer.observationTimeConflict, true);
  store.recordRegionResult(result(run, { observedAt: 10000 })); assert.equal(latest(store, 11000).freshness, 'fresh');
});

test('answer and outcome histories are strictly half-open, reporter/run scoped and timed independently', () => {
  const store = open(), run = start(store);
  const first = store.recordRegionResult(result(run, { observedAt: 1000, completedAt: 2000 }));
  store.recordRegionResult(result(run, { observedAt: 1500, observer: 'DD'.repeat(32) }));
  store.recordRegionResult(result(run, { observedAt: 2000, target: 'EE'.repeat(32) }));
  const terminal = failed(run, 3000); store.recordRegionResult(terminal);
  assert.equal(store.queryRegionAnswers({ start: 1000, end: 2000 }).total, 2);
  assert.equal(store.queryRegionAnswers({ start: 1000, end: 1000 }).total, 0);
  assert.equal(store.queryRegionOutcomes({ start: 2000, end: 3000 }).total, 2);
  assert.equal(store.queryRegionOutcomes({ ...RANGE, status: 'failed' }).outcomes[0].requestId, terminal.outcome.requestId);
  assert.equal(store.queryRegionAnswers({ ...RANGE, observerPublicKey: OBSERVER, targetPublicKey: TARGET }).answers[0].answerId, first.answerId);
  assert.equal(store.queryRegionAnswers({ ...RANGE, runId: run.runId }).total, 3);
  assert.equal(store.queryRegionOutcomes({ ...RANGE, runId: randomUUID() }).total, 0);
  assert.equal(store.queryRegionOutcomes({ ...RANGE, observerPublicKey: OBSERVER, targetPublicKey: TARGET }).total, 2);
  assert.equal(store.queryRegionAnswers({ ...RANGE, targetPublicKey: 'AA'.repeat(32) }).coverage.retainedRecords, 0);
});

test('read models preserve exact case, whitespace, duplicates, wildcard and nullable remote clock', () => {
  const store = open(), run = start(store), input = result(run, { csv: '*, Be ,bé,Be,Be' });
  input.answer.repeaterClock = null; store.recordRegionResult(input);
  const read = latest(store); assert.deepEqual(read.answer.regions, ['*',' Be ','bé','Be','Be']);
  assert.equal(read.answer.repeaterClock, null); assert.equal(read.answer.completeness, 'unknown');
  assert.deepEqual(store.queryRegionAnswers(RANGE).answers[0].regions, read.answer.regions);
});

test('pages default to 100, cap at 200, sort ties deterministically and retain coverage beyond a page', () => {
  const store = open(), run = start(store), ids = [];
  for (let n = 0; n < 205; n++) ids.push(store.recordRegionResult(result(run, { brokers: ['first'] })).answerId);
  assert.equal(store.queryRegionAnswers(RANGE).answers.length, 100);
  const page = store.queryRegionAnswers({ ...RANGE, limit: 200 }); assert.equal(page.total, 205);
  assert.deepEqual(page.answers.map(row => row.answerId), ids.slice(5).reverse());
  assert.equal(page.coverage.retainedRecords, 205); assert.equal(page.coverage.earliestRetainedAt, 1000);
  assert.equal(page.coverage.historyCompleteness, 'unknown'); assert.equal(page.coverage.retainedHistoryOnly, true);
  assert.equal(store.queryRegionAnswers({ ...RANGE, offset: 205 }).answers.length, 0);
  const outcomes = store.queryRegionOutcomes(RANGE); assert.equal(outcomes.outcomes.length, 100);
  assert.deepEqual(outcomes.outcomes.map(row => row.requestId), outcomes.outcomes.map(row => row.requestId).sort().reverse());
  const pubs = store.queryRegionPublications({ brokerId: 'first' }); assert.equal(pubs.total, 1); // Equivalent public timestamp identities dedupe.
  assert.equal(pubs.limit, 100); assert.equal(pubs.offset, 0);
  assert.equal(store.queryRegionPublications({ brokerId: 'first', offset: 1 }).publications.length, 0);
});

test('publication reads isolate broker/scope/state and preserve unknown acknowledgement through restart', () => {
  const path = file(); let store = open(path), run = start(store);
  store.recordRegionResult(result(run, { brokers: ['first','second'] })); const first = claim(store, run); publish(store, first, 2001);
  claim(store, run, 'second');
  const published = store.queryRegionPublications({ brokerId: 'first', state: 'published' }).publications[0];
  assert.equal(published.transportAcknowledgement, 'recorded-success'); assert.equal(published.downstreamIngestion, 'unknown');
  assert.equal(Object.hasOwn(published, 'claimToken'), false);
  const publishing = store.queryRegionPublications({ brokerId: 'second', observerPublicKey: OBSERVER, targetPublicKey: TARGET }).publications[0];
  assert.equal(publishing.state, 'publishing'); assert.equal(publishing.transportAcknowledgement, 'unknown'); assert.equal(publishing.observedAt, 1000);
  assert.equal(store.queryRegionPublications({ brokerId: 'first', state: 'pending' }).total, 0); close(store);
  store = open(path); start(store, 3000);
  const pending = store.queryRegionPublications({ brokerId: 'second' }).publications[0];
  assert.equal(pending.state, 'pending'); assert.equal(pending.transportAcknowledgement, 'unknown'); assert.equal(pending.lastAttemptAt, 2000);
  assert.equal(pending.lastResultAt, null); assert.equal(pending.observedAt, 1000);
});

test('publication pages stay bounded across distinct observations, ordered by due time then ID', () => {
  const store = open(), run = start(store), ids = [];
  for (let n = 0; n < 205; n++) ids.push(store.recordRegionResult(result(run, { observedAt: n + 1000, brokers: ['first'] })).answerId);
  const page = store.queryRegionPublications({ brokerId: 'first', limit: 200 }); assert.equal(page.total, 205);
  assert.deepEqual(page.publications.map(row => row.answerId), ids.slice(0,200));
  assert.equal(store.queryRegionPublications({ brokerId: 'first', offset: 200 }).publications.length, 5);
});

test('every read and shared-prune boundary rejects invalid types, scopes, units and unknown properties before processing', () => {
  const store = open();
  for (const bad of [null, [], 'secret', 42]) {
    assert.throws(() => store.queryRegionAnswers(bad), /^Error: Invalid region data$/);
    assert.throws(() => store.queryRegionOutcomes(bad), /^Error: Invalid region data$/);
    assert.throws(() => store.queryRegionPublications(bad), /^Error: Invalid region data$/);
  }
  for (const change of [{ limit: 201 }, { limit: null }, { offset: -1 }, { offset: 0.5 }, { targetPublicKey: 'AC' }, { sql: 'secret' }]) {
    assert.throws(() => store.queryRegionAnswers({ ...RANGE, ...change }), /^Error: Invalid region data$/);
    assert.throws(() => store.queryRegionOutcomes({ ...RANGE, ...change }), /^Error: Invalid region data$/);
    assert.throws(() => store.queryRegionPublications({ brokerId: 'first', ...change }), /^Error: Invalid region data$/);
  }
  for (const change of [{ start: 2, end: 1 }, { start: '0' }, { runId: 'bad' }, { status: 'deferred' }]) {
    assert.throws(() => store.queryRegionOutcomes({ ...RANGE, ...change }), /^Error: Invalid region data$/);
  }
  assert.throws(() => store.queryRegionAnswers({ ...RANGE, status: 'answered' }), /^Error: Invalid region data$/);
  assert.throws(() => store.queryRegionPublications({ brokerId: 'first', runId: randomUUID() }), /^Error: Invalid region data$/);
  assert.throws(() => latest(store, 0, { observerPublicKey: undefined }), /^Error: Invalid region data$/);
  for (const windowMs of [0, 3600001, 8761 * HOUR, '72', null]) assert.throws(() => latest(store, 0, { windowMs }), /^Error: Invalid region data$/);
  for (const cutoff of [-1, NaN, '1000', 1.5, null]) assert.throws(() => store.pruneOlderThan(cutoff), /^Error: Invalid region data$/);
});

test('retention protects latest/empty/pending/publishing snapshots and both receipt/terminal/result cutoff equalities', () => {
  const path = file(), store = open(path), run = start(store);
  const plain = store.recordRegionResult(result(run, { observedAt: 100 }));
  const recentTerminal = store.recordRegionResult(result(run, { observedAt: 200, completedAt: 5000 }));
  const pending = store.recordRegionResult(result(run, { observedAt: 300, brokers: ['removed'] }));
  const publishing = store.recordRegionResult(result(run, { observedAt: 400, brokers: ['second'] })); claim(store, run, 'second', 600);
  const oldAck = store.recordRegionResult(result(run, { observedAt: 500, brokers: ['first'] })); publish(store, claim(store, run, 'first', 700), 800);
  const ackEquality = store.recordRegionResult(result(run, { observedAt: 600, brokers: ['first'] })); publish(store, claim(store, run, 'first', 900), 1000);
  const completeEquality = store.recordRegionResult(result(run, { observedAt: 700, completedAt: 1000 }));
  const observedEquality = store.recordRegionResult(result(run, { observedAt: 1000 }));
  const saved = store.recordRegionResult(result(run, { observedAt: 8000 }));
  const empty = store.recordRegionResult(result(run, { csv: '', observedAt: 100, target: 'DD'.repeat(32) }));
  store.recordRegionResult(failed(run, 900)); store.recordRegionResult(failed(run, 1000)); store.pruneOlderThan(1000);
  const remaining = store.queryRegionAnswers(RANGE).answers.map(row => row.answerId);
  assert.ok(!remaining.includes(plain.answerId)); assert.ok(!remaining.includes(oldAck.answerId));
  for (const kept of [recentTerminal,pending,publishing,ackEquality,completeEquality,observedEquality,saved,empty]) assert.ok(remaining.includes(kept.answerId));
  assert.equal(store.queryRegionOutcomes({ ...RANGE, status: 'failed' }).total, 1);
  assert.equal(store.queryRegionPublications({ brokerId: 'second' }).publications[0].state, 'publishing');
  assert.equal(store.queryRegionPublications({ brokerId: 'removed' }).total, 1);
  assert.equal(latest(store, 10000, { targetPublicKey: 'DD'.repeat(32) }).presence, 'empty');
  store.pruneOlderThan(1001); assert.equal(store.queryRegionPublications({ brokerId: 'first' }).total, 0);
  close(store); inspect(path, db => assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []));
});

test('protected source-run FKs survive cleanup; obsolete unreferenced ended runs disappear child-first', () => {
  const path = file(); let store = open(path), first = start(store);
  store.recordRegionResult(result(first, { observedAt: 100 })); store.recordRegionResult(failed(first, 150));
  store.endObserverRun({ runId: first.runId, observedAt: 200, observedDurationMs: 200, reason: 'SIGINT' }); close(store);
  store = open(path); const protectedRun = start(store, 300);
  store.recordRegionResult(result(protectedRun, { observedAt: 400, target: 'DD'.repeat(32), csv: '' }));
  store.recordRegionResult(result(protectedRun, { observedAt: 500, brokers: ['offline'] }));
  store.endObserverRun({ runId: protectedRun.runId, observedAt: 600, observedDurationMs: 300, reason: 'SIGINT' }); close(store);
  store = open(path); const live = start(store, 700); store.recordRegionResult(result(live, { observedAt: 800 })); store.pruneOlderThan(1000);
  assert.equal(store.getObserverRun({ runId: first.runId }), null); assert.ok(store.getObserverRun({ runId: protectedRun.runId }));
  assert.ok(store.getObserverRun({ runId: live.runId })); assert.equal(store.queryRegionAnswers({ ...RANGE, runId: protectedRun.runId }).total, 2);
  const read = latest(store, 10000); assert.equal(read.coverage.retainedRecords, 2); assert.equal(read.coverage.historyCompleteness, 'unknown');
  assert.equal(read.coverage.earliestRetainedAt, 500); close(store);
  inspect(path, db => assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []));
});

for (const point of ['region_publications','region_answers','region_query_outcomes','runtime_events']) test(`shared prune rolls back every region and source-run change when ${point} deletion fails`, () => {
  const path = file(); let store = open(path), run = start(store);
  store.recordRegionResult(result(run, { observedAt: 100, brokers: ['first'] })); publish(store, claim(store, run, 'first', 200), 300);
  store.recordRegionResult(result(run, { observedAt: 1000 })); store.recordRegionResult(failed(run, 400));
  store.recordRuntimeEvent({ runId: run.runId, observedAt: 250, kind: 'radio.connected', serviceId: null,
    state: 'connected', precision: 'event', observationWindowMs: null }); close(store);
  const before = inspect(path, db => { const saved = snapshot(db); db.exec(`CREATE TRIGGER fail_prune BEFORE DELETE ON ${point}
    BEGIN SELECT RAISE(ABORT,'retention fixture'); END`); return saved; });
  store = open(path); assert.throws(() => store.pruneOlderThan(500), /retention fixture/); close(store);
  inspect(path, db => assert.deepEqual(snapshot(db), before));
});

test('retention preserves ambiguity on the retained latest snapshot after older conflicting detail is gone', () => {
  const store = open(), run = start(store);
  store.recordRegionResult(result(run, { observedAt: 100 })); store.recordRegionResult(result(run, { observedAt: 100, csv: 'Different' }));
  store.pruneOlderThan(1000); const read = latest(store, 2000);
  assert.equal(read.coverage.retainedRecords, 1); assert.equal(read.freshness, 'ambiguous'); assert.equal(read.fresh, false);
  assert.equal(store.queryRegionOutcomes(RANGE).total, 1);
});
