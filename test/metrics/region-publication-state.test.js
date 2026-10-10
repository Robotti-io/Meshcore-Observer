import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { MetricsStore } from '../../src/metrics/store.js';
import { parseRegionResponseBody } from '../../src/regions/region-response-parser.js';

const OBSERVER = 'BE'.repeat(32), TARGET = 'AC'.repeat(32);
const stores = new Set(), dirs = new Set(), children = new Set();
afterEach(async () => {
  for (const child of children) { child.process.kill(); await child.exited; } children.clear();
  for (const store of stores) store.close(); stores.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.clear();
});
function file() { const dir = mkdtempSync(join(tmpdir(), 'region-publications-')); dirs.add(dir); return join(dir, 'metrics.sqlite3'); }
function open(path) { const store = new MetricsStore({ dbPath: path }); stores.add(store); return store; }
function close(store) { store.close(); stores.delete(store); }
function start(store, at = 0, runId = randomUUID()) { return store.beginObserverRun({ runId, startedAt: at, observedAt: at,
  observedDurationMs: 0, appVersion: '2.4.0', nodeVersion: process.version, platform: process.platform, architecture: process.arch }); }
function inspect(path, work) { const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
  try { return work(db); } finally { db.close(); } }
function result(run, { csv = '*,Be', observedAt = 1000, brokers = [], observer = OBSERVER } = {}) {
  return { outcome: { requestId: randomUUID(), runId: run.runId, observerPublicKey: observer, targetPublicKey: TARGET,
    startedAt: 0, completedAt: observedAt + 10, clockAnomaly: false, status: 'answered', reason: null, route: 'direct' },
  answer: { ...parseRegionResponseBody({ body: [0,0,0,0,...Buffer.from(csv)] }).answer, observedAt }, brokerIds: brokers };
}
function claim(store, run, brokerId = 'first', now = 2000) { return store.claimRegionPublication({ brokerId, runId: run.runId, now }); }
function resolution(saved, extras = {}) { return { answerId: saved.answerId, brokerId: saved.brokerId,
  runId: saved.runId, claimToken: saved.claimToken, resolvedAt: 2001, status: 'published', ...extras }; }
function rows(db) { return Object.fromEntries(['region_query_outcomes','region_answers','region_latest','region_publications']
  .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))])); }
function fixture(path, sql) { inspect(path, db => db.exec(sql)); }

test('explicit staging preserves progress, empty answers and equivalent public identity across reporter scopes', () => {
  const path = file(), store = open(path), run = start(store);
  const first = store.recordRegionResult(result(run, { csv: '', brokers: ['first'] }));
  const sent = claim(store, run); assert.deepEqual(sent.answer.regions, []);
  assert.equal(store.resolveRegionPublication(resolution(sent)), true);
  const equivalent = store.recordRegionResult(result(run, { csv: '' }));
  assert.deepEqual(store.stageRegionPublications({ answerId: equivalent.answerId, brokerIds: ['first','second'] }),
    { answerId: equivalent.answerId, staged: 1, observationTimeConflict: false });
  assert.equal(store.stageRegionPublications({ answerId: first.answerId, brokerIds: ['second'] }).staged, 0);
  const other = store.recordRegionResult(result(run, { csv: '', observer: 'DD'.repeat(32) }));
  assert.equal(store.stageRegionPublications({ answerId: other.answerId, brokerIds: ['first'] }).staged, 1);
  assert.equal(store.stageRegionPublications({ answerId: first.answerId, brokerIds: [] }).staged, 0);
  close(store); inspect(path, db => {
    const data = rows(db); assert.equal(data.region_answers.length, 3); assert.equal(data.region_publications.length, 3);
    const ack = data.region_publications.find(row => row.answer_id === first.answerId);
    assert.equal(ack.state, 'published'); assert.equal(ack.attempt_count, 1); assert.equal(ack.last_result_at, 2001);
  });
});

test('unknown and ambiguous answers create no staging; existing collision history remains saved', () => {
  const path = file(), store = open(path), run = start(store);
  assert.throws(() => store.stageRegionPublications({ answerId: 999, brokerIds: ['first'] }), /^Error: Region answer not found$/);
  const first = store.recordRegionResult(result(run, { brokers: ['first'] }));
  const second = store.recordRegionResult(result(run, { csv: 'Different' }));
  for (const answerId of [first.answerId,second.answerId]) assert.deepEqual(
    store.stageRegionPublications({ answerId, brokerIds: ['second'] }), { answerId, staged: 0, observationTimeConflict: true });
  assert.equal(claim(store, run), null); close(store);
  inspect(path, db => assert.equal(rows(db).region_publications.length, 1));
});

test('late staging failure rolls back every newly requested broker without altering existing acknowledgements', () => {
  const path = file(); let store = open(path), run = start(store);
  const answer = store.recordRegionResult(result(run, { brokers: ['saved'] })); close(store);
  const before = inspect(path, db => { const data = rows(db); db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON region_publications
    WHEN NEW.broker_id='second' BEGIN SELECT RAISE(ABORT,'staging fixture'); END`); return data; });
  store = open(path); start(store, 3000);
  assert.throws(() => store.stageRegionPublications({ answerId: answer.answerId, brokerIds: ['first','second'] }), /staging fixture/);
  close(store); inspect(path, db => assert.deepEqual(rows(db), before));
});

test('claims return one immutable original snapshot, never recycle a publishing item and retain older queued observations', () => {
  const path = file(), store = open(path), run = start(store);
  const one = store.recordRegionResult(result(run, { brokers: ['first'], observedAt: 1000 }));
  const two = store.recordRegionResult(result(run, { brokers: ['first'], observedAt: 2000 }));
  assert.equal(claim(store, run, 'first', 1009), null);
  const first = claim(store, run, 'first', 1010);
  assert.equal(first.answerId, one.answerId); assert.equal(first.answer.observedAt, 1000);
  assert.equal(first.observerPublicKey, OBSERVER); assert.equal(first.targetPublicKey, TARGET); assert.equal(first.sourceRunId, run.runId);
  assert.match(first.claimToken, /^[a-f0-9-]{36}$/); assert.equal(first.attemptCount, 1);
  assert.equal(store.stageRegionPublications({ answerId: one.answerId, brokerIds: ['first'] }).staged, 0);
  first.answer.regions.push('Mutated');
  assert.equal(claim(store, run, 'first', 2009), null);
  const second = claim(store, run, 'first', 2010); assert.equal(second.answerId, two.answerId);
  assert.notEqual(second.claimToken, first.claimToken); assert.equal(claim(store, run, 'first', 3000), null);
  close(store); inspect(path, db => {
    const data = rows(db); assert.deepEqual(JSON.parse(data.region_answers[0].regions_json), ['*','Be']);
    assert.equal(data.region_publications.length, 2); assert.ok(data.region_publications.every(row => row.state === 'publishing'));
  });
});

test('due ordering uses next-due then stable answer ID, and retry equality is eligible', () => {
  const path = file(), store = open(path), run = start(store);
  const one = store.recordRegionResult(result(run, { brokers: ['first'] }));
  const two = store.recordRegionResult(result(run, { brokers: ['first'], observedAt: 2000 }));
  const first = claim(store, run); assert.equal(first.answerId, one.answerId);
  assert.equal(store.resolveRegionPublication(resolution(first, { status: 'pending', reason: 'broker-unavailable', nextDueAt: 4000 })), true);
  assert.equal(claim(store, run, 'first', 3000).answerId, two.answerId);
  assert.equal(claim(store, run, 'first', 3999), null);
  const retry = claim(store, run, 'first', 4000); assert.equal(retry.answerId, one.answerId); assert.equal(retry.attemptCount, 2);
  assert.notEqual(retry.claimToken, first.claimToken); close(store);
});

test('per-broker results require the captured answer/run/token and preserve independent retry/result history', () => {
  const path = file(), store = open(path), run = start(store);
  const saved = store.recordRegionResult(result(run, { brokers: ['first','second'] }));
  const first = claim(store, run), second = claim(store, run, 'second');
  for (const changes of [{ answerId: saved.answerId + 1 }, { brokerId: 'missing' }, { brokerId: 'second' }, { claimToken: randomUUID() }]) {
    assert.equal(store.resolveRegionPublication(resolution(first, changes)), false);
  }
  assert.throws(() => store.resolveRegionPublication(resolution(first, { runId: randomUUID() })), /active owned run/);
  assert.equal(store.resolveRegionPublication(resolution(first)), true);
  assert.equal(store.resolveRegionPublication(resolution(first)), false);
  assert.equal(store.resolveRegionPublication(resolution(second, { status: 'pending', reason: 'publish-failed', nextDueAt: 3000 })), true);
  const retried = claim(store, run, 'second', 3000);
  assert.equal(store.resolveRegionPublication(resolution(second, { resolvedAt: 3001 })), false);
  assert.equal(store.resolveRegionPublication(resolution(retried, { resolvedAt: 3001 })), true); close(store);
  inspect(path, db => {
    const publications = rows(db).region_publications;
    assert.deepEqual(publications.map(row => [row.broker_id,row.state,row.attempt_count,row.last_result_at,row.last_error,row.claim_token]),
      [['first','published',1,2001,null,null],['second','published',2,3001,null,null]]);
  });
});

test('strict publication inputs reject unknown fields, unsafe IDs/types and raw errors before mutation', () => {
  const path = file(), store = open(path), run = start(store);
  const saved = store.recordRegionResult(result(run, { brokers: ['first'] }));
  const first = claim(store, run);
  for (const input of [{ answerId: saved.answerId, brokerIds: ['first','first'] }, { answerId: 0, brokerIds: [] },
    { answerId: saved.answerId, brokerIds: Array.from({ length: 65 }, (_, i) => String(i)) },
    { answerId: saved.answerId, brokerIds: ['x'.repeat(257)] }, { answerId: saved.answerId, brokerIds: [], password: 'do-not-store' }]) {
    assert.throws(() => store.stageRegionPublications(input), /^Error: Invalid region data$/);
  }
  for (const input of [{ brokerId: 'first', runId: run.runId, now: '2000' }, { brokerId: '', runId: run.runId, now: 2000 },
    { brokerId: 'first', runId: 'invalid', now: 2000 }, { brokerId: 'first', runId: run.runId, now: -1 },
    { brokerId: 'first', runId: run.runId, now: 2000, token: 'do-not-store' }]) {
    assert.throws(() => store.claimRegionPublication(input), /^Error: Invalid region data$/);
  }
  for (const input of [resolution(first, { claimToken: 'invalid' }), resolution(first, { status: 'pending', reason: 'raw-secret-error', nextDueAt: 3000 }),
    resolution(first, { status: 'pending', reason: 'publish-failed', nextDueAt: 2000 }), resolution(first, { password: 'do-not-store' }),
    resolution(first, { status: 'published', reason: 'publish-failed' }), resolution(first, { resolvedAt: 0.5 })]) {
    assert.throws(() => store.resolveRegionPublication(input), /^Error: Invalid region data$/);
  }
  close(store); inspect(path, db => {
    const data = rows(db); assert.equal(data.region_publications.length, 1); assert.equal(data.region_publications[0].state, 'publishing');
    assert.equal(data.region_publications[0].attempt_count, 1); assert.equal(data.region_publications[0].last_result_at, null);
    assert.doesNotMatch(JSON.stringify(data), /do-not-store|raw-secret-error|password/);
  });
});

test('staging, claims and resolutions require a current owned running run', () => {
  const path = file(), store = open(path), runId = randomUUID();
  assert.throws(() => store.stageRegionPublications({ answerId: 1, brokerIds: [] }), /active owned run/);
  assert.throws(() => store.claimRegionPublication({ brokerId: 'first', runId, now: 0 }), /active owned run/);
  const run = start(store), answer = store.recordRegionResult(result(run, { brokers: ['first'] })), saved = claim(store, run);
  assert.throws(() => claim(store, { runId }), /active owned run/);
  store.endObserverRun({ runId: run.runId, observedAt: 2000, observedDurationMs: 2000, reason: 'SIGINT' });
  assert.throws(() => store.stageRegionPublications({ answerId: answer.answerId, brokerIds: ['second'] }), /active owned run/);
  assert.throws(() => claim(store, run), /active owned run/);
  assert.throws(() => store.resolveRegionPublication(resolution(saved)), /active owned run/);
  close(store); inspect(path, db => assert.equal(rows(db).region_publications.length, 1));
});

test('claim write failure leaves the original pending intent, attempt count and timestamps unchanged', () => {
  const path = file(); let store = open(path), run = start(store);
  store.recordRegionResult(result(run, { brokers: ['first'] })); close(store);
  const before = inspect(path, db => { const data = rows(db); db.exec(`CREATE TRIGGER fail_claim BEFORE UPDATE ON region_publications
    WHEN NEW.state='publishing' BEGIN SELECT RAISE(ABORT,'claim fixture'); END`); return data; });
  store = open(path); run = start(store, 3000); assert.throws(() => claim(store, run), /claim fixture/);
  close(store); inspect(path, db => assert.deepEqual(rows(db), before));
});

test('resolution write failure leaves the publishing claim usable for a later local acknowledgement', () => {
  const path = file(); let store = open(path); close(store);
  fixture(path, `CREATE TRIGGER fail_result BEFORE UPDATE ON region_publications
    WHEN NEW.state='published' BEGIN SELECT RAISE(ABORT,'result fixture'); END`);
  store = open(path); const run = start(store); store.recordRegionResult(result(run, { brokers: ['first'] }));
  const first = claim(store, run); assert.throws(() => store.resolveRegionPublication(resolution(first)), /result fixture/);
  assert.equal(store.resolveRegionPublication(resolution(first, { status: 'pending', reason: 'identity-unavailable', nextDueAt: 3000 })), true);
  close(store); inspect(path, db => {
    const row = rows(db).region_publications[0]; assert.equal(row.state, 'pending'); assert.equal(row.last_error, 'identity-unavailable');
    assert.equal(row.attempt_count, 1); assert.equal(row.claim_token, null);
  });
});

test('same-time conflict invalidates both success and retry of an active claim while a later observation is claimable', () => {
  const path = file(), store = open(path), run = start(store);
  const first = store.recordRegionResult(result(run, { brokers: ['first'] })), saved = claim(store, run);
  store.recordRegionResult(result(run, { csv: 'Different', brokers: ['first'] }));
  assert.equal(store.resolveRegionPublication(resolution(saved)), false);
  assert.equal(store.resolveRegionPublication(resolution(saved, { status: 'pending', reason: 'publish-failed', nextDueAt: 3000 })), false);
  assert.equal(claim(store, run), null);
  const later = store.recordRegionResult(result(run, { observedAt: 3000, brokers: ['first'] }));
  assert.equal(claim(store, run, 'first', 4000).answerId, later.answerId); close(store);
  inspect(path, db => {
    const row = rows(db).region_publications.find(p => p.answer_id === first.answerId);
    assert.equal(row.state, 'publishing'); assert.equal(row.claim_token, saved.claimToken); assert.equal(row.last_result_at, null);
  });
});

test('reopen alone changes nothing; owned-run recovery preserves original times/results and clears only interrupted claims', () => {
  const path = file(); let store = open(path), run = start(store);
  store.recordRegionResult(result(run, { csv: '', brokers: ['first','second','disabled','removed'] }));
  const first = claim(store, run), second = claim(store, run, 'second');
  store.resolveRegionPublication(resolution(second));
  store.resolveRegionPublication(resolution(first, { status: 'pending', reason: 'broker-disabled', nextDueAt: 5000 }));
  const interrupted = claim(store, run, 'first', 5000); close(store);
  const before = inspect(path, db => rows(db)); store = open(path); close(store);
  inspect(path, db => assert.deepEqual(rows(db), before));
  store = open(path); run = start(store, 6000);
  assert.equal(claim(store, run, 'second', 6000), null);
  assert.equal(store.resolveRegionPublication(resolution(interrupted, { runId: run.runId, resolvedAt: 6000 })), false);
  assert.throws(() => store.resolveRegionPublication(resolution(interrupted)), /active owned run/);
  const next = claim(store, run, 'first', 6000); assert.equal(next.attemptCount, 3);
  assert.equal(next.answer.observedAt, 1000); assert.deepEqual(next.answer.regions, []); assert.notEqual(next.claimToken, interrupted.claimToken);
  close(store); inspect(path, db => {
    const data = rows(db); assert.deepEqual(data.region_answers, before.region_answers);
    for (const id of ['second','disabled','removed']) assert.deepEqual(data.region_publications.find(row => row.broker_id === id),
      before.region_publications.find(row => row.broker_id === id));
    const row = data.region_publications.find(row => row.broker_id === 'first');
    assert.equal(row.last_result_at, 2001); assert.equal(row.last_error, 'broker-disabled'); assert.equal(row.next_due_at, 5000);
  });
});

test('repeated begin for the same active run cannot recover its live claim', () => {
  const path = file(), store = open(path), run = start(store);
  store.recordRegionResult(result(run, { brokers: ['first'] })); const saved = claim(store, run);
  assert.equal(start(store, 0, run.runId).runId, run.runId);
  assert.equal(claim(store, run), null); assert.equal(store.resolveRegionPublication(resolution(saved)), true); close(store);
});

test('late recovery failure rolls back new-run creation, previous run recovery and every cleared claim', () => {
  const path = file(); let store = open(path), run = start(store);
  store.recordRegionResult(result(run, { brokers: ['first','second'] })); claim(store, run); claim(store, run, 'second'); close(store);
  const before = inspect(path, db => { const data = rows(db); db.exec(`CREATE TRIGGER fail_recovery BEFORE UPDATE ON region_publications
    WHEN NEW.state='pending' AND OLD.broker_id='second' BEGIN SELECT RAISE(ABORT,'recovery fixture'); END`); return data; });
  const nextId = randomUUID(); store = open(path); assert.throws(() => start(store, 4000, nextId), /recovery fixture/);
  assert.equal(store.getObserverRun({ runId: nextId }), null);
  assert.equal(store.getObserverRun({ runId: run.runId }).state, 'running'); close(store);
  inspect(path, db => { assert.deepEqual(rows(db), before); db.exec('DROP TRIGGER fail_recovery'); });
  store = open(path); start(store, 4000, nextId); close(store);
  inspect(path, db => {
    const pubs = rows(db).region_publications; assert.ok(pubs.every(row => row.state === 'pending' && row.claim_token === null && row.claim_run_id === null));
    assert.ok(pubs.every(row => row.attempt_count === 1 && row.last_attempt_at === 2000 && row.last_result_at === null));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('ambiguous recovered claims stay saved and unclaimable, without certifying delivery', () => {
  const path = file(); let store = open(path), run = start(store);
  store.recordRegionResult(result(run, { brokers: ['first'] })); const saved = claim(store, run);
  store.recordRegionResult(result(run, { csv: 'Different' })); close(store);
  store = open(path); run = start(store, 3000); assert.equal(claim(store, run), null);
  assert.equal(store.resolveRegionPublication(resolution(saved, { runId: run.runId, resolvedAt: 3001 })), false); close(store);
  inspect(path, db => { const pub = rows(db).region_publications[0]; assert.equal(pub.state, 'pending');
    assert.equal(pub.last_result_at, null); assert.equal(pub.attempt_count, 1); });
});

test('saved content is validated before explicit staging or claiming', () => {
  const path = file(); let store = open(path), run = start(store);
  const saved = store.recordRegionResult(result(run, { brokers: ['first'] })); close(store);
  fixture(path, `UPDATE region_answers SET regions_json='["Invalid"]'`); // Valid SQL JSON, inconsistent normalized CSV byte length.
  store = open(path); run = start(store, 3000);
  assert.throws(() => store.stageRegionPublications({ answerId: saved.answerId, brokerIds: ['second'] }), /^Error: Invalid region data$/);
  assert.throws(() => claim(store, run), /^Error: Invalid region data$/); close(store);
  inspect(path, db => { const pubs = rows(db).region_publications; assert.equal(pubs.length, 1);
    assert.equal(pubs[0].state, 'pending'); assert.equal(pubs[0].attempt_count, 0); });
});

test('maximum explicit staging fan-out binds SQL-looking IDs and preserves the original delayed observation', () => {
  const path = file(); let store = open(path), run = start(store);
  const saved = store.recordRegionResult(result(run)); close(store);
  store = open(path); run = start(store, 100000);
  const brokerIds = Array.from({ length: 63 }, (_, i) => 'broker-' + i).concat("x'); DROP TABLE nodes; --");
  assert.equal(store.stageRegionPublications({ answerId: saved.answerId, brokerIds }).staged, 64);
  const next = claim(store, run, brokerIds[63], 100000); assert.equal(next.answer.observedAt, 1000);
  assert.equal(next.sourceRunId === run.runId, false); close(store);
  inspect(path, db => { assert.equal(rows(db).region_publications.length, 64);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='nodes'").get().n, 1); });
});

test('a suppressed claim update returns no fabricated durable claim', () => {
  const path = file(); let store = open(path), run = start(store);
  store.recordRegionResult(result(run, { brokers: ['first'] })); close(store);
  fixture(path, `CREATE TRIGGER ignore_claim BEFORE UPDATE ON region_publications
    WHEN NEW.state='publishing' BEGIN SELECT RAISE(IGNORE); END`);
  store = open(path); run = start(store, 3000); assert.throws(() => claim(store, run), /^Error: Region publication claim conflict$/);
  close(store); inspect(path, db => { const pub = rows(db).region_publications[0]; assert.equal(pub.state, 'pending');
    assert.equal(pub.attempt_count, 0); assert.equal(pub.claim_token, null); });
});

function launch(path, mode) {
  const process = spawn(globalThis.process.execPath, [resolve('test/fixtures/region-publication-child.js'),path,mode],
    { stdio: ['ignore','ignore','pipe','ipc'], windowsHide: true });
  let output = ''; process.stderr.on('data', bytes => { output += bytes; });
  const child = { process, exited: new Promise(done => process.on('exit', (code, signal) => { children.delete(child); done({ code, signal }); })) };
  child.ready = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Child fixture readiness timed out: ' + output)), 10000);
    process.once('message', message => { clearTimeout(timer); done(message); });
    process.once('error', error => { clearTimeout(timer); reject(error); });
    process.once('exit', () => { clearTimeout(timer); reject(new Error('Child exited before readiness: ' + output)); });
  }); children.add(child); return child;
}

for (const mode of ['accepted-without-local-ack','published']) test(`abrupt process death after ${mode} preserves ownership and truthful recovery`, async () => {
  const path = file(), child = launch(path, mode), saved = await child.ready;
  assert.throws(() => open(path), error => error.code === 'OBSERVER_DATABASE_IN_USE');
  child.process.kill(); await child.exited;
  const store = open(path), run = start(store, 5000);
  assert.equal(store.getObserverRun({ runId: saved.runId }).state, 'unclean');
  assert.equal(store.resolveRegionPublication(resolution(saved.claim, { runId: run.runId, resolvedAt: 5001 })), false);
  const next = claim(store, run, 'first', 5000);
  if (mode === 'published') assert.equal(next, null);
  else {
    assert.equal(next.answerId, saved.claim.answerId); assert.equal(next.attemptCount, 2);
    assert.equal(next.requestId, saved.claim.requestId); assert.equal(next.sourceRunId, saved.runId);
    assert.equal(next.answer.observedAt, 1000); assert.deepEqual(next.answer.regions, []);
    assert.notEqual(next.claimToken, saved.claim.claimToken);
    assert.equal(store.resolveRegionPublication(resolution(next, { resolvedAt: 5001 })), true);
  }
  close(store); inspect(path, db => {
    const pubs = rows(db).region_publications;
    assert.equal(pubs.find(row => row.broker_id === 'second').state, 'pending');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('an external reader blocks recovery until exclusive ownership is acquired, preserving the original claim', () => {
  const path = file(); let store = open(path), run = start(store);
  store.recordRegionResult(result(run, { brokers: ['first'] })); const saved = claim(store, run); close(store);
  const standby = open(path), reader = new DatabaseSync(path);
  try {
    reader.exec('BEGIN; SELECT * FROM region_publications');
    assert.throws(() => start(standby, 4000), error => error.code === 'OBSERVER_DATABASE_IN_USE');
  } finally { reader.close(); }
  close(standby); inspect(path, db => { const pub = rows(db).region_publications.find(row => row.broker_id === 'first');
    assert.equal(pub.state, 'publishing'); assert.equal(pub.claim_token, saved.claimToken);
    assert.equal(db.prepare('SELECT count(*) AS n FROM observer_runs').get().n, 1); });
  store = open(path); run = start(store, 5000); assert.equal(claim(store, run, 'first', 5000).attemptCount, 2); close(store);
});
