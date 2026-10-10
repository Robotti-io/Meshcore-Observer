import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { MetricsStore } from '../src/metrics/store.js';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dropRegionSchema } from './fixtures/region-downgrade.js';

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
    PACKETCAPTURE_METRICS_UI_RETENTION_DAYS: '0', PACKETCAPTURE_RUNTIME_EVENT_MAX_PER_MINUTE: '60' };
}

test('invalid topology configuration fails before database/hardware/network startup', () => {
  const env = { ...environment(), PACKETCAPTURE_TOPOLOGY_MAX_OBSERVATIONS_PER_MINUTE: '0' };
  const result = spawnSync(process.execPath, [resolve('src/index.js')], { env, cwd: process.cwd(), encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 1); assert.match(result.stdout + result.stderr, /Invalid configuration/);
  assert.equal(existsSync(env.PACKETCAPTURE_METRICS_UI_DB_PATH), false);
  assert.doesNotMatch(result.stdout + result.stderr, /failed to open tcp connection/);
});

test('invalid explicit region freshness fails before store creation and hardware/network startup', () => {
  for (const value of ['', '0', '8761', '1.5']) {
    const env = { ...environment(), PACKETCAPTURE_REGION_ANSWER_FRESHNESS_HOURS: value };
    const result = spawnSync(process.execPath, [resolve('src/index.js')], { env, cwd: process.cwd(), encoding: 'utf8', timeout: 3000, windowsHide: true });
    assert.equal(result.status, 1); assert.match(result.stdout + result.stderr, /Configuration error:/);
    assert.equal(existsSync(env.PACKETCAPTURE_METRICS_UI_DB_PATH), false);
    assert.doesNotMatch(result.stdout + result.stderr, /meshcore-observer starting|failed to open tcp connection/);
  }
});

test('invalid remote overrides fail before store creation and hardware/network startup', () => {
  for (const overrides of [{ PACKETCAPTURE_REMOTE_REQUEST_ACK_TIMEOUT_MS: '' },
    { PACKETCAPTURE_REMOTE_REQUEST_RESPONSE_TIMEOUT_MAX_MS: '0' },
    { PACKETCAPTURE_REMOTE_REQUEST_MIN_INTERVAL_MS: '1.5' },
    { PACKETCAPTURE_REMOTE_REQUEST_MAX_PER_MINUTE: '7' }]) {
    const env = { ...environment(), ...overrides };
    const result = spawnSync(process.execPath, [resolve('src/index.js')], { env, cwd: process.cwd(), encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 1); assert.match(result.stdout + result.stderr, /Configuration error:/);
    assert.equal(existsSync(env.PACKETCAPTURE_METRICS_UI_DB_PATH), false);
    assert.doesNotMatch(result.stdout + result.stderr, /meshcore-observer starting|failed to open tcp connection/);
  }
});

test('invalid discovery settings fail before database/hardware/network startup even while disabled', () => {
  for(const overrides of [{ PACKETCAPTURE_REGION_DISCOVERY_ENABLED:'' },{ PACKETCAPTURE_REGION_QUERY_REFRESH_HOURS:'1.5' },
    { PACKETCAPTURE_REGION_QUERY_MAX_ATTEMPTS:'11' },{ PACKETCAPTURE_REGION_QUERY_RETRY_BASE_MINUTES:'61',PACKETCAPTURE_REGION_QUERY_RETRY_MAX_HOURS:'1' }]) {
    const env={ ...environment(),PACKETCAPTURE_REGION_DISCOVERY_ENABLED:'false',...overrides };
    const result=spawnSync(process.execPath,[resolve('src/index.js')],{ env,cwd:process.cwd(),encoding:'utf8',timeout:3000,windowsHide:true });
    assert.equal(result.status,1);assert.match(result.stdout+result.stderr,/Configuration error:/);
    assert.equal(existsSync(env.PACKETCAPTURE_METRICS_UI_DB_PATH),false);
    assert.doesNotMatch(result.stdout+result.stderr,/meshcore-observer starting|failed to open tcp connection/);
  }
});

test('offline UI-disabled entrypoint constructs idle remote ownership and drains it before radio/storage teardown', async () => {
  const env = { ...environment(), PACKETCAPTURE_BOT_REPLY_QUIET_MS: '0',
    PACKETCAPTURE_REMOTE_REQUEST_ACK_TIMEOUT_MS: '1000', PACKETCAPTURE_REMOTE_REQUEST_RESPONSE_TIMEOUT_MAX_MS: '2000',
    PACKETCAPTURE_REMOTE_REQUEST_MIN_INTERVAL_MS: '10000', PACKETCAPTURE_REMOTE_REQUEST_MAX_PER_MINUTE: '6' };
  const child = launch(env, 'remote-lifecycle'); await child.next(); child.process.send({ action: 'stop' });
  assert.deepEqual(await child.next(), { remoteStopping: true, automaticRequests: 0, replies: 'foreground', pending: 'foreground', sending: 'foreground' });
  const waiting = await snapshot(child); assert.equal(waiting.snapshot.runs[0].state, 'running');
  assert.equal(waiting.snapshot.runs[0].endedAt, null);
  child.process.send({ action: 'release' }); assert.deepEqual(await child.next(), { radioStopping: true });
  assert.equal((await child.exited).code, 0);
  read(env, store => assert.equal(store.queryObserverRuns({ start: 0, end: Number.MAX_SAFE_INTEGER }).runs[0].state, 'clean'));
});
test('enabled discovery entrypoint stops admission, drains coordinator then producer before radio/run/store teardown', async () => {
  const env = { ...environment(), PACKETCAPTURE_REGION_DISCOVERY_ENABLED: 'true',
    PACKETCAPTURE_REGION_QUERY_PREFLIGHT_TIMEOUT_MS: '2000' };
  const child = launch(env, 'discovery-lifecycle'); await child.next(); child.process.send({ action: 'stop' });
  assert.deepEqual(await child.next(), { discoveryDraining: true, started: 1, admissionStopped: true, remoteStopped: true });
  const waiting = await snapshot(child); assert.equal(waiting.snapshot.runs[0].state, 'running');
  assert.equal(waiting.snapshot.runs[0].endedAt, null);
  child.process.send({ action: 'release' }); assert.deepEqual(await child.next(), { radioStopping: true });
  assert.equal((await child.exited).code, 0);
  read(env, store => assert.equal(store.queryObserverRuns({ start: 0, end: Number.MAX_SAFE_INTEGER }).runs[0].state, 'clean'));
});
test('offline dashboard-disabled topology persists bounded duplicate receptions and final coverage, then survives restart unchanged', async () => {
  const env = { ...environment(), PACKETCAPTURE_TOPOLOGY_MAX_OBSERVATIONS_PER_MINUTE: '2' };
  const child = launch(env); await child.next();
  child.process.send({ action: 'topology-storm' }); assert.equal((await child.next()).topologyStorm, true);
  const observed = await snapshot(child);
  assert.equal(observed.topology.total, 1); assert.equal(observed.topology.paths[0].receptionCount, 2);
  assert.equal(observed.topologyDetails.total, 2);
  child.process.send({ action: 'stop' }); assert.equal((await child.exited).code, 0);
  read(env, (store) => {
    const samples = store.queryTopologyCoverage({ start: 0, end: Number.MAX_SAFE_INTEGER }).samples;
    assert.equal(samples.reduce((sum, row) => sum + row.accepted, 0), 2);
    assert.equal(samples.reduce((sum, row) => sum + row.suppressed, 0), 98);
    assert.equal(samples.reduce((sum, row) => sum + row.noRelay, 0), 1);
    assert.equal(samples[0].runId, observed.snapshot.runs[0].runId);
  });
  const restarted = launch(env); await restarted.next(); const after = await snapshot(restarted);
  assert.deepEqual(after.topology, observed.topology); assert.equal(after.topologyDetails.total, 2);
  restarted.process.send({ action: 'stop' }); assert.equal((await restarted.exited).code, 0);
});

test('offline UI-disabled entrypoint upgrades v13 without inferred regions or lost legacy inventory/topology', async () => {
  const env=environment(), path=env.PACKETCAPTURE_METRICS_UI_DB_PATH;
  const store=new MetricsStore({ dbPath:path });
  const run=store.beginObserverRun({ runId:randomUUID(),startedAt:0,observedAt:0,observedDurationMs:0,
    appVersion:'2.4.0',nodeVersion:process.version,platform:process.platform,architecture:process.arch });
  try {
    store.upsertNode({ publicKeyHex:'AC'.repeat(32),name:'Kept offline',type:'REPEATER',heardAt:1000 });
    store.recordTopologyObservation({ runId:run.runId,observerPublicKey:'CD'.repeat(32),receivedAt:1000,route:1,
      kind:'flood-traversed',payloadVersion:0,hashWidth:1,prefixes:['AC'],transportCodes:null,containsRepeatedPrefix:false });
    store.endObserverRun({ runId:run.runId,observedAt:2000,observedDurationMs:2000,reason:'SIGINT' });
  } finally { store.close(); }
  const db=new DatabaseSync(path);
  try { db.exec(`${dropRegionSchema} PRAGMA user_version=13`); assert.equal(db.prepare('PRAGMA user_version').get().user_version,13); }
  finally { db.close(); }
  const child=launch(env,'region-lifecycle'); await child.next(); const observed=await snapshot(child);
  assert.equal(observed.nodes,1); assert.equal(observed.topology.total,1); assert.equal(observed.topology.paths[0].receptionCount,1);
  assert.equal(observed.regions.latest.presence,'unknown'); assert.equal(observed.regions.answers.total,0);
  assert.equal(observed.regions.outcomes.total,0); assert.equal(observed.regions.first.total,0);
  assert.equal(observed.regions.remoteRequestCalls,0); assert.equal(observed.regions.mqttPublishCalls,0);
  child.process.send({ action:'stop' }); assert.equal((await child.exited).code,0);
  const checked=new DatabaseSync(path);
  try { assert.equal(checked.prepare('PRAGMA user_version').get().user_version,15);
    assert.equal(checked.prepare('SELECT name FROM nodes').get().name,'Kept offline'); assert.deepEqual(checked.prepare('PRAGMA foreign_key_check').all(),[]); }
  finally { checked.close(); }
});

for(const ending of ['clean','abrupt']) test(`offline entrypoint ${ending} restart preserves empty latest, pending history and original publication identity`, async () => {
  const env=environment(), child=launch(env,'region-lifecycle'); await child.next();
  child.process.send({ action:'region-seed' }); const seeded=await child.next(); assert.equal(seeded.regionFixture,true);
  const observed=await snapshot(child); assert.equal(observed.regions.answers.total,2); assert.equal(observed.regions.outcomes.total,3);
  assert.equal(observed.regions.latest.presence,'empty'); assert.deepEqual(observed.regions.latest.answer.regions,[]);
  assert.equal(observed.regions.latest.latestOutcome.reason,'malformed-response');
  assert.equal(observed.regions.first.publications[0].state,'publishing');
  assert.equal(observed.regions.second.publications[0].state,'published');
  child.process.send({ action:'region-prune' }); assert.equal((await child.next()).regionPruned,true);
  const pruned=await snapshot(child); assert.equal(pruned.regions.answers.total,2); assert.equal(pruned.regions.outcomes.total,2);
  assert.equal(pruned.regions.second.total,0); assert.equal(pruned.regions.first.total,2);
  assert.equal(pruned.regions.remoteRequestCalls,0); assert.equal(pruned.regions.mqttPublishCalls,0);
  if(ending==='clean') child.process.send({ action:'stop' }); else child.process.kill();
  const ended=await child.exited; if(ending==='clean') assert.equal(ended.code,0,ended.output);
  const restarted=launch(env,'region-lifecycle'); await restarted.next(); const after=await snapshot(restarted);
  assert.equal(after.regions.latest.presence,'empty'); assert.deepEqual(after.regions.latest.answer,pruned.regions.latest.answer);
  assert.deepEqual(after.regions.answers.answers,pruned.regions.answers.answers);
  assert.ok(after.regions.first.publications.every(row=>row.state==='pending' && row.transportAcknowledgement==='unknown'));
  assert.equal(after.regions.first.publications[0].observedAt,seeded.claim.answer.observedAt);
  assert.equal(after.regions.first.publications[0].lastResultAt,null); assert.equal(after.regions.first.publications[0].attemptCount,1);
  assert.equal(after.regions.remoteRequestCalls,0); assert.equal(after.regions.mqttPublishCalls,0);
  assert.equal(after.snapshot.runs.find(run=>run.runId===observed.regions.runId).state,ending==='clean'?'clean':'unclean');
  restarted.process.send({ action:'region-claim' }); const reclaimed=(await restarted.next()).claim;
  assert.equal(reclaimed.requestId,seeded.claim.requestId); assert.equal(reclaimed.sourceRunId,seeded.claim.sourceRunId);
  assert.deepEqual(reclaimed.answer,seeded.claim.answer); assert.notEqual(reclaimed.claimToken,seeded.claim.claimToken);
  assert.equal(reclaimed.attemptCount,2); restarted.process.send({ action:'stop' }); assert.equal((await restarted.exited).code,0);
});

test('a verified closed-database backup restores source identity, empty latest and recoverable publication intent', async () => {
  const env=environment(), path=env.PACKETCAPTURE_METRICS_UI_DB_PATH, child=launch(env,'region-lifecycle'); await child.next();
  child.process.send({ action:'region-seed' }); const saved=await child.next(), observed=await snapshot(child);
  child.process.send({ action:'stop' }); assert.equal((await child.exited).code,0);
  // Copy only this fixture's closed, checkpointed database, never an active
  // file with a live WAL. The restored file stays in the test's temp directory.
  assert.equal(existsSync(path+'-wal'),false);
  const backup=join(dirname(path),'verified-backup.sqlite3'); copyFileSync(path,backup);
  const restored=new MetricsStore({ dbPath:backup });
  try {
    assert.deepEqual(restored.getRegionLatest({ observerPublicKey:'CD'.repeat(32),targetPublicKey:'AC'.repeat(32),now:Date.now(),windowMs:72*3600000 }).answer,
      observed.regions.latest.answer);
    const run=restored.beginObserverRun({ runId:randomUUID(),startedAt:Date.now(),observedAt:Date.now(),observedDurationMs:0,
      appVersion:'2.4.0',nodeVersion:process.version,platform:process.platform,architecture:process.arch });
    assert.equal(run.instanceId,observed.snapshot.runs[0].instanceId);
    const reclaimed=restored.claimRegionPublication({ brokerId:'first',runId:run.runId,now:Date.now() });
    assert.equal(reclaimed.requestId,saved.claim.requestId); assert.deepEqual(reclaimed.answer,saved.claim.answer);
    assert.notEqual(reclaimed.claimToken,saved.claim.claimToken);
  } finally { restored.close(); }
  const checked=new DatabaseSync(backup);
  try { assert.deepEqual(checked.prepare('PRAGMA foreign_key_check').all(),[]); } finally { checked.close(); }
});
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
  assert.ok(alive.resources.total >= 1);
  assert.equal(alive.resources.samples[0].runId, initial.snapshot.runs[0].runId);
  assert.equal(alive.resources.samples.at(-1).cpuPercent, null); // First collection is the unavailable CPU baseline.
  assert.ok(alive.resources.samples[0].rssBytes > 0);
  child.process.send({ action: 'stop' });
  const stopping = await snapshot(child);
  assert.equal(stopping.snapshot.runs[0].state, 'running');
  assert.equal(stopping.snapshot.runs[0].endedAt, null);
  assert.ok(stopping.resourcesBeforeStop >= alive.resources.total);
  assert.equal(stopping.resources.total, stopping.resourcesBeforeStop + 1); // Exactly one final resource flush.
  child.process.send({ action: 'release' });
  const result = await child.exited; assert.equal(result.code, 0, result.output);
  read(env, (store) => {
    const run = store.getObserverRun({ runId: initial.snapshot.runs[0].runId });
    assert.equal(run.state, 'clean'); assert.equal(run.endReason, 'SIGINT');
    assert.equal(run.durationIsLowerBound, false); assert.ok(run.observedDurationMs >= alive.summary.observedDurationMs);
    assert.equal(store.queryProcessSamples({ start: 0, end: Number.MAX_SAFE_INTEGER }).total, stopping.resources.total);
  });
});

test('offline UI-disabled event storms are bounded and orderly stop flushes suppression with the correct run', async () => {
  const env = { ...environment(), PACKETCAPTURE_RUNTIME_EVENT_MAX_PER_MINUTE: '2' };
  const child = launch(env); await child.next();
  child.process.send({ action: 'event-storm' }); assert.equal((await child.next()).storm, true);
  const observed = await snapshot(child); assert.equal(observed.events.total, 2);
  assert.doesNotMatch(JSON.stringify(observed.events), /secret/);
  child.process.send({ action: 'stop' }); assert.equal((await child.exited).code, 0);
  read(env, (store) => {
    const resources = store.queryProcessSamples({ start: 0, end: Number.MAX_SAFE_INTEGER });
    assert.equal(resources.total, 1); assert.equal(resources.samples[0].suppressedEvents, 98);
    assert.equal(resources.samples[0].failedEvents, 0);
    assert.equal(resources.samples[0].runId, observed.snapshot.runs[0].runId);
    assert.equal(store.queryObserverRuntimeSummary().cleanRuns, 1);
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
  const lastKnown = await snapshot(first);
  first.process.kill('SIGKILL'); await first.exited;
  const second = launch(env); await second.next(); const recovered = await snapshot(second);
  const old = recovered.snapshot.runs.find((run) => run.runId === original.snapshot.runs[0].runId);
  assert.equal(old.state, 'unclean'); assert.equal(old.endedAt, null);
  assert.equal(old.observedDurationMs, lastKnown.snapshot.runs[0].observedDurationMs);
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
