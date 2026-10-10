import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { MetricsSampler } from '../../src/metrics/sampler.js';
import { MetricsStore } from '../../src/metrics/store.js';
import { RunHistory } from '../../src/metrics/run-history.js';
import { ProcessMeasurements } from '../../src/metrics/process-measurements.js';
import { randomUUID } from 'node:crypto';

const samplers = new Set();

for (const retentionDays of [0,7,36500]) test(`always-on offline maintenance applies shared region retention ${retentionDays} days without losing latest or pending work`, async () => {
  const DAY = 86400000, store = new MetricsStore({ dbPath: ':memory:' }), log = silentLogger(); let sampler;
  try {
    const run = store.beginObserverRun({ runId: randomUUID(), startedAt: 0, observedAt: 0, observedDurationMs: 0,
      appVersion: '2.4.0', nodeVersion: process.version, platform: process.platform, architecture: process.arch });
    for (const [at,brokers] of [[DAY,[]],[2 * DAY,['offline']],[3 * DAY,[]]]) store.recordRegionResult({
      outcome: { requestId: randomUUID(), runId: run.runId, observerPublicKey: 'BE'.repeat(32), targetPublicKey: 'AC'.repeat(32),
        startedAt: 0, completedAt: at, clockAnomaly: false, status: 'answered', reason: null, route: 'direct' },
      answer: { observedAt: at, regions: [], repeaterClock: 0, bodyBytes: 4, csvBytes: 0, parserVersion: 1,
        completeness: 'unknown', provenance: 'companion-tag-attributed' }, brokerIds: brokers });
    vi.setSystemTime(30 * DAY); sampler = makeSampler({ serviceHealth: fakeServiceHealth(baseSnapshot({ mqtt: {}, radioConnected: false })),
      metricsStore: store, sampleIntervalMs: 10, retentionDays, logger: log });
    sampler.start(); await vi.advanceTimersByTimeAsync(10); sampler.stop();
    assert.equal(store.queryRegionAnswers({ start: 0, end: Date.now() }).total, retentionDays === 7 ? 2 : 3);
    assert.equal(store.queryRegionPublications({ brokerId: 'offline' }).publications[0].observedAt, 2 * DAY);
    const latest = store.getRegionLatest({ observerPublicKey: 'BE'.repeat(32), targetPublicKey: 'AC'.repeat(32), now: Date.now(), windowMs: 72 * 3600000 });
    assert.equal(latest.presence, 'empty'); assert.equal(latest.freshness, 'stale'); assert.equal(latest.answer.observedAt, 3 * DAY);
    assert.equal(log.calls.warn.length, 0);
  } finally { sampler?.stop(); store.close(); }
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const sampler of samplers) sampler.stop();
  samplers.clear();
  vi.useRealTimers();
});

function makeSampler(options) {
  const sampler = new MetricsSampler(options);
  samplers.add(sampler);
  return sampler;
}

function silentLogger() {
  const calls = { warn: [] };
  return {
    calls,
    debug() {},
    info() {},
    warn: (source, message, meta) => calls.warn.push({ source, message, meta }),
    error() {}
  };
}

function fakeServiceHealth(snapshot) {
  return { snapshot: () => snapshot };
}

function baseSnapshot(overrides = {}) {
  return {
    packetsReceived: 1,
    packetsDecoded: 1,
    packetsByType: {},
    radioConnected: true,
    mqtt: {},
    bots: [],
    replyQueue: { size: 0 },
    ...overrides
  };
}

test('topology cadence/final flush and opt-in daily maintenance isolate failures from ordinary samples', async () => {
  const logger = silentLogger(); let topologyFlushes = 0; let pathsPruned = 0; let packets = 0; let history = 0; let fingerprints = 0;
  const sampler = makeSampler({ serviceHealth: fakeServiceHealth(baseSnapshot()), sampleIntervalMs: 1000,
    retentionDays: 1, repeaterFingerprintPruneAfterDays: 1, topologyPruneAfterDays: 7, logger,
    topologyObserver: { flushCoverage() { topologyFlushes++; throw new Error('fail'); } },
    metricsStore: { recordPacketSample() { packets++; }, pruneOlderThan() { history++; throw new Error('history failure'); },
      pruneInactiveRepeaterFingerprints() { fingerprints++; throw new Error('fingerprint failure'); },
      pruneInactiveTopologyPaths({ cutoffMs }) { pathsPruned++; assert.ok(cutoffMs <= Date.now() - 7 * 86400000); throw new Error('topology failure'); } } });
  sampler.start(); await vi.advanceTimersByTimeAsync(2000); sampler.stop(); sampler.flushTopologyCoverage();
  assert.equal(topologyFlushes, 3); assert.equal(packets, 2); assert.equal(history, 1); assert.equal(fingerprints, 1); assert.equal(pathsPruned, 1);
  assert.ok(logger.calls.warn.some((item) => item.message === 'failed to prune inactive topology paths'));
});

test('process history is run-linked on the existing cadence without changing packet/SSE snapshots', async () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const baseline = Date.now(); const logger = silentLogger(); const snapshot = baseSnapshot();
  const runHistory = new RunHistory({ store, startedAt: baseline, monotonicStartedAt: baseline,
    monotonicNow: Date.now, metadata: { appVersion: '2.5.0', nodeVersion: process.version, platform: process.platform, architecture: process.arch } });
  const processMeasurements = new ProcessMeasurements({ monotonicNow: Date.now, cpuUsage: () => ({ user: (Date.now() - baseline) * 250, system: 0 }),
    memoryUsage: () => ({ rss: 100, heapTotal: 80, heapUsed: 60, external: 20 }),
    eventLoopUsage: () => ({ active: 0, idle: 0, utilization: 0 }) });
  const sampler = makeSampler({ serviceHealth: fakeServiceHealth(snapshot), metricsStore: store, runHistory, processMeasurements,
    sampleIntervalMs: 1000, retentionDays: 0, logger });
  const emitted = []; sampler.on('sample', (value) => emitted.push(value));
  try {
    sampler.start(); await vi.advanceTimersByTimeAsync(2000); sampler.stop();
    const rows = store.queryProcessSamples({ start: 0, end: Number.MAX_SAFE_INTEGER }).samples;
    assert.equal(rows.length, 2); assert.equal(rows[0].runId, runHistory.runId);
    assert.equal(rows[0].intervalMs, 1000); assert.equal(rows[0].cpuPercent, 25); assert.equal(rows[1].cpuPercent, null);
    assert.equal(store.getObserverRun({ runId: runHistory.runId }).observedDurationMs, 2000);
    assert.deepEqual(emitted, [snapshot, snapshot]);
    assert.equal(Object.hasOwn(snapshot, 'cpuPercent'), false);
    assert.equal(store.queryPacketTotals({ start: baseline, end: baseline + 3000 }).received, 1);
  } finally { sampler.stop(); store.close(); }
});

test('optional process persistence failure preserves counts, falls back to heartbeat, and keeps packet sampling alive', async () => {
  const logger = silentLogger(); let checkpoints = 0; let packets = 0; let writes = 0; let acknowledged = 0;
  const runtimeEvents = { observeSnapshot() {}, pendingCounts: () => ({ suppressedEvents: 3, failedEvents: 2 }),
    acknowledgeCounts: (counts) => { assert.deepEqual(counts, { suppressedEvents: 3, failedEvents: 2 }); acknowledged++; } };
  const sampler = makeSampler({ serviceHealth: fakeServiceHealth(baseSnapshot()), sampleIntervalMs: 1000, retentionDays: 0, logger,
    runHistory: { checkpoint: () => checkpoints++, checkpointEvidence: () => ({ runId: 'test', observedAt: Date.now() }) },
    processMeasurements: { collect: () => ({ measurements: {}, unavailable: ['memory'] }) }, runtimeEvents,
    metricsStore: { recordPacketSample: () => packets++, recordProcessSample: (row) => {
      assert.equal(row.suppressedEvents, 3); assert.equal(row.failedEvents, 2);
      if (++writes === 1) throw new Error('disk full');
    } } });
  sampler.start(); await vi.advanceTimersByTimeAsync(2000); sampler.stop();
  assert.equal(checkpoints, 1); assert.equal(packets, 2); assert.equal(acknowledged, 1);
  assert.ok(logger.calls.warn.some((item) => item.source === 'services.processMetrics' && /failed to persist/.test(item.message)));
  assert.ok(logger.calls.warn.some((item) => item.message === 'process measurements unavailable'));
});

test('failed collector/readiness observation cannot stop heartbeat, packets or later collection', async () => {
  const logger = silentLogger(); let packets = 0; let checkpoints = 0;
  const sampler = makeSampler({ serviceHealth: fakeServiceHealth(baseSnapshot()), sampleIntervalMs: 1000, retentionDays: 0, logger,
    runHistory: { checkpoint: () => checkpoints++ }, processMeasurements: { collect: () => { throw new Error('measurement failed'); } },
    runtimeEvents: { observeSnapshot: () => { throw new Error('snapshot failed'); } },
    metricsStore: { recordPacketSample: () => packets++ } });
  sampler.start(); await vi.advanceTimersByTimeAsync(2000); sampler.stop();
  assert.equal(packets, 2); assert.equal(checkpoints, 2);
  assert.ok(logger.calls.warn.some((item) => item.source === 'services.runtimeEvents'));
});

test('emits "sample" with the fresh snapshot on every tick, and persists it', async () => {
  const persisted = [];
  const metricsStore = {
    recordPacketSample: (sample) => persisted.push(sample),
    pruneOlderThan: () => {}
  };
  const snapshot = baseSnapshot({ packetsReceived: 3, packetsDecoded: 2 });
  const sampler = makeSampler({
    serviceHealth: fakeServiceHealth(snapshot),
    metricsStore,
    sampleIntervalMs: 10,
    retentionDays: 0,
    logger: silentLogger()
  });

  const emitted = [];
  sampler.on('sample', (s) => emitted.push(s));
  sampler.start();
  await vi.advanceTimersByTimeAsync(50);
  sampler.stop();

  assert.ok(emitted.length > 0, 'expected at least one sample tick');
  assert.equal(emitted[0], snapshot);
  assert.ok(persisted.length > 0);
  assert.equal(persisted[0].packetsReceived, 3);
  assert.equal(persisted[0].packetsDecoded, 2);
});

test('a later tick reports only the delta since the previous tick, not the cumulative total', async () => {
  const persisted = [];
  const metricsStore = { recordPacketSample: (sample) => persisted.push(sample), pruneOlderThan: () => {} };
  let received = 5;
  const serviceHealth = { snapshot: () => baseSnapshot({ packetsReceived: received, packetsDecoded: received }) };
  const sampler = makeSampler({ serviceHealth, metricsStore, sampleIntervalMs: 15, retentionDays: 0, logger: silentLogger() });

  sampler.start();
  await vi.advanceTimersByTimeAsync(15);
  received = 8; // +3 since the first tick
  await vi.advanceTimersByTimeAsync(15);
  sampler.stop();

  assert.ok(persisted.length >= 2, 'expected at least two ticks');
  assert.equal(persisted[0].packetsReceived, 5); // first tick: no prior snapshot, delta == cumulative
  assert.equal(persisted[1].packetsReceived, 3); // second tick: only the increase
});

test('a store failure while recording a sample is caught and logged, never thrown', async () => {
  const logger = silentLogger();
  const metricsStore = {
    recordPacketSample: () => {
      throw new Error('disk full');
    }
  };
  const sampler = makeSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore,
    sampleIntervalMs: 10,
    retentionDays: 0,
    logger
  });

  sampler.start();
  await vi.advanceTimersByTimeAsync(30);
  sampler.stop();

  assert.ok(logger.calls.warn.some((call) => call.message.includes('failed to persist a metrics sample')));
});

test('never prunes when retentionDays is 0 (unlimited retention)', async () => {
  const pruneCalls = [];
  const metricsStore = { recordPacketSample: () => {}, pruneOlderThan: (cutoff) => pruneCalls.push(cutoff) };
  const sampler = makeSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore,
    sampleIntervalMs: 10,
    retentionDays: 0,
    logger: silentLogger()
  });

  sampler.start();
  await vi.advanceTimersByTimeAsync(40);
  sampler.stop();

  assert.equal(pruneCalls.length, 0, 'retentionDays: 0 must never prune');
});

test('prunes with a positive retentionDays configured', async () => {
  const pruneCalls = [];
  const metricsStore = { recordPacketSample: () => {}, pruneOlderThan: (cutoff) => pruneCalls.push(cutoff) };
  const sampler = makeSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore,
    sampleIntervalMs: 10,
    retentionDays: 7,
    logger: silentLogger()
  });

  sampler.start();
  await vi.advanceTimersByTimeAsync(30);
  sampler.stop();

  assert.ok(pruneCalls.length >= 1, 'expected at least one prune call');
  assert.ok(pruneCalls.every((cutoff) => typeof cutoff === 'number'));
});

test('a prune failure is caught and logged, never thrown', async () => {
  const logger = silentLogger();
  const metricsStore = {
    recordPacketSample: () => {},
    pruneOlderThan: () => {
      throw new Error('locked');
    }
  };
  const sampler = makeSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore,
    sampleIntervalMs: 10,
    retentionDays: 7,
    logger
  });

  sampler.start();
  await vi.advanceTimersByTimeAsync(30);
  sampler.stop();

  assert.ok(logger.calls.warn.some((call) => call.message.includes('failed to prune persisted metrics')));
});

test('start() is idempotent - calling it twice does not double the tick rate', async () => {
  const persisted = [];
  const metricsStore = { recordPacketSample: (sample) => persisted.push(sample) };
  const sampler = makeSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore,
    sampleIntervalMs: 20,
    retentionDays: 0,
    logger: silentLogger()
  });

  sampler.start();
  sampler.start();
  await vi.advanceTimersByTimeAsync(45);
  sampler.stop();

  // ~2 ticks expected at a 20ms interval over 45ms; a doubled rate (two
  // independent timers) would produce roughly twice that.
  assert.ok(persisted.length <= 3, `expected about 2 ticks, got ${persisted.length}`);
});

test('stop() is idempotent and safe to call without a prior start()', () => {
  const sampler = makeSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore: { recordPacketSample: () => {} },
    sampleIntervalMs: 10,
    retentionDays: 0,
    logger: silentLogger()
  });

  assert.doesNotThrow(() => sampler.stop());
  assert.doesNotThrow(() => sampler.stop());
});

test('stop() actually halts ticking - no further samples after stop', async () => {
  const persisted = [];
  const metricsStore = { recordPacketSample: (sample) => persisted.push(sample) };
  const sampler = makeSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore,
    sampleIntervalMs: 10,
    retentionDays: 0,
    logger: silentLogger()
  });

  sampler.start();
  await vi.advanceTimersByTimeAsync(25);
  sampler.stop();
  const countAtStop = persisted.length;
  await vi.advanceTimersByTimeAsync(40);

  assert.equal(persisted.length, countAtStop);
});

test('fingerprint cleanup is off by default even when history retention is configured', async () => {
  const removed = [];
  const sampler = makeSampler({ serviceHealth: fakeServiceHealth(baseSnapshot()), sampleIntervalMs: 10,
    retentionDays: 7, logger: silentLogger(), metricsStore: {
      recordPacketSample() {}, pruneOlderThan() {}, pruneInactiveRepeaterFingerprints: (query) => removed.push(query)
    } });
  sampler.start(); await vi.advanceTimersByTimeAsync(30);
  assert.equal(removed.length, 0);
});

test('days-based fingerprint cleanup runs locally with unlimited history and at most once a day', async () => {
  const DAY = 86400000; const removed = []; const history = [];
  const now = 30 * DAY;
  vi.setSystemTime(now);
  const sampler = makeSampler({ serviceHealth: fakeServiceHealth(baseSnapshot()), sampleIntervalMs: 10,
    retentionDays: 0, repeaterFingerprintPruneAfterDays: 7, logger: silentLogger(), metricsStore: {
      recordPacketSample() {}, pruneOlderThan: (cutoff) => history.push(cutoff),
      pruneInactiveRepeaterFingerprints: (query) => { removed.push(query); return 0; }
    } });
  sampler.start(); await vi.advanceTimersByTimeAsync(30);
  assert.deepEqual(removed, [{ cutoffMs: now + 10 - 7 * DAY }]);
  assert.equal(history.length, 0);
  vi.setSystemTime(now + DAY);
  await vi.advanceTimersByTimeAsync(30);
  assert.equal(removed.length, 2);
  assert.equal(history.length, 0);
});

test('cleanup failures are isolated and reported, and saved history protects fingerprints after history failure', async () => {
  const order = []; const logger = silentLogger();
  vi.setSystemTime(30 * 86400000);
  const sampler = makeSampler({ serviceHealth: fakeServiceHealth(baseSnapshot()), sampleIntervalMs: 10,
    retentionDays: 14, repeaterFingerprintPruneAfterDays: 7, logger, metricsStore: {
      recordPacketSample() {}, pruneOlderThan() { order.push('history'); throw new Error('history locked'); },
      pruneInactiveRepeaterFingerprints() { order.push('fingerprints'); throw new Error('fingerprints locked'); }
    } });
  const samples = []; sampler.on('sample', (sample) => samples.push(sample));
  sampler.start(); await vi.advanceTimersByTimeAsync(30);
  assert.deepEqual(order, ['history', 'fingerprints']);
  assert.equal(logger.calls.warn.length, 2);
  assert.equal(samples.length, 3);
});

test('clock rollback delays cleanup and never supplies a negative fingerprint cutoff', async () => {
  const calls = [];
  vi.setSystemTime(1000);
  const sampler = makeSampler({ serviceHealth: fakeServiceHealth(baseSnapshot()), sampleIntervalMs: 10,
    retentionDays: 0, repeaterFingerprintPruneAfterDays: 7, logger: silentLogger(), metricsStore: {
      recordPacketSample() {}, pruneInactiveRepeaterFingerprints: (query) => { calls.push(query); return 0; }
    } });
  sampler.start(); await vi.advanceTimersByTimeAsync(20);
  assert.equal(calls.length, 0);
  vi.setSystemTime(30 * 86400000); await vi.advanceTimersByTimeAsync(10);
  assert.equal(calls.length, 1);
  vi.setSystemTime(29 * 86400000); await vi.advanceTimersByTimeAsync(30);
  assert.equal(calls.length, 1);
});

test('always-on local maintenance preserves offline lookup and direct evidence using the real store', async () => {
  const DAY = 86400000; const KEY = 'AB'.repeat(32);
  const store = new MetricsStore({ dbPath: ':memory:' });
  let sampler;
  try {
    for (let i = 1; i <= 2; i++) store.recordVerifiedAdvert({ publicKeyHex: KEY, name: 'Offline Summit',
      type: 'REPEATER', eventDigest: String(i).repeat(64), receivedAt: i * DAY, hopCount: 0 });
    vi.setSystemTime(30 * DAY);
    sampler = makeSampler({ serviceHealth: fakeServiceHealth(baseSnapshot({ mqtt: {}, radioConnected: false })),
      metricsStore: store, sampleIntervalMs: 10, retentionDays: 14,
      repeaterFingerprintPruneAfterDays: 7, logger: silentLogger() });
    sampler.start(); await vi.advanceTimersByTimeAsync(10); sampler.stop();
    assert.equal(store.findNodesByPublicKeyPrefix(KEY)[0].name, 'Offline Summit');
    assert.equal(store.findNodesByPublicKeyPrefix(KEY)[0].firstHeardAt, DAY);
    assert.deepEqual(store.queryDirectHeardEligibility({ publicKeyHex: KEY, now: Date.now(), windowMs: 72 * 3600000 }),
      { lastDirectHeardAt: 2 * DAY, eligible: false });
    assert.equal(store.queryAdvertTotals({ start: 0, end: Date.now() }).events, 0);
    assert.equal(store.recordVerifiedAdvert({ publicKeyHex: KEY, name: null, type: 'REPEATER',
      eventDigest: '1'.repeat(64), receivedAt: Date.now(), hopCount: 1 }).eventRecorded, false);
    assert.equal(store.findNodesByPublicKeyPrefix(KEY)[0].name, 'Offline Summit');
  } finally { sampler?.stop(); store.close(); }
});

test('run checkpoints share sampling cadence and failures do not stop sample persistence or broadcast', async () => {
  let checkpoints = 0; let samples = 0; let broadcasts = 0;
  const log = silentLogger();
  const sampler = makeSampler({ serviceHealth: fakeServiceHealth(baseSnapshot({ mqtt: {}, radioConnected: false })),
    sampleIntervalMs: 10, retentionDays: 0, logger: log,
    metricsStore: { recordPacketSample() { samples++; } },
    runHistory: { checkpoint() { checkpoints++; if (checkpoints === 1) throw new Error('disk locked'); } } });
  sampler.on('sample', () => broadcasts++);
  sampler.start(); sampler.start(); await vi.advanceTimersByTimeAsync(30); sampler.stop();
  await vi.advanceTimersByTimeAsync(30);
  assert.equal(checkpoints, 3); assert.equal(samples, 3); assert.equal(broadcasts, 3);
  assert.equal(log.calls.warn.length, 1);
  assert.equal(log.calls.warn[0].source, 'services.runHistory');
});
