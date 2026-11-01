import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { MetricsStore } from '../../src/metrics/store.js';

const KEY = 'AB'.repeat(32);
function baseItem(overrides = {}) {
  return { botName: 'echo', channel: '#echo', trigger: '!echo', sender: 'Alice', hopCount: 1,
    path: 'AA', hash: 'packet-reference', enqueuedAt: 1000, expiresAt: 10000, ...overrides };
}
function withStore(work) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-reply-lifecycle-'));
  const dbPath = join(dir, 'metrics.sqlite3');
  let store;
  try { store = new MetricsStore({ dbPath }); return work({ dir, dbPath, get store() { return store; },
    close() { store?.close(); store = null; }, reopen() { store?.close(); store = null; store = new MetricsStore({ dbPath }); return store; } }); }
  finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('delivery policy and pending private recipient survive reopen; ACK remains separate from terminal send status', () => withStore(f => {
  const policy = { version: 1, transport: 'private', scope: { mode: 'device-default' },
    fallback: { mode: 'none' }, maxAttempts: 2 };
  const id = f.store.enqueueReplyItem(baseItem({ deliveryPolicy: policy, recipientPublicKey: KEY }));
  f.close();
  const store = f.reopen();
  const pending = store.getReplyById(id);
  assert.equal(pending.status, 'pending'); assert.deepEqual(pending.deliveryPolicy, policy);
  assert.equal(pending.recipientPublicKey, KEY); assert.equal(pending.attemptCount, 0);
  assert.equal(store.claimReplyDispatch({ id, dispatchStartedAt: 2000 }), true);
  assert.equal(store.claimReplyDispatch({ id, dispatchStartedAt: 2001 }), false);
  const dispatching = store.getReplyById(id);
  assert.equal(dispatching.status, 'dispatching'); assert.equal(dispatching.ackStatus, 'waiting');
  assert.equal(dispatching.attemptCount, 1); assert.equal(dispatching.dispatchStartedAt, 2000);
  assert.equal(store.queryReplyOutcomeTotals({ start: 0, end: 10000 }).sent, 0);
  assert.equal(store.resolveReplyItem(id, { status: 'sent', resolvedAt: 2500, queuedMs: 1500 }), true);
  const sent = store.getReplyById(id);
  assert.equal(sent.status, 'sent'); assert.equal(sent.recipientPublicKey, null); assert.equal(sent.ackStatus, 'waiting');
  assert.equal(store.resolveReplyAcknowledgement({ id, status: 'acknowledged', occurredAt: 2750 }), true);
  const acknowledged = store.getReplyById(id);
  assert.equal(acknowledged.status, 'sent'); assert.equal(acknowledged.ackStatus, 'acknowledged');
  assert.equal(acknowledged.ackAt, 2750); assert.equal(acknowledged.ackLatencyMs, 750);
  assert.deepEqual(store.queryReplyOutcomeTotals({ start: 0, end: 10000 }), { sent: 1, failed: 0, expired: 0, cancelled: 0 });
}));

test('ACK timeout records an independent milestone without changing a sent reply outcome', () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const id = store.enqueueReplyItem(baseItem({ deliveryPolicy: { version: 1, transport: 'private',
    scope: { mode: 'device-default' }, fallback: { mode: 'none' }, maxAttempts: 1 }, recipientPublicKey: KEY }));
  store.claimReplyDispatch({ id, dispatchStartedAt: 2000 });
  store.resolveReplyItem(id, { status: 'sent', resolvedAt: 2500, queuedMs: 1500 });
  assert.equal(store.resolveReplyAcknowledgement({ id, status: 'timed-out', occurredAt: 5000 }), true);
  assert.deepEqual([store.getReplyById(id).status, store.getReplyById(id).ackStatus,
    store.getReplyById(id).ackLatencyMs], ['sent', 'timed-out', 3000]);
  store.close();
});

test('scope policy failure records its specific terminal reason', () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const id = store.enqueueReplyItem(baseItem());
  store.claimReplyDispatch({ id, dispatchStartedAt: 2000 });
  assert.equal(store.resolveReplyItem(id, {
    status: 'failed', resolvedAt: 2100, queuedMs: 1100, reason: 'scope-unavailable'
  }), true);
  assert.deepEqual([store.getReplyById(id).status, store.getReplyById(id).outcomeReason], ['failed', 'scope-unavailable']);
  store.close();
});

test('suppression is a pending-only conditional terminal state and stays outside legacy outcome totals', () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const id = store.enqueueReplyItem(baseItem());
  assert.equal(store.suppressPendingReplyItem({ id, resolvedAt: 2000 }), true);
  assert.equal(store.suppressPendingReplyItem({ id, resolvedAt: 2001 }), false);
  assert.deepEqual([store.getReplyById(id).status, store.getReplyById(id).outcomeReason], ['suppressed', 'satisfactory-response']);
  assert.deepEqual(store.queryReplyOutcomeTotals({ start: 0, end: 10000 }), { sent: 0, failed: 0, expired: 0, cancelled: 0 });
  assert.deepEqual(store.queryReplyLifecycleTotals({ start: 0, end: 10000 }), {
    sent: 0, failed: 0, expired: 0, cancelled: 0, suppressed: 1, 'delivery-unknown': 0
  });
  store.close();
});

test('pending suppression candidate query uses receipt time, expiry, channel, and a strict bound', () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const validId = store.enqueueReplyItem(baseItem({ enqueuedAt: 1000, expiresAt: 5000 }));
  store.enqueueReplyItem(baseItem({ channel: '#other', enqueuedAt: 1100, expiresAt: 5000 }));
  store.enqueueReplyItem(baseItem({ enqueuedAt: 2100, expiresAt: 5000 }));
  store.enqueueReplyItem(baseItem({ enqueuedAt: 1200, expiresAt: 1900 }));
  const candidates = store.queryPendingReplySuppressionCandidates({ channel: '#echo', observedAt: 2000 });
  assert.equal(candidates.overflow, false);
  assert.deepEqual(candidates.items.map((item) => item.id), [validId]);
  assert.throws(() => store.queryPendingReplySuppressionCandidates({ channel: '#echo', observedAt: -1 }), /Invalid bot reply suppression query/);
  store.close();
});

test('schema v23 suppression index migration rolls back cleanly and can be retried', () => withStore(f => {
  f.close();
  const db = new DatabaseSync(f.dbPath);
  db.exec(`DROP INDEX idx_bot_replies_pending_channel;
    CREATE INDEX idx_bot_replies_pending_channel ON nodes(name);
    PRAGMA user_version=22;`);
  db.close();
  assert.throws(() => f.reopen(), /idx_bot_replies_pending_channel/);
  const check = new DatabaseSync(f.dbPath);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 22);
  check.exec('DROP INDEX idx_bot_replies_pending_channel');
  check.close();
  const migrated = f.reopen();
  assert.equal(migrated.getReplyById(1), null);
  const versionDb = new DatabaseSync(f.dbPath);
  assert.equal(versionDb.prepare('PRAGMA user_version').get().user_version, 23);
  assert.equal(versionDb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_bot_replies_pending_channel'").get().n, 1);
  versionDb.close();
}));

test('restart recovery marks dispatching as delivery-unknown and never makes it pending again', () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const id = store.enqueueReplyItem(baseItem());
  store.claimReplyDispatch({ id, dispatchStartedAt: 2000 });
  assert.equal(store.recoverDispatchingReplyItems({ recoveredAt: 3000 }), 1);
  assert.equal(store.recoverDispatchingReplyItems({ recoveredAt: 4000 }), 0);
  const recovered = store.getReplyById(id);
  assert.equal(recovered.status, 'delivery-unknown'); assert.equal(recovered.outcomeReason, 'process-restart');
  assert.equal(recovered.recipientPublicKey, null); assert.equal(store.countPendingReplyItems(), 0);
  store.close();
});

function downgradeToV21(db) {
  db.exec(`
    DROP INDEX idx_bot_replies_status_enqueued;
    DROP INDEX idx_bot_replies_status_resolved;
    DROP INDEX idx_bot_replies_bot_status_resolved;
    DROP INDEX idx_bot_replies_accepted;
    ALTER TABLE bot_replies RENAME TO bot_replies_v22;
    CREATE TABLE bot_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,bot_name TEXT NOT NULL,channel TEXT,trigger TEXT NOT NULL,sender TEXT,
      hop_count INTEGER,path TEXT,hash TEXT,handler_state_json TEXT NOT NULL CHECK(json_valid(handler_state_json)),
      enqueued_at INTEGER,expires_at INTEGER,status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','expired','cancelled')),
      resolved_at INTEGER,queued_ms INTEGER,sender_identifier TEXT,sender_identifier_kind TEXT,sender_identifier_source TEXT,
      region_scope TEXT CHECK(region_scope IS NULL OR length(region_scope) BETWEEN 1 AND 31)
    );
    INSERT INTO bot_replies SELECT id,bot_name,channel,trigger,sender,hop_count,path,hash,handler_state_json,enqueued_at,
      expires_at,status,resolved_at,queued_ms,sender_identifier,sender_identifier_kind,sender_identifier_source,region_scope
      FROM bot_replies_v22;
    DROP TABLE bot_replies_v22;
    CREATE INDEX idx_bot_replies_status_enqueued ON bot_replies(status,enqueued_at);
    CREATE INDEX idx_bot_replies_status_resolved ON bot_replies(status,resolved_at);
    CREATE INDEX idx_bot_replies_bot_status_resolved ON bot_replies(bot_name,status,resolved_at);
    CREATE INDEX idx_bot_replies_accepted ON bot_replies(enqueued_at,bot_name) WHERE enqueued_at IS NOT NULL;
    PRAGMA user_version=21;
  `);
}

test('migration 22 preserves legacy rows and gives them channel/device-default delivery policy', () => withStore(f => {
  const pendingId = f.store.enqueueReplyItem(baseItem({ regionScope: 'NORTH' }));
  const sentId = f.store.enqueueReplyItem(baseItem({ trigger: '!sent', enqueuedAt: 1100, expiresAt: 10000 }));
  f.store.claimReplyDispatch({ id: sentId, dispatchStartedAt: 1200 });
  f.store.resolveReplyItem(sentId, { status: 'sent', resolvedAt: 1300, queuedMs: 200 });
  f.close();
  const db = new DatabaseSync(f.dbPath);
  try { downgradeToV21(db); } finally { db.close(); }
  const migrated = f.reopen();
  assert.equal(migrated.getReplyById(pendingId).status, 'pending');
  assert.equal(migrated.getReplyById(pendingId).regionScope, 'NORTH');
  assert.deepEqual(migrated.getReplyById(pendingId).deliveryPolicy, { version: 1, transport: 'channel',
    scope: { mode: 'region', region: 'NORTH' }, fallback: { mode: 'none' }, maxAttempts: 1 });
  assert.equal(migrated.getReplyById(sentId).status, 'sent'); assert.equal(migrated.getReplyById(sentId).id, sentId);
  assert.equal(migrated.getReplyById(sentId).deliveryPolicy.transport, 'channel');
  assert.deepEqual(migrated.queryReplyOutcomeTotals({ start: 0, end: 10000 }), { sent: 1, failed: 0, expired: 0, cancelled: 0 });
  const versionDb = new DatabaseSync(f.dbPath);
  try { assert.equal(versionDb.prepare('PRAGMA user_version').get().user_version, 23); } finally { versionDb.close(); }
}));

test('invalid persisted delivery policy data is rejected before enqueue side effects', () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  assert.throws(() => store.enqueueReplyItem(baseItem({ deliveryPolicy: { version: 1, transport: 'channel',
    scope: { mode: 'device-default' }, fallback: { mode: 'none' }, maxAttempts: 1, secret: true } })), /Invalid bot/);
  assert.equal(store.countPendingReplyItems(), 0);
  store.close();
});

test('version 22 migration rolls back table rebuilding and user_version together', () => withStore(f => {
  const id = f.store.enqueueReplyItem(baseItem());
  f.close();
  const db = new DatabaseSync(f.dbPath);
  try {
    downgradeToV21(db);
    db.exec('DROP INDEX idx_bot_replies_status_enqueued; CREATE INDEX idx_bot_replies_status_enqueued ON nodes(name)');
  } finally { db.close(); }
  assert.throws(() => f.reopen(), /already exists/);
  const check = new DatabaseSync(f.dbPath);
  try {
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 21);
    assert.equal(check.prepare('SELECT id FROM bot_replies').get().id, id);
    assert.equal(check.prepare("SELECT type FROM sqlite_master WHERE name='bot_replies'").get().type, 'table');
  } finally { check.close(); }
}));
