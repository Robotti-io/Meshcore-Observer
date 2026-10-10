import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { MetricsStore } from '../src/metrics/store.js';
import { advertSigner, signedAdvertPacket } from './fixtures/signed-advert.js';
import { buildRawFrame, PayloadType, RouteType } from './fixtures/packet-frames.js';
import { deriveHashtagChannelKey } from '../src/bots/channel-key.js';
import { dropPollSchema, start, reservation, completion } from './fixtures/region-poll.js';

const children = new Set(), dirs = new Set(), OBSERVER = 'BE'.repeat(32), START = 1700000000000;
const channelKey = deriveHashtagChannelKey('#echo');
const groupRaw = (() => {
  const header = Buffer.alloc(5); header.writeUInt32LE(1700000000);
  const data = Buffer.concat([header, Buffer.from('Fixture: !echo'), Buffer.from([0])]);
  const plain = Buffer.concat([data, Buffer.alloc(Math.ceil(data.length / 16) * 16 - data.length)]);
  const cipher = createCipheriv('aes-128-ecb', channelKey, null); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac('sha256', Buffer.concat([channelKey, Buffer.alloc(16)])).update(encrypted).digest().subarray(0, 2);
  const payload = Buffer.concat([createHash('sha256').update(channelKey).digest().subarray(0, 1), mac, encrypted]);
  return buildRawFrame({ payloadType: PayloadType.GRP_TXT, routeType: RouteType.FLOOD, hops: ['AC'], payload }).toString('hex');
})();
afterEach(async () => {
  for (const child of children) { child.process.kill(); await child.exited; } children.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.clear();
});
function environment({ enabled = true, bots = false,publication=false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'region-entrypoint-')); dirs.add(dir);
  const signer = advertSigner(), targetPublicKey = signer.publicKeyHex;
  const advertRaw = signedAdvertPacket(signer.payload({ name: null })).raw;
  const second = advertSigner(), secondAdvertRaw = signedAdvertPacket(second.payload({ name: 'Second' })).raw;
  const brokers = join(dir, 'brokers.json'), botFile = join(dir, 'bots.json');
  writeFileSync(brokers,JSON.stringify(publication?[
    { id:'regions',enabled:true,host:'fixture.invalid',port:1883,auth:{ method:'none' },
      regionPublication:{ enabled:true,tickIntervalMs:1000,publishTimeoutMs:1000,retryBaseMs:1000,retryMaxMs:4000 } },
    { id:'opt-out',enabled:true,host:'opt-out.invalid',port:1883,auth:{ method:'none' } }
  ]:[]));
  writeFileSync(botFile, JSON.stringify(bots ? [{ name: 'echo', channel: '#echo', enabled: true, minHops: 1,
    commands: [{ trigger: '!echo', response: 'reply to {sender}' }] }] : []));
  return { dir, targetPublicKey, advertRaw, secondTarget: second.publicKeyHex, secondAdvertRaw, env: { ...process.env, PACKETCAPTURE_CONNECTION_TYPE: 'tcp',
    PACKETCAPTURE_TCP_HOST: 'unused.invalid', PACKETCAPTURE_TCP_PORT: '1', PACKETCAPTURE_IATA: 'CVG',
    PACKETCAPTURE_BOTS_CONFIG_FILE: botFile, PACKETCAPTURE_BROKERS_CONFIG_FILE: brokers,
    PACKETCAPTURE_METRICS_UI_ENABLED: 'false', PACKETCAPTURE_METRICS_UI_DB_PATH: join(dir, 'metrics.sqlite3'),
    PACKETCAPTURE_METRICS_UI_SAMPLE_INTERVAL_MS: '1000', PACKETCAPTURE_METRICS_UI_RETENTION_DAYS: '0',
    PACKETCAPTURE_REGION_DISCOVERY_ENABLED: String(enabled), PACKETCAPTURE_REGION_QUERY_STARTUP_DELAY_MS: '10000',
    PACKETCAPTURE_REGION_QUERY_TICK_INTERVAL_MS: '1000', PACKETCAPTURE_REGION_QUERY_PREFLIGHT_TIMEOUT_MS: '1000',
    PACKETCAPTURE_REMOTE_REQUEST_MIN_INTERVAL_MS: '10000', PACKETCAPTURE_REMOTE_REQUEST_MAX_PER_MINUTE: '6',
    PACKETCAPTURE_REMOTE_REQUEST_ACK_TIMEOUT_MS: '1000', PACKETCAPTURE_REMOTE_REQUEST_RESPONSE_TIMEOUT_MAX_MS: '1000',
    PACKETCAPTURE_FLOOD_ADVERT_INTERVAL_HOURS: '0', PACKETCAPTURE_BOT_REPLY_QUIET_MS: '0',
    PACKETCAPTURE_CONNECTION_RETRY_DELAY: '10', PACKETCAPTURE_CONNECTION_RETRY_DELAY_MAX: '10' } };
}
async function launch(f, options = {}) {
  const suffix = options.suffix ?? 'first', ledger = join(f.dir, suffix + '-wire.jsonl'), fixtureFile = join(f.dir, suffix + '-fixture.json');
  writeFileSync(ledger, ''); writeFileSync(fixtureFile, JSON.stringify({ observerPublicKey: OBSERVER,
    targetPublicKey: f.targetPublicKey, advertRaw: f.advertRaw, secondAdvertRaw: f.secondAdvertRaw, groupRaw, channelKey: [...channelKey],
    startAt: START, ledger, ...options }));
  const childProcess = spawn(process.execPath, [resolve('test/fixtures/region-discovery-child.js'), fixtureFile],
    { env: f.env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = ''; const mailbox = [], waiters = [];
  childProcess.stdout.on('data', bytes => { output += bytes; }); childProcess.stderr.on('data', bytes => { output += bytes; });
  childProcess.on('message', message => { const waiter = waiters.shift(); if (waiter) waiter.resolve(message); else mailbox.push(message); });
  const child = { process: childProcess, ledger,
    next: () => mailbox.length ? Promise.resolve(mailbox.shift()) : new Promise((resolve, reject) => waiters.push({ resolve, reject })) };
  child.exited = new Promise(resolve => childProcess.once('exit', code => {
    children.delete(child); for (const waiter of waiters.splice(0)) waiter.reject(Error(output)); resolve({ code, output });
  }));
  child.ask = async message => { childProcess.send(message); return child.next(); };
  child.stop = async () => { childProcess.send({ action: 'stop' }); const end = await child.exited; assert.equal(end.code, 0, end.output); return end; };
  children.add(child); assert.deepEqual(await child.next(), { ready: true }); return child;
}
const scope = f => ({ observerPublicKey: OBSERVER, targetPublicKey: f.targetPublicKey });
function read(f, callback) {
  const store = new MetricsStore({ dbPath: f.env.PACKETCAPTURE_METRICS_UI_DB_PATH });
  try { return callback(store); } finally { store.close(); }
}
const codes = snapshot => snapshot.writes.map(write => write.bytes[0]);

test('actual entrypoint saves then publishes a measured answer only to opted-in MQTT client topic, keeping capture active',async()=>{
  const f=environment({ publication:true }),child=await launch(f,{ publicationBrokerId:'regions' });
  await child.ask({ action:'advert' });const saved=await child.ask({ action:'tick',ms:10000 });
  assert.equal(saved.answers.total,1);assert.equal(saved.publications.total,1);
  const delivered=await child.ask({ action:'tick',ms:1000 });assert.equal(delivered.publications.publications[0].state,'published');
  assert.equal(delivered.regionDeliveries.length,1);const sent=delivered.regionDeliveries[0];
  assert.equal(sent.host,'fixture.invalid');assert.equal(sent.topic,'meshcore/client/'+OBSERVER.toLowerCase()+'/regions');
  assert.deepEqual(sent.settings,{ qos:1,retain:false });assert.deepEqual(sent.payload.regions,['*','BE','be-vlg']);
  assert.equal(sent.payload.timestamp,new Date(saved.latest.answer.observedAt).toISOString());assert.equal(sent.payload.truncated,true);
  const capture=await child.ask({ action:'advert',count:2 });assert.equal(capture.publishTopics.filter(topic=>topic.endsWith('/packets')).length,3);
  assert.equal(capture.regionDeliveries.length,1);await child.stop();
  read(f,store=>{assert.equal(store.queryObserverRuntimeSummary().cleanRuns,1);assert.equal(store.queryRegionPublications({ brokerId:'opt-out' }).total,0);});
});
for(const publicationOutcome of ['failure','hang'])test(`actual entrypoint ${publicationOutcome} retains original answer, bounded retry and continuing capture`,async()=>{
  const f=environment({ publication:true }),child=await launch(f,{ publicationBrokerId:'regions',publicationOutcome,answer:'empty' });
  await child.ask({ action:'advert' });await child.ask({ action:'tick',ms:10000 });await child.ask({ action:'tick',ms:1000 });
  const retriable=await child.ask({ action:'tick',ms:1000 });
  assert.equal(retriable.publications.publications[0].state,'pending');assert.equal(retriable.latest.presence,'empty');
  assert.deepEqual(retriable.regionDeliveries[0].payload.regions,[]);
  await child.ask({ action:'publication-mode',value:'success' });
  if(publicationOutcome==='hang')await child.ask({ action:'tick',ms:5000 });
  const retried=await child.ask({ action:'tick',ms:4000 });
  assert.equal(retried.publications.publications[0].state,'published');
  for(const sent of retried.regionDeliveries)assert.deepEqual(sent.payload,retried.regionDeliveries[0].payload);
  const capture=await child.ask({ action:'advert',count:2 });assert.equal(capture.publishTopics.filter(topic=>topic.endsWith('/packets')).length,3);
  const end=await child.stop();assert.doesNotMatch(end.output,/Private broker failure/);
});
test('actual entrypoint can backfill saved latest with discovery/UI disabled and an unavailable broker',async()=>{
  const f=environment({ enabled:false,publication:true });seed(f);
  const child=await launch(f,{ publicationBrokerId:'regions' });await child.ask({ action:'broker-connected',value:false });
  const offline=await child.ask({ action:'tick',ms:1000 });assert.equal(offline.publications.total,1);
  assert.equal(offline.publications.publications[0].attemptCount,0);assert.equal(offline.regionDeliveries.length,0);assert.deepEqual(codes(offline),[]);
  await child.ask({ action:'broker-connected',value:true });const published=await child.ask({ action:'tick',ms:1000 });
  assert.equal(published.publications.publications[0].state,'published');assert.deepEqual(published.regionDeliveries[0].payload.regions,['Kept']);
  assert.equal(published.regionDeliveries[0].payload.timestamp,new Date(START-25*3600000+1).toISOString());await child.stop();
});
for(const phase of ['broker-accepted-before-local-save','after-publication-save'])test(`actual entrypoint crash ${phase} restarts with truthful delivery state and identical source observation`,async()=>{
  const f=environment({ publication:true }),child=await launch(f,{ phase,publicationBrokerId:'regions' });
  await child.ask({ action:'advert' });await child.ask({ action:'tick',ms:10000 });child.process.send({ action:'tick',ms:1000 });
  const end=await child.exited;assert.equal(end.code,17,end.output);
  const original=readFileSync(child.ledger,'utf8').trim().split('\n').map(line=>JSON.parse(line)).find(row=>row.region).region;
  const restarted=await launch(f,{ suffix:'publication-restart',startAt:START+20000,publicationBrokerId:'regions' });
  const recovered=await restarted.ask({ action:'tick',ms:1000 });assert.equal(recovered.publications.publications[0].state,'published');
  assert.equal(recovered.regionDeliveries.length,phase==='after-publication-save'?0:1);
  if(recovered.regionDeliveries.length)assert.deepEqual(recovered.regionDeliveries[0].payload,original.payload);
  assert.deepEqual(codes(recovered),[]);assert.equal(recovered.runs.runs.find(row=>row.runId!==recovered.runId).state,'unclean');await restarted.stop();
});
test('actual entrypoint retries delivery persistence locally and refuses clean closure while an accepted result is unsaved',async()=>{
  const f=environment({ publication:true }),child=await launch(f,{ publicationBrokerId:'regions',publicationWriteFault:true });
  await child.ask({ action:'advert' });await child.ask({ action:'tick',ms:10000 });await child.ask({ action:'tick',ms:1000 });
  const paused=await child.ask({ action:'tick',ms:5000 });assert.equal(paused.regionDeliveries.length,1);
  assert.equal(paused.publications.publications[0].state,'publishing');
  child.process.send({ action:'stop' });const end=await child.exited;assert.equal(end.code,1,end.output);
  assert.doesNotMatch(end.output,/Private publication storage failure/);assert.match(end.output,/clean shutdown cannot be confirmed/);
  read(f,store=>{assert.equal(store.queryObserverRuntimeSummary().cleanRuns,0);assert.equal(store.queryRegionPublications({ brokerId:'regions' }).publications[0].state,'publishing');});
});

test('actual offline dashboard-disabled entrypoint receives verified adverts and persists nonempty answers with only fixed read/request commands', async () => {
  const f = environment(), child = await launch(f);
  const heard = await child.ask({ action: 'advert' }); assert.equal(heard.inventory, 1); assert.equal(heard.advertTotals.events, 1);
  const answered = await child.ask({ action: 'tick', ms: 10000 });
  assert.deepEqual(codes(answered), [0x1E, 0x39]); assert.equal(answered.latest.presence, 'non-empty');
  assert.deepEqual(answered.latest.answer.regions, ['*', 'BE', 'be-vlg']); assert.equal(answered.latest.answer.completeness, 'unknown');
  assert.equal(answered.publications.total, 0); assert.equal(answered.answers.total, 1); assert.equal(answered.outcomes.total, 1);
  assert.equal(answered.resources.total, 10); assert.ok(answered.publishTopics.every(topic => !topic.endsWith('/regions')));
  assert.equal(answered.state.cycleReservations, 0); await child.stop();
  read(f, store => { assert.equal(store.queryObserverRuntimeSummary().cleanRuns, 1); assert.equal(store.getRegionLatest({ ...scope(f), now: answered.now, windowMs: 72 * 3600000 }).presence, 'non-empty'); });
});

function seed(f) {
  read(f, store => {
    const at = START - 25 * 3600000, run = start(store, at);
    store.recordRegionResult(completion(reservation(run, at, { ...scope(f) }), { csv: 'Kept', at: at + 1 }).result);
    store.endObserverRun({ runId: run.runId, observedAt: at + 2, observedDurationMs: 2, reason: 'SIGINT' });
  });
}
for (const [answer, status, reason] of [['empty', 'answered', null], ['malformed', 'failed', 'malformed-response'],
  ['timeout', 'failed', 'response-timeout'], ['unsupported', 'unsupported', 'unsupported'], ['flood', 'failed', 'route-mismatch'],
  ['ack-wait', 'failed', 'ack-timeout']]) {
  test(`actual offline entrypoint ${answer} records truthful terminal evidence and preserves prior latest on failure`, async () => {
    const f = environment(); seed(f); const child = await launch(f, { answer }); await child.ask({ action: 'advert' });
    let result = await child.ask({ action: 'tick', ms: 10000 });
    if (answer === 'timeout' || answer === 'ack-wait') result = await child.ask({ action: 'tick', ms: 1000 });
    const outcome = result.outcomes.outcomes.find(row => row.runId === result.runId);
    assert.equal(outcome.status, status); assert.equal(outcome.reason, reason); assert.equal(outcome.targetPublicKey, f.targetPublicKey);
    assert.equal(outcome.clockAnomaly, false);
    assert.deepEqual(result.latest.answer.regions, status === 'answered' ? [] : ['Kept']);
    assert.equal(result.publications.total, 0); assert.ok(codes(result).every(code => [0x1E, 0x39].includes(code)));
    const end = await child.stop(); assert.doesNotMatch(end.output, /Private fixture failure/);
  });
}
for (const [contact, stateReason] of [['missing', 'contact-missing'], ['full', 'preflight-failed'], ['unsafe', 'unsafe-route'],
  ['unsupported', 'preflight-unsupported'], ['wrong-key', null], ['silent', null]]) {
  test(`actual offline entrypoint ${contact} contact sends no anonymous RF or contact/auth mutation and capture can continue`, async () => {
    const f = environment(), child = await launch(f, { contact }); await child.ask({ action: 'advert' });
    let result = await child.ask({ action: 'tick', ms: 10000 });
    if (!stateReason) { await child.ask({ action: 'tick', ms: 1000 }); result = await child.ask({ action: 'tick', ms: 20 }); }
    assert.deepEqual(codes(result), [0x1E]); assert.equal(result.outcomes.total, 0);
    assert.equal(result.state?.reason ?? null, stateReason); assert.equal(result.state?.cycleReservations ?? 0, 0);
    const more = await child.ask({ action: 'advert', count: 2 });
    assert.equal(more.advertTotals.events, 1, 'identical signed payload retains one event identity');
    assert.equal(more.publishTopics.length, 3, 'all three physical receptions still reach packet capture');
    assert.equal(more.inventory, 1); assert.ok(more.radio.ready); await child.stop();
  });
}
test('disabled discovery leaves actual capture, verified inventory and bot duplicate filtering active with no region scheduling', async () => {
  const f = environment({ enabled: false, bots: true }), child = await launch(f);
  await child.ask({ action: 'advert' }); const group = await child.ask({ action: 'group', count: 2 });
  assert.equal(group.botUsage.accepted, 1); const result = await child.ask({ action: 'tick', ms: 20000 });
  assert.deepEqual(codes(result), []); assert.equal(result.state, null); assert.equal(result.outcomes.total, 0);
  assert.equal(result.inventory, 1); assert.equal(result.replies.length, 1); assert.equal(result.publishTopics.length, 3);
  await child.stop();
});
test('actual enabled entrypoint shares a reply wait with bots, duplicate capture, adverts and signing; wrong tags remain ignored', async () => {
  const f = environment({ bots: true }), child = await launch(f, { answer: 'hold' }); await child.ask({ action: 'advert' });
  const waiting = await child.ask({ action: 'tick', ms: 10000 }); assert.equal(waiting.state.reason, 'reserved');
  const group = await child.ask({ action: 'group', count: 2 }); assert.equal(group.botUsage.accepted, 1);
  const replied = await child.ask({ action: 'tick', ms: 250 }); assert.deepEqual(replied.replies, [{ channel: 0, text: 'reply to Fixture' }]);
  await child.ask({ action: 'flood-advert' }); const advertised = await child.ask({ action: 'tick', ms: 250 });
  assert.equal(advertised.adverts.length, 2); assert.equal(advertised.publishTopics.length, 3);
  const signed = await child.ask({ action: 'sign' }); assert.deepEqual(signed.localCalls, ['sign']); assert.equal(signed.outcomes.total, 0);
  const wrong = await child.ask({ action: 'reply', tag: 999 }); assert.equal(wrong.outcomes.total, 0);
  const completed = await child.ask({ action: 'reply' }); assert.equal(completed.outcomes.total, 1);
  assert.equal(completed.latest.presence, 'non-empty'); assert.equal(completed.publications.total, 0); await child.stop();
});
test('old transport/generation callbacks cannot resolve another repeater after disconnect; global spacing survives reconnect', async () => {
  const f = environment(), child = await launch(f, { answer: 'hold' }); await child.ask({ action: 'advert' });
  await child.ask({ action: 'tick', ms: 10000 }); await child.ask({ action: 'disconnect' });
  await child.ask({ action: 'tick', ms: 20 }); await child.ask({ action: 'advert', second: true }); await child.ask({ action: 'next-tag' });
  const limited = await child.ask({ action: 'tick', ms: 2000 }); assert.equal(codes(limited).filter(code => code === 0x39).length, 1);
  await child.ask({ action: 'tick', ms: 8000 });
  // Random signed keys can place the new target before the prior cursor;
  // allow one bounded keyset wrap after the spacing gate, not before it.
  let waiting = await child.ask({ action: 'snapshot' });
  if(codes(waiting).filter(code=>code===0x39).length===1)waiting=await child.ask({ action:'tick',ms:1000 });
  assert.equal(codes(waiting).filter(code => code === 0x39).length, 2); assert.equal(waiting.outcomes.total, 1);
  const stale = await child.ask({ action: 'reply', tag: 18, connection: 0 }); assert.equal(stale.outcomes.total, 1);
  const wrong = await child.ask({ action: 'reply', tag: 17 }); assert.equal(wrong.outcomes.total, 1);
  const good = await child.ask({ action: 'reply', tag: 18 }); assert.equal(good.outcomes.total, 2);
  assert.equal(good.outcomes.outcomes.find(row => row.status === 'answered').targetPublicKey, f.secondTarget);
  assert.equal(good.state.cycleReservations, 1); await child.stop();
});
for (const phase of ['before-reservation', 'after-reservation', 'after-send', 'before-completion', 'after-completion']) {
  test(`actual entrypoint crash ${phase} recovers owned evidence/cooldown without RF replay or fabricated answers`, async () => {
    const f = environment(), child = await launch(f, { phase }); await child.ask({ action: 'advert' });
    child.process.send({ action: 'tick', ms: 10000 }); const ended = await child.exited; assert.equal(ended.code, 17, ended.output);
    const ledger = readFileSync(child.ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(ledger.filter(row => row.bytes?.[0] === 0x39).length, ['before-reservation', 'after-reservation'].includes(phase) ? 0 : 1);
    const before = read(f, store => ({ state: store.getRegionPollState(scope(f)),
      answers: store.queryRegionAnswers({ start: 0, end: Number.MAX_SAFE_INTEGER }), runs: store.queryObserverRuns({ start: 0, end: Number.MAX_SAFE_INTEGER }) }));
    assert.equal(before.answers.total, phase === 'after-completion' ? 1 : 0);
    assert.equal(before.state?.cycleReservations ?? 0, ['before-reservation', 'after-completion'].includes(phase) ? 0 : 1);
    assert.equal(before.runs.runs[0].state, 'running');
    const restarted = await launch(f, { suffix: 'restart', startAt: START + 20000 });
    const after = await restarted.ask({ action: 'tick', ms: 10000 });
    assert.equal(after.runs.runs.find(row => row.runId === before.runs.runs[0].runId).state, 'unclean');
    assert.deepEqual(codes(after), phase === 'before-reservation' ? [0x1E, 0x39] : []);
    if (phase !== 'before-reservation') {
      assert.deepEqual(after.state, before.state); assert.deepEqual(after.answers.answers, before.answers.answers);
      assert.equal(after.outcomes.total, phase === 'after-completion' ? 1 : 0);
    }
    await restarted.stop();
  });
}
test('actual entrypoint failed answer commit blocks requery; recovered local write preserves original times and final shutdown saves before clean close', async () => {
  const f = environment(), child = await launch(f, { writeFault: true }); await child.ask({ action: 'advert' });
  const failed = await child.ask({ action: 'tick', ms: 10000 }); assert.equal(failed.outcomes.total, 0); assert.equal(failed.state.reason, 'reserved');
  const deferred = await child.ask({ action: 'tick', ms: 2000 }); assert.deepEqual(codes(deferred), [0x1E, 0x39]);
  await child.ask({ action: 'answer-mode', value: 'nonempty', writeFault: false });
  const saved = await child.ask({ action: 'tick', ms: 1000 }); assert.equal(saved.outcomes.total, 1);
  assert.equal(saved.latest.answer.observedAt, failed.now); assert.equal(saved.latest.latestOutcome.completedAt, failed.now);
  await child.ask({ action: 'prune' }); await child.stop();
  const restart = await launch(f, { suffix: 'restart', startAt: saved.now + 10000 });
  const after = await restart.ask({ action: 'tick', ms: 10000 }); assert.deepEqual(codes(after), []);
  assert.deepEqual(after.latest.answer, saved.latest.answer); assert.equal(after.state.nextDueAt, saved.state.nextDueAt); await restart.stop();
});
test('actual entrypoint persistent final commit failure leaves the run unclosed at the bounded shutdown deadline', async () => {
  const f = environment(), child = await launch(f, { writeFault: true }); await child.ask({ action: 'advert' });
  const failed = await child.ask({ action: 'tick', ms: 10000 }); child.process.send({ action: 'stop' });
  const ended = await child.exited; assert.equal(ended.code, 1); assert.match(ended.output, /shutdown failed; run end remains unconfirmed/);
  assert.doesNotMatch(ended.output, /Private fixture failure|meshcore-observer stopped/);
  read(f, store => { assert.equal(store.getObserverRun({ runId: failed.runId }).state, 'running');
    assert.equal(store.getRegionPollState(scope(f)).reason, 'reserved'); assert.equal(store.queryRegionOutcomes({ start: 0, end: Number.MAX_SAFE_INTEGER }).total, 0); });
});
test('actual offline entrypoint upgrades v14 to v15 without inventing schedules, outcomes or lost legacy inventory', async () => {
  const f = environment(); read(f, store => store.upsertNode({ publicKeyHex: f.targetPublicKey, name: 'Legacy kept', type: 'REPEATER', heardAt: START }));
  const db = new DatabaseSync(f.env.PACKETCAPTURE_METRICS_UI_DB_PATH);
  try { db.exec(dropPollSchema + ' PRAGMA user_version=14'); } finally { db.close(); }
  const child = await launch(f); const after = await child.ask({ action: 'tick', ms: 10000 });
  assert.equal(after.inventory, 1); assert.deepEqual(codes(after), []); assert.equal(after.state, null); assert.equal(after.outcomes.total, 0); await child.stop();
  const checked = new DatabaseSync(f.env.PACKETCAPTURE_METRICS_UI_DB_PATH);
  try { assert.equal(checked.prepare('PRAGMA user_version').get().user_version, 16); assert.deepEqual(checked.prepare('PRAGMA foreign_key_check').all(), []); }
  finally { checked.close(); }
});
