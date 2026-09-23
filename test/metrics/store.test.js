import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetricsStore, resolveBucketWidthMs } from '../../src/metrics/store.js';

function openStore() {
  return new MetricsStore({ dbPath: ':memory:' });
}

function baseSample(overrides = {}) {
  return {
    sampleAt: 1_000,
    intervalMs: 10_000,
    packetsReceived: 1,
    packetsDecoded: 1,
    radioConnected: true,
    brokersConnected: 1,
    brokersTotal: 1,
    botsReady: 0,
    botsTotal: 0,
    replyQueueSize: 0,
    packetsByType: {},
    brokerDeliveries: {},
    ...overrides
  };
}

test('resolveBucketWidthMs picks the sample interval when the range easily fits within maxBuckets', () => {
  const width = resolveBucketWidthMs({ rangeMs: 60_000, maxBuckets: 180, sampleIntervalMs: 10_000 });
  assert.equal(width, 10_000);
});

test('resolveBucketWidthMs snaps up to the next ladder rung once the sample interval would exceed maxBuckets', () => {
  // 24h at a 10s sample interval is 8640 samples - far more than 180 buckets,
  // so it must snap up past the sample interval. Ideal width is 480,000ms
  // (24h / 180), and the smallest ladder rung >= that is 15m (900,000ms).
  const width = resolveBucketWidthMs({ rangeMs: 24 * 60 * 60 * 1000, maxBuckets: 180, sampleIntervalMs: 10_000 });
  assert.equal(width, 900_000); // 15m
  assert.ok(Math.ceil((24 * 60 * 60 * 1000) / width) <= 180);
});

test('resolveBucketWidthMs falls back to a multiple of the largest rung for very large ranges', () => {
  // With only 5 buckets to cover it, 2 years overflows even the 30d rung
  // (ideal width ~12.6 30d-rungs), forcing the multiple-of-30d fallback.
  const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;
  const width = resolveBucketWidthMs({ rangeMs: twoYearsMs, maxBuckets: 5, sampleIntervalMs: 10_000 });
  assert.equal(width % 2_592_000_000, 0); // still a whole multiple of the 30d rung
  assert.ok(width > 2_592_000_000);
  assert.ok(Math.ceil(twoYearsMs / width) <= 5);
});

test('resolveBucketWidthMs never returns a width smaller than the sample interval', () => {
  const width = resolveBucketWidthMs({ rangeMs: 0, maxBuckets: 180, sampleIntervalMs: 10_000 });
  assert.equal(width, 10_000);
});

test('records a packet sample and reads it back via queryPacketTypeTotals', () => {
  const store = openStore();
  store.recordPacketSample(baseSample({ packetsReceived: 5, packetsDecoded: 4, packetsByType: { advert: 3, txtMsg: 1 } }));

  const totals = store.queryPacketTypeTotals({ start: 0, end: 100_000 });
  assert.deepEqual(
    totals.sort((a, b) => a.packetTypeBucket.localeCompare(b.packetTypeBucket)),
    [
      { packetTypeBucket: 'advert', total: 3 },
      { packetTypeBucket: 'txtMsg', total: 1 }
    ]
  );
  store.close();
});

test('queryPacketTypeTotals excludes samples outside the requested window', () => {
  const store = openStore();
  store.recordPacketSample(baseSample({ sampleAt: 1_000, packetsByType: { advert: 1 } }));
  store.recordPacketSample(baseSample({ sampleAt: 500_000, packetsByType: { advert: 9 } }));

  const totals = store.queryPacketTypeTotals({ start: 0, end: 100_000 });
  assert.deepEqual(totals, [{ packetTypeBucket: 'advert', total: 1 }]);
  store.close();
});

test('queryPacketHistory groups samples into backend-computed buckets bounded by maxBuckets', () => {
  const store = openStore();
  const sampleIntervalMs = 10_000;

  for (let i = 0; i < 20; i += 1) {
    store.recordPacketSample(
      baseSample({ sampleAt: i * sampleIntervalMs, intervalMs: sampleIntervalMs, packetsByType: { advert: 1 } })
    );
  }

  const buckets = store.queryPacketHistory({
    start: 0,
    end: 20 * sampleIntervalMs,
    maxBuckets: 4,
    sampleIntervalMs
  });

  assert.ok(buckets.length <= 4);
  const total = buckets.reduce((sum, bucket) => sum + (bucket.countsByType.advert ?? 0), 0);
  assert.equal(total, 20);
  for (let i = 1; i < buckets.length; i += 1) {
    assert.ok(buckets[i].bucketStart > buckets[i - 1].bucketStart);
  }
  store.close();
});

test('queryPacketHistory buckets include received/decoded sums even for samples with no decoded packet types', () => {
  const store = openStore();
  const sampleIntervalMs = 10_000;

  // Every raw packet received, but none successfully decoded/published -
  // this sample has no metrics_sample_packet_types rows at all.
  store.recordPacketSample(baseSample({ sampleAt: 0, intervalMs: sampleIntervalMs, packetsReceived: 7, packetsDecoded: 0 }));

  const [bucket] = store.queryPacketHistory({
    start: 0,
    end: sampleIntervalMs,
    maxBuckets: 180,
    sampleIntervalMs
  });

  assert.equal(bucket.packetsReceived, 7);
  assert.equal(bucket.packetsDecoded, 0);
  assert.deepEqual(bucket.countsByType, {});
  store.close();
});

test('records a broker-delivery breakdown and reads it back via queryBrokerDeliveryTotals', () => {
  const store = openStore();
  store.recordPacketSample(
    baseSample({ sampleAt: 1_000, brokerDeliveries: { okimesh: { sent: 3, skipped: 0, failed: 1 }, letsmesh: { sent: 2, skipped: 1, failed: 0 } } })
  );

  const totals = store.queryBrokerDeliveryTotals({ start: 0, end: 100_000 });
  assert.deepEqual(totals, [
    { brokerId: 'letsmesh', outcome: 'sent', total: 2 },
    { brokerId: 'letsmesh', outcome: 'skipped', total: 1 },
    { brokerId: 'okimesh', outcome: 'failed', total: 1 },
    { brokerId: 'okimesh', outcome: 'sent', total: 3 }
  ]);
  store.close();
});

test('queryBrokerDeliveryTotals omits zero-count (broker, outcome) pairs rather than storing them', () => {
  const store = openStore();
  store.recordPacketSample(baseSample({ brokerDeliveries: { okimesh: { sent: 1, skipped: 0, failed: 0 } } }));

  const totals = store.queryBrokerDeliveryTotals({ start: 0, end: 100_000 });
  assert.deepEqual(totals, [{ brokerId: 'okimesh', outcome: 'sent', total: 1 }]);
  store.close();
});

// Seeds one already-resolved reply (enqueue -> peek -> resolve) rather
// than a direct table insert, exercising the real path a resolved row is
// produced through now that bot_replies covers a reply's whole lifecycle
// (see the store's v5 migration doc comment) - there's no more standalone
// "just record an outcome" API to seed historical rows with directly.
function seedResolvedReply(store, { status, resolvedAt, queuedMs = 0, ...itemOverrides }) {
  store.enqueueReplyItem(baseReplyQueueItem({ enqueuedAt: resolvedAt - queuedMs, expiresAt: resolvedAt + 60_000, ...itemOverrides }));
  const item = store.peekOldestPendingReplyItem();
  store.resolveReplyItem(item.id, { status, resolvedAt, queuedMs });
}

test('records and queries reply events, scoped by bot name/outcome and time window', () => {
  const store = openStore();
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', sender: 'Jeymz', hash: 'aa', status: 'sent', resolvedAt: 1_000, queuedMs: 10 });
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', sender: 'Jeymz', hash: 'bb', status: 'sent', resolvedAt: 2_000, queuedMs: 12 });
  seedResolvedReply(store, { botName: 'echo', trigger: '!test', sender: 'Jeymz', hash: 'cc', status: 'sent', resolvedAt: 3_000, queuedMs: 8 });
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', sender: 'Jeymz', hash: 'dd', status: 'failed', resolvedAt: 3_500, queuedMs: 20 });
  seedResolvedReply(store, { botName: 'weather', trigger: '!wx', sender: 'Robotti', hash: 'ee', status: 'sent', resolvedAt: 4_000, queuedMs: 5 });
  // Outside the queried window below - must not be counted.
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', sender: 'Jeymz', hash: 'ff', status: 'sent', resolvedAt: 999_999, queuedMs: 9 });

  const counts = store.queryBotCommandCounts({ botName: 'echo', start: 0, end: 10_000 });
  assert.deepEqual(counts, [
    { trigger: '!echo', count: 2 },
    { trigger: '!test', count: 1 }
  ]);

  const outcomeTotals = store.queryBotReplyOutcomeTotals({ start: 0, end: 10_000 });
  assert.deepEqual(outcomeTotals, [
    { botName: 'echo', outcome: 'failed', total: 1 },
    { botName: 'echo', outcome: 'sent', total: 3 },
    { botName: 'weather', outcome: 'sent', total: 1 }
  ]);
  store.close();
});

test('queryReplyOutcomeTotals sums every outcome across every bot, within the requested window', () => {
  const store = openStore();
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', status: 'sent', resolvedAt: 1_000 });
  seedResolvedReply(store, { botName: 'weather', trigger: '!wx', status: 'sent', resolvedAt: 2_000 });
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', status: 'failed', resolvedAt: 3_000 });
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', status: 'expired', resolvedAt: 4_000 });
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', status: 'expired', resolvedAt: 5_000 });
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', status: 'cancelled', resolvedAt: 6_000 });
  // Outside the queried window below - must not be counted.
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', status: 'sent', resolvedAt: 999_999_999 });

  assert.deepEqual(store.queryReplyOutcomeTotals({ start: 0, end: 10_000 }), { sent: 2, failed: 1, expired: 2, cancelled: 1 });
  store.close();
});

test('queryReplyOutcomeTotals excludes still-pending items (only resolved statuses count)', () => {
  const store = openStore();
  store.enqueueReplyItem(baseReplyQueueItem({ enqueuedAt: 1_000, expiresAt: 61_000 }));

  assert.deepEqual(store.queryReplyOutcomeTotals({ start: 0, end: 10_000 }), { sent: 0, failed: 0, expired: 0, cancelled: 0 });
  store.close();
});

test('queryReplyOutcomeTotals returns all-zero counts when nothing was resolved in the window', () => {
  const store = openStore();
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', status: 'sent', resolvedAt: 999_999_999 });
  assert.deepEqual(store.queryReplyOutcomeTotals({ start: 0, end: 10_000 }), { sent: 0, failed: 0, expired: 0, cancelled: 0 });
  store.close();
});

function baseNode(overrides = {}) {
  return {
    publicKeyHex: 'E85C'.repeat(16),
    name: 'Summit Repeater',
    type: 'REPEATER',
    heardAt: 1_000,
    ...overrides
  };
}

test('upsertNode inserts a new node with first_heard_at and last_heard_at both set to heardAt', () => {
  const store = openStore();
  store.upsertNode(baseNode());

  const { nodes } = store.queryNodes({ limit: 10, offset: 0 });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].publicKeyHex, 'E85C'.repeat(16));
  assert.equal(nodes[0].name, 'Summit Repeater');
  assert.equal(nodes[0].type, 'REPEATER');
  assert.equal(nodes[0].firstHeardAt, 1_000);
  assert.equal(nodes[0].lastHeardAt, 1_000);
  store.close();
});

test('upsertNode on an existing public key refreshes name/type/last_heard_at but never first_heard_at', () => {
  const store = openStore();
  store.upsertNode(baseNode({ heardAt: 1_000, name: 'Old Name' }));
  store.upsertNode(baseNode({ heardAt: 5_000, name: 'New Name', type: 'CHAT' }));

  const { nodes } = store.queryNodes({ limit: 10, offset: 0 });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'New Name');
  assert.equal(nodes[0].type, 'CHAT');
  assert.equal(nodes[0].firstHeardAt, 1_000);
  assert.equal(nodes[0].lastHeardAt, 5_000);
  store.close();
});

test('queryNodeTotals counts a once-heard node as added only, never also updated', () => {
  const store = openStore();
  store.upsertNode(baseNode({ heardAt: 5_000 }));

  assert.deepEqual(store.queryNodeTotals({ start: 0, end: 10_000 }), { added: 1, updated: 0 });
  store.close();
});

test('queryNodeTotals counts a re-heard node as updated (once), independent of when it was first added', () => {
  const store = openStore();
  store.upsertNode(baseNode({ publicKeyHex: 'AA'.repeat(32), heardAt: -1_000 })); // added before the window
  store.upsertNode(baseNode({ publicKeyHex: 'AA'.repeat(32), heardAt: 5_000 })); // re-heard inside the window

  assert.deepEqual(store.queryNodeTotals({ start: 0, end: 10_000 }), { added: 0, updated: 1 });
  store.close();
});

test('queryNodeTotals with a type filter only counts nodes of that type', () => {
  const store = openStore();
  store.upsertNode(baseNode({ heardAt: 5_000, type: 'REPEATER' }));
  store.upsertNode(baseNode({ publicKeyHex: 'AA'.repeat(32), heardAt: 5_000, type: 'CHAT' }));

  assert.deepEqual(store.queryNodeTotals({ start: 0, end: 10_000, type: 'REPEATER' }), { added: 1, updated: 0 });
  store.close();
});

test('queryNodeTotals excludes nodes whose first/last heard falls outside the window', () => {
  const store = openStore();
  store.upsertNode(baseNode({ heardAt: 999_999 }));

  assert.deepEqual(store.queryNodeTotals({ start: 0, end: 10_000 }), { added: 0, updated: 0 });
  store.close();
});

test('queryNodes matches a case-insensitive name substring', () => {
  const store = openStore();
  store.upsertNode(baseNode({ name: 'Summit Repeater' }));
  store.upsertNode(baseNode({ publicKeyHex: 'AA'.repeat(32), name: 'Valley Room', type: 'ROOM' }));

  const { total, nodes } = store.queryNodes({ q: 'summit', limit: 10, offset: 0 });
  assert.equal(total, 1);
  assert.equal(nodes[0].name, 'Summit Repeater');
  store.close();
});

test('queryNodes matches a public-key hex prefix', () => {
  const store = openStore();
  store.upsertNode(baseNode({ publicKeyHex: 'E85C'.repeat(16) }));
  store.upsertNode(baseNode({ publicKeyHex: 'AA'.repeat(32), name: 'Other' }));

  const { total, nodes } = store.queryNodes({ q: 'e85c', limit: 10, offset: 0 });
  assert.equal(total, 1);
  assert.equal(nodes[0].publicKeyHex, 'E85C'.repeat(16));
  store.close();
});

test('queryNodes filters by type', () => {
  const store = openStore();
  store.upsertNode(baseNode({ type: 'REPEATER' }));
  store.upsertNode(baseNode({ publicKeyHex: 'AA'.repeat(32), name: 'Other', type: 'CHAT' }));

  const { total, nodes } = store.queryNodes({ type: 'CHAT', limit: 10, offset: 0 });
  assert.equal(total, 1);
  assert.equal(nodes[0].type, 'CHAT');
  store.close();
});

test('queryNodes paginates via limit/offset and sorts most-recently-heard first', () => {
  const store = openStore();
  store.upsertNode(baseNode({ publicKeyHex: 'AA'.repeat(32), name: 'Oldest', heardAt: 1_000 }));
  store.upsertNode(baseNode({ publicKeyHex: 'BB'.repeat(32), name: 'Newest', heardAt: 3_000 }));
  store.upsertNode(baseNode({ publicKeyHex: 'CC'.repeat(32), name: 'Middle', heardAt: 2_000 }));

  const page1 = store.queryNodes({ limit: 2, offset: 0 });
  assert.equal(page1.total, 3);
  assert.deepEqual(page1.nodes.map((n) => n.name), ['Newest', 'Middle']);

  const page2 = store.queryNodes({ limit: 2, offset: 2 });
  assert.deepEqual(page2.nodes.map((n) => n.name), ['Oldest']);
  store.close();
});

test('queryNodes returns everything, unfiltered, when q and type are both omitted', () => {
  const store = openStore();
  store.upsertNode(baseNode());
  store.upsertNode(baseNode({ publicKeyHex: 'AA'.repeat(32), name: 'Other', type: 'CHAT' }));

  const { total } = store.queryNodes({ limit: 10, offset: 0 });
  assert.equal(total, 2);
  store.close();
});

function baseReplyQueueItem(overrides = {}) {
  return {
    botName: 'echo',
    channel: '#echo',
    trigger: '!echo',
    sender: 'Jeymz',
    hopCount: 1,
    path: 'AA',
    hash: 'deadbeef',
    enqueuedAt: 1_000,
    expiresAt: 61_000,
    ...overrides
  };
}

test('enqueueReplyItem persists a pending item, reflected in countPendingReplyItems', () => {
  const store = openStore();
  assert.equal(store.countPendingReplyItems(), 0);

  store.enqueueReplyItem(baseReplyQueueItem());
  assert.equal(store.countPendingReplyItems(), 1);
  store.close();
});

test('peekOldestPendingReplyItem returns null and changes nothing when the table is empty', () => {
  const store = openStore();
  assert.equal(store.peekOldestPendingReplyItem(), null);
  store.close();
});

test('peekOldestPendingReplyItem returns the item with the earliest enqueuedAt, carrying every field, without removing it', () => {
  const store = openStore();
  store.enqueueReplyItem(baseReplyQueueItem({ trigger: '!second', enqueuedAt: 2_000, expiresAt: 62_000 }));
  store.enqueueReplyItem(
    baseReplyQueueItem({
      trigger: '!first',
      sender: 'Robotti',
      hopCount: 3,
      path: 'AA➡️BB',
      hash: 'cafef00d',
      query: 'E85C',
      lookupOutcome: 'found',
      name: 'Summit Repeater',
      matchCount: 1,
      enqueuedAt: 1_000,
      expiresAt: 61_000
    })
  );

  const item = store.peekOldestPendingReplyItem();
  assert.equal(item.trigger, '!first');
  assert.equal(item.botName, 'echo');
  assert.equal(item.channel, '#echo');
  assert.equal(item.sender, 'Robotti');
  assert.equal(item.hopCount, 3);
  assert.equal(item.path, 'AA➡️BB');
  assert.equal(item.hash, 'cafef00d');
  assert.equal(item.query, 'E85C');
  assert.equal(item.lookupOutcome, 'found');
  assert.equal(item.name, 'Summit Repeater');
  assert.equal(item.matchCount, 1);
  assert.equal(item.enqueuedAt, 1_000);
  assert.equal(item.expiresAt, 61_000);
  assert.equal(item.status, 'pending');

  assert.equal(store.countPendingReplyItems(), 2, 'peeking must not remove or resolve anything');
  assert.equal(store.peekOldestPendingReplyItem().trigger, '!first', 'peeking again returns the same oldest item');
  store.close();
});

test('enqueueReplyItem stores optional lookup-only fields as null when omitted', () => {
  const store = openStore();
  store.enqueueReplyItem(baseReplyQueueItem());

  const item = store.peekOldestPendingReplyItem();
  assert.equal(item.query, null);
  assert.equal(item.lookupOutcome, null);
  assert.equal(item.name, null);
  assert.equal(item.matchCount, null);
  store.close();
});

test('resolveReplyItem moves an item out of pending, recording status/resolvedAt/queuedMs', () => {
  const store = openStore();
  store.enqueueReplyItem(baseReplyQueueItem({ enqueuedAt: 1_000 }));
  const item = store.peekOldestPendingReplyItem();

  store.resolveReplyItem(item.id, { status: 'sent', resolvedAt: 1_500, queuedMs: 500 });

  assert.equal(store.countPendingReplyItems(), 0);
  const resolved = store.getReplyById(item.id);
  assert.equal(resolved.status, 'sent');
  assert.equal(resolved.resolvedAt, 1_500);
  assert.equal(resolved.queuedMs, 500);
  // Every other field (bot/channel/trigger/etc.) is untouched by resolving.
  assert.equal(resolved.trigger, '!echo');
  assert.equal(resolved.enqueuedAt, 1_000);
});

test('getReplyById returns null for an id that does not exist', () => {
  const store = openStore();
  assert.equal(store.getReplyById(999), null);
  store.close();
});

test('takeExpiredReplyItems marks and returns only items at or before the given time as expired, oldest first', () => {
  const store = openStore();
  store.enqueueReplyItem(baseReplyQueueItem({ trigger: '!fresh', enqueuedAt: 1_000, expiresAt: 100_000 }));
  store.enqueueReplyItem(baseReplyQueueItem({ trigger: '!stale-newer', enqueuedAt: 2_000, expiresAt: 5_000 }));
  store.enqueueReplyItem(baseReplyQueueItem({ trigger: '!stale-older', enqueuedAt: 1_500, expiresAt: 4_000 }));

  const expired = store.takeExpiredReplyItems(10_000);
  assert.deepEqual(expired.map((i) => i.trigger), ['!stale-older', '!stale-newer']);
  // The returned rows reflect state *before* the expiry, per the method's
  // own doc comment - still 'pending' here, not 'expired'.
  assert.ok(expired.every((i) => i.status === 'pending'));
  assert.equal(store.countPendingReplyItems(), 1);

  const staleOlder = store.getReplyById(expired[0].id);
  assert.equal(staleOlder.status, 'expired');
  assert.equal(staleOlder.resolvedAt, 10_000);
  assert.equal(staleOlder.queuedMs, 10_000 - 1_500);

  const remaining = store.peekOldestPendingReplyItem();
  assert.equal(remaining.trigger, '!fresh');
  store.close();
});

test('takeExpiredReplyItems returns an empty array and changes nothing when none are expired', () => {
  const store = openStore();
  store.enqueueReplyItem(baseReplyQueueItem({ expiresAt: 100_000 }));

  assert.deepEqual(store.takeExpiredReplyItems(0), []);
  assert.equal(store.countPendingReplyItems(), 1);
  store.close();
});

test('getEarliestSampleAt returns null with no data and the minimum sample_at once populated', () => {
  const store = openStore();
  assert.equal(store.getEarliestSampleAt(), null);

  store.recordPacketSample(baseSample({ sampleAt: 5_000, packetsReceived: 0, packetsDecoded: 0, brokersConnected: 0, brokersTotal: 0 }));
  store.recordPacketSample(baseSample({ sampleAt: 1_000, packetsReceived: 0, packetsDecoded: 0, brokersConnected: 0, brokersTotal: 0 }));

  assert.equal(store.getEarliestSampleAt(), 1_000);
  store.close();
});

test('pruneOlderThan removes samples, their child rows, and resolved replies at or before the cutoff', () => {
  const store = openStore();
  store.recordPacketSample(baseSample({ sampleAt: 1_000, packetsByType: { advert: 1 }, brokerDeliveries: { okimesh: { sent: 1, skipped: 0, failed: 0 } } }));
  store.recordPacketSample(baseSample({ sampleAt: 50_000, packetsByType: { advert: 1 }, brokerDeliveries: { okimesh: { sent: 1, skipped: 0, failed: 0 } } }));
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', status: 'sent', resolvedAt: 1_000 });
  seedResolvedReply(store, { botName: 'echo', trigger: '!echo', status: 'sent', resolvedAt: 50_000 });

  store.pruneOlderThan(10_000);

  assert.equal(store.getEarliestSampleAt(), 50_000);
  assert.deepEqual(store.queryPacketTypeTotals({ start: 0, end: 100_000 }), [
    { packetTypeBucket: 'advert', total: 1 }
  ]);
  assert.deepEqual(store.queryBrokerDeliveryTotals({ start: 0, end: 100_000 }), [
    { brokerId: 'okimesh', outcome: 'sent', total: 1 }
  ]);
  assert.deepEqual(store.queryBotCommandCounts({ botName: 'echo', start: 0, end: 100_000 }), [
    { trigger: '!echo', count: 1 }
  ]);
  store.close();
});

test('pruneOlderThan never removes a still-pending item, no matter how old its enqueuedAt is', () => {
  const store = openStore();
  store.enqueueReplyItem(baseReplyQueueItem({ trigger: '!ancient', enqueuedAt: 1_000, expiresAt: 999_999_999 }));

  store.pruneOlderThan(500_000);

  assert.equal(store.countPendingReplyItems(), 1);
  assert.equal(store.peekOldestPendingReplyItem().trigger, '!ancient');
  store.close();
});

test('creates the db file\'s parent directory, and reopening it later re-runs migrations without failing or losing data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshcore-metrics-store-'));
  const dbPath = join(dir, 'nested', 'metrics.sqlite3');

  try {
    const first = new MetricsStore({ dbPath });
    first.recordPacketSample(baseSample({ packetsByType: { advert: 1 } }));
    first.close();

    const second = new MetricsStore({ dbPath });
    assert.deepEqual(second.queryPacketTypeTotals({ start: 0, end: 100_000 }), [
      { packetTypeBucket: 'advert', total: 1 }
    ]);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
