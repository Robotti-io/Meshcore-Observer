import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

const active = [];
async function flush() { for (let n = 0; n < 150; n++) await Promise.resolve(); }
function ack(tag) { const b = Buffer.alloc(10); b[0] = 6; b.writeUInt32LE(tag, 2); b.writeUInt32LE(5000, 6); return [...b]; }
function login({ admin = 0, timestamp = 100 } = {}) { const b = Buffer.alloc(14); b[0] = 0x85; b[1] = admin;
  b.set(Buffer.from(TARGET, 'hex').subarray(0, 6), 2); b.writeUInt32LE(timestamp, 8); b[13] = 2; return [...b]; }
function binary(tag, body) { const b = Buffer.alloc(6 + body.length); b[0] = 0x8C; b.writeUInt32LE(tag, 2); b.set(body, 6); return [...b]; }
function rig({ neighbours = false } = {}) {
  vi.useFakeTimers(); const f = createTelemetryFixture(); active.push(f);
  f.dir = mkdtempSync(join(tmpdir(), 'telemetry-producer-'));
  const policyPath = join(f.dir, 'policy.json'), secretsPath = join(f.dir, 'secrets.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, defaultCredentialRef: 'fixtureGuest',
    components: { status: false, sensors: !neighbours, neighbours } }));
  writeFileSync(secretsPath, JSON.stringify({ version: 1, secrets: { fixtureGuest: 'PRIVATE-ONLY7' } }));
  f.config = loadTelemetryPolling({ settings: { ...TELEMETRY_POLL_DEFAULTS, enabled: true, refreshIntervalMs: 3600000,
    startupDelayMs: 1000, tickIntervalMs: 1000 }, policyPath, secretsPath });
  f.variant = neighbours ? { component: 'neighbours', params: f.config.neighbourParams } : SENSOR;
  f.clock = 10000; f.foreground = false; f.quiet = true; f.writes = [];
  f.logger = { warn: vi.fn(), info: vi.fn() }; f.snapshot = { ready: true, generation: 1, observerPublicKey: OBSERVER };
  f.connection = new EventEmitter(); f.radio = new EventEmitter();
  f.radio.getConnectionSnapshot = () => f.snapshot;
  f.radio.runCommand = async callback => callback(f.connection, { generation: f.snapshot.generation, signal: new AbortController().signal });
  f.radio.invalidateConnection = async () => { f.snapshot = { ...f.snapshot, ready: false }; f.radio.emit('radio.disconnected'); return { status: 'reset' }; };
  f.connection.sendToRadioFrame = async bytes => {
    f.writes.push({ at: f.clock, code: bytes[0] });
    if (bytes[0] === Constants.CommandCodes.SendTracePath) {
      f.connection.emit('rx', telemetryTraceAck(bytes));
      f.connection.emit('rx', telemetryTraceResponse(bytes));
    }
    if (bytes[0] === 26 || bytes[0] === 50) {
      const variant = bytes[0] === 26 ? { component: 'guest-login', params: {} } : f.variant;
      const state = f.store.getTelemetryPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET, variant });
      assert.equal(state.reason, 'reserved'); assert.equal(state.reservedAt, f.clock);
    }
  };
  f.connection.addOrUpdateContact = async () => {};
  f.connection.sendCommandSendBinaryReq = async (_, bytes) => { f.binaryBytes = bytes; await f.connection.sendToRadioFrame([50]); };
  f.coordinator = new RemoteRequestCoordinator({ radio: f.radio, logger: f.logger, now: () => f.clock, wallNow: () => f.clock,
    airtimeCoordinator: { canRunWhenQuiet: () => f.quiet, tryRunWhenQuiet: cb => f.quiet ? Promise.resolve().then(cb) : null },
    hasForegroundWork: () => f.foreground, uniquenessBytes: () => [1, 2, 3, 4], minIntervalMs: 10000, maxPerMinute: 6 });
  f.calls = [];
  for (const method of ['tryGuestLogin', 'tryTelemetryRequest']) {
    const original = f.coordinator[method].bind(f.coordinator);
    f.coordinator[method] = async (...args) => { const result = await original(...args); f.calls.push({ method, result }); return result; };
  }
  observe(f, TARGET);
  f.store.recordVerifiedAdvert({ publicKeyHex: TARGET, name: null, type: 'REPEATER',
    receivedAt: 900, hopCount: 0, eventDigest: 'cd'.repeat(32), routeEvidence: {
      hashWidth: 2, pathHashesHex: [], flags: 2, advertTimestamp: 0, lat: null, lon: null
    } });
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
test('real shared owner, strict raw guest proof and tagged query commit through scheduler owned hooks', async () => {
  const f = rig(); await f.authenticate(); assert.equal(f.store.getTelemetryAuthReplayState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET }).serverTimestamp, 100,
    JSON.stringify([f.calls, f.logger.warn.mock.calls, f.store.queryTelemetryAuthenticationOutcomes({ start: 0, end: 100000 })]));
  assert.equal(f.store.queryTelemetryOutcomes({ start: 0, end: 100000 }).total, 0); await f.data();
  const data = f.store.queryTelemetryOutcomes({ start: 0, end: 100000 }); assert.equal(data.total, 1); assert.equal(data.outcomes[0].status, 'partial');
  assert.equal(data.outcomes[0].observerPublicKey, OBSERVER); assert.equal(data.outcomes[0].targetPublicKey, TARGET);
  assert.ok(f.writes.filter(w => [26, 50].includes(w.code)).every((w, i, arr) => i === 0 || w.at - arr[i - 1].at >= 10000));
  assert.doesNotMatch(JSON.stringify([data, f.logger.warn.mock.calls, f.logger.info.mock.calls]), /PRIVATE-ONLY7|fixtureGuest|PRIVATE-NAME/);
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
