import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { MetricsStore } from '../src/metrics/store.js';

const children = new Set(); const dirs = new Set();
afterEach(async () => {
  for (const child of children) { child.process.kill(); await child.exited; }
  children.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.clear();
});
function environment() {
  const dir = mkdtempSync(join(tmpdir(), 'run-entrypoint-')); dirs.add(dir);
  const bots = join(dir, 'bots.json'); const brokers = join(dir, 'brokers.json');
  writeFileSync(bots, '[]'); writeFileSync(brokers, '[]');
  return { ...process.env, PACKETCAPTURE_CONNECTION_TYPE: 'tcp', PACKETCAPTURE_TCP_HOST: '127.0.0.1',
    PACKETCAPTURE_TCP_PORT: '1', PACKETCAPTURE_IATA: 'CVG', PACKETCAPTURE_BOTS_CONFIG_FILE: bots,
    PACKETCAPTURE_BROKERS_CONFIG_FILE: brokers, PACKETCAPTURE_METRICS_UI_ENABLED: 'false',
    PACKETCAPTURE_METRICS_UI_DB_PATH: join(dir, 'metrics.sqlite3'), PACKETCAPTURE_METRICS_UI_SAMPLE_INTERVAL_MS: '1000',
    PACKETCAPTURE_METRICS_UI_RETENTION_DAYS: '0' };
}
function launch(env, mode = 'ordinary') {
  const process = spawn(globalThis.process.execPath, [resolve('test/fixtures/run-lifecycle-child.js'), mode],
    { cwd: globalThis.process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const mailbox = []; const waiting = [];
  let output = '';
  process.stdout.on('data', (bytes) => { output += bytes; });
  process.stderr.on('data', (bytes) => { output += bytes; });
  process.on('message', (message) => {
    const waiter = waiting.shift(); if (waiter) waiter.resolve(message); else mailbox.push(message);
  });
  const child = { process, exited: new Promise((resolve) => process.on('exit', (code, signal) => {
    children.delete(child);
    for (const waiter of waiting.splice(0)) waiter.reject(new Error(`Child exited before reply: ${output}`));
    resolve({ code, signal, output });
  })), next: () => mailbox.length ? Promise.resolve(mailbox.shift()) : new Promise((resolve, reject) => waiting.push({ resolve, reject })) };
  children.add(child); return child;
}
async function snapshot(child) { child.process.send({ action: 'snapshot' }); return child.next(); }
function read(env, check) {
  const store = new MetricsStore({ dbPath: env.PACKETCAPTURE_METRICS_UI_DB_PATH });
  try { check(store); } finally { store.close(); }
}

test('offline entrypoint checkpoints and records clean completion only after delayed teardown', async () => {
  const env = environment(); const child = launch(env, 'delayed-stop');
  assert.equal((await child.next()).ready, true);
  const initial = await snapshot(child);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const alive = await snapshot(child);
  assert.ok(alive.summary.observedDurationMs > initial.summary.observedDurationMs);
  child.process.send({ action: 'stop' });
  const stopping = await snapshot(child);
  assert.equal(stopping.snapshot.runs[0].state, 'running');
  assert.equal(stopping.snapshot.runs[0].endedAt, null);
  child.process.send({ action: 'release' });
  const result = await child.exited; assert.equal(result.code, 0, result.output);
  read(env, (store) => {
    const run = store.getObserverRun({ runId: initial.snapshot.runs[0].runId });
    assert.equal(run.state, 'clean'); assert.equal(run.endReason, 'SIGINT');
    assert.equal(run.durationIsLowerBound, false); assert.ok(run.observedDurationMs >= alive.summary.observedDurationMs);
  });
});

test('abrupt child death releases ownership and restart recovers a lower bound without downtime', async () => {
  const env = environment(); const first = launch(env); await first.next();
  const original = await snapshot(first);
  const blocked = spawnSync(process.execPath, [resolve('src/index.js')], { env, cwd: process.cwd(), encoding: 'utf8', timeout: 3000 });
  const blockedOutput = blocked.stdout + blocked.stderr;
  assert.equal(blocked.status, 1);
  assert.match(blockedOutput, /Observer database is locked by another connection/);
  assert.match(blockedOutput, /Only one Observer can use this database at a time/);
  assert.match(blockedOutput, /Stop the other Observer instance or close external SQLite tools\/scripts, then restart/);
  assert.match(blockedOutput, /Locks release automatically when the owning process exits/);
  assert.doesNotMatch(blockedOutput, /failed to open tcp connection|node:sqlite support is now a hard requirement/);
  first.process.kill('SIGKILL'); await first.exited;
  const second = launch(env); await second.next(); const recovered = await snapshot(second);
  const old = recovered.snapshot.runs.find((run) => run.runId === original.snapshot.runs[0].runId);
  assert.equal(old.state, 'unclean'); assert.equal(old.endedAt, null);
  assert.equal(old.observedDurationMs, original.snapshot.runs[0].observedDurationMs);
  assert.equal(recovered.summary.instanceId, original.summary.instanceId);
  assert.equal(recovered.summary.durationIsLowerBound, true);
  second.process.send({ action: 'stop' }); assert.equal((await second.exited).code, 0);
});

test('shutdown drains already-started verified advert work before marking clean and closing the store', async () => {
  const env = environment(); const child = launch(env, 'pending-advert'); await child.next();
  assert.equal((await snapshot(child)).nodes, 0);
  child.process.send({ action: 'stop' });
  const stopping = await snapshot(child);
  assert.equal(stopping.snapshot.runs[0].state, 'running'); assert.equal(stopping.nodes, 0);
  child.process.send({ action: 'release' });
  const result = await child.exited; assert.equal(result.code, 0, result.output);
  read(env, (store) => {
    assert.equal(store.queryObserverRuntimeSummary().cleanRuns, 1);
    assert.equal(store.countNodesByType('REPEATER'), 1);
    assert.equal(store.queryAdvertTotals({ start: 0, end: Number.MAX_SAFE_INTEGER }).events, 1);
  });
});
