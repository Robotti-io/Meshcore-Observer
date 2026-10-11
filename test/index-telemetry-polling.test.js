import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { MetricsStore } from '../src/metrics/store.js';
import { advertSigner, signedAdvertPacket } from './fixtures/signed-advert.js';
import { snapshot as pollSnapshot } from './fixtures/telemetry-poll.js';
import { buildRawFrame, PayloadType, RouteType } from './fixtures/packet-frames.js';
import { deriveHashtagChannelKey } from '../src/bots/channel-key.js';

const OBSERVER = 'BE'.repeat(32), START = 1700000000000, range = { start: 0, end: Number.MAX_SAFE_INTEGER };
const children = new Set(), dirs = new Set(), channelKey = deriveHashtagChannelKey('#echo');
const groupRaw = (() => {
  const header = Buffer.alloc(5); header.writeUInt32LE(1700000000);
  const data = Buffer.concat([header, Buffer.from('Fixture: !echo'), Buffer.from([0])]);
  const plain = Buffer.concat([data, Buffer.alloc(Math.ceil(data.length / 16) * 16 - data.length)]);
  const cipher = createCipheriv('aes-128-ecb', channelKey, null); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac('sha256', Buffer.concat([channelKey, Buffer.alloc(16)])).update(encrypted).digest().subarray(0, 2);
  return buildRawFrame({ payloadType: PayloadType.GRP_TXT, routeType: RouteType.FLOOD, hops: ['AC'],
    payload: Buffer.concat([createHash('sha256').update(channelKey).digest().subarray(0, 1), mac, encrypted]) }).toString('hex');
})();
afterEach(async () => {
  for (const child of children) { child.process.kill(); await child.exited; } children.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.clear();
});
function environment({ enabled = true, components, profiles = false, bots = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-poll-entrypoint-')); dirs.add(dir);
  const signer = advertSigner(), targetPublicKey = signer.publicKeyHex;
  const policy = join(dir, 'policy.json'), secrets = join(dir, 'secrets.json');
  const brokers = join(dir, 'brokers.json'), botFile = join(dir, 'bots.json');
  writeFileSync(policy, JSON.stringify({ version: 1, defaultCredentialRef: 'fixtureGuest', ...(components ? { components } : {}),
    ...(profiles ? { targets: [{ targetPublicKey, statusProfile: { layout: 'common48', evidence: 'established' }, emitterProfile: 'positive-channels' }] } : {}) }));
  writeFileSync(secrets, JSON.stringify({ version: 1, secrets: { fixtureGuest: 'PRIVATE-ONLY7' } }));
  writeFileSync(brokers, '[]');
  writeFileSync(botFile, JSON.stringify(bots ? [{ name: 'echo', channel: '#echo', enabled: true, minHops: 1,
    commands: [{ trigger: '!echo', response: 'reply to {sender}' }] }] : []));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PACKETCAPTURE_TELEMETRY_POLL_')) delete env[key];
  Object.assign(env, { PACKETCAPTURE_CONNECTION_TYPE: 'tcp', PACKETCAPTURE_TCP_HOST: 'unused.invalid', PACKETCAPTURE_TCP_PORT: '1',
    PACKETCAPTURE_IATA: 'CVG', PACKETCAPTURE_BOTS_CONFIG_FILE: botFile, PACKETCAPTURE_BROKERS_CONFIG_FILE: brokers,
    PACKETCAPTURE_METRICS_UI_ENABLED: 'false', PACKETCAPTURE_METRICS_UI_DB_PATH: join(dir, 'metrics.sqlite3'),
    PACKETCAPTURE_METRICS_UI_SAMPLE_INTERVAL_MS: '1000', PACKETCAPTURE_METRICS_UI_RETENTION_DAYS: '0',
    PACKETCAPTURE_REGION_DISCOVERY_ENABLED: 'false', PACKETCAPTURE_REMOTE_REQUEST_MIN_INTERVAL_MS: '10000',
    PACKETCAPTURE_REMOTE_REQUEST_MAX_PER_MINUTE: '6', PACKETCAPTURE_REMOTE_REQUEST_ACK_TIMEOUT_MS: '1000',
    PACKETCAPTURE_REMOTE_REQUEST_RESPONSE_TIMEOUT_MAX_MS: '1000', PACKETCAPTURE_FLOOD_ADVERT_INTERVAL_HOURS: '0',
    PACKETCAPTURE_BOT_REPLY_QUIET_MS: '0', PACKETCAPTURE_CONNECTION_RETRY_DELAY: '10', PACKETCAPTURE_CONNECTION_RETRY_DELAY_MAX: '10',
    PACKETCAPTURE_TELEMETRY_POLL_STARTUP_DELAY_SECONDS: '10', PACKETCAPTURE_TELEMETRY_POLL_TICK_SECONDS: '1',
    PACKETCAPTURE_TELEMETRY_POLL_PREFLIGHT_SECONDS: '1', PACKETCAPTURE_TELEMETRY_POLL_INTERVAL_HOURS: '1' });
  if (enabled) Object.assign(env, { PACKETCAPTURE_TELEMETRY_POLL_ENABLED: 'true',
    PACKETCAPTURE_TELEMETRY_POLL_CONFIG_FILE: policy, PACKETCAPTURE_TELEMETRY_POLL_SECRETS_FILE: secrets });
  return { dir, env, targetPublicKey, signer, advertRaw: signedAdvertPacket(signer.payload({ name: null })).raw };
}
function fixtureFile(f, options = {}) {
  const suffix = options.suffix ?? 'first', ledger = join(f.dir, suffix + '-ledger.jsonl'), path = join(f.dir, suffix + '-fixture.json');
  writeFileSync(ledger, ''); writeFileSync(path, JSON.stringify({ observerPublicKey: OBSERVER, targetPublicKey: f.targetPublicKey,
    advertRaw: f.advertRaw, groupRaw, channelKey: [...channelKey], startAt: START, ledger, ...options })); return { path, ledger };
}
async function launch(f, options = {}) {
  const { path, ledger } = fixtureFile(f, options);
  const p = spawn(process.execPath, [resolve('test/fixtures/telemetry-polling-child.js'), path],
    { env: f.env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = ''; const mailbox = [], waiters = [];
  p.stdout.on('data', bytes => { output += bytes; }); p.stderr.on('data', bytes => { output += bytes; });
  p.on('message', message => { const waiter = waiters.shift(); if (waiter) waiter.resolve(message); else mailbox.push(message); });
  const child = { process: p, ledger, next: () => mailbox.length ? Promise.resolve(mailbox.shift())
    : new Promise((resolve, reject) => waiters.push({ resolve, reject })) };
  child.exited = new Promise(resolve => p.once('exit', code => { children.delete(child);
    for (const waiter of waiters.splice(0)) waiter.reject(Error(output)); resolve({ code, output }); }));
  child.ask = async message => { p.send(message); return child.next(); };
  child.stop = async () => { p.send({ action: 'stop' }); const ended = await child.exited; assert.equal(ended.code, 0, ended.output); return ended; };
  children.add(child); assert.deepEqual(await child.next(), { ready: true }); return child;
}
const physical = s => s.writes.filter(w => [26, 50].includes(w.code));
const onlySensors = { status: false, sensors: true, neighbours: false };
async function due(child) { await child.ask({ action: 'advert' }); await child.ask({ action: 'due' }); }
function read(f, callback) {
  const store = new MetricsStore({ dbPath: f.env.PACKETCAPTURE_METRICS_UI_DB_PATH });
  try { return callback(store); } finally { store.close(); }
}
function inspect(f, callback) {
  const db = new DatabaseSync(f.env.PACKETCAPTURE_METRICS_UI_DB_PATH);
  try { return callback(db); } finally { db.close(); }
}

test('default-off actual entrypoint captures verified direct evidence and duplicate bot commands without remote collection or internet', async () => {
  const f = environment({ enabled: false, bots: true }), child = await launch(f);
  await child.ask({ action: 'advert', count: 2 }); await child.ask({ action: 'group', count: 2 });
  const saved = await child.ask({ action: 'tick', ms: 20000 });
  assert.deepEqual(physical(saved), []); assert.equal(saved.auth.outcomes.length, 0); assert.equal(saved.outcomes.total, 0);
  assert.equal(saved.inventory, 1); assert.equal(saved.advertTotals.events, 1); assert.equal(saved.candidates.candidates.length, 1);
  assert.equal(saved.botUsage.accepted, 1); assert.equal(saved.replies.length, 1); assert.equal(saved.publishTopics.length, 4);
  await child.stop();
});
for (const profiles of [false, true]) test(`real opt-in entrypoint stores all three components with ${profiles ? 'established' : 'unknown'} profiles and original attribution`, async () => {
  const f = environment({ profiles }), child = await launch(f); await due(child);
  let saved;
  for (let n = 0; n < 4; n++) saved = await child.ask({ action: 'tick', ms: 10000 });
  assert.deepEqual(physical(saved).map(w => w.component), ['guest-login', 'status', 'sensors', 'neighbours']);
  assert.equal(saved.auth.outcomes[0].record.status, 'completed'); assert.equal(saved.observations.total, 3); assert.equal(saved.outcomes.total, 3);
  for (const outcome of saved.outcomes.outcomes) {
    assert.equal(outcome.runId, saved.runId); assert.equal(outcome.observerPublicKey, OBSERVER); assert.equal(outcome.targetPublicKey, f.targetPublicKey);
    assert.equal(outcome.route, 'direct'); assert.equal(outcome.receivedAt, outcome.completedAt);
    assert.equal(outcome.startedAt, physical(saved).find(w => w.requestId === outcome.requestId).at);
  }
  const status = saved.observations.observations.find(o => o.variant.component === 'status');
  assert.equal(status.quality, profiles ? 'decoded' : 'prefix-only');
  assert.equal(status.data.batteryMillivolts, 3300);
  const neighbour = saved.observations.observations.find(o => o.variant.component === 'neighbours');
  assert.equal(neighbour.data.entries[0].prefix, 'DD'.repeat(32));
  assert.ok(physical(saved).every((w, i, arr) => i === 0 || w.at - arr[i - 1].at >= 10000));
  const ended = await child.stop(); assert.doesNotMatch(ended.output + JSON.stringify(saved), /PRIVATE-ONLY7|fixtureGuest|PRIVATE-NAME/);
  inspect(f, db => { assert.doesNotMatch(JSON.stringify(pollSnapshot(db)), /PRIVATE-ONLY7|fixtureGuest|PRIVATE-NAME/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); });
});
for (const mode of ['admin', 'read-write', 'legacy', 'denied', 'unsupported', 'flood-ack']) test(`real entrypoint ${mode} guest response never authorizes a data query`, async () => {
  const f = environment({ components: onlySensors }), child = await launch(f, { mode }); await due(child);
  const saved = await child.ask({ action: 'tick', ms: 10000 }); const later = await child.ask({ action: 'tick', ms: 20000 });
  assert.equal(physical(saved).length, 1); assert.equal(physical(later).length, 1);
  assert.equal(later.auth.outcomes.length, 1); assert.equal(later.auth.outcomes[0].record.status, 'failed');
  assert.equal(later.observations.total, 0); assert.equal(later.outcomes.total, 0); await child.stop();
});
for (const contact of ['flood', 'out-of-radius', 'collision', 'unsupported']) test(`real entrypoint ${contact} contact preflight defers without physical auth/data`, async () => {
  const f = environment({ components: onlySensors }), child = await launch(f, { contact }); await due(child);
  const saved = await child.ask({ action: 'tick', ms: 10000 });
  assert.equal(physical(saved).length, 0); assert.equal(saved.auth.outcomes.length, 0); assert.equal(saved.outcomes.total, 0); await child.stop();
});
test('stale and relayed-only adverts cannot create direct eligibility or blind probing through the real entrypoint', async () => {
  const f = environment({ components: onlySensors }), child = await launch(f);
  await child.ask({ action: 'advert', raw: signedAdvertPacket(f.signer.payload(), { hops: ['AA', 'BB', 'CC'] }).raw });
  const relayed = await child.ask({ action: 'tick', ms: 10000 }); assert.equal(relayed.candidates.candidates.length, 0); assert.equal(physical(relayed).length, 0);
  await child.ask({ action: 'advert' }); await child.ask({ action: 'due' });
  const stale = await child.ask({ action: 'jump', ms: 73 * 3600000 });
  assert.equal(stale.candidates.candidates.length, 0); assert.equal(physical(stale).length, 0); await child.stop();
});
test('held data reply keeps real capture, duplicate-filtered bot replies and local signing alive; wrong tags cannot complete it', async () => {
  const f = environment({ components: onlySensors, bots: true }), child = await launch(f); await due(child);
  await child.ask({ action: 'tick', ms: 10000 }); await child.ask({ action: 'mode', value: 'hold' });
  const waiting = await child.ask({ action: 'tick', ms: 10000 }); assert.equal(physical(waiting).length, 2);
  const group = await child.ask({ action: 'group', count: 2 }); assert.equal(group.botUsage.accepted, 1);
  const signed = await child.ask({ action: 'sign' }); assert.deepEqual(signed.localCalls, ['sign']);
  await child.ask({ action: 'reply', tag: 0 });
  const wrong = await child.ask({ action: 'snapshot' }); assert.equal(wrong.outcomes.total, 0);
  const completed = await child.ask({ action: 'reply' }); assert.equal(completed.outcomes.total, 1);
  const bot = await child.ask({ action: 'tick', ms: 250 }); assert.equal(bot.replies.length, 1); assert.equal(bot.publishTopics.length, 3);
  await child.stop();
});
test('reporter identity change cancels a held request and cannot inherit direct evidence or guest authority', async () => {
  const f = environment({ components: onlySensors }), child = await launch(f); await due(child);
  await child.ask({ action: 'tick', ms: 10000 }); await child.ask({ action: 'mode', value: 'hold' });
  await child.ask({ action: 'tick', ms: 10000 }); await child.ask({ action: 'disconnect', identity: 'BF'.repeat(32) });
  const changed = await child.ask({ action: 'tick', ms: 20 }); assert.equal(changed.radio.observerPublicKey.toUpperCase(), 'BF'.repeat(32));
  assert.equal(changed.outcomes.outcomes[0].reason, 'disconnected'); assert.equal(changed.observations.total, 0);
  const later = await child.ask({ action: 'tick', ms: 20000 }); assert.equal(physical(later).length, 2); assert.equal(later.candidates.candidates.length, 0);
  const stale = await child.ask({ action: 'reply', connection: 0 }); assert.equal(stale.outcomes.total, 1); await child.stop();
});
for (const mode of ['unsupported', 'malformed', 'empty']) test(`owned ${mode} binary response preserves explicit outcome or empty observation without invented readings`, async () => {
  const f = environment({ components: { status: false, sensors: false, neighbours: true } }), child = await launch(f); await due(child);
  await child.ask({ action: 'tick', ms: 10000 }); await child.ask({ action: 'mode', value: mode });
  const saved = await child.ask({ action: 'tick', ms: 10000 }); assert.equal(saved.outcomes.total, 1);
  assert.equal(saved.outcomes.outcomes[0].status, mode === 'empty' ? 'answered' : mode === 'unsupported' ? 'unsupported' : 'failed');
  assert.equal(saved.observations.total, mode === 'empty' ? 1 : 0);
  if (mode === 'empty') assert.deepEqual(saved.observations.observations[0].data.entries, []); await child.stop();
});
for (const phase of ['before-reservation', 'after-reservation', 'after-send', 'before-completion', 'after-completion']) test(`real crash ${phase} retains original reservation/outcome and restart creates no replay or fabricated completion`, async () => {
  const f = environment({ components: onlySensors }), child = await launch(f, { phase }); await due(child);
  await child.ask({ action: 'tick', ms: 10000 }); child.process.send({ action: 'tick', ms: 10000 });
  const ended = await child.exited; assert.equal(ended.code, 17, ended.output);
  const before = read(f, store => ({ state: store.getTelemetryPollState({ observerPublicKey: OBSERVER, targetPublicKey: f.targetPublicKey,
    variant: { component: 'sensors', params: { permissionMask: 0 } } }), outcomes: store.queryTelemetryOutcomes(range), observations: store.queryTelemetryObservations(range) }));
  assert.equal(before.outcomes.total, phase === 'after-completion' ? 1 : 0);
  const next = await launch(f, { suffix: 'restart', startAt: START + 30000 });
  const recovered = await next.ask({ action: 'tick', ms: 10000 });
  assert.equal(recovered.runs.runs.find(r => r.runId !== recovered.runId).state, 'unclean');
  assert.equal(recovered.outcomes.total, before.outcomes.total); assert.deepEqual(recovered.observations, before.observations);
  if (phase !== 'before-reservation') assert.equal(physical(recovered).length, 0);
  assert.ok(!recovered.states.some(s => s?.reason === 'reserved')); await next.stop();
});
for (const ending of ['clean', 'abrupt', 'backup']) test(`real ${ending} restart preserves collected data/deadlines/public replay evidence without restoring session authority`, async () => {
  const f = environment({ components: onlySensors }), child = await launch(f); await due(child);
  await child.ask({ action: 'tick', ms: 10000 }); const before = await child.ask({ action: 'tick', ms: 10000 });
  if (ending === 'abrupt') { child.process.kill(); await child.exited; } else await child.stop();
  if (ending === 'backup') { const path = f.env.PACKETCAPTURE_METRICS_UI_DB_PATH, backup = join(f.dir, 'backup.sqlite3');
    assert.equal(existsSync(path + '-wal'), false); copyFileSync(path, backup); f.env.PACKETCAPTURE_METRICS_UI_DB_PATH = backup; }
  const next = await launch(f, { suffix: 'restart', startAt: START + 30000 });
  const after = await next.ask({ action: 'tick', ms: 10000 });
  assert.equal(after.instanceId, before.instanceId); assert.notEqual(after.runId, before.runId);
  assert.deepEqual(after.outcomes, before.outcomes); assert.deepEqual(after.observations, before.observations);
  assert.deepEqual(after.states, before.states); assert.equal(physical(after).length, 0);
  // Advance just past the saved component deadline with passive evidence still fresh.
  const dueAt = before.states.find(s => s?.variant.component === 'sensors').nextDueAt;
  const authentication = await next.ask({ action: 'jump', ms: dueAt - after.now + 1000 });
  assert.deepEqual(physical(authentication).map(w => w.component), ['guest-login']);
  // Synthetic old server time is rejected, proving durable replay protection.
  assert.equal(authentication.auth.outcomes.find(o => o.runId === authentication.runId).record.status, 'failed'); assert.equal(authentication.outcomes.total, 1);
  await next.stop(); inspect(f, db => assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []));
});
test('failed terminal save pauses all collection, local retry retains original times, and shutdown saves before clean store close', async () => {
  const f = environment({ components: onlySensors }), child = await launch(f, { writeFault: true }); await due(child);
  await child.ask({ action: 'tick', ms: 10000 }); const failed = await child.ask({ action: 'tick', ms: 10000 });
  assert.equal(failed.outcomes.total, 0); const paused = await child.ask({ action: 'tick', ms: 20000 }); assert.equal(physical(paused).length, 2);
  await child.ask({ action: 'mode', writeFault: false }); const saved = await child.ask({ action: 'tick', ms: 1000 });
  assert.equal(saved.outcomes.outcomes[0].completedAt, failed.now); assert.equal(saved.outcomes.outcomes[0].receivedAt, failed.now);
  const ended = await child.stop(); assert.doesNotMatch(ended.output, /PRIVATE-ONLY7/);
  assert.match(readFileSync(child.ledger, 'utf8'), /"closedRun":"clean"/);
});
test('persistent terminal save failure refuses clean run completion and leaves a recoverable reservation', async () => {
  const f = environment({ components: onlySensors }), child = await launch(f, { writeFault: true }); await due(child);
  await child.ask({ action: 'tick', ms: 10000 }); const failed = await child.ask({ action: 'tick', ms: 10000 });
  child.process.send({ action: 'stop' }); const ended = await child.exited;
  assert.equal(ended.code, 1); assert.match(ended.output, /Telemetry terminal result was not persisted; clean shutdown cannot be confirmed/);
  assert.doesNotMatch(ended.output, /PRIVATE-ONLY7|meshcore-observer stopped/);
  read(f, store => { assert.equal(store.getObserverRun({ runId: failed.runId }).state, 'running'); assert.equal(store.queryTelemetryOutcomes(range).total, 0); });
});
for (const kind of ['bad-setting', 'unsafe-secret', 'unknown-policy', 'missing-file']) test(`real ${kind} explicit polling configuration fails safely before store, radio or network startup`, () => {
  const f = environment();
  if (kind === 'bad-setting') f.env.PACKETCAPTURE_TELEMETRY_POLL_RADIUS = '0';
  if (kind === 'unsafe-secret') writeFileSync(f.env.PACKETCAPTURE_TELEMETRY_POLL_SECRETS_FILE, '{"version":1,"secrets":{"fixtureGuest":"PRIVATE-ONLY7\\u0000"}}');
  if (kind === 'unknown-policy') writeFileSync(f.env.PACKETCAPTURE_TELEMETRY_POLL_CONFIG_FILE, '{"version":1,"defaultCredentialRef":"fixtureGuest","PRIVATE-ONLY7":true}');
  if (kind === 'missing-file') f.env.PACKETCAPTURE_TELEMETRY_POLL_SECRETS_FILE = join(f.dir, 'PRIVATE-ONLY7.json');
  const { path } = fixtureFile(f);
  const result = spawnSync(process.execPath, [resolve('test/fixtures/telemetry-polling-child.js'), path],
    { env: f.env, cwd: process.cwd(), encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stdout + result.stderr, /Configuration error:/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-ONLY7|fixtureGuest|meshcore-observer starting|Unexpected/);
  assert.equal(existsSync(f.env.PACKETCAPTURE_METRICS_UI_DB_PATH), false);
});

for (const phase of ['before-reservation', 'after-reservation', 'after-send', 'before-completion', 'after-completion']) test(`real guest-login crash ${phase} never restores authority or fabricates an auth terminal`, async () => {
  const f = environment({ components: onlySensors }), child = await launch(f, { phase, crashComponent: 'guest-login' }); await due(child);
  child.process.send({ action: 'tick', ms: 10000 }); const ended = await child.exited; assert.equal(ended.code, 17, ended.output);
  const before = read(f, store => store.queryTelemetryAuthenticationOutcomes(range));
  assert.equal(before.outcomes.length, phase === 'after-completion' ? 1 : 0);
  const next = await launch(f, { suffix: 'restart', startAt: START + 30000 });
  const recovered = await next.ask({ action: 'tick', ms: 10000 });
  assert.equal(recovered.outcomes.total, 0); assert.equal(recovered.observations.total, 0);
  assert.equal(recovered.runs.runs.find(r => r.runId !== recovered.runId).state, 'unclean');
  if (phase !== 'before-reservation') { assert.deepEqual(recovered.auth, before); assert.equal(physical(recovered).length, 0); }
  assert.ok(!recovered.states.some(s => s?.reason === 'reserved')); await next.stop();
});
for (const component of ['guest-login', 'sensors']) for (const mode of ['ack-wait', 'hold']) test(`real shutdown during ${component} ${mode} commits a stopped terminal before closing`, async () => {
  const f = environment({ components: onlySensors }), child = await launch(f, { mode: component === 'guest-login' ? mode : 'success' }); await due(child);
  await child.ask({ action: 'tick', ms: 10000 });
  if (component === 'sensors') { await child.ask({ action: 'mode', value: mode }); await child.ask({ action: 'tick', ms: 10000 }); }
  await child.stop();
  read(f, store => {
    const outcomes = component === 'guest-login' ? store.queryTelemetryAuthenticationOutcomes(range).outcomes : store.queryTelemetryOutcomes(range).outcomes;
    assert.equal(outcomes.length, 1); assert.equal(component === 'guest-login' ? outcomes[0].record.reason : outcomes[0].reason, 'stopped');
    assert.equal(store.queryTelemetryObservations(range).total, 0); assert.equal(store.queryObserverRuntimeSummary().cleanRuns, 1);
  });
});
for (const recover of [true, false]) test(`real auth persistence failure ${recover ? 'retries locally without granting a session' : 'refuses clean shutdown'}`, async () => {
  const f = environment({ components: onlySensors }), child = await launch(f, { writeFault: true, faultComponent: 'guest-login' }); await due(child);
  const failed = await child.ask({ action: 'tick', ms: 10000 }); assert.equal(failed.auth.outcomes.length, 0);
  const paused = await child.ask({ action: 'tick', ms: 20000 }); assert.equal(physical(paused).length, 1); assert.equal(paused.outcomes.total, 0);
  if (recover) {
    await child.ask({ action: 'mode', writeFault: false }); const saved = await child.ask({ action: 'tick', ms: 1000 });
    assert.equal(saved.auth.outcomes.length, 1); assert.equal(saved.auth.outcomes[0].record.completedAt, failed.now);
    assert.equal(saved.outcomes.total, 0); assert.equal(physical(saved).length, 1);
    const ended = await child.stop(); assert.doesNotMatch(ended.output, /PRIVATE-ONLY7/);
  } else {
    child.process.send({ action: 'stop' }); const ended = await child.exited; assert.equal(ended.code, 1);
    assert.doesNotMatch(ended.output, /PRIVATE-ONLY7|meshcore-observer stopped/);
    read(f, store => assert.equal(store.getObserverRun({ runId: failed.runId }).state, 'running'));
  }
});
test('real sustained busy-air receptions defer background work without losing capture or creating RF attempts', async () => {
  const f = environment({ components: onlySensors }); f.env.PACKETCAPTURE_BOT_REPLY_QUIET_MS = '15000';
  const child = await launch(f); await due(child); let saved;
  for (let n = 0; n < 4; n++) { await child.ask({ action: 'advert' }); saved = await child.ask({ action: 'tick', ms: 10000 }); }
  assert.equal(physical(saved).length, 0); assert.equal(saved.outcomes.total, 0); assert.equal(saved.publishTopics.length, 5);
  assert.equal(saved.advertTotals.events, 1); await child.stop();
});
test('real unreachable data response consumes one attempt then durable backoff prevents rapid retries', async () => {
  const f = environment({ components: onlySensors }), child = await launch(f); await due(child);
  await child.ask({ action: 'tick', ms: 10000 }); await child.ask({ action: 'mode', value: 'hold' });
  await child.ask({ action: 'tick', ms: 10000 }); const timedOut = await child.ask({ action: 'tick', ms: 2000 });
  assert.equal(timedOut.outcomes.outcomes[0].reason, 'response-timeout'); assert.equal(timedOut.observations.total, 0);
  const later = await child.ask({ action: 'tick', ms: 60000 }); assert.equal(physical(later).length, 2);
  const state = later.states.find(s => s?.variant.component === 'sensors'); assert.equal(state.cycleAttempts, 1); assert.ok(state.nextDueAt > later.now);
  await child.stop();
});
