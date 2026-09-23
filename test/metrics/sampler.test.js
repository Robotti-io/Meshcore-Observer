import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsSampler } from '../../src/metrics/sampler.js';

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
  const sampler = new MetricsSampler({
    serviceHealth: fakeServiceHealth(snapshot),
    metricsStore,
    sampleIntervalMs: 10,
    retentionDays: 0,
    logger: silentLogger()
  });

  const emitted = [];
  sampler.on('sample', (s) => emitted.push(s));
  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
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
  const sampler = new MetricsSampler({ serviceHealth, metricsStore, sampleIntervalMs: 15, retentionDays: 0, logger: silentLogger() });

  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  received = 8; // +3 since the first tick
  await new Promise((resolve) => setTimeout(resolve, 20));
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
  const sampler = new MetricsSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore,
    sampleIntervalMs: 10,
    retentionDays: 0,
    logger
  });

  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  sampler.stop();

  assert.ok(logger.calls.warn.some((call) => call.message.includes('failed to persist a metrics sample')));
});

test('never prunes when retentionDays is 0 (unlimited retention)', async () => {
  const pruneCalls = [];
  const metricsStore = { recordPacketSample: () => {}, pruneOlderThan: (cutoff) => pruneCalls.push(cutoff) };
  const sampler = new MetricsSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore,
    sampleIntervalMs: 10,
    retentionDays: 0,
    logger: silentLogger()
  });

  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  sampler.stop();

  assert.equal(pruneCalls.length, 0, 'retentionDays: 0 must never prune');
});

test('prunes with a positive retentionDays configured', async () => {
  const pruneCalls = [];
  const metricsStore = { recordPacketSample: () => {}, pruneOlderThan: (cutoff) => pruneCalls.push(cutoff) };
  const sampler = new MetricsSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore,
    sampleIntervalMs: 10,
    retentionDays: 7,
    logger: silentLogger()
  });

  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
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
  const sampler = new MetricsSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore,
    sampleIntervalMs: 10,
    retentionDays: 7,
    logger
  });

  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  sampler.stop();

  assert.ok(logger.calls.warn.some((call) => call.message.includes('failed to prune persisted metrics')));
});

test('start() is idempotent - calling it twice does not double the tick rate', async () => {
  const persisted = [];
  const metricsStore = { recordPacketSample: (sample) => persisted.push(sample) };
  const sampler = new MetricsSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore,
    sampleIntervalMs: 20,
    retentionDays: 0,
    logger: silentLogger()
  });

  sampler.start();
  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 45));
  sampler.stop();

  // ~2 ticks expected at a 20ms interval over 45ms; a doubled rate (two
  // independent timers) would produce roughly twice that.
  assert.ok(persisted.length <= 3, `expected about 2 ticks, got ${persisted.length}`);
});

test('stop() is idempotent and safe to call without a prior start()', () => {
  const sampler = new MetricsSampler({
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
  const sampler = new MetricsSampler({
    serviceHealth: fakeServiceHealth(baseSnapshot()),
    metricsStore,
    sampleIntervalMs: 10,
    retentionDays: 0,
    logger: silentLogger()
  });

  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  sampler.stop();
  const countAtStop = persisted.length;
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(persisted.length, countAtStop);
});
