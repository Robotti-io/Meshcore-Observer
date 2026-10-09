import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { MetricsSampler } from '../../src/metrics/sampler.js';
import { MetricsStore } from '../../src/metrics/store.js';

const samplers = new Set();

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
