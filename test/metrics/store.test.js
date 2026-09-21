import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetricsStore, resolveBucketWidthMs } from '../../src/metrics/store.js';

function openStore() {
  return new MetricsStore({ dbPath: ':memory:' });
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
  store.recordPacketSample({
    sampleAt: 1_000,
    intervalMs: 10_000,
    packetsReceived: 5,
    packetsPublished: 4,
    radioConnected: true,
    brokersConnected: 2,
    brokersTotal: 2,
    botsReady: 1,
    botsTotal: 1,
    packetsByType: { advert: 3, txtMsg: 1 }
  });

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
  store.recordPacketSample({
    sampleAt: 1_000,
    intervalMs: 10_000,
    packetsReceived: 1,
    packetsPublished: 1,
    radioConnected: true,
    brokersConnected: 1,
    brokersTotal: 1,
    botsReady: 0,
    botsTotal: 0,
    packetsByType: { advert: 1 }
  });
  store.recordPacketSample({
    sampleAt: 500_000,
    intervalMs: 10_000,
    packetsReceived: 1,
    packetsPublished: 1,
    radioConnected: true,
    brokersConnected: 1,
    brokersTotal: 1,
    botsReady: 0,
    botsTotal: 0,
    packetsByType: { advert: 9 }
  });

  const totals = store.queryPacketTypeTotals({ start: 0, end: 100_000 });
  assert.deepEqual(totals, [{ packetTypeBucket: 'advert', total: 1 }]);
  store.close();
});

test('queryPacketHistory groups samples into backend-computed buckets bounded by maxBuckets', () => {
  const store = openStore();
  const sampleIntervalMs = 10_000;

  for (let i = 0; i < 20; i += 1) {
    store.recordPacketSample({
      sampleAt: i * sampleIntervalMs,
      intervalMs: sampleIntervalMs,
      packetsReceived: 1,
      packetsPublished: 1,
      radioConnected: true,
      brokersConnected: 1,
      brokersTotal: 1,
      botsReady: 0,
      botsTotal: 0,
      packetsByType: { advert: 1 }
    });
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

test('queryPacketHistory buckets include received/published sums even for samples with no decoded packet types', () => {
  const store = openStore();
  const sampleIntervalMs = 10_000;

  // Every raw packet received, but none successfully decoded/published -
  // this sample has no metrics_sample_packet_types rows at all.
  store.recordPacketSample({
    sampleAt: 0,
    intervalMs: sampleIntervalMs,
    packetsReceived: 7,
    packetsPublished: 0,
    radioConnected: true,
    brokersConnected: 1,
    brokersTotal: 1,
    botsReady: 0,
    botsTotal: 0,
    packetsByType: {}
  });

  const [bucket] = store.queryPacketHistory({
    start: 0,
    end: sampleIntervalMs,
    maxBuckets: 180,
    sampleIntervalMs
  });

  assert.equal(bucket.packetsReceived, 7);
  assert.equal(bucket.packetsPublished, 0);
  assert.deepEqual(bucket.countsByType, {});
  store.close();
});

test('records and queries bot command events, scoped by bot name and time window', () => {
  const store = openStore();
  store.recordBotCommand({ botName: 'echo', trigger: '!echo', occurredAt: 1_000 });
  store.recordBotCommand({ botName: 'echo', trigger: '!echo', occurredAt: 2_000 });
  store.recordBotCommand({ botName: 'echo', trigger: '!test', occurredAt: 3_000 });
  store.recordBotCommand({ botName: 'weather', trigger: '!wx', occurredAt: 4_000 });
  store.recordBotCommand({ botName: 'echo', trigger: '!echo', occurredAt: 999_999 });

  const counts = store.queryBotCommandCounts({ botName: 'echo', start: 0, end: 10_000 });
  assert.deepEqual(counts, [
    { trigger: '!echo', count: 2 },
    { trigger: '!test', count: 1 }
  ]);
  store.close();
});

test('getEarliestSampleAt returns null with no data and the minimum sample_at once populated', () => {
  const store = openStore();
  assert.equal(store.getEarliestSampleAt(), null);

  store.recordPacketSample({
    sampleAt: 5_000,
    intervalMs: 10_000,
    packetsReceived: 0,
    packetsPublished: 0,
    radioConnected: true,
    brokersConnected: 0,
    brokersTotal: 0,
    botsReady: 0,
    botsTotal: 0,
    packetsByType: {}
  });
  store.recordPacketSample({
    sampleAt: 1_000,
    intervalMs: 10_000,
    packetsReceived: 0,
    packetsPublished: 0,
    radioConnected: true,
    brokersConnected: 0,
    brokersTotal: 0,
    botsReady: 0,
    botsTotal: 0,
    packetsByType: {}
  });

  assert.equal(store.getEarliestSampleAt(), 1_000);
  store.close();
});

test('pruneOlderThan removes samples, their packet-type rows, and bot command events at or before the cutoff', () => {
  const store = openStore();
  store.recordPacketSample({
    sampleAt: 1_000,
    intervalMs: 10_000,
    packetsReceived: 1,
    packetsPublished: 1,
    radioConnected: true,
    brokersConnected: 1,
    brokersTotal: 1,
    botsReady: 0,
    botsTotal: 0,
    packetsByType: { advert: 1 }
  });
  store.recordPacketSample({
    sampleAt: 50_000,
    intervalMs: 10_000,
    packetsReceived: 1,
    packetsPublished: 1,
    radioConnected: true,
    brokersConnected: 1,
    brokersTotal: 1,
    botsReady: 0,
    botsTotal: 0,
    packetsByType: { advert: 1 }
  });
  store.recordBotCommand({ botName: 'echo', trigger: '!echo', occurredAt: 1_000 });
  store.recordBotCommand({ botName: 'echo', trigger: '!echo', occurredAt: 50_000 });

  store.pruneOlderThan(10_000);

  assert.equal(store.getEarliestSampleAt(), 50_000);
  assert.deepEqual(store.queryPacketTypeTotals({ start: 0, end: 100_000 }), [
    { packetTypeBucket: 'advert', total: 1 }
  ]);
  assert.deepEqual(store.queryBotCommandCounts({ botName: 'echo', start: 0, end: 100_000 }), [
    { trigger: '!echo', count: 1 }
  ]);
  store.close();
});

test('creates the db file\'s parent directory, and reopening it later re-runs migrations without failing or losing data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshcore-metrics-store-'));
  const dbPath = join(dir, 'nested', 'metrics.sqlite3');

  try {
    const first = new MetricsStore({ dbPath });
    first.recordPacketSample({
      sampleAt: 1_000,
      intervalMs: 10_000,
      packetsReceived: 1,
      packetsPublished: 1,
      radioConnected: true,
      brokersConnected: 1,
      brokersTotal: 1,
      botsReady: 0,
      botsTotal: 0,
      packetsByType: { advert: 1 }
    });
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
