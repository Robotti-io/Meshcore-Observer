import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryPollingScheduler } from '../../src/telemetry/polling-scheduler.js';
import { RemoteRequestCoordinator } from '../../src/radio/remote-request-coordinator.js';
import { loadTelemetryPolling } from '../../src/telemetry/polling-config.js';
import { TELEMETRY_POLL_DEFAULTS } from '../../src/telemetry/polling-schemas.js';
import { createTelemetryFixture, TELEMETRY_OBSERVER as OBSERVER } from '../fixtures/telemetry-store.js';
import { observe, SENSOR } from '../fixtures/telemetry-poll.js';
import { telemetryContactFrame, telemetryInventoryBoundary, telemetryRadioTarget as TARGET, telemetryTraceAck, telemetryTraceResponse } from '../fixtures/telemetry-radio-wire.js';
import { Constants } from '@liamcottle/meshcore.js';
import { telemetryBytes, telemetryWire, neighbourPage } from '../fixtures/telemetry-wire.js';
import { frontierNode, neighbourReport } from '../fixtures/neighbour-frontier.js';

const active = [];
async function flush() { for (let n = 0; n < 150; n++) await Promise.resolve(); }
function ack(tag) { const b = Buffer.alloc(10); b[0] = 6; b.writeUInt32LE(tag, 2); b.writeUInt32LE(5000, 6); return [...b]; }
function login({ admin = 0, timestamp = 100 } = {}) { const b = Buffer.alloc(14); b[0] = 0x85; b[1] = admin;
  b.set(Buffer.from(TARGET, 'hex').subarray(0, 6), 2); b.writeUInt32LE(timestamp, 8); b[13] = 2; return [...b]; }
function binary(tag, body) { const b = Buffer.alloc(6 + body.length); b[0] = 0x8C; b.writeUInt32LE(tag, 2); b.set(body, 6); return [...b]; }
function rig({ neighbours = false, neighbourSeed = false, exchange = false } = {}) {
  vi.useFakeTimers(); const f = createTelemetryFixture(); active.push(f);
  f.dir = mkdtempSync(join(tmpdir(), 'telemetry-producer-'));
  const policyPath = join(f.dir, 'policy.json'), secretsPath = join(f.dir, 'secrets.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, defaultCredentialRef: 'fixtureGuest',
    components: { status: false, sensors: !neighbours, neighbours } }));
  writeFileSync(secretsPath, JSON.stringify({ version: 1, secrets: { fixtureGuest: 'PRIVATE-ONLY7' } }));
  f.config = loadTelemetryPolling({ settings: { ...TELEMETRY_POLL_DEFAULTS, enabled: true, refreshIntervalMs: 3600000,
    startupDelayMs: 1000, tickIntervalMs: 1000, exchangeMaxRequests: exchange ? 6 : 1 }, policyPath, secretsPath });
  f.variant = neighbours ? { component: 'neighbours', params: f.config.neighbourParams } : SENSOR;
  f.clock = 10000; f.foreground = false; f.quiet = true; f.writes = []; f.traceReplies = true; f.contactUpdates = [];
  f.logger = { warn: vi.fn(), info: vi.fn() }; f.snapshot = { ready: true, generation: 1, observerPublicKey: OBSERVER };
  f.connection = new EventEmitter(); f.radio = new EventEmitter();
  f.radio.getConnectionSnapshot = () => f.snapshot;
  f.radio.runCommand = async callback => callback(f.connection, { generation: f.snapshot.generation, signal: new AbortController().signal });
  f.radio.invalidateConnection = async () => { f.snapshot = { ...f.snapshot, ready: false }; f.radio.emit('radio.disconnected'); return { status: 'reset' }; };
  f.connection.sendToRadioFrame = async bytes => {
    f.writes.push({ at: f.clock, code: bytes[0] });
    if (bytes[0] === Constants.CommandCodes.SendTracePath) {
      f.connection.emit('rx', telemetryTraceAck(bytes));
      if (f.traceReplies) f.connection.emit('rx', telemetryTraceResponse(bytes));
    }
    if (bytes[0] === 26 || bytes[0] === 50) {
      const variant = bytes[0] === 26 ? { component: 'guest-login', params: {} } : f.variant;
      const state = f.store.getTelemetryPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET, variant });
      assert.equal(state.reason, 'reserved');
      assert.equal(state.reservedAt, exchange && bytes[0] === 26
        ? f.writes.findLast(w => w.code === Constants.CommandCodes.SendTracePath).at : f.clock);
    }
  };
  f.connection.addOrUpdateContact = async contact => { f.contactUpdates.push(contact); };
  f.connection.sendCommandSendBinaryReq = async (_, bytes) => { f.binaryBytes = bytes; await f.connection.sendToRadioFrame([50]); };
  f.coordinator = new RemoteRequestCoordinator({ radio: f.radio, logger: f.logger, now: () => f.clock, wallNow: () => f.clock,
    airtimeCoordinator: { canRunWhenQuiet: () => f.quiet, tryRunWhenQuiet: cb => f.quiet ? Promise.resolve().then(cb) : null },
    hasForegroundWork: () => f.foreground, uniquenessBytes: () => [1, 2, 3, 4],
    minIntervalMs: exchange ? 60000 : 10000, maxPerMinute: exchange ? 1 : 6,
    ...(exchange ? { responseTimeoutMaxMs: 120000 } : {}) });
  f.calls = [];
  for (const method of ['tryGuestLogin', 'tryTelemetryRequest']) {
    const original = f.coordinator[method].bind(f.coordinator);
    f.coordinator[method] = async (...args) => { const result = await original(...args); f.calls.push({ method, result }); return result; };
  }
  if (neighbourSeed) {
    f.store.upsertNode({ publicKeyHex: TARGET, name: null, type: 'REPEATER', heardAt: 900 });
    neighbourReport(f, frontierNode(f, 'E85C'), [TARGET]);
  } else {
    observe(f, TARGET);
    f.store.recordVerifiedAdvert({ publicKeyHex: TARGET, name: null, type: 'REPEATER',
    receivedAt: 900, hopCount: 0, eventDigest: 'cd'.repeat(32), routeEvidence: {
      hashWidth: 2, pathHashesHex: [], flags: 2, advertTimestamp: 0, lat: null, lon: null
    } });
  }
  const policy = Object.fromEntries(['refreshIntervalMs', 'retryBaseMs', 'retryMaxMs', 'maxAttempts', 'authCooldownMs'].map(k => [k, f.config[k]]));
  f.store.deferTelemetryPoll({ observerPublicKey: OBSERVER, targetPublicKey: TARGET, variant: f.variant, runId: f.run.runId,
    observedAt: f.clock, nextDueAt: f.clock, reason: 'rate-limited', policy });
  f.scheduler = new TelemetryPollingScheduler({ config: f.config, store: f.store, runId: f.run.runId, radio: f.radio,
    coordinator: f.coordinator, logger: f.logger, wallNow: () => f.clock, monotonicNow: () => f.clock });
  f.tick = async (ms = 1000) => { f.clock += ms; await vi.advanceTimersByTimeAsync(ms); await flush(); };
  f.frame = async bytes => { f.connection.emit('rx', bytes); await flush(); };
  f.authenticate = async proof => {
    f.scheduler.start(); await f.tick(10000); assert.equal(f.writes.at(-1)?.code, 4, JSON.stringify([f.logger.warn.mock.calls, f.calls]));
    await f.frame(telemetryInventoryBoundary(2, 1)); await f.frame(telemetryContactFrame());
    await f.frame(telemetryInventoryBoundary(4)); assert.equal(f.writes.at(-1).code, 30);
    await f.frame(telemetryContactFrame()); assert.equal(f.writes.at(-1).code, 26);
    await f.frame(ack(Buffer.from(TARGET, 'hex').readUInt32LE(0))); await f.frame(proof ?? login());
  };
  f.data = async () => {
    await f.tick(10000); assert.equal(f.writes.at(-1).code, 30); await f.frame(telemetryContactFrame());
    assert.equal(f.writes.at(-1).code, 50); const tag = Buffer.from(f.binaryBytes).readUInt32LE(1);
    await f.frame(ack(tag)); await f.frame(binary(tag, telemetryBytes(telemetryWire.sensors)));
  };
  return f;
}
afterEach(async () => {
  for (const f of active.splice(0)) {
    f.scheduler.stop(); await f.coordinator.stop(); await flush();
    try { await f.scheduler.drain(); } catch { /* Deliberately blocked terminal fixtures. */ }
    assert.equal(f.radio.listenerCount('radio.connected'), 0); assert.equal(f.connection.listenerCount('rx'), 0);
    f.cleanup(); rmSync(f.dir, { recursive: true, force: true });
  }
  assert.equal(vi.getTimerCount(), 0); vi.useRealTimers();
});

async function exchangeLogin(f, timestamp = 100, extra = {}) {
  assert.equal(f.writes.at(-1).code, 4);
  await f.frame(telemetryInventoryBoundary(2, 1)); await f.frame(telemetryContactFrame());
  await f.frame(telemetryInventoryBoundary(4));
  await f.tick(1000); assert.equal(f.writes.at(-1).code, 30); await f.frame(telemetryContactFrame());
  assert.equal(f.writes.at(-1).code, 26);
  await f.frame(ack(Buffer.from(TARGET, 'hex').readUInt32LE(0))); await f.frame(login({ timestamp, ...extra }));
}

test('one-minute pacing moves after trace/login/data, while a delayed tagged reply stays owned', async () => {
  const f = rig({ exchange: true, neighbours: true });
  f.scheduler.start(); await f.tick(60000); await exchangeLogin(f);
  const loginAt = f.clock;
  await f.tick(1000); assert.equal(f.writes.at(-1).code, 30, JSON.stringify({ calls: f.calls.map(c => ({ method: c.method,
    status: c.result.status, reason: c.result.reason })), warnings: f.logger.warn.mock.calls })); await f.frame(telemetryContactFrame());
  assert.equal(f.writes.at(-1).code, 50);
  assert.equal(f.clock - loginAt, 1000, 'collection follows login without a sixty-second rate-limit gap');
  const tag = Buffer.from(f.binaryBytes).readUInt32LE(1); await f.frame(ack(tag));
  await f.tick(30000);
  const prefix = 'D000' + 'EE'.repeat(30);
  await f.frame(binary(tag, neighbourPage([{ prefix, age: 12, snr: 28 }], { prefixLength: 32 })));
  assert.equal(f.store.queryTelemetryObservations({ start: 0, end: 1000000, component: 'neighbours' }).total, 1);
  const d = f.store.queryTelemetryRequestDiagnostics({ start: 0, end: 1000000 }).diagnostics;
  assert.equal(d.find(r => r.operation === 'neighbours' && r.status === 'completed').responseTimeoutMs, 60000);
  // Add another due target: all three RF writes (trace, login, query) must
  // settle before either another target or a separate background producer.
  const other = 'DF'.repeat(32); observe(f, other);
  f.store.deferTelemetryPoll({ observerPublicKey: OBSERVER, targetPublicKey: other, variant: f.variant,
    runId: f.run.runId, observedAt: f.clock, nextDueAt: f.clock, reason: 'rate-limited',
    policy: Object.fromEntries(['refreshIntervalMs', 'retryBaseMs', 'retryMaxMs', 'maxAttempts', 'authCooldownMs'].map(k => [k, f.config[k]])) });
  const count = f.writes.length;
  await f.tick(179000); assert.equal(f.writes.length, count);
  await f.tick(1000); assert.equal(f.writes.at(-1).code, 4);
});

test('foreground work defers a logged-in exchange without consuming its collection turn', async () => {
  const f = rig({ exchange: true }); f.scheduler.start(); await f.tick(60000); await exchangeLogin(f);
  f.foreground = true; const writes = f.writes.length; await f.tick(1000);
  assert.equal(f.writes.length, writes); f.foreground = false;
  await f.tick(1000); assert.equal(f.writes.at(-1).code, 30); await f.frame(telemetryContactFrame());
  assert.equal(f.writes.at(-1).code, 50);
});

test('foreign requests cannot spend exchange credit and pending region discovery gets the next shared turn', async () => {
  const f = rig({ exchange: true }); f.scheduler.start(); await f.tick(60000); await exchangeLogin(f);
  const before = f.writes.length;
  const foreign = await f.coordinator.tryRequest({ requestId: randomUUID(), targetPublicKey: TARGET, operation: 'status', params: {} });
  assert.equal(foreign.reason, 'rate-limited'); assert.equal(f.writes.length, before);
  await f.tick(1000); await f.frame(telemetryContactFrame());
  const tag = Buffer.from(f.binaryBytes).readUInt32LE(1);
  await f.frame(ack(tag)); await f.frame(binary(tag, telemetryBytes(telemetryWire.sensors)));
  await f.tick(179000); f.coordinator.noteBackgroundDemand({ source: 'regions' });
  const request = { requestId: randomUUID(), targetPublicKey: TARGET, operation: 'anonymous-regions', params: {} };
  await f.tick(1000);
  const pending = f.coordinator.tryRequest(request, { expectedRoute: 'direct' }, () => true, () => true);
  await flush(); assert.equal(f.writes.at(-1).code, 30, 'region contact preflight must receive the turn');
  await f.coordinator.stop(); await pending;
});

test('generation change revokes an exchange and cannot carry its short-spacing credit to another connection', async () => {
  const f = rig({ exchange: true }); f.scheduler.start(); await f.tick(60000); await exchangeLogin(f);
  f.snapshot = { ...f.snapshot, generation: 2 }; f.radio.emit('radio.connected');
  const count = f.writes.length; await f.tick(1000); await f.tick(10000);
  assert.equal(f.writes.length, count); assert.equal(f.writes.some(w => w.code === 50), false);
});

test('exchange admission clears only recoverable ownership failure after a new radio generation', async () => {
  const f = rig({ exchange: true }), originalSend = f.connection.sendToRadioFrame;
  let transactionController;
  f.radio.runCommand = async callback => {
    transactionController = new AbortController();
    return callback(f.connection, { generation: f.snapshot.generation, signal: transactionController.signal });
  };
  f.connection.sendToRadioFrame = async bytes => {
    if (bytes[0] === Constants.CommandCodes.SendTracePath) throw Error('synthetic write failure');
    return originalSend(bytes);
  };
  f.radio.invalidateConnection = async () => {
    f.snapshot = { ...f.snapshot, ready: false }; f.radio.emit('radio.disconnected'); return { status: 'failed' };
  };
  f.scheduler.start(); await f.tick(60000);
  await f.frame(telemetryInventoryBoundary(2, 1)); await f.frame(telemetryContactFrame());
  await f.frame(telemetryInventoryBoundary(4)); await flush();
  assert.equal(f.coordinator.getStatus().recoveryFailed, true);
  const other = 'DF'.repeat(32); observe(f, other);
  f.store.deferTelemetryPoll({ observerPublicKey: OBSERVER, targetPublicKey: other, variant: f.variant,
    runId: f.run.runId, observedAt: f.clock, nextDueAt: f.clock, reason: 'rate-limited',
    policy: Object.fromEntries(['refreshIntervalMs', 'retryBaseMs', 'retryMaxMs', 'maxAttempts', 'authCooldownMs'].map(k => [k, f.config[k]])) });
  f.connection.sendToRadioFrame = originalSend;
  f.snapshot = { ...f.snapshot, generation: 2, ready: true };
  transactionController.abort(); f.radio.emit('radio.connected'); await flush();
  await f.tick(60000);
  assert.equal(f.coordinator.getStatus().recoveryFailed, false);
  assert.equal(f.writes.at(-1).code, 4, 'new generation must admit inventory after cooldown instead of staying latched forever');
});

test('exchange pacing never turns an unsafe guest proof into collection permission', async () => {
  const f = rig({ exchange: true }); f.scheduler.start(); await f.tick(60000); await exchangeLogin(f, 100, { admin: 1 });
  await f.tick(1000); await f.tick(60000);
  assert.equal(f.writes.some(w => w.code === 50), false);
  const auth = f.store.queryTelemetryAuthenticationOutcomes({ start: 0, end: 1000000 }).outcomes;
  assert.equal(auth.length, 1); assert.equal(auth[0].record.reason, 'unsafe-login-permissions');
  assert.equal(f.store.queryTelemetryOutcomes({ start: 0, end: 1000000 }).total, 0);
});

test('failed auth persistence closes the exchange; saving later grants neither old credit nor a guest session', async () => {
  const f = rig({ exchange: true }), original = f.store.completeTelemetryAuthentication.bind(f.store);
  f.store.completeTelemetryAuthentication = () => { throw Error('PRIVATE-ONLY7'); };
  f.scheduler.start(); await f.tick(60000); await exchangeLogin(f);
  const count = f.writes.length; await f.tick(1000); assert.equal(f.writes.length, count);
  f.store.completeTelemetryAuthentication = original; await f.tick(1000); await f.tick(60000);
  assert.equal(f.writes.length, count); assert.equal(f.writes.some(w => w.code === 50), false);
  assert.doesNotMatch(JSON.stringify(f.logger.warn.mock.calls), /PRIVATE-ONLY7/);
});

test('timed-out collection keeps its durable retry deadline and attempt count instead of replaying inside the exchange', async () => {
  const f = rig({ exchange: true }); f.scheduler.start(); await f.tick(60000); await exchangeLogin(f);
  await f.tick(1000); await f.frame(telemetryContactFrame());
  const tag = Buffer.from(f.binaryBytes).readUInt32LE(1); await f.frame(ack(tag)); await f.tick(60000);
  const state = f.store.getTelemetryPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET, variant: f.variant });
  assert.equal(state.reason, 'retry'); assert.equal(state.cycleAttempts, 1);
  assert.equal(state.nextDueAt, f.clock + f.config.retryBaseMs);
  const count = f.writes.length; await f.tick(180000); assert.equal(f.writes.length, count);
  assert.equal(f.store.queryTelemetryOutcomes({ start: 0, end: 2000000, targetPublicKey: TARGET }).outcomes[0].reason, 'response-timeout');
  await f.tick(f.config.retryBaseMs); assert.equal(f.writes.at(-1).code, 4);
  await exchangeLogin(f, 101);
  await f.tick(1000); await f.frame(telemetryContactFrame());
  const retryTag = Buffer.from(f.binaryBytes).readUInt32LE(1);
  await f.frame(ack(retryTag)); await f.frame(binary(retryTag, telemetryBytes(telemetryWire.sensors)));
  const outcomes = f.store.queryTelemetryOutcomes({ start: 0, end: 3000000, targetPublicKey: TARGET }).outcomes;
  assert.equal(outcomes.length, 2); assert.equal(new Set(outcomes.map(r => r.requestId)).size, 2);
  assert.ok(outcomes.some(r => r.status === 'failed')); assert.ok(outcomes.some(r => r.status === 'partial'));
});
test('real shared owner, strict raw guest proof and tagged query commit through scheduler owned hooks', async () => {
  const f = rig(); await f.authenticate(); assert.equal(f.store.getTelemetryAuthReplayState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET }).serverTimestamp, 100,
    JSON.stringify([f.calls, f.logger.warn.mock.calls, f.store.queryTelemetryAuthenticationOutcomes({ start: 0, end: 100000 })]));
  assert.equal(f.store.queryTelemetryOutcomes({ start: 0, end: 100000 }).total, 0); await f.data();
  const data = f.store.queryTelemetryOutcomes({ start: 0, end: 100000 }); assert.equal(data.total, 1); assert.equal(data.outcomes[0].status, 'partial');
  assert.equal(data.outcomes[0].observerPublicKey, OBSERVER); assert.equal(data.outcomes[0].targetPublicKey, TARGET);
  assert.ok(f.writes.filter(w => [26, 50].includes(w.code)).every((w, i, arr) => i === 0 || w.at - arr[i - 1].at >= 10000));
  assert.doesNotMatch(JSON.stringify([data, f.logger.warn.mock.calls, f.logger.info.mock.calls]), /PRIVATE-ONLY7|fixtureGuest|PRIVATE-NAME/);
});

test('neighbour-only eligibility still requires a successful independent trace before contact changes or login', async () => {
  const f = rig({ neighbourSeed: true }); f.traceReplies = false;
  f.scheduler.start(); await f.tick(10000);
  await f.frame(telemetryInventoryBoundary(2, 1)); await f.frame(telemetryContactFrame());
  await f.frame(telemetryInventoryBoundary(4));
  assert.equal(f.writes.at(-1).code, Constants.CommandCodes.SendTracePath);
  assert.deepEqual(f.contactUpdates, []);
  assert.equal(f.writes.some(w => [26, 50].includes(w.code)), false);
  await f.tick(60000);
  assert.equal(f.writes.some(w => [26, 50].includes(w.code)), false);
  assert.deepEqual(f.contactUpdates, []);
  assert.ok(f.calls.some(c => c.result.reason === 'trace-timeout'));
  assert.equal(f.store.queryTelemetryOutcomes({ start: 0, end: 100000, targetPublicKey: TARGET }).total, 0);
});

test('a neighbour-seeded route passes real trace, guest proof, saved reservation and tagged data gates', async () => {
  const f = rig({ neighbourSeed: true });
  const contact = telemetryContactFrame({ encodedPathLength: 0x41, path: [0xE8, 0x5C] });
  f.scheduler.start(); await f.tick(10000);
  await f.frame(telemetryInventoryBoundary(2, 1)); await f.frame(telemetryContactFrame());
  await f.frame(telemetryInventoryBoundary(4));
  assert.ok(f.writes.some(w => w.code === Constants.CommandCodes.SendTracePath));
  assert.equal(f.contactUpdates.length, 1);
  assert.equal(f.writes.at(-1).code, 30); await f.frame(contact);
  assert.equal(f.writes.at(-1).code, 26);
  await f.frame(ack(Buffer.from(TARGET, 'hex').readUInt32LE(0))); await f.frame(login());
  await f.tick(10000); assert.equal(f.writes.at(-1).code, 30); await f.frame(contact);
  assert.equal(f.writes.at(-1).code, 50);
  const tag = Buffer.from(f.binaryBytes).readUInt32LE(1);
  await f.frame(ack(tag)); await f.frame(binary(tag, telemetryBytes(telemetryWire.sensors)));
  const data = f.store.queryTelemetryOutcomes({ start: 0, end: 100000, targetPublicKey: TARGET });
  assert.equal(data.total, 1); assert.equal(data.outcomes[0].status, 'partial');
  const diagnostics = f.store.queryTelemetryRequestDiagnostics({ start: 0, end: 100000, targetPublicKey: TARGET });
  assert.ok(diagnostics.diagnostics.some(d => d.routeEvidenceSource === 'telemetry-neighbours' && d.traceOutcome === 'response'));
});

test('known over-radius route never starts inventory preflight and a fresh shorter route can resume normally', async () => {
  const f = rig();
  f.store.recordVerifiedAdvert({ publicKeyHex: TARGET, name: null, type: 'REPEATER',
    receivedAt: f.clock, hopCount: 2, eventDigest: 'ed'.repeat(32), routeEvidence: {
      hashWidth: 2, pathHashesHex: ['1100', '2200'], flags: 2, advertTimestamp: 0, lat: null, lon: null
    } });
  f.scheduler.start(); await f.tick(10000);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.writes, []);
  f.store.recordVerifiedAdvert({ publicKeyHex: TARGET, name: null, type: 'REPEATER',
    receivedAt: f.clock + 1, hopCount: 0, eventDigest: 'ee'.repeat(32), routeEvidence: {
      hashWidth: 2, pathHashesHex: [], flags: 2, advertTimestamp: 0, lat: null, lon: null
    } });
  await f.authenticate(); await f.data();
  assert.equal(f.store.queryTelemetryObservations({ start: 0, end: 100000 }).total, 1);
});

test('owner still rejects a route that grows beyond the radius after scheduler selection', async () => {
  const f = rig(); f.scheduler.start(); await f.tick(10000);
  assert.equal(f.writes.at(-1).code, 4);
  f.store.recordVerifiedAdvert({ publicKeyHex: TARGET, name: null, type: 'REPEATER',
    receivedAt: f.clock, hopCount: 2, eventDigest: 'ef'.repeat(32), routeEvidence: {
      hashWidth: 2, pathHashesHex: ['1100', '2200'], flags: 2, advertTimestamp: 0, lat: null, lon: null
    } });
  await f.frame(telemetryInventoryBoundary(2, 1)); await f.frame(telemetryContactFrame());
  await f.frame(telemetryInventoryBoundary(4));
  assert.equal(f.writes.some(w => [26, 50, Constants.CommandCodes.SendTracePath].includes(w.code)), false);
  const completed = f.calls.at(-1).result;
  assert.equal(completed.status, 'deferred'); assert.equal(completed.dispatchedAt, undefined);
  assert.equal(completed.diagnostics.routeFailureReason, 'route-exceeds-radius');
  assert.equal(f.store.queryTelemetryOutcomes({ start: 0, end: 100000 }).total, 0);
});
test('real unsafe admin reply saves auth failure only and blocks subsequent data', async () => {
  const f = rig(); await f.authenticate(login({ admin: 1 })); await f.tick(10000);
  assert.equal(f.store.queryTelemetryAuthenticationOutcomes({ start: 0, end: 100000 }).outcomes[0].record.reason, 'unsafe-login-permissions');
  assert.equal(f.writes.filter(w => [26, 50].includes(w.code)).length, 1); assert.equal(f.store.queryTelemetryOutcomes({ start: 0, end: 100000 }).total, 0);
});
test('real owner cannot grant a session after failed auth commit; local retry persists without RF replay', async () => {
  const f = rig(), original = f.store.completeTelemetryAuthentication.bind(f.store);
  f.store.completeTelemetryAuthentication = () => { throw new Error('PRIVATE-ONLY7'); };
  await f.authenticate(); await f.tick(10000); assert.equal(f.writes.filter(w => [26, 50].includes(w.code)).length, 1);
  f.store.completeTelemetryAuthentication = original; await f.tick(1000);
  assert.equal(f.store.queryTelemetryAuthenticationOutcomes({ start: 0, end: 100000 }).outcomes.length, 1);
  assert.equal(f.writes.filter(w => [26, 50].includes(w.code)).length, 1);
  assert.doesNotMatch(JSON.stringify(f.logger.warn.mock.calls), /PRIVATE-ONLY7/);
});
test('real stop cancels an owned data response, persists stopped result, then drains before close', async () => {
  const f = rig(); await f.authenticate(); await f.tick(10000); await f.frame(telemetryContactFrame());
  const tag = Buffer.from(f.binaryBytes).readUInt32LE(1); await f.frame(ack(tag));
  f.scheduler.stop(); await f.coordinator.stop(); await f.scheduler.drain();
  const outcome = f.store.queryTelemetryOutcomes({ start: 0, end: 100000 }).outcomes[0];
  assert.equal(outcome.reason, 'stopped'); assert.equal(outcome.receivedAt, null);
  assert.equal(f.store.queryTelemetryObservations({ start: 0, end: 100000 }).total, 0);
});
test('real foreground work wins admission while independent capture/local commands remain available', async () => {
  const f = rig(); f.foreground = true; f.scheduler.start(); await f.tick(10000); assert.equal(f.writes.length, 0);
  assert.equal(await f.radio.runCommand(() => 'local-work'), 'local-work');
  let captured = 0; f.radio.on('radio.packet', () => captured++); f.radio.emit('radio.packet', {}); assert.equal(captured, 1);
});

test('real owner keeps the authenticated neighbour query ahead of a dense candidate rotation while enforcing airtime spacing', async () => {
  const f = rig({ neighbours: true });
  for (let i = 0; i < 40; i++) observe(f, (0xD000 + i).toString(16).toUpperCase() + 'EE'.repeat(30));
  await f.authenticate();
  f.foreground = true; await f.tick(1000); f.foreground = false;
  await f.tick(1000);
  assert.deepEqual(f.writes.filter(w => [26, 50].includes(w.code)).map(w => w.code), [26]);
  await f.tick(10000);
  assert.equal(f.writes.at(-1).code, 30); await f.frame(telemetryContactFrame());
  assert.equal(f.writes.at(-1).code, 50); assert.equal(f.binaryBytes[0], 6);
  const tag = Buffer.from(f.binaryBytes).readUInt32LE(1), prefix = 'D000' + 'EE'.repeat(30);
  await f.frame(ack(tag)); await f.frame(binary(tag, neighbourPage([{ prefix, age: 12, snr: 28 }], { prefixLength: 32 })));
  const page = f.store.queryTelemetryObservations({ start: 0, end: 100000, component: 'neighbours' });
  assert.equal(page.total, 1); assert.equal(page.observations[0].targetPublicKey, TARGET);
  assert.equal(page.observations[0].quality, 'decoded');
  assert.deepEqual(page.observations[0].data.entries[0], { order: 0, prefix, heardSecondsAgo: 12, snrQuarterDb: 28, snrDb: 7 });
  const sent = f.writes.filter(w => [26, 50].includes(w.code));
  assert.deepEqual(sent.map(w => w.code), [26, 50]); assert.ok(sent[1].at - sent[0].at >= 10000);
  assert.equal(f.store.queryTelemetryAuthenticationOutcomes({ start: 0, end: 100000 }).outcomes.length, 1);
});
