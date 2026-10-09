import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { RunHistory, createRunShutdown } from '../../src/metrics/run-history.js';
import { MetricsStore } from '../../src/metrics/store.js';

const stores = new Set();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); vi.useRealTimers(); });
function fixture() {
  const store = new MetricsStore({ dbPath: ':memory:' }); stores.add(store);
  let wall = 1000; let monotonic = 20;
  const history = new RunHistory({ store, startedAt: 900, monotonicStartedAt: 0,
    wallNow: () => wall, monotonicNow: () => monotonic,
    metadata: { appVersion: '2.5.0', nodeVersion: process.version, platform: 'win32', architecture: 'x64' } });
  return { store, history, clock: (at, duration) => { wall = at; monotonic = duration; } };
}
function logger() {
  const messages = [];
  return { messages, info: (...args) => messages.push(args), warn: (...args) => messages.push(args), error: (...args) => messages.push(args) };
}

test('helper includes bootstrap elapsed time and monotonic duration survives wall clock jumps', () => {
  const { store, history, clock } = fixture();
  assert.equal(store.getObserverRun({ runId: history.runId }).observedDurationMs, 20);
  clock(500, 200); history.checkpoint();
  clock(100000, 500); history.finishClean('SIGINT');
  const run = store.getObserverRun({ runId: history.runId });
  assert.equal(run.startedAt, 900); assert.equal(run.endedAt, 100000);
  assert.equal(run.observedDurationMs, 500); assert.equal(run.wallTimeAnomaly, true);
});

test('failed checkpoint leaves previous evidence intact; next successful checkpoint catches up', () => {
  const { store, history, clock } = fixture();
  const original = store.checkpointObserverRun.bind(store);
  store.checkpointObserverRun = () => { throw new Error('disk full'); };
  clock(2000, 1000); assert.throws(() => history.checkpoint(), /disk full/);
  assert.equal(store.getObserverRun({ runId: history.runId }).observedDurationMs, 20);
  store.checkpointObserverRun = original;
  clock(2500, 1500); history.checkpoint();
  assert.equal(store.getObserverRun({ runId: history.runId }).observedDurationMs, 1500);
});

test('shutdown waits for teardown, writes one clean end then closes; repeated signals share completion', async () => {
  const { store, history, clock } = fixture(); const log = logger(); const codes = []; const order = [];
  let release; const blocked = new Promise((resolve) => { release = resolve; });
  const shutdown = createRunShutdown({ logger: log, runHistory: history,
    metricsStore: { close() { order.push('close'); } }, setExitCode: (code) => codes.push(code),
    teardown: async () => { order.push('teardown'); await blocked; clock(2000, 1000); order.push('drained'); } });
  const first = shutdown('SIGINT'); assert.equal(shutdown('SIGTERM'), first);
  await Promise.resolve();
  assert.equal(store.getObserverRun({ runId: history.runId }).state, 'running');
  assert.deepEqual(order, ['teardown']);
  release(); await first;
  assert.deepEqual(order, ['teardown', 'drained', 'close']); assert.deepEqual(codes, [0]);
  assert.equal(store.getObserverRun({ runId: history.runId }).endReason, 'SIGINT');
  assert.equal(log.messages.filter((call) => call[1] === 'shutdown signal received').length, 1);
});

test('failed teardown leaves end unconfirmed and storage open, with the force-exit bound preserved', async () => {
  vi.useFakeTimers();
  const { store, history } = fixture(); const log = logger(); const codes = []; const forced = [];
  let closed = false;
  const shutdown = createRunShutdown({ logger: log, runHistory: history, metricsStore: { close() { closed = true; } },
    teardown: async () => { throw new Error('radio stop failed'); }, timeoutMs: 100,
    forceExit: (code) => forced.push(code), setExitCode: (code) => codes.push(code) });
  await shutdown('SIGTERM');
  assert.equal(store.getObserverRun({ runId: history.runId }).endedAt, null);
  assert.equal(closed, false); assert.deepEqual(codes, [1]);
  await vi.advanceTimersByTimeAsync(100);
  assert.deepEqual(forced, [1]);
  assert.ok(log.messages.some((call) => call[1].includes('run end remains unconfirmed')));
});

test('a hung shutdown times out and late completion cannot record a false clean end', async () => {
  vi.useFakeTimers();
  const { store, history } = fixture(); const forced = []; let release; let closed = false;
  const shutdown = createRunShutdown({ logger: logger(), runHistory: history,
    metricsStore: { close() { closed = true; } }, setExitCode() {}, forceExit: (code) => forced.push(code),
    timeoutMs: 100, teardown: () => new Promise((resolve) => { release = resolve; }) });
  const pending = shutdown('SIGINT'); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(100); release(); await pending;
  assert.deepEqual(forced, [1]); assert.equal(closed, false);
  assert.equal(store.getObserverRun({ runId: history.runId }).state, 'running');
});

test('clean-end write failure is logged without closing storage or claiming success', async () => {
  vi.useFakeTimers(); const { store, history } = fixture(); const log = logger(); let closed = false;
  store.endObserverRun = () => { throw new Error('database full'); };
  const shutdown = createRunShutdown({ logger: log, runHistory: history, metricsStore: { close() { closed = true; } },
    teardown: async () => {}, setExitCode() {}, forceExit() {}, timeoutMs: 100 });
  await shutdown('SIGINT'); await vi.advanceTimersByTimeAsync(100);
  assert.equal(closed, false); assert.equal(store.getObserverRun({ runId: history.runId }).state, 'running');
  assert.ok(log.messages.some((call) => call[2]?.error === 'database full'));
});
