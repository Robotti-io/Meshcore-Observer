import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MetricsStore } from '../../src/metrics/store.js';
import { dropTopologySchema } from '../fixtures/topology-downgrade.js';

const HOUR = 3600000;
const KEY = 'AB'.repeat(32);
const RANGE = { start: 0, end: 10000 };
const stores = new Set();
const dirs = new Set();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});
function open(dbPath = ':memory:') {
  const store = new MetricsStore({ dbPath });
  stores.add(store);
  return store;
}
function close(store) { store.close(); stores.delete(store); }
function file() {
  const dir = mkdtempSync(join(tmpdir(), 'advert-history-'));
  dirs.add(dir);
  return join(dir, 'metrics.sqlite3');
}
function evidence(id, overrides = {}) {
  return { publicKeyHex: KEY, eventDigest: createHash('sha256').update(String(id)).digest('hex'),
    name: 'Summit', type: 'REPEATER', receivedAt: 1000, hopCount: 2, ...overrides };
}
function eligible(store, now, windowMs = 72 * HOUR, publicKeyHex = KEY) {
  return store.queryDirectHeardEligibility({ publicKeyHex, now, windowMs });
}
function inspect(path, read) {
  const db = new DatabaseSync(path);
  try { return read(db); } finally { db.close(); }
}
function makeV9(path) {
  close(open(path));
  inspect(path, (db) => db.exec(`
    ${dropTopologySchema}
    DROP TABLE runtime_events; DROP TABLE process_samples;
    DROP TABLE observer_runs; DROP TABLE observer_instance;
    DROP TABLE advert_events; DROP TABLE advert_fingerprints;
    ALTER TABLE nodes RENAME TO nodes_v10;
    CREATE TABLE nodes(public_key_hex TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT,
      first_heard_at INTEGER NOT NULL,last_heard_at INTEGER NOT NULL);
    DROP TABLE nodes_v10;
    CREATE INDEX idx_nodes_first_heard_at ON nodes(first_heard_at);
    CREATE INDEX idx_nodes_last_heard_at ON nodes(last_heard_at);
    PRAGMA user_version=9;
  `));
}

test('three distinct adverts count three events, one key, one discovery and two re-hears', () => {
  const store = open();
  for (let i = 1; i <= 3; i++) store.recordVerifiedAdvert(evidence(i, { receivedAt: i * 1000 }));
  store.recordVerifiedAdvert(evidence(1, { receivedAt: 4000, hopCount: 0 }));
  assert.deepEqual(store.queryAdvertTotals(RANGE), {
    events: 3, distinctNodes: 1, newDiscoveries: 1, rehears: 2, earliestEventAt: 1000
  });
  assert.deepEqual(store.queryAdvertNodeCounts(RANGE).nodes.map((n) => ({ ...n })), [{
    publicKeyHex: KEY, type: 'REPEATER', events: 3, newDiscoveries: 1, rehears: 2,
    firstEventAt: 1000, lastEventAt: 3000
  }]);
  assert.equal(store.queryNodes({ limit: 100, offset: 0 }).nodes[0].lastHeardAt, 4000);
  assert.deepEqual(eligible(store, 4000), { lastDirectHeardAt: 4000, eligible: true });
});

test('receptions finishing out of order preserve chronology, snapshots and one first discovery', () => {
  const path = file();
  const store = open(path);
  store.recordVerifiedAdvert(evidence('latest', { name: null, receivedAt: 3000 }));
  store.recordVerifiedAdvert(evidence('rename', { name: 'Latest known', receivedAt: 2000 }));
  store.recordVerifiedAdvert(evidence('earliest', { name: 'Original', receivedAt: 1000 }));
  const [node] = store.queryNodes({ limit: 100, offset: 0 }).nodes;
  assert.equal(node.name, 'Latest known');
  assert.equal(node.firstHeardAt, 1000);
  assert.equal(node.lastHeardAt, 3000);
  assert.equal(store.queryAdvertTotals({ start: 1000, end: 2000 }).newDiscoveries, 1);
  assert.equal(store.queryAdvertTotals({ start: 2000, end: 4000 }).newDiscoveries, 0);
  const rows = inspect(path, (db) => db.prepare('SELECT name,is_new FROM advert_events ORDER BY received_at').all());
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { name: 'Original', is_new: 1 }, { name: 'Latest known', is_new: 0 }, { name: null, is_new: 0 }
  ]);
});

test('equal reception timestamps select discovery and latest name deterministically', () => {
  const first = evidence('a');
  const second = evidence('b', { name: 'Second' });
  const a = open(); const b = open();
  for (const observation of [first, second]) a.recordVerifiedAdvert(observation);
  for (const observation of [second, first]) b.recordVerifiedAdvert(observation);
  assert.deepEqual(a.queryNodes({ limit: 100, offset: 0 }), b.queryNodes({ limit: 100, offset: 0 }));
  assert.deepEqual(a.queryAdvertTotals(RANGE), b.queryAdvertTotals(RANGE));
  assert.equal(a.queryAdvertTotals(RANGE).newDiscoveries, 1);
});

test('same names keep separate full-key identities and historical types survive current type changes', () => {
  const store = open();
  store.recordVerifiedAdvert(evidence('rep'));
  store.recordVerifiedAdvert(evidence('chat', { publicKeyHex: 'CD'.repeat(32), type: 'CHAT' }));
  store.recordVerifiedAdvert(evidence('changed', { type: 'CHAT', name: 'Renamed', receivedAt: 2000 }));
  store.recordVerifiedAdvert(evidence('room', { publicKeyHex: 'EF'.repeat(32), type: 'ROOM', hopCount: 0 }));
  assert.equal(store.queryNodes({ limit: 100, offset: 0 }).total, 3);
  assert.equal(store.queryAdvertTotals(RANGE).distinctNodes, 2);
  assert.deepEqual(store.queryAdvertTypeTotals(RANGE).map(({ type, events, distinctNodes, newDiscoveries }) =>
    ({ type, events, distinctNodes, newDiscoveries })), [
    { type: 'CHAT', events: 2, distinctNodes: 2, newDiscoveries: 1 },
    { type: 'REPEATER', events: 1, distinctNodes: 1, newDiscoveries: 1 }
  ]);
  assert.equal(store.queryAdvertNodeCounts(RANGE).total, 3);
  assert.equal(eligible(store, 2000).eligible, false);
  assert.equal(eligible(store, 2000, HOUR, 'EF'.repeat(32)).eligible, false);
});

test('range reads are half-open, bounded, empty-safe and expose retained coverage independently', () => {
  const store = open();
  assert.deepEqual(store.queryAdvertTotals(RANGE), {
    events: 0, distinctNodes: 0, newDiscoveries: 0, rehears: 0, earliestEventAt: null
  });
  store.recordVerifiedAdvert(evidence(1));
  store.recordVerifiedAdvert(evidence(2, { publicKeyHex: 'CD'.repeat(32), receivedAt: 2000 }));
  assert.equal(store.queryAdvertTotals({ start: 1000, end: 2000 }).events, 1);
  assert.equal(store.queryAdvertTotals({ start: 2000, end: 2000 }).events, 0);
  assert.equal(store.queryAdvertTotals({ start: 5000, end: 6000 }).earliestEventAt, 1000);
  const page = store.queryAdvertNodeCounts({ ...RANGE, limit: 1, offset: 1 });
  assert.equal(page.total, 2); assert.equal(page.nodes.length, 1);
  assert.equal(page.nodes[0].publicKeyHex, 'CD'.repeat(32));
  assert.deepEqual(store.queryAdvertNodeCounts({ ...RANGE, offset: 10 }), { total: 2, nodes: [] });
});

test('strict advert and read schemas reject malformed or extra fields before writes', () => {
  const store = open();
  for (const changes of [ { extra: true }, { publicKeyHex: 'AB' }, { eventDigest: 'ff' },
    { receivedAt: NaN }, { receivedAt: -1 }, { hopCount: 64 }, { type: 'UNKNOWN' }, { name: {} } ]) {
    assert.throws(() => store.recordVerifiedAdvert(evidence(1, changes)), /Invalid verified advert/);
  }
  assert.equal(store.queryNodes({ limit: 100, offset: 0 }).total, 0);
  for (const query of [null, { start: 2, end: 1 }, { ...RANGE, extra: true }, { ...RANGE, type: 'ROOM' }]) {
    assert.throws(() => store.queryAdvertTotals(query), /Invalid advert query/);
  }
  for (const query of [{ ...RANGE, limit: 201 }, { ...RANGE, offset: -1 }, { ...RANGE, limit: 0 }]) {
    assert.throws(() => store.queryAdvertNodeCounts(query), /Invalid advert query/);
  }
  assert.throws(() => eligible(store, 1000, 0), /Invalid advert query/);
  assert.throws(() => eligible(store, 1000, HOUR, 'ab'.repeat(32)), /Invalid advert query/);
});

test('only zero-hop repeater receptions refresh direct evidence; exact expiry and future clocks are conservative', () => {
  const store = open();
  store.recordVerifiedAdvert(evidence('one'));
  assert.deepEqual(eligible(store, 1000), { lastDirectHeardAt: null, eligible: false });
  store.recordVerifiedAdvert(evidence('one', { receivedAt: 2000, hopCount: 0 }));
  store.recordVerifiedAdvert(evidence('two', { receivedAt: 3000, hopCount: 1 }));
  assert.deepEqual(eligible(store, 2000 + 72 * HOUR - 1), { lastDirectHeardAt: 2000, eligible: true });
  assert.equal(eligible(store, 2000 + 72 * HOUR).eligible, false);
  assert.equal(eligible(store, 2000 + HOUR, HOUR).eligible, false);
  assert.equal(eligible(store, 1999).eligible, false);
  // A clock rollback doesn't overwrite saved evidence with an earlier time.
  store.recordVerifiedAdvert(evidence('old', { receivedAt: 1500, hopCount: 0 }));
  assert.deepEqual(eligible(store, 1500), { lastDirectHeardAt: 2000, eligible: false });
  store.recordVerifiedAdvert(evidence('chat', { type: 'CHAT', receivedAt: 4000, hopCount: 0 }));
  assert.deepEqual(eligible(store, 4000), { lastDirectHeardAt: 2000, eligible: false });
});

test('history pruning and reopening preserve fingerprint identity, inventory and direct evidence', () => {
  const path = file();
  let store = open(path);
  store.recordVerifiedAdvert(evidence('first', { hopCount: 0 }));
  store.pruneOlderThan(1001);
  assert.equal(store.queryAdvertTotals(RANGE).events, 0);
  close(store); store = open(path);
  const replay = store.recordVerifiedAdvert(evidence('first', { receivedAt: 3000, hopCount: 0 }));
  assert.equal(replay.eventRecorded, false);
  assert.equal(store.queryAdvertTotals(RANGE).events, 0);
  assert.equal(store.queryNodes({ limit: 100, offset: 0 }).nodes[0].firstHeardAt, 1000);
  assert.deepEqual(eligible(store, 3000), { lastDirectHeardAt: 3000, eligible: true });
  store.recordVerifiedAdvert(evidence('fresh', { receivedAt: 4000 }));
  assert.deepEqual(store.queryAdvertTotals(RANGE), {
    events: 1, distinctNodes: 1, newDiscoveries: 0, rehears: 1, earliestEventAt: 4000
  });
  close(store); store = open(path);
  assert.equal(eligible(store, 3000 + 72 * HOUR).eligible, false);
  assert.equal(store.queryAdvertTotals(RANGE).events, 1);
});

test('duplicate path summaries preserve earliest reception and shortest observed hop count', () => {
  const path = file(); const store = open(path);
  store.recordVerifiedAdvert(evidence('same', { receivedAt: 3000, hopCount: 3 }));
  store.recordVerifiedAdvert(evidence('same', { receivedAt: 1000, hopCount: 2 }));
  store.recordVerifiedAdvert(evidence('same', { receivedAt: 2000, hopCount: 0 }));
  const row = inspect(path, (db) => db.prepare('SELECT received_at,last_received_at,first_hops,min_hops FROM advert_events').get());
  assert.deepEqual({ ...row }, { received_at: 1000, last_received_at: 3000, first_hops: 2, min_hops: 0 });
  assert.equal(store.queryAdvertTotals(RANGE).newDiscoveries, 1);
  assert.equal(eligible(store, 2000).lastDirectHeardAt, 2000);
});

test('migration 10 preserves legacy data without inventing history or direct evidence', () => {
  const path = file(); makeV9(path);
  inspect(path, (db) => {
    db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?)').run(KEY, 'Legacy', 'REPEATER', 100, 900);
    db.exec("UPDATE flood_advert_state SET status='pending',requested_at=42");
    db.exec(`INSERT INTO bot_replies (id,bot_name,trigger,handler_state_json,status,resolved_at)
      VALUES (17,'bot','!ping','{"kind":"exact","version":1,"data":{}}','sent',800)`);
  });
  const store = open(path);
  assert.equal(store.queryNodes({ limit: 100, offset: 0 }).nodes[0].firstHeardAt, 100);
  assert.equal(store.getReplyById(17).status, 'sent');
  assert.equal(store.getFloodAdvertState().requestedAt, 42);
  assert.equal(store.queryAdvertTotals(RANGE).events, 0);
  assert.equal(eligible(store, 1000).lastDirectHeardAt, null);
  store.recordVerifiedAdvert(evidence('fresh', { name: null }));
  assert.equal(store.queryNodes({ limit: 100, offset: 0 }).nodes[0].name, 'Legacy');
  assert.equal(store.queryAdvertTotals(RANGE).newDiscoveries, 0);
  assert.equal(inspect(path, (db) => db.prepare('PRAGMA user_version').get().user_version), 14);
});

test('late migration failure rolls back the node rebuild and all new tables', () => {
  const path = file(); makeV9(path);
  inspect(path, (db) => {
    db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?)').run(KEY, 'Legacy', 'REPEATER', 100, 900);
    db.exec('CREATE INDEX idx_advert_events_at ON bot_replies(resolved_at)');
  });
  assert.throws(() => new MetricsStore({ dbPath: path }), /idx_advert_events_at/);
  inspect(path, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('nodes_new','advert_events','advert_fingerprints')").get().n, 0);
    assert.equal(db.prepare('PRAGMA table_info(nodes)').all().find((col) => col.name === 'name').notnull, 1);
    db.exec('DROP INDEX idx_advert_events_at');
  });
  assert.equal(open(path).queryNodes({ limit: 100, offset: 0 }).total, 1);
});

test('atomic reception rolls back inventory and fingerprints if event insertion fails', () => {
  const path = file(); const store = open(path);
  inspect(path, (db) => db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON advert_events BEGIN SELECT RAISE(ABORT,'disk fixture'); END"));
  assert.throws(() => store.recordVerifiedAdvert(evidence('one')), /disk fixture/);
  assert.equal(store.queryNodes({ limit: 100, offset: 0 }).total, 0);
  assert.equal(inspect(path, (db) => db.prepare('SELECT COUNT(*) AS n FROM advert_fingerprints').get().n), 0);
});

test('20,000 event fixtures use the range index and measure permanent ledger page cost', () => {
  const path = file(); const store = open(path);
  // A bulk SQL fixture isolates ledger page cost from transaction/timing noise.
  store.recordVerifiedAdvert(evidence('first'));
  const measurements = inspect(path, (db) => {
    const size = () => db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
    const before = size();
    const insert = db.prepare('INSERT INTO advert_fingerprints(digest,node_id) VALUES (?,?)');
    const event = db.prepare(`INSERT INTO advert_events VALUES (?, ?, ?, ?, NULL, 'REPEATER', 0, 1, 1)`);
    const id = db.prepare('SELECT id FROM nodes').get().id;
    db.exec('BEGIN');
    for (let i = 0; i < 20000; i++) insert.run(Buffer.from(evidence(`fixture-${i}`).eventDigest, 'hex'), id);
    db.exec('COMMIT');
    const ledgerBytes = size() - before;
    db.exec('BEGIN');
    for (let i = 0; i < 20000; i++) event.run(Buffer.from(evidence(`fixture-${i}`).eventDigest, 'hex'), KEY, i + 2000, i + 2000);
    db.exec('COMMIT');
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM advert_events WHERE received_at>=? AND received_at<?').all(2000, 22000);
    assert.ok(plan.some((row) => row.detail.includes('idx_advert_events_at')));
    return { ledgerBytes, bytesPerFingerprint: ledgerBytes / 20000 };
  });
  assert.ok(measurements.bytesPerFingerprint >= 32);
  assert.equal(store.queryAdvertTotals({ start: 2000, end: 22000 }).events, 20000);
  console.info('Advert ledger growth fixture:', measurements);
});

test('opt-in cleanup protects retained history and original discovery while preserving offline inventory', () => {
  const path = file(); let store = open(path);
  store.recordVerifiedAdvert(evidence('discovery', { receivedAt: 1000, hopCount: 0 }));
  store.recordVerifiedAdvert(evidence('expired-detail', { receivedAt: 2000 }));
  store.recordVerifiedAdvert(evidence('retained-detail', { receivedAt: 3000 }));
  store.pruneOlderThan(3000);
  // The equality cutoff represents at least N days of inactivity.
  assert.equal(store.pruneInactiveRepeaterFingerprints({ cutoffMs: 2999 }), 0);
  assert.equal(store.pruneInactiveRepeaterFingerprints({ cutoffMs: 3000 }), 1);
  assert.equal(store.pruneInactiveRepeaterFingerprints({ cutoffMs: 3000 }), 0);
  assert.equal(inspect(path, (db) => db.prepare('SELECT COUNT(*) AS n FROM advert_fingerprints').get().n), 2);
  const [node] = store.queryNodes({ limit: 100, offset: 0 }).nodes;
  assert.equal(node.name, 'Summit');
  assert.equal(node.firstHeardAt, 1000);
  assert.equal(node.lastHeardAt, 3000);
  assert.equal(eligible(store, 3000).lastDirectHeardAt, 1000);
  assert.equal(store.queryAdvertTotals(RANGE).events, 1);
  close(store); store = open(path);
  assert.equal(store.recordVerifiedAdvert(evidence('discovery', { receivedAt: 4000 })).eventRecorded, false);
  assert.equal(store.recordVerifiedAdvert(evidence('retained-detail', { receivedAt: 4500 })).eventRecorded, false);
  const replay = store.recordVerifiedAdvert(evidence('expired-detail', { receivedAt: 5000 }));
  assert.deepEqual(replay, { eventRecorded: true, newlyDiscovered: false });
  assert.deepEqual(store.queryAdvertTotals(RANGE), {
    events: 2, distinctNodes: 1, newDiscoveries: 0, rehears: 2, earliestEventAt: 3000
  });
  assert.equal(store.queryNodes({ limit: 100, offset: 0 }).nodes[0].firstHeardAt, 1000);
});

test('inactivity cleanup preserves active repeaters and other inventory types', () => {
  const path = file(); const store = open(path);
  for (const [key, type, last] of [['AB', 'REPEATER', 3000], ['CD', 'CHAT', 2000], ['EF', 'ROOM', 2000]]) {
    for (let i = 1; i <= 2; i++) store.recordVerifiedAdvert(evidence(`${key}-${i}`, {
      publicKeyHex: key.repeat(32), type, receivedAt: i === 2 ? last : 1000
    }));
  }
  // A verified duplicate is activity too, so it protects this repeater.
  store.recordVerifiedAdvert(evidence('AB-2', { receivedAt: 4000 }));
  store.pruneOlderThan(5000);
  assert.equal(store.pruneInactiveRepeaterFingerprints({ cutoffMs: 3000 }), 0);
  assert.equal(store.queryNodes({ limit: 100, offset: 0 }).total, 3);
  assert.equal(inspect(path, (db) => db.prepare('SELECT COUNT(*) AS n FROM advert_fingerprints').get().n), 4);
});

test('invalid prune DTOs cannot delete data and a failed cleanup rolls back atomically', () => {
  const path = file(); const store = open(path);
  for (let i = 1; i <= 3; i++) store.recordVerifiedAdvert(evidence(i, { receivedAt: i * 1000 }));
  store.pruneOlderThan(4000);
  for (const query of [null, {}, { cutoffMs: -1 }, { cutoffMs: 4000, extra: true }, { cutoffMs: Infinity }]) {
    assert.throws(() => store.pruneInactiveRepeaterFingerprints(query), /Invalid advert query/);
  }
  inspect(path, (db) => db.exec("CREATE TRIGGER fail_prune BEFORE DELETE ON advert_fingerprints BEGIN SELECT RAISE(ABORT,'locked fixture'); END"));
  assert.throws(() => store.pruneInactiveRepeaterFingerprints({ cutoffMs: 4000 }), /locked fixture/);
  assert.equal(inspect(path, (db) => db.prepare('SELECT COUNT(*) AS n FROM advert_fingerprints').get().n), 3);
  assert.equal(store.queryNodes({ limit: 100, offset: 0 }).total, 1);
  inspect(path, (db) => db.exec('DROP TRIGGER fail_prune'));
  assert.equal(store.pruneInactiveRepeaterFingerprints({ cutoffMs: 4000 }), 2);
});
