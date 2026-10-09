import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MetricsStore } from '../../src/metrics/store.js';
import { parseTopologyFrame } from '../../src/nodes/topology-parser.js';
import { buildRawFrame } from '../fixtures/packet-frames.js';
import { dropTopologySchema } from '../fixtures/topology-downgrade.js';

const OBSERVER = 'CD'.repeat(32); const HOUR = 3600000;
const RANGE = { start: 0, end: Number.MAX_SAFE_INTEGER };
const stores = new Set(); const dirs = new Set();
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.clear();
});
function file() { const dir = mkdtempSync(join(tmpdir(), 'topology-')); dirs.add(dir); return join(dir, 'metrics.sqlite3'); }
function open(path = ':memory:') { const store = new MetricsStore({ dbPath: path }); stores.add(store); return store; }
function close(store) { store.close(); stores.delete(store); }
function start(store, at = 0) {
  return store.beginObserverRun({ runId: randomUUID(), startedAt: at, observedAt: at, observedDurationMs: 0,
    appVersion: '2.4.0', nodeVersion: process.version, platform: process.platform, architecture: process.arch });
}
function evidence(run, at = 1000, { hops = ['AC01', '9905', 'E85C'], width = 2, route = 1, observer = OBSERVER } = {}) {
  return parseTopologyFrame({ runId: run.runId, observerPublicKey: observer, receivedAt: at,
    raw: buildRawFrame({ payloadType: 3, routeType: route, pathHashSize: width, hops,
      transportCodes: [0x1234, 0x5678], payload: Buffer.from('opaque-secret') }).toString('hex') }).evidence;
}
const coverage = (run, at = 1000) => ({ runId: run.runId, observerPublicKey: OBSERVER, sampleAt: at,
  accepted: 1, suppressed: 2, failed: 3, malformed: 4, unsupported: 5, noRelay: 6 });
function node(store, prefix, suffix = '00', type = 'REPEATER', name = null) {
  const publicKeyHex = prefix.padEnd(62, '0') + suffix;
  store.upsertNode({ publicKeyHex, name, type, heardAt: 1000 }); return publicKeyHex;
}
const proximity = (store, changes = {}) => store.queryObservedProximity({ observerPublicKey: OBSERVER, now: 2000, windowMs: 72 * HOUR, radius: 2, ...changes });

test('atomic compact receptions retain exact count, positions, chronology and run identity across restart', () => {
  const path = file(); let store = open(path); const run = start(store);
  const first = store.recordTopologyObservation(evidence(run, 2000));
  assert.equal(store.recordTopologyObservation(evidence(run, 1000)).pathId, first.pathId);
  store.recordTopologyObservation(evidence(run, 2000)); store.recordTopologyCoverage(coverage(run, 2000));
  close(store); store = open(path);
  const record = store.getTopologyPath({ pathId: first.pathId });
  assert.equal(record.receptionCount, 3); assert.equal(record.firstReceivedAt, 1000); assert.equal(record.lastReceivedAt, 2000);
  assert.deepEqual(record.hops.map((hop) => [hop.prefix, hop.distance]), [['AC01', 3], ['9905', 2], ['E85C', 1]]);
  assert.ok(record.hops.every((hop) => hop.resolution === 'unresolved' && hop.identity === null));
  assert.equal(record.countScope, 'cumulative'); assert.equal(record.outboundRouteVerified, false);
  assert.equal(store.queryTopologyObservations({ start: 1000, end: 2000 }).total, 1);
  assert.equal(store.queryTopologyRouteCounts({ start: 1000, end: 2001 }).paths[0].receptionCount, 3);
  assert.equal(store.queryTopologyCoverage(RANGE).samples[0].noRelay, 6);
  assert.equal(store.countNodesByType('REPEATER'), 0);
  assert.doesNotMatch(JSON.stringify(record), /opaque-secret|payload|raw|SNR|RSSI/);
  const next = start(store, 3000);
  assert.equal(store.recordTopologyObservation(evidence(next, 1500)).pathId, first.pathId);
  assert.equal(store.getTopologyPath({ pathId: first.pathId }).lastReceivedAt, 2000);
});

test('storage guards reject unowned/ended runs, schema errors and mismatched repeated-prefix flags before side effects', () => {
  const store = open(); const run = start(store);
  assert.throws(() => store.recordTopologyObservation(evidence({ runId: randomUUID() })), /active owned run/);
  assert.throws(() => store.recordTopologyCoverage(coverage({ runId: randomUUID() })), /active owned run/);
  for (const changes of [{ receivedAt: -1 }, { raw: 'secret' }, { kind: 'direct-remaining' }, { containsRepeatedPrefix: true },
    { observerPublicKey: OBSERVER.toLowerCase() }, { hashWidth: 4 }]) {
    assert.throws(() => store.recordTopologyObservation({ ...evidence(run), ...changes }), /Invalid topology evidence/);
  }
  assert.throws(() => store.recordTopologyCoverage({ ...coverage(run), accepted: -1 }), /Invalid topology input/);
  assert.equal(store.queryTopologyPaths().total, 0);
  store.endObserverRun({ runId: run.runId, observedAt: 2000, observedDurationMs: 2000, reason: 'SIGINT' });
  assert.throws(() => store.recordTopologyObservation(evidence(run)), /active owned run/);
});

test('late observation failure rolls back a new path/hops and an existing path frequency update', () => {
  const path = file(); let store = open(path); const firstRun = start(store);
  const first = store.recordTopologyObservation(evidence(firstRun)); close(store);
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER fail_topology BEFORE INSERT ON topology_observations BEGIN SELECT RAISE(ABORT,'disk fixture'); END"); db.close();
  store = open(path); const run = start(store, 2000);
  assert.throws(() => store.recordTopologyObservation(evidence(run, 3000)), /disk fixture/);
  assert.throws(() => store.recordTopologyObservation(evidence(run, 3000, { hops: ['AA01'] })), /disk fixture/);
  assert.equal(store.queryTopologyPaths().total, 1); assert.equal(store.queryTopologyObservations(RANGE).total, 1);
  assert.equal(store.getTopologyPath({ pathId: first.pathId }).receptionCount, 1);
  close(store); const inspect = new DatabaseSync(path);
  assert.equal(inspect.prepare('SELECT count(*) AS n FROM topology_path_hops').get().n, 3); inspect.close();
});

test('existing digests verify serialized AND actual canonical fields before coalescing', () => {
  for (const column of ['canonical', 'path_hex', 'observer_public_key']) {
    const path = file(); let store = open(path); const run = start(store);
    store.recordTopologyObservation(evidence(run)); close(store);
    const db = new DatabaseSync(path); db.prepare(`UPDATE topology_paths SET ${column}=?`).run('changed'); db.close();
    store = open(path); const next = start(store, 2000);
    assert.throws(() => store.recordTopologyObservation(evidence(next)), /digest collision/);
    assert.equal(store.queryTopologyPaths().paths[0].receptionCount, 1);
  }
});

test('distinct widths, route/transport modes, ordered paths and observing radios never combine evidence', () => {
  const store = open(); const run = start(store);
  for (const options of [{}, { route: 0 }, { route: 2 }, { route: 3 }, { observer: 'AA'.repeat(32) },
    { hops: ['E85C', '9905', 'AC01'] }, { width: 1, hops: ['AC', '99', 'E8'] }, { width: 3, hops: ['AC0102'] }]) {
    store.recordTopologyObservation(evidence(run, 1000, options));
  }
  assert.equal(store.queryTopologyPaths().total, 8);
  assert.equal(store.queryTopologyPaths({ observerPublicKey: 'AA'.repeat(32) }).total, 1);
  assert.equal(store.queryTopologyPaths({ kind: 'direct-remaining' }).total, 2);
  const direct = store.queryTopologyPaths({ kind: 'direct-remaining' }).paths[0];
  assert.ok(store.getTopologyPath({ pathId: direct.pathId }).hops.every((hop) => hop.distance === null));
});

test('dynamic all-identity association preserves unknowns, renames and mixed-type collisions without choosing a target', () => {
  const store = open(); const run = start(store);
  const { pathId } = store.recordTopologyObservation(evidence(run));
  assert.equal(proximity(store).total, 0);
  const ac = node(store, 'AC01', '01'); const middle = node(store, '9905', '01'); const near = node(store, 'E85C', '01');
  assert.deepEqual(proximity(store).candidates.map((row) => row.publicKeyHex), [near, middle]);
  assert.equal(proximity(store, { radius: 0 }).total, 0);
  assert.equal(proximity(store, { radius: 3 }).total, 3);
  store.upsertNode({ publicKeyHex: middle, name: 'Renamed', type: 'REPEATER', heardAt: 2000 });
  assert.equal(proximity(store).candidates[1].name, 'Renamed');
  node(store, '9905', '02', 'CHAT', 'Conflicting identity');
  const hop = store.getTopologyPath({ pathId }).hops[1];
  assert.equal(hop.resolution, 'ambiguous'); assert.equal(hop.matchCount, 2); assert.equal(hop.identity, null);
  assert.deepEqual(proximity(store).candidates.map((row) => row.publicKeyHex), [near]);
  const ambiguity = store.queryTopologyPrefixIdentities({ hashWidth: 2, prefix: '9905', limit: 1, offset: 1 });
  assert.equal(ambiguity.identities.length, 1); assert.equal(ambiguity.identity, null);
  assert.equal(store.getTopologyPath({ pathId }).hops[0].identity.publicKeyHex, ac);
});

test('legacy lower-case keys resolve through expression indexes while duplicate or invalid full keys cannot become targets', () => {
  const path = file(); let store = open(path); close(store);
  const db = new DatabaseSync(path);
  const insert = db.prepare('INSERT INTO nodes(public_key_hex,name,type,first_heard_at,last_heard_at) VALUES(?,?,?,0,0)');
  insert.run('ac01'.padEnd(64, 'a'), null, 'REPEATER'); insert.run('9905invalid', null, 'REPEATER');
  insert.run('e85c'.padEnd(64, 'a'), null, 'REPEATER'); insert.run('E85C'.padEnd(64, 'A'), null, 'REPEATER'); db.close();
  store = open(path); const run = start(store); const { pathId } = store.recordTopologyObservation(evidence(run));
  const hops = store.getTopologyPath({ pathId }).hops;
  assert.equal(hops[0].resolution, 'unique'); assert.equal(hops[0].identity.publicKeyHex, 'AC01'.padEnd(64, 'A'));
  assert.equal(hops[1].resolution, 'ambiguous'); assert.equal(hops[2].resolution, 'ambiguous');
  assert.equal(proximity(store, { radius: 3 }).total, 1);
});

test('multiple fresh routes preserve older inside-radius evidence, bounded alternates and stable frequency ordering', () => {
  const store = open(); const run = start(store); const key = node(store, 'E85C');
  const first = store.recordTopologyObservation(evidence(run, 1000, { hops: ['E85C'] }));
  store.recordTopologyObservation(evidence(run, 2000, { hops: ['E85C', '9905', 'AC01'] }));
  for (let i = 0; i < 5; i++) store.recordTopologyObservation(evidence(run, 1500, { route: 0, hops: [i.toString(16).padStart(4, '0'), 'E85C'] }));
  store.recordTopologyObservation(evidence(run, 1500, { route: 0, hops: ['0000', 'E85C'] }));
  const candidate = proximity(store).candidates[0];
  assert.equal(candidate.publicKeyHex, key); assert.equal(candidate.distance, 1); assert.equal(candidate.receptionCount, 2);
  assert.equal(candidate.alternatePaths.length, 3);
  assert.ok(candidate.alternatePaths.some((row) => row.pathId === first.pathId) === false); // more recent equal-distance routes rank first
  assert.equal(proximity(store, { radius: 1, now: 1200 }).candidates[0].pathId, first.pathId);
});

test('loops, direct remaining paths and observing radio self-identity are excluded from proximity', () => {
  const store = open(); const run = start(store); node(store, 'E85C');
  store.upsertNode({ publicKeyHex: OBSERVER, name: null, type: 'REPEATER', heardAt: 1000 });
  store.recordTopologyObservation(evidence(run, 1000, { route: 2 }));
  store.recordTopologyObservation(evidence(run, 1000, { hops: ['E85C', 'E85C'] }));
  store.recordTopologyObservation(evidence(run, 1000, { hops: ['CDCD'] }));
  assert.equal(proximity(store).total, 0);
  assert.equal(store.queryTopologyPaths().paths.filter((row) => row.loopOrCollision).length, 1);
});

test('freshness excludes future/equality/stale evidence, cannot refresh on restart and guards wall-clock rollback', () => {
  const path = file(); let store = open(path); const run = start(store); node(store, 'E85C');
  store.recordTopologyObservation(evidence(run, 1000, { hops: ['E85C'] }));
  assert.equal(proximity(store, { now: 999, windowMs: HOUR }).total, 0);
  assert.equal(proximity(store, { now: 1000 + HOUR - 1, windowMs: HOUR }).total, 1);
  assert.equal(proximity(store, { now: 1000 + HOUR, windowMs: HOUR }).total, 0);
  const rollback = proximity(store, { now: 2000, windowMs: HOUR });
  assert.equal(rollback.total, 0); assert.equal(rollback.clockRollback, true);
  store.recordTopologyCoverage(coverage(run, 1000 + HOUR)); close(store); store = open(path);
  assert.equal(proximity(store, { now: 2000, windowMs: HOUR }).total, 0);
  assert.equal(store.queryTopologyPaths().paths[0].lastReceivedAt, 1000);
  assert.equal(proximity(store, { observerPublicKey: 'AA'.repeat(32), now: 1000 + HOUR }).total, 0);
});

test('all reads are strict and capped, range boundaries exact, metadata avoids nested identities', () => {
  const store = open(); const run = start(store);
  for (let i = 0; i < 205; i++) store.recordTopologyObservation(evidence(run, i + 1000, { hops: [i.toString(16).padStart(4, '0')] }));
  assert.equal(store.queryTopologyPaths({ limit: 200 }).paths.length, 200);
  assert.equal(store.queryTopologyPaths({ limit: 200, offset: 200 }).paths.length, 5);
  assert.equal(store.queryTopologyObservations({ ...RANGE, limit: 200 }).observations.length, 200);
  assert.equal(store.queryTopologyRouteCounts({ ...RANGE, limit: 200 }).paths.length, 200);
  assert.equal(store.queryTopologyObservations({ start: 1000, end: 1001 }).total, 1);
  assert.equal(store.queryTopologyObservations({ start: 1000, end: 1000 }).total, 0);
  assert.equal(store.getTopologyPath({ pathId: 9999 }), null);
  assert.equal(Object.hasOwn(store.queryTopologyPaths().paths[0], 'hops'), false);
  for (const query of [{ limit: 201 }, { offset: -1 }, { extra: true }]) {
    assert.throws(() => store.queryTopologyPaths(query), /Invalid topology input/);
    assert.throws(() => store.queryTopologyObservations({ ...RANGE, ...query }), /Invalid topology input/);
    assert.throws(() => store.queryTopologyRouteCounts({ ...RANGE, ...query }), /Invalid topology input/);
    assert.throws(() => proximity(store, query), /Invalid topology input/);
  }
  assert.throws(() => store.queryTopologyObservations({ start: 2, end: 1 }), /inverted range/);
  assert.throws(() => store.queryTopologyPrefixIdentities({ hashWidth: 2, prefix: 'AC' }), /prefix width/);
  assert.throws(() => store.queryTopologyPrefixIdentities({ hashWidth: 4, prefix: 'AC' }), /Invalid topology input/);
  assert.throws(() => store.getTopologyPath({ pathId: "1 OR 1=1" }), /Invalid topology input/);
  assert.throws(() => proximity(store, { radius: 64 }), /Invalid topology input/);
  assert.throws(() => store.queryTopologyCoverage({ ...RANGE, pathId: 1 }), /no path scope/);
});

test('migration 13 preserves earlier inventory/run state, creates no legacy observations and rolls back its last index failure', () => {
  const path = file(); let store = open(path); const run = start(store); node(store, 'E85C'); close(store);
  let db = new DatabaseSync(path); db.exec(`${dropTopologySchema} PRAGMA user_version=12;
    CREATE INDEX idx_nodes_prefix_3 ON nodes(name)`); db.close();
  assert.throws(() => open(path), /idx_nodes_prefix_3/);
  db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'topology_%'").get().n, 0);
  db.exec('DROP INDEX idx_nodes_prefix_3'); db.close();
  store = open(path); assert.equal(store.getObserverRun({ runId: run.runId }).state, 'running');
  assert.equal(store.countNodesByType('REPEATER'), 1); assert.equal(store.queryTopologyPaths().total, 0);
  assert.equal(store.queryTopologyObservations(RANGE).total, 0); close(store);
  db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.close();
});

test('shared detail retention deletes children before run parents while summaries persist and catalog pruning waits for references', () => {
  const path = file(); let store = open(path); const run = start(store); const key = node(store, 'E85C');
  const old = store.recordTopologyObservation(evidence(run, 1000));
  const retained = store.recordTopologyObservation(evidence(run, 1500, { hops: ['E85C'] }));
  store.recordTopologyCoverage(coverage(run, 1500));
  store.endObserverRun({ runId: run.runId, observedAt: 2000, observedDurationMs: 2000, reason: 'SIGINT' }); close(store);
  store = open(path); const live = start(store, 3000);
  assert.equal(store.pruneInactiveTopologyPaths({ cutoffMs: 1500 }), 0);
  store.pruneOlderThan(1500); assert.equal(store.queryTopologyObservations(RANGE).total, 1);
  assert.equal(store.queryTopologyPaths().total, 2); assert.ok(store.getObserverRun({ runId: run.runId }));
  assert.equal(store.getTopologyPath({ pathId: old.pathId }).receptionCount, 1);
  assert.equal(store.pruneInactiveTopologyPaths({ cutoffMs: 1500 }), 1);
  assert.equal(store.getTopologyPath({ pathId: old.pathId }), null);
  assert.ok(store.getTopologyPath({ pathId: retained.pathId }));
  store.pruneOlderThan(2001); assert.equal(store.getObserverRun({ runId: run.runId }), null);
  assert.equal(store.getObserverRun({ runId: live.runId }).state, 'running');
  assert.equal(store.findNodesByPublicKeyPrefix(key).length, 1);
  const returned = store.recordTopologyObservation(evidence(live, 4000));
  assert.ok(returned.pathId > retained.pathId); assert.equal(store.getTopologyPath({ pathId: returned.pathId }).receptionCount, 1);
});

test('failed catalog delete rolls back hops and failed shared retention restores all children', () => {
  const path = file(); let store = open(path); const run = start(store);
  const first = store.recordTopologyObservation(evidence(run)); store.recordTopologyCoverage(coverage(run));
  store.pruneOlderThan(1001); close(store);
  let db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER fail_prune BEFORE DELETE ON topology_paths BEGIN SELECT RAISE(ABORT,'prune fixture'); END"); db.close();
  store = open(path); assert.throws(() => store.pruneInactiveTopologyPaths({ cutoffMs: 1000 }), /prune fixture/);
  assert.equal(store.getTopologyPath({ pathId: first.pathId }).hops.length, 3);
  const next = start(store, 2000); store.recordTopologyObservation(evidence(next, 3000)); store.recordTopologyCoverage(coverage(next, 3000)); close(store);
  db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER fail_coverage_prune BEFORE DELETE ON topology_capture_samples BEGIN SELECT RAISE(ABORT,'coverage fixture'); END"); db.close();
  store = open(path); assert.throws(() => store.pruneOlderThan(3001), /coverage fixture/);
  assert.equal(store.queryTopologyObservations(RANGE).total, 1); assert.equal(store.queryTopologyCoverage(RANGE).total, 1);
});
