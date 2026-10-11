import { test, afterEach, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { NodeJSSerialConnection, TCPConnection, Constants } from '@liamcottle/meshcore.js';
import { RemoteRequestCoordinator } from '../../src/radio/remote-request-coordinator.js';
import { RadioManager } from '../../src/radio/radio-manager.js';
import { RemoteRequestBudget } from '../../src/radio/remote-request-budget.js';
import { loadTelemetryPolling } from '../../src/telemetry/polling-config.js';
import { TELEMETRY_POLL_DEFAULTS } from '../../src/telemetry/polling-schemas.js';
import { telemetryRadioTarget as target, telemetryRadioOther as other, telemetryContactFrame as contact,
  telemetryInventoryBoundary as boundary } from '../fixtures/telemetry-radio-wire.js';

const observer = 'BE'.repeat(32), secret = 'PRIVATE-ONLY7';
const active = [], root = mkdtempSync(join(tmpdir(), 'meshcore-telemetry-owner-'));
let sequence = 0;
const request = (operation = 'status', key = target) => ({ requestId: '12345678-1234-4abc-8def-' + String(++sequence).padStart(12, '0'),
  targetPublicKey: key, operation, params: operation === 'telemetry' ? { permissionMask: 0 }
    : operation === 'neighbours' ? { version: 0, count: 3, offset: 0, orderBy: 0, prefixLength: 32 } : {} });
const loginRequest = (key = target) => { const { requestId, targetPublicKey } = request('status', key); return { requestId, targetPublicKey }; };
function config(settings = {}) {
  const policyPath = join(root, `policy-${sequence++}.json`), secretsPath = join(root, `secrets-${sequence++}.json`);
  writeFileSync(policyPath, JSON.stringify({ version: 1, defaultCredentialRef: 'testRef' }));
  writeFileSync(secretsPath, JSON.stringify({ version: 1, secrets: { testRef: secret } }));
  return loadTelemetryPolling({ settings: { ...TELEMETRY_POLL_DEFAULTS, enabled: true, ...settings }, policyPath, secretsPath });
}
async function flush() { for (let n = 0; n < 100; n++) await Promise.resolve(); }
function ack(tag = Buffer.from(target, 'hex').readUInt32LE(0), route = 0, estimate = 5000) {
  const frame = Buffer.alloc(10); frame[0] = 6; frame[1] = route; frame.writeUInt32LE(tag, 2); frame.writeUInt32LE(estimate, 6); return [...frame];
}
function login({ key = target, timestamp = 100, admin = 0, permissions = 0, firmware = 2 } = {}) {
  const frame = Buffer.alloc(14); frame[0] = 0x85; frame[1] = admin; frame.set(Buffer.from(key, 'hex').subarray(0, 6), 2);
  frame.writeUInt32LE(timestamp, 8); frame[12] = permissions; frame[13] = firmware; return [...frame];
}
function binary(tag = 42) { const frame = Buffer.alloc(8); frame[0] = 0x8C; frame.writeUInt32LE(tag, 2); return [...frame]; }
async function rig({ kind = 'mock', policy = config(), budget = false, ...options } = {}) {
  vi.useFakeTimers(); const clock = { value: 10000 }, foreground = { value: false }, quiet = { value: true };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, connections = [], writes = [], buffers = [], records = [];
  let reporter = observer;
  const radio = new RadioManager({ config: { radio: { reconnect: { maxRetries: 0, initialDelayMs: 10, maxDelayMs: 10 } } }, logger,
    closeTimeoutMs: 100, openTransport: async () => {
      const c = kind === 'serial' ? new NodeJSSerialConnection('UNUSED') : kind === 'tcp' ? new TCPConnection('unused', 0) : new EventEmitter();
      c.getSelfInfo = async () => ({ publicKey: [...Buffer.from(reporter, 'hex')], name: 'Offline fixture' });
      c.getDeviceTime = async () => ({ epochSecs: Math.floor(Date.now() / 1000) }); c.setDeviceTime = async () => {}; c.deviceQuery = async () => ({});
      c.sendToRadioFrame = vi.fn(async bytes => { writes.push({ at: clock.value, bytes: [...bytes] }); buffers.push(bytes); if (c.fail) throw new Error(secret); });
      if (kind === 'mock') {
        c.close = vi.fn(async () => c.emit('disconnected'));
        c.sendCommandSendBinaryReq = vi.fn(async (key, bytes) => c.sendToRadioFrame([50, ...key, ...bytes]));
      } else if (kind === 'serial') c.serialPort = { close: () => { c.onDisconnected(); return c.serialPort; } };
      else c.socket = { destroy: () => c.onDisconnected() };
      connections.push(c); return c;
    } });
  const ready = new Promise(resolve => radio.once('radio.connected', resolve)); radio.start(); await ready;
  const coordinator = new RemoteRequestCoordinator({ radio, logger,
    airtimeCoordinator: { canRunWhenQuiet: () => quiet.value, tryRunWhenQuiet: callback => quiet.value ? Promise.resolve().then(callback) : null },
    hasForegroundWork: () => foreground.value, now: () => clock.value, wallNow: () => 100000 + clock.value,
    ackTimeoutMs: 1000, responseTimeoutMaxMs: 2000, minIntervalMs: 10000, maxPerMinute: 6,
    uniquenessBytes: () => [1, 2, 3, 4],
    budget: budget === true ? new RemoteRequestBudget({ minIntervalMs: 10000, maxPerMinute: 6, now: () => clock.value - 10000 })
      : budget || { canAttempt: () => true, recordAttempt: () => true }, ...options });
  let highWater = null;
  const hooks = { isEligible: vi.fn(() => true), reserve: vi.fn(() => true), getReplayHighWater: () => highWater,
    recordAuthentication: vi.fn(record => { records.push(record); if (record.proof) highWater = record.proof.serverTimestamp; return true; }) };
  const f = { clock, foreground, quiet, logger, radio, coordinator, connections, writes, buffers, records, policy, hooks,
    setReporter: value => { reporter = value; }, setHighWater: value => { highWater = value; }, current: () => connections.at(-1),
    tick: async ms => { clock.value += ms; await vi.advanceTimersByTimeAsync(ms); await flush(); } };
  active.push(f); return f;
}
async function frame(f, bytes, c = f.current()) {
  if (c instanceof EventEmitter) c.emit('rx', bytes);
  else {
    const data = Buffer.from(bytes), wire = Buffer.concat([Buffer.from([Constants.SerialFrameTypes.Incoming, data.length & 255, data.length >> 8]), data]);
    if (c instanceof TCPConnection) { c.onSocketDataReceived(wire.subarray(0, 2)); c.onSocketDataReceived(wire.subarray(2)); }
    else { await c.onDataReceived(wire.subarray(0, 2)); await c.onDataReceived(wire.subarray(2)); }
  }
  await f.tick(1);
}
async function preflight(f, contacts = [contact()]) {
  await flush(); assert.equal(f.writes.at(-1).bytes[0], 4);
  await frame(f, boundary(2, contacts.length));
  for (const bytes of contacts) await frame(f, bytes);
  await frame(f, boundary(4));
  if (f.writes.at(-1).bytes[0] === 30) await frame(f, contacts.find(bytes => Buffer.from(bytes.slice(1, 33)).toString('hex').toUpperCase() === target));
}
async function authenticated(f, response = login()) {
  const result = f.coordinator.tryGuestLogin(loginRequest(), f.policy, f.hooks);
  await preflight(f); assert.equal(f.writes.at(-1).bytes[0], 26);
  await frame(f, ack()); await frame(f, response); return result;
}
async function data(f, operation = 'status', tag = 42) {
  const result = f.coordinator.tryTelemetryRequest(request(operation), f.policy, f.hooks);
  await flush(); await frame(f, contact()); await frame(f, ack(tag)); await frame(f, binary(tag)); return result;
}
function clean(f) {
  assert.ok(f.radio.listenerCount('radio.connected') <= 1, 'at most one bounded idle session invalidation guard');
  assert.ok(f.radio.listenerCount('radio.disconnected') <= 1, 'at most one bounded idle session invalidation guard');
  const c = f.current(); assert.equal(c instanceof EventEmitter ? c.listenerCount('rx') : (c.eventListenersMap.get('rx') ?? []).length, 0);
}
afterEach(async () => {
  try { for (const f of active.splice(0)) { const stop = f.coordinator.stop(); await f.tick(101); await stop;
    assert.equal(f.radio.listenerCount('radio.connected'), 0); assert.equal(f.radio.listenerCount('radio.disconnected'), 0);
    const closed = f.radio.stop(); await f.tick(101); await closed; assert.equal(vi.getTimerCount(), 0); }
  } finally { vi.useRealTimers(); }
});
afterAll(() => { assert.ok(realpathSync(root).startsWith(realpathSync(tmpdir()) + sep));
  assert.ok(root.includes('meshcore-telemetry-owner-')); rmSync(root, { recursive: true, force: true }); });

for (const kind of ['mock', 'serial', 'tcp']) test(`${kind}: saved guest proof grants bounded original-config authority; local commands proceed after ACK`, async () => {
  const f = await rig({ kind }); const result = f.coordinator.tryGuestLogin(loginRequest(), f.policy, f.hooks);
  await preflight(f); await frame(f, login()); // Early proof is not buffered.
  assert.equal(f.records.length, 0); await frame(f, ack());
  let signal; assert.equal(await f.radio.runCommand((_, context) => { signal = context.signal; return 'local'; }), 'local');
  assert.equal((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).reason, 'guest-session-unavailable');
  await frame(f, login()); const completed = await result;
  assert.equal(completed.status, 'completed'); assert.equal(completed.context.observerPublicKey, observer);
  assert.equal(f.records.length, 1); assert.ok(f.records[0].dispatchedAt < completed.receivedAt);
  assert.equal(f.buffers.find(bytes => bytes[0] === 26), undefined, 'private buffer cleared after ACK');
  assert.deepEqual(f.writes.find(write => write.bytes[0] === 26).bytes.slice(33), [...Buffer.from(secret)]);
  for (const operation of ['status', 'telemetry', 'neighbours']) assert.equal((await data(f, operation, 42 + sequence++)).status, 'completed');
  assert.equal(f.records.length, 1, 'data does not invent more authentication');
  assert.doesNotMatch(JSON.stringify([completed, f.records, f.logger.info.mock.calls, f.logger.warn.mock.calls]), /PRIVATE-ONLY7|testRef|PRIVATE-NAME/);
  assert.equal(getEventListeners(signal, 'abort').length, 0); clean(f);
});

test('strict guest/data contracts and trusted gates reject before policy/radio effects', async () => {
  const f = await rig();
  for (const bad of [{ ...loginRequest(), password: secret }, { ...loginRequest(), operation: 'login' }, { ...loginRequest(), targetPublicKey: 'bad' }])
    await assert.rejects(f.coordinator.tryGuestLogin(bad, f.policy, f.hooks), /Invalid telemetry owner data/);
  for (const params of [{ permissionMask: 1 }, { permissionMask: 0, password: secret }])
    assert.throws(() => f.coordinator.tryTelemetryRequest({ ...request('telemetry'), params }, f.policy, f.hooks), /Invalid telemetry owner data/);
  await assert.rejects(f.coordinator.tryGuestLogin(loginRequest(), f.policy, { ...f.hooks, reserve: null }), /trusted gates/);
  await assert.rejects(f.coordinator.tryGuestLogin(loginRequest(), config({ enabled: false }), f.hooks), /trusted gates/);
  assert.equal((await f.coordinator.tryGuestLogin(loginRequest(), { ...f.policy }, f.hooks)).reason, 'credential-unavailable');
  assert.equal((await f.coordinator.tryGuestLogin(loginRequest('00000000' + 'AC'.repeat(28)), f.policy, f.hooks)).reason, 'unsafe-prefix');
  assert.equal(f.writes.length, 0); assert.equal(f.hooks.isEligible.mock.calls.length, 0);
});

for (const [name, response, reason] of [
  ['admin', login({ admin: 1 }), 'unsafe-login-permissions'], ['readonly', login({ permissions: 1 }), 'unsafe-login-permissions'],
  ['high permission', login({ permissions: 128 }), 'unsafe-login-permissions'], ['unknown protocol', login({ firmware: 3 }), 'unsupported-login-protocol'],
  ['legacy', login().slice(0, 8), 'legacy-login-proof'], ['denial', [0x86, 0, ...Buffer.from(target, 'hex').subarray(0, 6)], 'authentication-denied'],
  ['truncated', login().slice(0, 13), 'invalid-login-frame']
]) test(`${name} proof records a failure and grants no data permission`, async () => {
  const f = await rig(); const result = await authenticated(f, response);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, reason); assert.equal(f.records[0].reason, reason);
  assert.equal((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).reason, 'guest-session-unavailable'); clean(f);
});

for (const value of [100, 101, undefined, Promise.resolve(90)]) test(`known replay or invalid high-water ${String(value)} cannot create authority`, async () => {
  const f = await rig(); f.setHighWater(value); const result = await authenticated(f);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, typeof value === 'number' ? 'auth-replay' : 'auth-state-unavailable');
  assert.equal((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).reason, 'guest-session-unavailable');
});

for (const value of [false, Promise.resolve(true), 'throw']) test(`authentication save ${String(value)} denies reuse without exposing callback errors`, async () => {
  const f = await rig(); f.hooks.recordAuthentication = () => { if (value === 'throw') throw new Error(secret); return value; };
  assert.equal((await authenticated(f)).reason, 'auth-persistence');
  assert.equal((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).reason, 'guest-session-unavailable');
  assert.doesNotMatch(JSON.stringify(f.logger.warn.mock.calls), /PRIVATE-ONLY7/);
});

test('foreign and duplicate replies, retired prefix quarantine and expiry cannot resurrect a session', async () => {
  const f = await rig({ policy: config({ sessionTtlMs: 60000 }) });
  const pending = f.coordinator.tryGuestLogin(loginRequest(), f.policy, f.hooks); await preflight(f); await frame(f, ack());
  await frame(f, login({ key: other })); assert.equal(f.records.length, 0); await frame(f, login()); assert.equal((await pending).status, 'completed');
  await frame(f, login()); assert.equal(f.records.length, 1);
  assert.equal((await f.coordinator.tryGuestLogin(loginRequest(), f.policy, f.hooks)).reason, 'login-quarantined');
  assert.equal((await f.coordinator.tryTelemetryRequest(request(), { ...f.policy }, f.hooks)).reason, 'guest-session-unavailable');
  await f.tick(60000); assert.equal((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).reason, 'guest-session-unavailable');
  await f.tick(3000); assert.equal((await authenticated(f, login({ timestamp: 99 }))).reason, 'auth-replay'); clean(f);
});

for (const change of ['foreground', 'quiet', 'eligibility', 'reservation', 'reporter', 'generation']) test(`${change} at the physical boundary prevents login`, async () => {
  const f = await rig(); const pending = f.coordinator.tryGuestLogin(loginRequest(), f.policy, f.hooks);
  await flush(); await frame(f, boundary(2, 1)); await frame(f, contact()); await frame(f, boundary(4));
  if (change === 'foreground') f.foreground.value = true;
  if (change === 'quiet') f.quiet.value = false;
  if (change === 'eligibility') f.hooks.isEligible.mockReturnValue(false);
  if (change === 'reservation') f.hooks.reserve.mockReturnValue(Promise.resolve(true));
  if (change === 'reporter' || change === 'generation') {
    const original = f.radio.getConnectionSnapshot.bind(f.radio);
    vi.spyOn(f.radio, 'getConnectionSnapshot').mockImplementation(() => ({ ...original(),
      ...(change === 'reporter' ? { observerPublicKey: other } : { generation: 99 }) }));
  }
  await frame(f, contact()); assert.notEqual((await pending).status, 'completed');
  assert.equal(f.writes.filter(write => write.bytes[0] === 26).length, 0); assert.equal(f.records.length, 0);
});

test('prefix collisions and incomplete lists recover untagged ownership without consuming RF budget', async () => {
  const recordAttempt = vi.fn(() => true), f = await rig({ budget: { canAttempt: () => true, recordAttempt } });
  const pending = f.coordinator.tryGuestLogin(loginRequest(), f.policy, f.hooks); await flush();
  await frame(f, boundary(2, 2)); await frame(f, contact());
  await frame(f, contact({ key: target.slice(0, 8) + 'E2'.repeat(28), type: 1 }));
  assert.equal((await pending).reason, 'login-prefix-collision'); assert.equal(recordAttempt.mock.calls.length, 0);
  assert.equal(f.writes.filter(write => write.bytes[0] === 26).length, 0);
});

for (const phase of ['inventory', 'contact', 'ack', 'response']) test(`stop during ${phase} drains the captured owner and revokes authority`, async () => {
  const f = await rig(); const pending = f.coordinator.tryGuestLogin(loginRequest(), f.policy, f.hooks); await flush();
  if (phase !== 'inventory') {
    await frame(f, boundary(2, 1)); await frame(f, contact()); await frame(f, boundary(4));
    if (phase !== 'contact') await frame(f, contact());
    if (phase === 'response') await frame(f, ack());
  }
  await f.coordinator.stop(); const result = await pending; assert.equal(result.reason, 'stopped');
  assert.equal(f.records.length, ['ack', 'response'].includes(phase) ? 1 : 0); clean(f);
});

for (const broken of ['silent inventory', 'silent ACK', 'silent proof', 'flood ACK', 'wrong ACK', 'write']) test(`${broken} has bounded cleanup, safe failure and no session`, async () => {
  const f = await rig(); const pending = f.coordinator.tryGuestLogin(loginRequest(), f.policy, f.hooks); await flush();
  if (broken === 'silent inventory') await f.tick(5000);
  else {
    if (broken === 'write') f.current().fail = true;
    await preflight(f);
    if (broken === 'silent ACK') await f.tick(1000);
    if (broken === 'silent proof') { await frame(f, ack(0x030201AC, 0, 0xFFFFFFFF)); await f.tick(2000); }
    if (broken === 'flood ACK') await frame(f, ack(0x030201AC, 1));
    if (broken === 'wrong ACK') await frame(f, ack(99));
  }
  assert.equal((await pending).status, 'failed');
  assert.notEqual((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).status, 'completed');
  assert.doesNotMatch(JSON.stringify(f.logger.warn.mock.calls), /PRIVATE-ONLY7/); clean(f);
});

test('guest and data use one shared physical budget; local preflight does not consume it', async () => {
  const f = await rig({ budget: true }); await f.tick(10000);
  assert.equal((await authenticated(f)).status, 'completed');
  const count = f.writes.length;
  assert.equal((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).reason, 'rate-limited'); assert.equal(f.writes.length, count);
  await f.tick(10000); assert.equal((await data(f)).status, 'completed');
  assert.equal(f.writes.filter(write => [26, 50].includes(write.bytes[0])).length, 2);
});

test('changed contact route and known contact mutation deny data and invalidate guest reuse', async () => {
  const f = await rig(); await authenticated(f);
  const pending = f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks); await flush();
  await frame(f, contact({ encodedPathLength: 255 })); assert.equal((await pending).reason, 'unknown-contact-route');
  assert.equal((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).reason, 'guest-session-unavailable');
});

test('retained old-generation frames cannot resolve a new owner; sessions do not survive disconnect', async () => {
  const f = await rig(); await authenticated(f); const old = f.current();
  old.emit('disconnected'); await flush();
  assert.notEqual((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).status, 'completed');
  await frame(f, login({ timestamp: 200 }), old); assert.equal(f.records.length, 1);
});

for (const kind of ['serial', 'tcp']) test(`${kind}: continuous region/telemetry demand alternates physical sends under one budget`, async () => {
  const f = await rig({ kind, budget: true }); await f.tick(10000);
  f.coordinator.noteBackgroundDemand({ source: 'regions' });
  assert.equal((await authenticated(f)).status, 'completed');
  for (let n = 0; n < 10; n++) {
    await f.tick(10000); f.coordinator.noteBackgroundDemand({ source: 'regions' });
    assert.equal((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).reason, 'background-turn');
    await flush(); // The shared queue callback tombstone drains after completion.
    const pending = f.coordinator.tryRequest(request('anonymous-regions'), {}, () => true, () => true);
    await flush(); await frame(f, contact()); await frame(f, ack(1000 + n)); await frame(f, binary(1000 + n));
    const region = await pending; assert.equal(region.status, 'completed', JSON.stringify(region));
    await f.tick(10000); f.coordinator.noteBackgroundDemand({ source: 'regions' });
    assert.equal((await data(f, 'status', 2000 + n)).status, 'completed');
  }
  const physical = f.writes.filter(write => [26, 50, 57].includes(write.bytes[0]));
  assert.deepEqual(physical.map(write => write.bytes[0]), [26, ...Array.from({ length: 10 }, () => [57, 50]).flat()]);
  for (let n = 1; n < physical.length; n++) assert.ok(physical[n].at - physical[n - 1].at >= 10000);
  f.foreground.value = true; await f.tick(10000);
  assert.equal((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).reason, 'foreground');
  assert.equal(f.writes.filter(write => [26, 50, 57].includes(write.bytes[0])).length, 21); clean(f);
});

test('contact mutation while awaiting guest proof retires authority and ownership', async () => {
  const f = await rig(); const pending = f.coordinator.tryGuestLogin(loginRequest(), f.policy, f.hooks);
  await preflight(f); await frame(f, ack()); await frame(f, [0x8A]);
  assert.equal((await pending).reason, 'contacts-changed'); await frame(f, login()); assert.equal(f.records.length, 1);
  assert.equal((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).reason, 'guest-session-unavailable'); clean(f);
});

test('reservation callback cannot change eligibility and still permit RF', async () => {
  const f = await rig(); f.hooks.reserve.mockImplementation(() => { f.hooks.isEligible.mockReturnValue(false); return true; });
  const pending = f.coordinator.tryGuestLogin(loginRequest(), f.policy, f.hooks); await preflight(f);
  assert.equal((await pending).reason, 'ineligible'); assert.equal(f.writes.filter(write => write.bytes[0] === 26).length, 0);
});

test('late inventory write rejection cannot invalidate its completed proof or the following exact-key read', async () => {
  const f = await rig(); let reject;
  f.current().sendToRadioFrame.mockImplementationOnce(bytes => { f.writes.push({ at: f.clock.value, bytes: [...bytes] }); return new Promise((_, fail) => { reject = fail; }); });
  const pending = f.coordinator.tryGuestLogin(loginRequest(), f.policy, f.hooks); await flush();
  await frame(f, boundary(2, 1)); await frame(f, contact()); await frame(f, boundary(4));
  reject(new Error(secret)); await flush(); await frame(f, contact()); await frame(f, ack()); await frame(f, login());
  assert.equal((await pending).status, 'completed'); clean(f);
});

test('server proof cannot grant authority when captured local completion time goes backwards', async () => {
  let wall = 100000; const f = await rig({ wallNow: () => wall });
  const pending = f.coordinator.tryGuestLogin(loginRequest(), f.policy, f.hooks); await preflight(f); await frame(f, ack());
  wall--; await frame(f, login()); assert.equal((await pending).reason, 'clock-anomaly');
  assert.equal(f.records[0].reason, 'clock-anomaly');
  assert.equal((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).reason, 'guest-session-unavailable');
});

test('rejected async replay-state callbacks are observed safely and cannot authorize data', async () => {
  const f = await rig(); f.hooks.getReplayHighWater = () => Promise.reject(new Error(secret));
  assert.equal((await authenticated(f)).reason, 'auth-state-unavailable');
  assert.doesNotMatch(JSON.stringify(f.logger.warn.mock.calls), /PRIVATE-ONLY7/);
  assert.equal((await f.coordinator.tryTelemetryRequest(request(), f.policy, f.hooks)).reason, 'guest-session-unavailable');
});
