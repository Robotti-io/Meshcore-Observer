import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { MetricsStore } from '../../src/metrics/store.js';
import { parseRegionResponseBody } from '../../src/regions/region-response-parser.js';
import { dropRegionSchema } from '../fixtures/region-downgrade.js';

const OBSERVER = 'BE'.repeat(32), TARGET = 'AC'.repeat(32);
const stores = new Set(), dirs = new Set();
afterEach(() => { for (const store of stores) store.close(); stores.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.clear(); });
function file() { const dir = mkdtempSync(join(tmpdir(), 'region-history-')); dirs.add(dir); return join(dir, 'metrics.sqlite3'); }
function open(path) { const store = new MetricsStore({ dbPath: path }); stores.add(store); return store; }
function close(store) { store.close(); stores.delete(store); }
function start(store, at = 0) { return store.beginObserverRun({ runId: randomUUID(), startedAt: at, observedAt: at,
  observedDurationMs: 0, appVersion: '2.4.0', nodeVersion: process.version, platform: process.platform, architecture: process.arch }); }
function inspect(path, work) { const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
  try { return work(db); } finally { db.close(); } }
function result(run, { csv = '*,Be,be-vlg', observedAt = 1000, clock = 0, brokers = [], observer = OBSERVER,
  target = TARGET, requestId = randomUUID(), completedAt = observedAt + 10 } = {}) {
  const head = Buffer.alloc(4); head.writeUInt32LE(clock);
  return { outcome: { requestId, runId: run.runId, observerPublicKey: observer, targetPublicKey: target,
    startedAt: 0, completedAt, clockAnomaly: false, status: 'answered', reason: null, route: 'direct' },
  answer: { ...parseRegionResponseBody({ body: [...head, ...Buffer.from(csv)] }).answer, observedAt }, brokerIds: brokers };
}
function snapshot(db) {
  return Object.fromEntries(['region_query_outcomes','region_answers','region_latest','region_publications']
    .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))]));
}

test('migration 14 preserves version-13 run/inventory/bot/advert/topology/process data and creates no declarations', () => {
  const path = file(); let store = open(path), run = start(store);
  store.upsertNode({ publicKeyHex: TARGET, name: 'Fixture', type: 'REPEATER', heardAt: 1000 });
  store.recordVerifiedAdvert({ publicKeyHex: TARGET, eventDigest: 'ab'.repeat(32), name: 'Fixture',
    type: 'REPEATER', receivedAt: 1000, hopCount: 0 });
  store.recordProcessSample({ runId: run.runId, sampleAt: 1000, intervalMs: null,
    cpuUserUs: null, cpuSystemUs: null, cpuPercent: null, rssBytes: 1024, heapTotalBytes: 512,
    heapUsedBytes: 256, externalBytes: 0, eventLoopActiveMs: null, eventLoopIdleMs: null,
    eventLoopUtilization: null, suppressedEvents: 0, failedEvents: 0 },
  { runId: run.runId, observedAt: 1000, observedDurationMs: 1000 });
  store.recordTopologyObservation({ runId: run.runId, observerPublicKey: OBSERVER, receivedAt: 1000,
    route: 1, kind: 'flood-traversed', payloadVersion: 0, hashWidth: 1, prefixes: ['AC'],
    transportCodes: null, containsRepeatedPrefix: false });
  store.requestFloodAdvert(1000);
  store.enqueueReplyItem({ botName: 'echo', channel: '#echo', trigger: '!echo', sender: 'Fixture', hopCount: 1,
    path: 'AC', hash: 'AB'.repeat(16), enqueuedAt: 1000, expiresAt: 5000 });
  store.recordTopologyCoverage({ runId: run.runId, observerPublicKey: OBSERVER, sampleAt: 1000,
    accepted: 1, suppressed: 0, failed: 0, malformed: 0, unsupported: 0, noRelay: 0 });
  store.recordRuntimeEvent({ runId: run.runId, observedAt: 1000, kind: 'radio.connect-error', serviceId: null,
    state: null, precision: 'event', observationWindowMs: null }); close(store);
  const prior = inspect(path, db => {
    db.exec(`${dropRegionSchema} PRAGMA user_version=13`);
    return ['observer_runs','observer_instance','nodes','bot_replies','flood_advert_state','advert_events','advert_fingerprints',
      'process_samples','topology_paths','topology_path_hops','topology_observations','topology_capture_samples','runtime_events']
      .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))]);
  });
  store = open(path); close(store);
  inspect(path, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
    for (const [table, rows] of prior) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })), rows);
    assert.ok(Object.values(snapshot(db)).every(rows => rows.length === 0));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('a late migration-index failure rolls back every region table and user_version, then retry succeeds', () => {
  const path = file(); let store = open(path); store.upsertNode({ publicKeyHex: TARGET, name: 'Kept', type: 'REPEATER', heardAt: 1 }); close(store);
  inspect(path, db => db.exec(`${dropRegionSchema} PRAGMA user_version=13;
    CREATE INDEX idx_region_publications_claim_run ON nodes(name)`));
  assert.throws(() => open(path), /idx_region_publications_claim_run/);
  inspect(path, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name LIKE 'region_%'").get().n, 0);
    assert.equal(db.prepare('SELECT name FROM nodes').get().name, 'Kept');
    db.exec('DROP INDEX idx_region_publications_claim_run');
  });
  store = open(path); close(store); inspect(path, db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14));
});

test('real owned store persists every answer and terminal failure without RF tags/raw bodies or fabricated empty success', () => {
  const path = file(), store = open(path), run = start(store);
  const first = store.recordRegionResult(result(run, { clock: 0xFFFFFFFF }));
  const failed = result(run); delete failed.answer; failed.outcome.status = 'failed'; failed.outcome.reason = 'response-timeout'; failed.outcome.route = null;
  assert.equal(store.recordRegionResult(failed).answerId, null);
  const unsupported = { ...failed, outcome: { ...failed.outcome, requestId: randomUUID(), status: 'unsupported', reason: 'anonymous-adapter-unavailable' } };
  store.recordRegionResult(unsupported);
  const empty = store.recordRegionResult(result(run, { csv: '', observedAt: 2000 }));
  assert.ok(empty.answerId > first.answerId); close(store);
  inspect(path, db => {
    const data = snapshot(db); assert.equal(data.region_query_outcomes.length, 4); assert.equal(data.region_answers.length, 2);
    assert.equal(data.region_latest[0].answer_id, empty.answerId); assert.equal(data.region_publications.length, 0);
    assert.deepEqual(JSON.parse(data.region_answers[0].regions_json), ['*', 'Be', 'be-vlg']);
    assert.equal(data.region_answers[0].repeater_clock, 0xFFFFFFFF); assert.deepEqual(JSON.parse(data.region_answers[1].regions_json), []);
    assert.equal(data.region_answers[1].repeater_clock, 0); assert.equal(data.region_answers[1].completeness, 'unknown');
    assert.doesNotMatch(JSON.stringify(data), /"tag"|"raw"|"body"|generation|password/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('latest uses observation time then stable ID; late arrivals and independent reporters/targets never overwrite newer scope', () => {
  const path = file(), store = open(path), run = start(store);
  const newest = store.recordRegionResult(result(run, { observedAt: 2000 }));
  const older = store.recordRegionResult(result(run, { observedAt: 1000, csv: 'Older' })); assert.equal(older.latestUpdated, false);
  const tie = store.recordRegionResult(result(run, { observedAt: 2000 })); assert.equal(tie.latestUpdated, true);
  const otherReporter = store.recordRegionResult(result(run, { observer: 'DD'.repeat(32), observedAt: 3000 }));
  const otherTarget = store.recordRegionResult(result(run, { target: 'EE'.repeat(32), observedAt: 3000 }));
  assert.ok(tie.answerId > newest.answerId); close(store);
  inspect(path, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM region_answers').get().n, 5);
    assert.deepEqual(db.prepare('SELECT answer_id FROM region_latest ORDER BY observer_public_key,target_public_key').all()
      .map(r => r.answer_id), [tie.answerId,otherTarget.answerId,otherReporter.answerId]);
  });
});

test('same-time identical declarations share each broker publication identity while retaining separate local observations', () => {
  const path = file(), store = open(path), run = start(store);
  const one = store.recordRegionResult(result(run, { brokers: ['first'] }));
  const two = store.recordRegionResult(result(run, { brokers: ['first','second'] }));
  assert.equal(two.observationTimeConflict, false); close(store);
  inspect(path, db => {
    const rows = snapshot(db); assert.equal(rows.region_answers.length, 2); assert.equal(rows.region_publications.length, 2);
    assert.deepEqual(rows.region_publications.map(r => [r.answer_id,r.broker_id]), [[one.answerId,'first'],[two.answerId,'second']]);
  });
});

test('conflicting same-time declarations/clock preserve both, mark the group and stage no new destinations; later unambiguous answers recover', () => {
  const path = file(), store = open(path), run = start(store);
  const first = store.recordRegionResult(result(run, { brokers: ['first'] }));
  const conflict = store.recordRegionResult(result(run, { csv: 'Different', brokers: ['second'] }));
  assert.equal(conflict.observationTimeConflict, true);
  assert.equal(store.recordRegionResult(result(run, { clock: 1, brokers: ['third'] })).observationTimeConflict, true);
  const later = store.recordRegionResult(result(run, { observedAt: 2000, brokers: ['first','second'] }));
  assert.equal(later.observationTimeConflict, false); close(store);
  inspect(path, db => {
    const rows = snapshot(db); assert.deepEqual(rows.region_answers.map(r => r.observation_time_conflict), [1,1,1,0]);
    assert.equal(rows.region_latest[0].answer_id, later.answerId);
    assert.deepEqual(rows.region_publications.map(r => [r.answer_id,r.broker_id]), [[first.answerId,'first'],[later.answerId,'first'],[later.answerId,'second']]);
  });
});

test('exact replays compare actual context/answer and preserve acknowledgements instead of restaging broker changes', () => {
  const path = file(); let store = open(path); close(store);
  inspect(path, db => db.exec(`CREATE TRIGGER fixture_ack AFTER INSERT ON region_publications BEGIN
    UPDATE region_publications SET state='published',attempt_count=1,last_result_at=3000 WHERE answer_id=NEW.answer_id; END`));
  store = open(path); const run = start(store), input = result(run, { brokers: ['first'] });
  const first = store.recordRegionResult(input);
  const duplicate = store.recordRegionResult({ answer: { ...input.answer }, brokerIds: ['second'], outcome: { ...input.outcome } });
  assert.equal(duplicate.answerId, first.answerId); assert.equal(duplicate.duplicate, true);
  for (const change of [
    { ...input, outcome: { ...input.outcome, completedAt: 2000 } },
    { ...input, outcome: { ...input.outcome, targetPublicKey: 'DD'.repeat(32) } },
    { ...input, answer: { ...input.answer, repeaterClock: 1 } }
  ]) {
    assert.throws(() => store.recordRegionResult(change), /identity conflict/);
  }
  const changed = result(run, { requestId: input.outcome.requestId, csv: 'Different' });
  assert.throws(() => store.recordRegionResult(changed), /identity conflict/); close(store);
  inspect(path, db => {
    const rows = snapshot(db); assert.equal(rows.region_answers.length, 1); assert.equal(rows.region_query_outcomes.length, 1);
    assert.equal(rows.region_publications.length, 1); assert.equal(rows.region_publications[0].broker_id, 'first');
    assert.equal(rows.region_publications[0].state, 'published'); assert.equal(rows.region_publications[0].last_result_at, 3000);
  });
});

test('failed and unsupported terminal results replay idempotently without creating an answer or replacing latest', () => {
  const path = file(), store = open(path), run = start(store);
  const saved = store.recordRegionResult(result(run));
  for (const [status, reason] of [['failed','response-timeout'],['unsupported','anonymous-adapter-unavailable']]) {
    const input = { outcome: { ...result(run).outcome, status, reason, route: null } };
    assert.equal(store.recordRegionResult(input).duplicate, false);
    assert.deepEqual(store.recordRegionResult(input), { requestId: input.outcome.requestId, answerId: null,
      duplicate: true, latestUpdated: false, observationTimeConflict: false });
    assert.throws(() => store.recordRegionResult({ outcome: { ...input.outcome, completedAt: 2000 } }), /identity conflict/);
  }
  close(store); inspect(path, db => {
    const data = snapshot(db); assert.equal(data.region_query_outcomes.length, 3);
    assert.equal(data.region_answers.length, 1); assert.equal(data.region_latest[0].answer_id, saved.answerId);
  });
});

test('a late latest-write failure rolls back prior conflict flags as well as the new observation', () => {
  const path = file(); let store = open(path), run = start(store);
  store.recordRegionResult(result(run, { brokers: ['first'] })); close(store);
  const before = inspect(path, db => { const rows = snapshot(db);
    db.exec(`CREATE TRIGGER fail_latest BEFORE INSERT ON region_latest BEGIN SELECT RAISE(ABORT,'latest fixture'); END`);
    return rows; });
  store = open(path); run = start(store, 3000);
  assert.throws(() => store.recordRegionResult(result(run, { csv: 'Conflicting', brokers: ['second'] })), /latest fixture/);
  close(store); inspect(path, db => assert.deepEqual(snapshot(db), before));
});

test('new timestamp conflicts preserve an existing publishing claim as evidence for T3 guarded resolution', () => {
  const path = file(), store = open(path), run = start(store);
  const first = store.recordRegionResult(result(run, { brokers: ['first'] }));
  const claim = store.claimRegionPublication({ brokerId: 'first', runId: run.runId, now: 2000 });
  assert.equal(store.recordRegionResult(result(run, { csv: 'Conflicting', brokers: ['second'] })).observationTimeConflict, true);
  close(store); inspect(path, db => {
    const data = snapshot(db); assert.equal(data.region_publications.length, 1);
    assert.equal(data.region_publications[0].answer_id, first.answerId);
    assert.equal(data.region_publications[0].state, 'publishing');
    assert.equal(data.region_publications[0].claim_token, claim.claimToken);
    assert.deepEqual(data.region_answers.map(row => row.observation_time_conflict), [1,1]);
  });
});

test('strict schemas and active/ended/foreign run guards reject before every database side effect', () => {
  const path = file(), store = open(path);
  const fake = { runId: randomUUID() }; assert.throws(() => store.recordRegionResult(result(fake)), /active owned run/);
  const run = start(store); const input = result(run);
  for (const value of [{ ...input, tag: 1 }, { ...input, answer: { ...input.answer, regions: ['bad\n'], csvBytes: 4 } },
    { ...input, brokerIds: ['first','first'] }, { ...input, brokerIds: Array.from({ length: 65 }, (_, i) => String(i)) },
    { ...input, outcome: { ...input.outcome, targetPublicKey: 'AC' } },
    { ...input, outcome: { ...input.outcome, status: 'deferred', reason: 'busy' } }]) {
    assert.throws(() => store.recordRegionResult(value), /Invalid region data/);
  }
  assert.throws(() => store.recordRegionResult(result(fake)), /active owned run/);
  store.endObserverRun({ runId: run.runId, observedAt: 2000, observedDurationMs: 2000, reason: 'SIGINT' });
  assert.throws(() => store.recordRegionResult(input), /active owned run/); close(store);
  inspect(path, db => assert.ok(Object.values(snapshot(db)).every(rows => rows.length === 0)));
});

for (const point of ['region_query_outcomes','region_answers','region_latest','region_publications']) test(`a ${point} insert failure rolls back the entire answer transaction`, () => {
  const path = file(); let store = open(path); close(store);
  inspect(path, db => db.exec(`CREATE TRIGGER fail_result BEFORE INSERT ON ${point} BEGIN SELECT RAISE(ABORT,'fixture failure'); END`));
  store = open(path); const run = start(store);
  assert.throws(() => store.recordRegionResult(result(run, { brokers: ['first','second'] })), /fixture failure/); close(store);
  inspect(path, db => assert.ok(Object.values(snapshot(db)).every(rows => rows.length === 0)));
});

test('late broker fan-out failure preserves a prior latest answer and rolls back all new outcome/answer/pending rows', () => {
  const path = file(); let store = open(path), run = start(store);
  const prior = store.recordRegionResult(result(run, { brokers: ['first'] })); close(store);
  const before = inspect(path, db => { const rows = snapshot(db); db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON region_publications
    WHEN NEW.broker_id='second' BEGIN SELECT RAISE(ABORT,'second broker fixture'); END`); return rows; });
  store = open(path); run = start(store, 3000);
  assert.throws(() => store.recordRegionResult(result(run, { csv: 'New', observedAt: 4000, brokers: ['first','second'] })), /second broker fixture/);
  close(store); inspect(path, db => { assert.deepEqual(snapshot(db), before); assert.equal(snapshot(db).region_latest[0].answer_id, prior.answerId); });
});

test('reopen preserves latest/empty/history/source runs and explicit pending rows with unknown acknowledgement', () => {
  const path = file(); let store = open(path), run = start(store);
  const saved = store.recordRegionResult(result(run, { csv: '', brokers: ['offline'] })); close(store);
  const before = inspect(path, db => snapshot(db)); store = open(path); run = start(store, 3000);
  const next = result(run, { observedAt: 4000 }); next.answer.repeaterClock = null;
  assert.ok(store.recordRegionResult(next).answerId > saved.answerId); close(store);
  inspect(path, db => {
    const data = snapshot(db); assert.deepEqual(data.region_publications, before.region_publications);
    assert.deepEqual(data.region_answers[0], before.region_answers[0]); assert.equal(data.region_answers[1].repeater_clock, null);
    assert.equal(db.prepare("SELECT count(*) AS n FROM observer_runs WHERE state='unclean'").get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('maximum broker fan-out uses bound values even for SQL-looking IDs and retains saved clock-anomaly timestamps', () => {
  const path = file(), store = open(path), run = start(store);
  const ids = Array.from({ length: 63 }, (_, i) => 'broker-' + i).concat("x'); DROP TABLE nodes; --");
  const input = result(run, { brokers: ids, observedAt: 1000 }); input.outcome.startedAt = 2000; input.outcome.completedAt = 500; input.outcome.clockAnomaly = true;
  store.recordRegionResult(input); close(store);
  inspect(path, db => {
    const data = snapshot(db); assert.equal(data.region_publications.length, 64); assert.equal(data.region_answers[0].observed_at, 1000);
    assert.equal(data.region_query_outcomes[0].completed_at, 500); assert.equal(data.region_query_outcomes[0].clock_anomaly, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='nodes'").get().n, 1);
  });
});

test('SQLite foreign keys reject mismatched answer/latest reporter scope and answers for failed outcomes', () => {
  const path = file(), store = open(path), run = start(store), input = result(run);
  const saved = store.recordRegionResult(input); close(store);
  inspect(path, db => {
    assert.throws(() => db.prepare('UPDATE region_latest SET observer_public_key=?').run('DD'.repeat(32)), /FOREIGN KEY/);
    assert.throws(() => db.prepare('UPDATE region_answers SET target_public_key=? WHERE id=?').run('DD'.repeat(32),saved.answerId), /FOREIGN KEY/);
    assert.throws(() => db.prepare("UPDATE region_query_outcomes SET status='failed',reason='response-timeout' WHERE request_id=?")
      .run(input.outcome.requestId), /FOREIGN KEY/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});
