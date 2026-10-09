import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { MetricsStore } from '../../src/metrics/store.js';
import { dropTopologySchema } from '../fixtures/topology-downgrade.js';

const resources = [];
afterEach(() => {
  for (const close of resources.reverse()) close();
  resources.length = 0;
});
function openStore(dbPath = ':memory:') {
  const store = new MetricsStore({ dbPath });
  resources.push(() => store.close());
  return store;
}
function fixturePath() {
  const dir = mkdtempSync(join(tmpdir(), 'meshcore-bot-usage-'));
  resources.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'metrics.sqlite3');
}
function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  resources.push(() => db.close());
  return db;
}
function item(overrides = {}) {
  return { botName: 'echo', channel: '#echo', trigger: '!echo', sender: 'Alice',
    hopCount: 1, path: 'AA', hash: 'packet-reference', enqueuedAt: 100, expiresAt: 10000, ...overrides };
}
const range = { start: 0, end: 10000 };

test('usage belongs to acceptance; every outcome belongs to completion, across midnight', () => {
  const store = openStore();
  const midnight = Date.UTC(2026, 9, 8);
  for (const status of ['sent', 'failed', 'expired', 'cancelled']) {
    const id = store.enqueueReplyItem(item({ enqueuedAt: midnight - 1, expiresAt: midnight + 1000 }));
    store.resolveReplyItem(id, { status, resolvedAt: midnight, queuedMs: 1 });
  }
  store.enqueueReplyItem(item({ enqueuedAt: midnight, expiresAt: midnight + 1000 }));
  const before = { start: midnight - 1000, end: midnight };
  const after = { start: midnight, end: midnight + 1000 };
  assert.equal(store.queryBotUsageTotals(before).accepted, 4);
  assert.equal(store.queryBotUsageTotals(after).accepted, 1);
  assert.equal(store.queryBotOutcomeGroups(before).total, 0);
  assert.deepEqual(store.queryBotOutcomeGroups(after).groups.map((g) => g.outcome), ['cancelled', 'expired', 'failed', 'sent']);
  assert.deepEqual(store.queryBotCommandCounts({ ...after, botName: 'echo' }), [{ trigger: '!echo', count: 1 }]);
});

test('exact names, unavailable names, dimensions, filters and stable pagination remain distinct', () => {
  const store = openStore();
  for (const sender of ['Alice', 'Alice', 'alice', ' Alice ', 'é', 'e\u0301', null]) {
    store.enqueueReplyItem(item({ sender }));
  }
  store.enqueueReplyItem(item({ botName: 'other', channel: '#other', trigger: '!test', sender: 'Alice' }));
  assert.deepEqual(store.queryBotUsageTotals(range), {
    accepted: 8, distinctSenderNames: 5, unknownSenderAccepted: 1,
    retainedUnknownAcceptance: 0, earliestAcceptanceAt: 100
  });
  const senders = store.queryBotSenderCounts({ ...range, limit: 2 });
  assert.equal(senders.total, 6);
  assert.deepEqual(senders.senders, [{ sender: 'Alice', count: 3 }, { sender: null, count: 1 }]);
  assert.equal(store.queryBotSenderCounts({ ...range, offset: 2, limit: 2 }).senders[0].sender, ' Alice ');
  assert.equal(store.queryBotUsageGroups(range).total, 7);
  assert.deepEqual(store.queryBotUsageGroups({ ...range, botName: 'other', channel: '#other', trigger: '!test', sender: 'Alice' }).groups,
    [{ botName: 'other', channel: '#other', trigger: '!test', sender: 'Alice', count: 1 }]);
  assert.equal(store.queryBotUsageTotals({ ...range, sender: "' OR 1=1 --" }).accepted, 0);
  assert.equal(store.getEarliestBotAcceptanceAt({ botName: 'absent' }), null);
  assert.deepEqual(store.queryBotUsageGroups({ ...range, offset: 99 }), { total: 7, groups: [] });
});

test('empty ranges and invalid query DTOs are explicit and bounded', () => {
  const store = openStore();
  assert.deepEqual(store.queryBotUsageTotals(range), {
    accepted: 0, distinctSenderNames: 0, unknownSenderAccepted: 0,
    retainedUnknownAcceptance: 0, earliestAcceptanceAt: null
  });
  assert.equal(store.queryBotUsageTotals({ start: 1, end: 1 }).accepted, 0);
  for (const query of [null, {}, { ...range, start: '0' }, { start: 10, end: 1 },
    { ...range, end: Infinity }, { ...range, sender: null }, { ...range, extra: true }]) {
    assert.throws(() => store.queryBotUsageTotals(query), /Invalid bot reporting query/);
  }
  for (const query of [{ ...range, limit: 0 }, { ...range, limit: 201 }, { ...range, offset: -1 }, { ...range, limit: null }]) {
    for (const method of ['queryBotUsageGroups', 'queryBotSenderCounts', 'queryBotOutcomeGroups']) {
      assert.throws(() => store[method](query), /Invalid bot reporting query/);
    }
  }
  assert.throws(() => store.getEarliestBotAcceptanceAt({ start: 0 }), /Invalid bot reporting query/);
});

test('optional identity evidence is complete or absent, with no additional message data', () => {
  const store = openStore();
  for (const overrides of [{ senderIdentifier: 'key' }, { senderIdentifierKind: 'public-key' },
    { senderIdentifier: '', senderIdentifierKind: 'public-key', senderIdentifierSource: 'verified-event' },
    { messageBody: 'private content' }, { hopCount: '1' }, { enqueuedAt: -1 }]) {
    assert.throws(() => store.enqueueReplyItem(item(overrides)), /Invalid bot interaction/);
  }
  assert.equal(store.queryBotUsageTotals(range).accepted, 0);
  const evidence = { senderIdentifier: 'verified-key', senderIdentifierKind: 'public-key', senderIdentifierSource: 'verified-event' };
  const id = store.enqueueReplyItem(item(evidence));
  const record = store.getReplyById(id);
  for (const [key, value] of Object.entries(evidence)) assert.equal(record[key], value);
  const other = store.enqueueReplyItem(item({ senderIdentifier: 'different-key', senderIdentifierKind: 'public-key', senderIdentifierSource: 'verified-event' }));
  assert.notEqual(store.getReplyById(other).senderIdentifier, record.senderIdentifier);
  assert.equal(store.queryBotUsageTotals(range).distinctSenderNames, 1, 'name counts do not claim to distinguish keys');
  assert.equal('messageBody' in record, false);
});

test('completion-based shared pruning protects pending and recent completions; IDs never recycle', () => {
  const store = openStore();
  const pending = store.enqueueReplyItem(item({ enqueuedAt: 1 }));
  const recent = store.enqueueReplyItem(item({ enqueuedAt: 2 }));
  store.resolveReplyItem(recent, { status: 'sent', resolvedAt: 1000, queuedMs: 998 });
  const removed = store.enqueueReplyItem(item({ enqueuedAt: 3 }));
  store.resolveReplyItem(removed, { status: 'failed', resolvedAt: 999, queuedMs: 996 });
  store.pruneOlderThan(1000);
  assert.equal(store.getReplyById(removed), null);
  assert.equal(store.getReplyById(pending).status, 'pending');
  assert.equal(store.getReplyById(recent).enqueuedAt, 2);
  const next = store.enqueueReplyItem(item());
  assert.ok(next > removed);
  assert.equal(store.queryBotUsageTotals(range).accepted, 3);
  assert.equal(store.getEarliestBotAcceptanceAt(), 1);
});

// A real v8-shaped table, with old completed records lacking acceptance.
function makeV8(dbPath) {
  const fresh = new MetricsStore({ dbPath });
  fresh.upsertNode({ publicKeyHex: 'AA', name: 'Repeater', type: 'REPEATER', heardAt: 10 });
  fresh.close();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`${dropTopologySchema} DROP TABLE runtime_events; DROP TABLE process_samples;
      DROP TABLE observer_runs; DROP TABLE observer_instance;
      DROP TABLE advert_events;
      DROP TABLE advert_fingerprints;
      ALTER TABLE nodes RENAME TO nodes_newer;
      CREATE TABLE nodes (public_key_hex TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT,
        first_heard_at INTEGER NOT NULL,last_heard_at INTEGER NOT NULL);
      INSERT INTO nodes SELECT public_key_hex,name,type,first_heard_at,last_heard_at FROM nodes_newer;
      DROP TABLE nodes_newer;
      DROP TABLE bot_replies;
      CREATE TABLE bot_replies (
        id INTEGER PRIMARY KEY, bot_name TEXT NOT NULL, channel TEXT, trigger TEXT NOT NULL,
        sender TEXT, hop_count INTEGER, path TEXT, hash TEXT,
        handler_state_json TEXT NOT NULL CHECK(json_valid(handler_state_json)),
        enqueued_at INTEGER, expires_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','expired','cancelled')),
        resolved_at INTEGER, queued_ms INTEGER);
      INSERT INTO bot_replies VALUES (41,'echo','#echo','!echo','Alice',1,'AA','hash',
        '{"kind":"exact","version":1,"data":{}}',100,10000,'pending',NULL,NULL);
      INSERT INTO bot_replies VALUES (42,'echo',NULL,'!echo',NULL,NULL,NULL,NULL,
        '{"kind":"exact","version":1,"data":{}}',NULL,NULL,'sent',200,10);
      CREATE INDEX idx_bot_replies_status_enqueued ON bot_replies(status,enqueued_at);
      CREATE INDEX idx_bot_replies_status_resolved ON bot_replies(status,resolved_at);
      CREATE INDEX idx_bot_replies_bot_status_resolved ON bot_replies(bot_name,status,resolved_at);
      PRAGMA user_version = 8;`);
  } finally { db.close(); }
}

test('v8 migration preserves IDs, legacy unavailable evidence, other datasets and reopen state', () => {
  const dbPath = fixturePath();
  makeV8(dbPath);
  const store = openStore(dbPath);
  assert.equal(store.peekOldestPendingReplyItem().id, 41);
  assert.equal(store.getReplyById(42).senderIdentifier, null);
  assert.equal(store.getReplyById(42).enqueuedAt, null);
  assert.deepEqual(store.queryBotUsageTotals(range), {
    accepted: 1, distinctSenderNames: 1, unknownSenderAccepted: 0,
    retainedUnknownAcceptance: 1, earliestAcceptanceAt: 100
  });
  assert.equal(store.queryBotUsageTotals({ start: 900, end: 1000 }).retainedUnknownAcceptance, 1);
  assert.equal(store.queryBotOutcomeGroups(range).groups.find((g) => g.sender === null).count, 1);
  assert.equal(store.countNodesByType(), 1);
  const id = store.enqueueReplyItem(item());
  assert.ok(id > 42);
  const reopened = openStore(dbPath);
  assert.deepEqual(reopened.getReplyById(id), store.getReplyById(id));
  assert.equal(openDb(dbPath).prepare('PRAGMA user_version').get().user_version, 13);
});

test('a failed v9 migration rolls back its rebuild and version without losing old records', () => {
  const dbPath = fixturePath();
  makeV8(dbPath);
  const db = openDb(dbPath);
  // Force failure late, after the table copy, using the index name namespace.
  db.exec('CREATE INDEX idx_bot_replies_accepted ON nodes(name)');
  assert.throws(() => new MetricsStore({ dbPath }), /already exists/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bot_replies').get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='bot_replies_new'").get().n, 0);
  db.exec('DROP INDEX idx_bot_replies_accepted');
  assert.equal(openStore(dbPath).getReplyById(41).status, 'pending');
});

test('accepted range queries use the index and return bounded groups on retained history', () => {
  const dbPath = fixturePath();
  const store = openStore(dbPath);
  const db = openDb(dbPath);
  const insert = db.prepare(`INSERT INTO bot_replies
    (bot_name,channel,trigger,sender,hop_count,path,hash,handler_state_json,enqueued_at,expires_at,status)
    VALUES ('echo','#echo','!echo',?,1,'AA','hash','{"kind":"exact","version":1,"data":{}}',?,30000,'pending')`);
  db.exec('BEGIN');
  try {
    for (let i = 0; i < 20000; i++) insert.run(`sender-${i % 1000}`, i);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM bot_replies WHERE enqueued_at >= ? AND enqueued_at < ?').all(10000, 11000);
  assert.ok(plan.some((row) => row.detail.includes('idx_bot_replies_accepted')));
  const started = performance.now();
  const query = { start: 10000, end: 11000, limit: 200 };
  assert.equal(store.queryBotUsageTotals(queryWithoutPage(query)).accepted, 1000);
  assert.equal(store.queryBotUsageGroups(query).groups.length, 200);
  assert.equal(store.queryBotSenderCounts(query).total, 1000);
  console.info(`Bot retained-history check: 20,000 rows; totals + 2 grouped pages ${Math.round(performance.now() - started)}ms`);
});
function queryWithoutPage({ start, end }) { return { start, end }; }
