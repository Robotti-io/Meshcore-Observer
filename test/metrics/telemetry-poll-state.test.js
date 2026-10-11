import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { MetricsStore } from '../../src/metrics/store.js';
import { createTelemetryFixture, startTelemetryRun, TELEMETRY_TARGET, telemetryResult } from '../fixtures/telemetry-store.js';
import { dropTelemetryPollSchema } from '../fixtures/telemetry-downgrade.js';
import { SCOPE, POLICY, AUTH, SENSOR, WINDOW, evidence, observe, reservation, authRecord, authCompletion, completion, snapshot } from '../fixtures/telemetry-poll.js';

const fixtures = [];
const fixture = () => { const f = createTelemetryFixture(); fixtures.push(f); return f; };
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.cleanup(); });
const query = (now = 1000, extra = {}) => ({ observerPublicKey: SCOPE.observerPublicKey, now, windowMs: WINDOW, radius: 2, ...extra });
const state = (f, variant = SENSOR) => f.store.getTelemetryPollState({ ...SCOPE, variant });
const recordAuth = (f, r, extra) => f.store.completeTelemetryAuthentication(authCompletion(r, extra));
const clone = input => JSON.parse(JSON.stringify(input));

test('migration 17 adds only empty polling datasets; legacy inventory and measurement do not grant reporter evidence', () => {
  const f = fixture(); f.store.recordVerifiedAdvert({ publicKeyHex: TELEMETRY_TARGET, name: null, type: 'REPEATER',
    receivedAt: 900, hopCount: 0, eventDigest: 'ab'.repeat(32) });
  f.store.recordTelemetryResult(telemetryResult(f.run)); f.close();
  const prior = f.inspect(db => { db.exec(dropTelemetryPollSchema+' PRAGMA user_version=16;');
    return db.prepare('SELECT * FROM telemetry_observations').all(); });
  f.open(); assert.equal(f.store.queryTelemetryPollCandidates(query()).candidates.length, 0); f.close();
  f.inspect(db => { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 17);
    assert.deepEqual(db.prepare('SELECT * FROM telemetry_observations').all(), prior);
    for (const table of ['telemetry_direct_evidence', 'telemetry_auth_outcomes', 'telemetry_poll_state'])
      assert.equal(db.prepare('SELECT count(*) AS n FROM '+table).get().n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); });
});

test('last migration index failure rolls back every new table/index and version; corrected retry succeeds', () => {
  const f = fixture(); f.close(); f.inspect(db => db.exec(dropTelemetryPollSchema+
    ' PRAGMA user_version=16; CREATE INDEX idx_telemetry_poll_request ON nodes(name);'));
  assert.throws(() => f.open(), /idx_telemetry_poll_request/);
  f.inspect(db => { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 16);
    for (const table of ['telemetry_direct_evidence', 'telemetry_auth_outcomes', 'telemetry_poll_state'])
      assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_schema WHERE name=?').get(table).n, 0);
    db.exec('DROP INDEX idx_telemetry_poll_request'); }); f.open();
});

test('direct markers use captured reporter/run, monotonic original receipts and strict freshness; stale/future/self/chat cannot grant', () => {
  const f = fixture(); observe(f); observe(f, 'EF'.repeat(32), 1001); observe(f, SCOPE.observerPublicKey);
  observe(f, 'BB'.repeat(32), 900, 'EE'.repeat(32));
  assert.equal(f.store.recordTelemetryDirectEvidence(evidence(f.run, TELEMETRY_TARGET, 899)).updated, false);
  assert.deepEqual(f.store.queryTelemetryPollCandidates(query()).candidates.map(r => r.targetPublicKey), [TELEMETRY_TARGET]);
  assert.equal(f.store.getTelemetryEligibility({ ...query(), targetPublicKey: TELEMETRY_TARGET }).outboundRouteVerified, false);
  f.store.upsertNode({ publicKeyHex: TELEMETRY_TARGET, type: 'CHAT', name: null, heardAt: 1000 });
  assert.equal(f.store.getTelemetryEligibility({ ...query(), targetPublicKey: TELEMETRY_TARGET }), null);
  assert.equal(f.store.queryTelemetryPollCandidates(query(WINDOW + 900)).candidates.length, 1); // future marker becomes valid, original is at cutoff
});

for (const width of [1, 2, 3]) test(`flood eligibility width ${width} requires unique full-key repeater, fresh reporter and bounded distance`, () => {
  const f = fixture(); f.store.upsertNode({ publicKeyHex: TELEMETRY_TARGET, type: 'REPEATER', name: null, heardAt: 900 });
  const prefix = TELEMETRY_TARGET.slice(0, width * 2);
  f.store.recordTopologyObservation({ runId: f.run.runId, observerPublicKey: SCOPE.observerPublicKey, receivedAt: 900,
    route: 1, kind: 'flood-traversed', payloadVersion: 0, hashWidth: width, prefixes: [prefix, 'AA'.repeat(width)],
    transportCodes: null, containsRepeatedPrefix: false });
  assert.equal(f.store.getTelemetryEligibility({ ...query(), targetPublicKey: TELEMETRY_TARGET }).distance, 2);
  assert.equal(f.store.getTelemetryEligibility({ ...query(1000, { radius: 1 }), targetPublicKey: TELEMETRY_TARGET }), null);
  assert.equal(f.store.queryTelemetryPollCandidates(query(1000, { observerPublicKey: 'EE'.repeat(32) })).candidates.length, 0);
  f.store.upsertNode({ publicKeyHex: prefix + 'FF'.repeat(32 - width), type: 'CHAT', name: null, heardAt: 900 });
  assert.equal(f.store.getTelemetryEligibility({ ...query(), targetPublicKey: TELEMETRY_TARGET }), null);
});

test('repeated/direct-remaining topology and anomalous source runs never authorize polling', () => {
  const f = fixture(); observe(f);
  f.store.checkpointObserverRun({ runId: f.run.runId, observedAt: 1000, observedDurationMs: 5000 });
  assert.equal(f.store.queryTelemetryPollCandidates(query()).candidates.length, 0);
  assert.equal(f.store.reserveTelemetryPoll(reservation(f)).reason, 'clock-anomaly');
});

test('bounded keyset evidence pages deduplicate direct/flood candidates and reject arbitrary cursor fields', () => {
  const f = fixture(); for (const byte of ['AC', 'AD', 'AE']) observe(f, byte.repeat(32));
  const first = f.store.queryTelemetryPollCandidates(query(1000, { limit: 2 }));
  assert.equal(first.candidates.length, 2); assert.equal(first.exhausted, false);
  const next = f.store.queryTelemetryPollCandidates(query(1000, { afterPublicKey: first.nextCursor, limit: 2 }));
  assert.equal(next.candidates.length, 1); assert.equal(next.exhausted, true);
  for (const extra of [{ limit: 201 }, { afterPublicKey: ' OR 1=1' }, { radius: 64 }, { windowMs: 0 }, { password: 'SENTINEL' }])
    assert.throws(() => f.store.queryTelemetryPollCandidates(query(1000, extra)), /^Error: Invalid telemetry polling data$/);
});

test('invalid trust-boundary DTOs and ownership fail before any transaction or marker/state mutation', () => {
  const f = fixture(); observe(f); const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
  const r = reservation(f);
  for (const bad of [null, { ...r, password: 'SENTINEL' }, { ...r, radius: 0 }, { ...r, requestId: 'x' },
    { ...r, variant: { ...SENSOR, params: { permissionMask: 1 } } }, { ...r, policy: { ...POLICY, retryMaxMs: 60000 } }])
    assert.throws(() => f.store.reserveTelemetryPoll(bad), /^Error: Invalid telemetry polling data$/);
  assert.throws(() => f.store.reserveTelemetryPoll({ ...r, runId: randomUUID() }), /active owned run/);
  assert.throws(() => f.store.recordTelemetryDirectEvidence({ ...evidence(f.run), hopCount: 1 }), /Invalid telemetry polling data/);
  assert.throws(() => f.store.completeTelemetryAuthentication({ ...authCompletion({ ...r, variant: AUTH }), secret: 'SENTINEL' }), /Invalid telemetry polling data/);
  assert.equal(exec.mock.calls.length, 0); assert.equal(state(f), null);
});

test('reservation is persisted before dispatch, counts an attempt, rejects duplicates/pending overlap and unavailable evidence', () => {
  const f = fixture(), r = reservation(f);
  assert.equal(f.store.reserveTelemetryPoll(r).reason, 'ineligible'); observe(f);
  const saved = f.store.reserveTelemetryPoll(r); assert.equal(saved.reserved, true); assert.equal(saved.state.cycleAttempts, 1);
  assert.equal(saved.state.nextDueAt, r.reservedAt + POLICY.retryBaseMs);
  assert.equal(f.store.reserveTelemetryPoll(r).reason, 'duplicate-reservation');
  assert.equal(f.store.reserveTelemetryPoll(reservation(f)).reason, 'pending-reservation');
  f.close(); f.inspect(db => assert.equal(db.prepare('SELECT request_id FROM telemetry_poll_state').get().request_id, r.requestId));
});

test('completed data saves useful result and due state atomically, replay is idempotent and tampering cannot replace history', () => {
  const f = fixture(); observe(f); const r = reservation(f); f.store.reserveTelemetryPoll(r);
  const terminal = completion(f, r), saved = f.store.completeTelemetryPoll(terminal);
  assert.equal(saved.completed, true); assert.equal(saved.state.cycleAttempts, 0);
  assert.equal(saved.state.nextDueAt, terminal.result.outcome.completedAt + POLICY.refreshIntervalMs);
  assert.equal(f.store.completeTelemetryPoll(terminal).recorded.duplicate, true);
  const changed = clone(terminal); changed.result.outcome.completedAt++;
  assert.throws(() => f.store.completeTelemetryPoll(changed), /identity conflict/);
  f.close(); f.inspect(db => { assert.equal(snapshot(db).telemetry_query_outcomes.length, 1);
    assert.equal(snapshot(db).telemetry_auth_outcomes.length, 0); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); });
});

test('physical failures use capped backoff, attempts exhaust and refresh resets only the next cycle', () => {
  const f = fixture(); observe(f); let now = 1000;
  for (let i = 1; i <= POLICY.maxAttempts; i++) {
    const r = reservation(f, now); assert.equal(f.store.reserveTelemetryPoll(r).reserved, true);
    const saved = f.store.completeTelemetryPoll(completion(f, r, { status: 'failed' }));
    assert.equal(saved.state.cycleAttempts, i); assert.equal(saved.state.reason, i === POLICY.maxAttempts ? 'exhausted' : 'retry');
    assert.equal(f.store.reserveTelemetryPoll(reservation(f, now + 2)).reason, 'not-due'); now = saved.state.nextDueAt;
  }
  const next = f.store.reserveTelemetryPoll(reservation(f, now)); assert.equal(next.reserved, true); assert.equal(next.state.cycleAttempts, 1);
});

test('deferrals do not spend physical attempts or create outcomes and cannot overwrite pending reservation', () => {
  const f = fixture(); observe(f);
  const d = { ...SCOPE, variant: SENSOR, runId: f.run.runId, observedAt: 1000, nextDueAt: 2000, reason: 'quiet-air', policy: POLICY };
  assert.equal(f.store.deferTelemetryPoll(d).state.cycleAttempts, 0);
  const r = reservation(f, 2000); f.store.reserveTelemetryPoll(r);
  assert.equal(f.store.deferTelemetryPoll({ ...d, observedAt: 2000, nextDueAt: 3000 }).reason, 'pending-reservation');
});

test('slower policy extends deadlines and faster settings cannot shorten previous conservative state', () => {
  const f = fixture(); observe(f); const r = reservation(f); f.store.reserveTelemetryPoll(r);
  f.store.completeTelemetryPoll(completion(f, r, { status: 'failed' }));
  const slower = { ...POLICY, retryBaseMs: POLICY.retryBaseMs * 2 };
  const early = f.store.reserveTelemetryPoll(reservation(f, 1000 + POLICY.retryBaseMs + 2, SENSOR, { policy: slower }));
  assert.equal(early.reason, 'not-due'); const deadline = early.state.nextDueAt;
  assert.equal(f.store.reserveTelemetryPoll(reservation(f, deadline - 1)).reason, 'not-due');
  assert.equal(f.store.reserveTelemetryPoll(reservation(f, deadline)).reserved, true);
});

test('auth success persists safe original evidence and replay high-water, scoped by reporter and without a restored live grant', () => {
  const f = fixture(); observe(f); const r = reservation(f, 1000, AUTH); f.store.reserveTelemetryPoll(r);
  const saved = recordAuth(f, r); assert.equal(saved.completed, true);
  assert.deepEqual(f.store.getTelemetryAuthReplayState(SCOPE), { serverTimestamp: 100 });
  assert.deepEqual(f.store.getTelemetryAuthReplayState({ ...SCOPE, observerPublicKey: 'EE'.repeat(32) }), { serverTimestamp: null });
  assert.equal(recordAuth(f, r).duplicate, true);
  assert.throws(() => recordAuth(f, r, { completedAt: 1002 }), /identity conflict/);
  const history = f.store.queryTelemetryAuthenticationOutcomes({ ...SCOPE, start: 0, end: 2000 });
  assert.deepEqual(history.outcomes[0].record, authRecord(r)); assert.equal(history.outcomes[0].runId, f.run.runId);
  f.close(); f.open(); assert.deepEqual(f.store.getTelemetryAuthReplayState(SCOPE), { serverTimestamp: 100 });
  assert.throws(() => recordAuth(f, r), /active owned run/);
  assert.equal(state(f, AUTH).reason, 'authenticated');
});

for (const timestamp of [0, 99, 100]) test(`accepted auth timestamp ${timestamp} cannot lower/equal durable replay high-water`, () => {
  const f = fixture(); observe(f); const r = reservation(f, 1000, AUTH); f.store.reserveTelemetryPoll(r); recordAuth(f, r);
  const next = reservation(f, state(f, AUTH).nextDueAt, AUTH); f.store.reserveTelemetryPoll(next);
  const proof = { ...authRecord(next).proof, serverTimestamp: timestamp };
  assert.throws(() => recordAuth(f, next, { proof }), /replay rejected/);
  assert.equal(state(f, AUTH).reason, 'reserved'); assert.equal(f.store.getTelemetryAuthReplayState(SCOPE).serverTimestamp, 100);
});

for (const failure of ['authentication-denied', 'unsafe-login-permissions', 'unsupported-login-protocol', 'auth-replay'])
  test(`authentication ${failure} stays separate and blocks all components through longer cooldown`, () => {
    const f = fixture(); observe(f); const r = reservation(f, 1000, AUTH); f.store.reserveTelemetryPoll(r);
    const failed = { status: 'failed', reason: failure, proof: undefined };
    // Optional proof is absent on wire silence; JSON DTOs never contain undefined properties.
    const input = authCompletion(r, failed); delete input.record.proof;
    const saved = f.store.completeTelemetryAuthentication(input); assert.equal(saved.state.reason, 'auth-cooldown');
    assert.equal(f.store.reserveTelemetryPoll(reservation(f, 2000)).reason, 'auth-cooldown');
    assert.equal(f.store.getTelemetryAuthReplayState(SCOPE).serverTimestamp, null);
    f.close(); f.inspect(db => { assert.equal(db.prepare('SELECT count(*) AS n FROM telemetry_query_outcomes').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM telemetry_auth_outcomes').get().n, 1); });
  });

for (const mutate of [r => { r.proof.permissions = 1; }, r => { r.proof.isAdmin = true; }, r => { r.proof.firmwareLevel = 1; },
  r => { r.route = 'flood'; }, r => { r.proof.publicKeyPrefix = 'EF'.repeat(6); }, r => { r.proof.serverTimestamp = 0x100000000; },
  r => { r.completedAt = r.dispatchedAt - 1; }, r => { r.context.operation = 'status'; }, r => { r.password = 'SENTINEL'; }])
  test(`malformed/unprivileged auth guard ${mutate.toString()} cannot mutate audit or replay state`, () => {
    const f = fixture(); observe(f); const r = reservation(f, 1000, AUTH); f.store.reserveTelemetryPoll(r);
    const input = authCompletion(r); mutate(input.record); const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
    assert.throws(() => f.store.completeTelemetryAuthentication(input), /^Error: Invalid telemetry polling data$/);
    assert.equal(exec.mock.calls.length, 0); assert.equal(state(f, AUTH).reason, 'reserved');
  });

test('restart orphan recovery is bounded, keeps consumed attempts, advances cooldown and fabricates no terminal evidence', () => {
  const f = fixture(); observe(f); const data = reservation(f), auth = reservation(f, 1000, AUTH);
  f.store.reserveTelemetryPoll(data); f.store.reserveTelemetryPoll(auth); f.close(); f.open(); f.start(2000);
  assert.equal(f.store.reserveTelemetryPoll(reservation(f, 2000)).reason, 'pending-reservation');
  const first = f.store.recoverTelemetryPollReservations({ runId: f.run.runId, observedAt: 2000, policy: POLICY, limit: 1 });
  assert.equal(first.recovered, 1); assert.equal(first.exhausted, false);
  const next = f.store.recoverTelemetryPollReservations({ runId: f.run.runId, observedAt: 2000, policy: POLICY, limit: 1, afterRequestId: first.nextCursor });
  assert.equal(next.recovered, 1); assert.equal(state(f).cycleAttempts, 1); assert.equal(state(f, AUTH).cycleAttempts, 1);
  assert.equal(f.store.reserveTelemetryPoll(reservation(f, 2000)).reason, 'auth-cooldown');
  f.close(); f.inspect(db => { assert.equal(snapshot(db).telemetry_auth_outcomes.length, 0); assert.equal(snapshot(db).telemetry_query_outcomes.length, 0); });
});

test('durable clock rollback and future receipt cannot make evidence due or admit RF after reopen', () => {
  const f = fixture(); observe(f); f.store.reserveTelemetryPoll(reservation(f, 1000)); f.close(); f.open(); f.start(1000);
  assert.equal(f.store.queryTelemetryPollCandidates(query(999)).clockRollback, true);
  assert.equal(f.store.recoverTelemetryPollReservations({ runId: f.run.runId, observedAt: 999, policy: POLICY }).clockRollback, true);
  assert.equal(f.store.reserveTelemetryPoll(reservation(f, 999)).reason, 'clock-anomaly');
});

for (const [table, event, kind] of [['telemetry_auth_outcomes', 'INSERT', 'auth'], ['telemetry_poll_state', 'UPDATE', 'auth'],
  ['telemetry_query_outcomes', 'INSERT', 'data'], ['telemetry_observations', 'INSERT', 'data'],
  ['telemetry_latest', 'INSERT', 'data'], ['telemetry_poll_state', 'UPDATE', 'data']])
  test(`injected ${table} ${event} failure rolls back ${kind} terminal and all reservation/replay changes`, () => {
    const f = fixture(); f.close(); f.inspect(db => db.exec(`CREATE TRIGGER fail_t4 BEFORE ${event} ON ${table}
      BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;`)); f.open(); f.start(); observe(f);
    const r = reservation(f, 1000, kind === 'auth' ? AUTH : SENSOR); f.store.reserveTelemetryPoll(r);
    const before = state(f, r.variant);
    assert.throws(() => kind === 'auth' ? recordAuth(f, r) : f.store.completeTelemetryPoll(completion(f, r)), /synthetic failure/);
    assert.deepEqual(state(f, r.variant), before); f.close(); f.inspect(db => {
      const saved = snapshot(db); assert.equal(saved.telemetry_auth_outcomes.length, 0); assert.equal(saved.telemetry_query_outcomes.length, 0);
      assert.equal(saved.telemetry_observations.length, 0); assert.equal(saved.telemetry_latest.length, 0);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
  });

test('shared pruning removes old auth history but preserves replay/direct/latest state and required source runs', () => {
  const f = fixture(); observe(f); const r = reservation(f, 1000, AUTH); f.store.reserveTelemetryPoll(r); recordAuth(f, r);
  const saved = state(f, AUTH); f.store.endObserverRun({ runId: f.run.runId, observedAt: 1001, observedDurationMs: 1001, reason: 'SIGINT' });
  f.close(); f.open(); f.start(2000); f.store.pruneOlderThan(2000);
  assert.equal(f.store.queryTelemetryAuthenticationOutcomes({ start: 0, end: 2000 }).outcomes.length, 0);
  assert.deepEqual(f.store.getTelemetryAuthReplayState(SCOPE), { serverTimestamp: 100 }); assert.deepEqual(state(f, AUTH), saved);
  assert.ok(f.store.getObserverRun({ runId: r.runId }));
  f.close(); f.inspect(db => { const data = snapshot(db); assert.equal(data.telemetry_direct_evidence.length, 1);
    assert.doesNotMatch(JSON.stringify(data), /password|credential|secret|privateKey|"body":/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); });
});

test('closed backup/reopen preserves source evidence and replay guards without granting writes under an old run', async () => {
  const f = fixture(); observe(f); const r = reservation(f, 1000, AUTH); f.store.reserveTelemetryPoll(r); recordAuth(f, r); f.close();
  const source = new DatabaseSync(f.path), target = join(dirname(f.path), 'backup.sqlite3');
  try { await backup(source, target); } finally { source.close(); }
  const restored = new MetricsStore({ dbPath: target });
  try { assert.equal(restored.getTelemetryAuthReplayState(SCOPE).serverTimestamp, 100);
    assert.throws(() => restored.completeTelemetryAuthentication(authCompletion(r)), /active owned run/);
    const run = startTelemetryRun(restored, 2000); assert.notEqual(run.runId, r.runId);
    assert.equal(restored.queryTelemetryPollCandidates(query(2000)).candidates.length, 1);
  } finally { restored.close(); }
});

test('existing #33 useful receipts seed cadence without creating evidence or authentication authority', () => {
  const f = fixture(); observe(f); f.store.recordTelemetryResult(telemetryResult(f.run));
  const result = f.store.reserveTelemetryPoll(reservation(f, 2000));
  assert.equal(result.reason, 'not-due'); assert.equal(result.state.cycleAttempts, 0);
  assert.ok(result.state.nextDueAt >= 1000 + POLICY.refreshIntervalMs);
  assert.deepEqual(f.store.getTelemetryAuthReplayState(SCOPE), { serverTimestamp: null });
});

test('same target under two reporters and canonical status profiles retain separate reservations', () => {
  const f = fixture(); observe(f); observe(f, TELEMETRY_TARGET, 900, 'EE'.repeat(32));
  const status = { component: 'status', params: {}, profile: { layout: 'common48', evidence: 'unknown' } };
  for (const [observerPublicKey, variant] of [[SCOPE.observerPublicKey, SENSOR], ['EE'.repeat(32), SENSOR],
    [SCOPE.observerPublicKey, status], [SCOPE.observerPublicKey, { ...status, profile: { ...status.profile, evidence: 'established' } }]]) {
    const r = reservation(f, 1000, variant, { observerPublicKey }); assert.equal(f.store.reserveTelemetryPoll(r).reserved, true);
    assert.equal(f.store.getTelemetryPollState({ observerPublicKey, targetPublicKey: TELEMETRY_TARGET, variant }).requestId, r.requestId);
  }
});

test('partial response retains useful observation while anomalous receipt stays historical; no synthetic success', () => {
  const f = fixture(); observe(f); const r = reservation(f); f.store.reserveTelemetryPoll(r);
  const partial = f.store.completeTelemetryPoll(completion(f, r, { body: [1, 250] }));
  assert.equal(partial.completed, true); assert.equal(partial.state.cycleAttempts, 0);
  const next = reservation(f, partial.state.nextDueAt); f.store.reserveTelemetryPoll(next);
  const anomaly = completion(f, next, { clockAnomaly: true, completedAt: next.reservedAt - 1 });
  const failed = f.store.completeTelemetryPoll(anomaly);
  assert.equal(failed.state.reason, 'retry'); assert.equal(failed.recorded.latestUpdated, false);
});

test('authentication history uses bounded keyset pages and strict ranges without a browsable public API', () => {
  const f = fixture(); observe(f); let now = 1000;
  for (let i = 0; i < 3; i++) { const r = reservation(f, now, AUTH); f.store.reserveTelemetryPoll(r);
    recordAuth(f, r, { proof: { ...authRecord(r).proof, serverTimestamp: 100 + i } }); now = state(f, AUTH).nextDueAt; }
  const range = { start: 0, end: now + 1, limit: 2 }, page = f.store.queryTelemetryAuthenticationOutcomes(range);
  assert.equal(page.outcomes.length, 2); assert.equal(page.exhausted, false);
  assert.equal(f.store.queryTelemetryAuthenticationOutcomes({ ...range, afterRequestId: page.nextCursor }).outcomes.length, 1);
  for (const extra of [{ start: now + 2 }, { limit: 201 }, { afterRequestId: 'SQL' }, { password: 'SENTINEL' }])
    assert.throws(() => f.store.queryTelemetryAuthenticationOutcomes({ ...range, ...extra }), /^Error: Invalid telemetry polling data$/);
});

test('latest replay source run remains protected when newer failed attempt and direct marker belong to another run', () => {
  const f = fixture(); observe(f); const r = reservation(f, 1000, AUTH); f.store.reserveTelemetryPoll(r); recordAuth(f, r);
  const nextAt = state(f, AUTH).nextDueAt;
  f.store.endObserverRun({ runId: f.run.runId, observedAt: 1001, observedDurationMs: 1001, reason: 'SIGINT' });
  f.close(); f.open(); f.start(nextAt); observe(f, TELEMETRY_TARGET, nextAt);
  const next = reservation(f, nextAt, AUTH); f.store.reserveTelemetryPoll(next);
  const input = authCompletion(next, { status: 'failed', reason: 'authentication-denied' }); delete input.record.proof;
  f.store.completeTelemetryAuthentication(input); f.store.pruneOlderThan(nextAt);
  assert.ok(f.store.getObserverRun({ runId: r.runId })); assert.equal(state(f, AUTH).replayRunId, r.runId);
  assert.equal(state(f, AUTH).runId, f.run.runId); assert.equal(f.store.getTelemetryAuthReplayState(SCOPE).serverTimestamp, 100);
});

test('auth retention uses both original times, retains exact cutoff, and rollback preserves all datasets', () => {
  const f = fixture(); observe(f); const r = reservation(f, 1000, AUTH); f.store.reserveTelemetryPoll(r); recordAuth(f, r);
  f.store.pruneOlderThan(1001); assert.equal(f.store.queryTelemetryAuthenticationOutcomes({ start: 0, end: 2000 }).outcomes.length, 1);
  f.close(); const before = f.inspect(db => { const saved = snapshot(db); db.exec(`CREATE TRIGGER fail_prune_t4 BEFORE DELETE ON telemetry_auth_outcomes
    BEGIN SELECT RAISE(ABORT,'synthetic retention failure'); END;`); return saved; });
  f.open(); f.start(2000); assert.throws(() => f.store.pruneOlderThan(2000), /synthetic retention failure/); f.close();
  f.inspect(db => { assert.deepEqual(snapshot(db), before); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); });
});

test('stale terminal identity cannot complete another reservation and arbitrary neighbour scopes are rejected', () => {
  const f = fixture(); observe(f); const r = reservation(f); f.store.reserveTelemetryPoll(r);
  const wrong = completion(f, { ...r, requestId: randomUUID() });
  assert.equal(f.store.completeTelemetryPoll(wrong).reason, 'stale-reservation'); assert.equal(state(f).reason, 'reserved');
  const params = { version: 0, count: 3, offset: 0, orderBy: 0, prefixLength: 32 };
  for (const change of [{ count: 4 }, { prefixLength: 8 }]) assert.throws(() => f.store.reserveTelemetryPoll(
    reservation(f, 1000, { component: 'neighbours', params: { ...params, ...change } })), /Invalid telemetry polling data/);
});

for (const reason of ['response-timeout', 'write-error', 'ack-timeout', 'command-error'])
  test(`transport auth failure ${reason} follows ordinary backoff rather than unsafe-role cooldown`, () => {
    const f = fixture(); observe(f); const r = reservation(f, 1000, AUTH); f.store.reserveTelemetryPoll(r);
    const input = authCompletion(r, { status: 'failed', reason }); delete input.record.proof;
    const saved = f.store.completeTelemetryAuthentication(input);
    assert.equal(saved.state.reason, 'retry'); assert.equal(saved.state.nextDueAt, 1001 + POLICY.retryBaseMs);
    assert.equal(f.store.reserveTelemetryPoll(reservation(f, 2000, AUTH)).reason, 'not-due');
  });

test('polling success reported over flood is rejected before transaction while generic #33 remains compatible', () => {
  const f = fixture(); observe(f); const r = reservation(f); f.store.reserveTelemetryPoll(r);
  const input = completion(f, r, { route: 'flood' }), exec = vi.spyOn(DatabaseSync.prototype, 'exec');
  assert.throws(() => f.store.completeTelemetryPoll(input), /^Error: Invalid telemetry polling data$/);
  assert.equal(exec.mock.calls.length, 0); exec.mockRestore();
  assert.equal(f.store.recordTelemetryResult(telemetryResult(f.run, { route: 'flood' })).duplicate, false);
});

test('faster configured cadence takes effect on a new cycle only after the previous saved deadline', () => {
  const f = fixture(); observe(f); const r = reservation(f); f.store.reserveTelemetryPoll(r);
  f.store.completeTelemetryPoll(completion(f, r)); const oldDue = state(f).nextDueAt;
  const faster = { ...POLICY, refreshIntervalMs: 3600000 };
  assert.equal(f.store.reserveTelemetryPoll(reservation(f, oldDue - 1, SENSOR, { policy: faster })).reason, 'not-due');
  const next = reservation(f, oldDue, SENSOR, { policy: faster }), saved = f.store.reserveTelemetryPoll(next);
  assert.equal(saved.reserved, true); assert.equal(saved.state.policy.refreshIntervalMs, 3600000);
  const completed = f.store.completeTelemetryPoll(completion(f, next));
  assert.equal(completed.state.nextDueAt, oldDue + 2 + 3600000);
});
