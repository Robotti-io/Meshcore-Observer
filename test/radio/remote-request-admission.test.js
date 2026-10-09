import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { RemoteRequestBudget } from '../../src/radio/remote-request-budget.js';
import { RemoteRequestCoordinator } from '../../src/radio/remote-request-coordinator.js';
import { AirtimeCoordinator } from '../../src/radio/airtime-coordinator.js';
import { RadioManager } from '../../src/radio/radio-manager.js';
import { createLogger } from '../../src/logging/logger.js';

const active = [];
const request = (operation = 'status', params = {}) => ({ requestId: '12345678-1234-4abc-8def-123456789abc',
  targetPublicKey: 'AC'.repeat(32), operation, params });
const noop = () => {};
const silent = () => ({ info: vi.fn(), warn: vi.fn(), error: noop, debug: noop });
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function sent(tag = 42, route = 0) {
  const bytes = Buffer.alloc(10); bytes[0] = 6; bytes[1] = route; bytes.writeUInt32LE(tag, 2); return [...bytes];
}
function binary(tag = 42, body = [0, 255]) {
  const bytes = Buffer.alloc(6); bytes[0] = 0x8C; bytes.writeUInt32LE(tag, 2); return [...bytes, ...body];
}
async function setup(options = {}) {
  vi.useFakeTimers(); const clock = { value: 0 }; const foreground = { replies: 0, advert: 'idle' };
  const logger = options.logger ?? silent();
  const connections = Array.from({ length: 3 }, () => {
    const conn = new EventEmitter();
    conn.getSelfInfo = async () => ({ publicKey: [...Buffer.from('BE'.repeat(32), 'hex')], name: 'Fixture' });
    conn.getDeviceTime = async () => ({ epochSecs: Math.floor(Date.now() / 1000) });
    conn.deviceQuery = async () => ({}); conn.setDeviceTime = async () => {};
    conn.close = vi.fn(async () => conn.emit('disconnected'));
    conn.sendCommandSendBinaryReq = vi.fn(async () => {}); return conn;
  });
  let opens = 0;
  const radio = new RadioManager({ config: { radio: { reconnect: { maxRetries: 0, initialDelayMs: 10, maxDelayMs: 10 } } },
    logger, openTransport: async () => connections[opens++], closeTimeoutMs: 100 });
  const ready = new Promise(resolve => radio.once('radio.connected', resolve)); radio.start(); await ready;
  const airtime = new AirtimeCoordinator({ quietMs: options.quietMs ?? 5000, now: () => clock.value });
  const coordinator = new RemoteRequestCoordinator({ radio, logger, airtimeCoordinator: airtime,
    hasForegroundWork: () => foreground.replies > 0 || ['pending', 'sending'].includes(foreground.advert),
    ackTimeoutMs: 1000, responseTimeoutMaxMs: 2000, minIntervalMs: 10000, maxPerMinute: 6,
    now: () => clock.value, uniquenessBytes: () => [1, 2, 3, 4], ...options });
  const fixture = { clock, foreground, logger, connections, radio, airtime, coordinator, opens: () => opens,
    tick: async ms => { clock.value += ms; await vi.advanceTimersByTimeAsync(ms); await flush(); } };
  active.push(fixture); return fixture;
}
async function complete(f, tag = 42, dto = request()) {
  const result = f.coordinator.tryRequest(dto); await flush(); const conn = f.connections[f.opens() - 1];
  conn.emit('rx', sent(tag)); await flush(); conn.emit('rx', binary(tag)); await flush(); return result;
}
afterEach(async () => {
  try {
    for (const f of active.splice(0)) {
      const stopped = f.coordinator.stop(); await f.tick(101); await stopped;
      const radioStopped = f.radio.stop().catch(noop); await f.tick(101); await radioStopped;
    }
  } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
});

test('budget delays the first attempt, enforces exact interval/minute boundaries and has no catch-up burst', () => {
  let now = 0; const budget = new RemoteRequestBudget({ now: () => now });
  now = 59999; assert.equal(budget.recordAttempt(), false); now = 60000; assert.equal(budget.recordAttempt(), true);
  assert.equal(budget.recordAttempt(), false); now = 119999; assert.equal(budget.canAttempt(), false);
  now = 120000; assert.equal(budget.recordAttempt(), true);
  now = 10000000; assert.equal(budget.recordAttempt(), true); assert.equal(budget.recordAttempt(), false);
  now += 59999; assert.equal(budget.recordAttempt(), false); now++; assert.equal(budget.recordAttempt(), true);
});

test('sliding minute cap is aggregate and exact, with bounded failure-inclusive attempts', () => {
  let now = 0; const budget = new RemoteRequestBudget({ minIntervalMs: 10000, maxPerMinute: 2, now: () => now });
  now = 10000; assert.equal(budget.recordAttempt(), true); now = 20000; assert.equal(budget.recordAttempt(), true);
  now = 30000; for (let i = 0; i < 100; i++) assert.equal(budget.recordAttempt(), false);
  now = 69999; assert.equal(budget.recordAttempt(), false); now = 70000; assert.equal(budget.recordAttempt(), true);
  now = 79999; assert.equal(budget.recordAttempt(), false); now = 80000; assert.equal(budget.recordAttempt(), true);
});

test('maximum budget remains bounded across many attempts and monotonic rollback cannot grant extra traffic', () => {
  let now = 0; const budget = new RemoteRequestBudget({ minIntervalMs: 10000, maxPerMinute: 6, now: () => now });
  for (let i = 1; i <= 120; i++) { now = i * 10000; assert.equal(budget.recordAttempt(), true); assert.equal(budget.recordAttempt(), false); }
  now = -1; assert.equal(budget.recordAttempt(), false); now = 1209999; assert.equal(budget.recordAttempt(), false);
  now = 1210000; assert.equal(budget.recordAttempt(), true);
});

test('budget and coordinator reject invalid normalized limits before policy/radio activity', async () => {
  for (const opts of [{ minIntervalMs: 9999 }, { minIntervalMs: 3600001 }, { minIntervalMs: '10000' },
    { maxPerMinute: 0 }, { maxPerMinute: 7 }, { maxPerMinute: 1.5 }]) assert.throws(() => new RemoteRequestBudget(opts), /Invalid remote request budget/);
  const f = await setup();
  for (const opts of [{ minIntervalMs: 0 }, { maxPerMinute: 7 }]) assert.throws(() => new RemoteRequestCoordinator({
    radio: f.radio, logger: f.logger, airtimeCoordinator: f.airtime, hasForegroundWork: () => false, ...opts
  }), /Invalid remote request limits/);
  assert.throws(() => new RemoteRequestCoordinator({ radio: f.radio }), /requires shared airtime/);
  assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 0);
});

test('idle construction has no timer/poll or physical send; code defaults wait a full initial interval', async () => {
  const f = await setup({ ackTimeoutMs: undefined, responseTimeoutMaxMs: undefined, minIntervalMs: undefined, maxPerMinute: undefined });
  assert.equal(vi.getTimerCount(), 0); await f.tick(59999);
  assert.equal((await f.coordinator.tryRequest(request())).reason, 'rate-limited'); assert.equal(vi.getTimerCount(), 0);
  await f.tick(1); assert.equal((await complete(f)).status, 'completed');
  assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 1);
});

test('pending bot replies and both pending/sending adverts defer quietly at admission', async () => {
  const f = await setup(); await f.tick(10000);
  for (const state of [{ replies: 1, advert: 'idle' }, { replies: 0, advert: 'pending' }, { replies: 0, advert: 'sending' }]) {
    Object.assign(f.foreground, state);
    for (let i = 0; i < 100; i++) assert.deepEqual(await f.coordinator.tryRequest(request()), { status: 'deferred', reason: 'foreground' });
  }
  assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 0); assert.equal(f.logger.warn.mock.calls.length, 0);
  Object.assign(f.foreground, { replies: 0, advert: 'idle' }); assert.equal((await complete(f)).status, 'completed');
});

test('foreground arriving during shared command wait wins without acquiring airtime or charging budget', async () => {
  for (const state of [{ replies: 1 }, { advert: 'pending' }, { advert: 'sending' }]) {
    const f = await setup(); await f.tick(10000); const block = gate();
    const local = f.radio.runCommand(() => block.promise); await flush();
    const result = f.coordinator.tryRequest(request()); await flush(); assert.equal(f.airtime.canRunWhenQuiet(), true);
    Object.assign(f.foreground, state); block.resolve(); await local; await flush();
    assert.equal((await result).reason, 'foreground'); assert.equal(f.airtime.canRunWhenQuiet(), true);
    assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 0);
    Object.assign(f.foreground, { replies: 0, advert: 'idle' }); assert.equal((await complete(f)).status, 'completed');
  }
});

test('RF or competing reservation during a command wait defers without a remote attempt', async () => {
  const f = await setup(); await f.tick(10000); const block = gate();
  const local = f.radio.runCommand(() => block.promise); await flush(); const result = f.coordinator.tryRequest(request()); await flush();
  f.airtime.noteActivity(); block.resolve(); await local; await flush(); assert.equal((await result).reason, 'quiet-air');
  assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 0); await f.tick(5000);
  const outbound = gate(); const foreground = f.airtime.tryRunWhenQuiet(() => outbound.promise); await flush();
  assert.equal((await f.coordinator.tryRequest(request())).reason, 'quiet-air'); outbound.resolve(); await foreground;
  await f.tick(5000); assert.equal((await complete(f)).status, 'completed');
});

test('queue expiry cancels the unsent callback, with no airtime reservation or budget charge', async () => {
  const f = await setup(); await f.tick(10000); const block = gate();
  const local = f.radio.runCommand(() => block.promise); await flush(); const result = f.coordinator.tryRequest(request()); await flush();
  await f.tick(1000); assert.equal((await result).reason, 'queue-timeout'); assert.equal(f.airtime.canRunWhenQuiet(), true);
  block.resolve(); await local; await flush(); assert.equal((await complete(f)).status, 'completed');
  assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 1);
});

test('stop or newly pending foreground work in the airtime microtask prevents a physical write', async () => {
  for (const stop of [false, true]) {
    const f = await setup({ quietMs: 0 }); await f.tick(10000);
    const original = f.airtime.tryRunWhenQuiet.bind(f.airtime);
    f.airtime.tryRunWhenQuiet = send => original(() => {
      if (stop) f.coordinator.stop(); else f.foreground.replies = 1;
      return send();
    });
    const result = f.coordinator.tryRequest(request()); await flush(); assert.equal((await result).reason, stop ? 'stopped' : 'foreground');
    assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 0); assert.equal(f.airtime.canRunWhenQuiet(), true);
  }
});

test('airtime and command leases end at ACK while remote response ownership continues', async () => {
  const f = await setup({ quietMs: 0 }); await f.tick(10000); const result = f.coordinator.tryRequest(request()); await flush();
  assert.equal(f.airtime.canRunWhenQuiet(), false); assert.equal(f.airtime.tryRunWhenQuiet(async () => {}), null);
  f.connections[0].emit('rx', sent()); await flush(); assert.equal(f.airtime.canRunWhenQuiet(), true);
  assert.equal(await f.radio.runCommand(() => 'local'), 'local');
  assert.equal(await f.airtime.tryRunWhenQuiet(async () => 'foreground-send'), 'foreground-send');
  assert.equal((await f.coordinator.tryRequest(request())).reason, 'busy');
  f.connections[0].emit('rx', binary()); assert.equal((await result).status, 'completed');
});

test('known errors and unexpected flood consume the aggregate minute budget across command types', async () => {
  for (const flood of [false, true]) {
    const f = await setup({ maxPerMinute: 1 }); await f.tick(10000);
    const result = f.coordinator.tryRequest(request(), { expectedRoute: 'direct' }); await flush();
    f.connections[0].emit('rx', flood ? sent(42, 1) : [1, 2]); await flush();
    assert.equal((await result).reason, flood ? 'route-mismatch' : 'command-error'); await f.tick(10000);
    assert.equal((await f.coordinator.tryRequest(request('telemetry', { permissionMask: 1 }))).reason, 'rate-limited');
    await f.tick(49999); assert.equal((await f.coordinator.tryRequest(request())).reason, 'rate-limited');
    await f.tick(1); assert.equal((await complete(f, 43, request('telemetry', { permissionMask: 1 }))).status, 'completed');
  }
});

test('write failure/ACK timeout release airtime on termination and reconnect preserves the attempt budget', async () => {
  for (const timeout of [false, true]) {
    const f = await setup({ quietMs: 0, maxPerMinute: 1 }); await f.tick(10000);
    f.connections[0].sendCommandSendBinaryReq.mockImplementation(() => timeout ? new Promise(noop) : Promise.reject(Error('SECRET')));
    const result = f.coordinator.tryRequest(request()); await flush(); if (timeout) await f.tick(1000);
    assert.equal((await result).reason, timeout ? 'ack-timeout' : 'write-error'); assert.equal(f.airtime.canRunWhenQuiet(), true);
    await f.tick(10); assert.equal(f.opens(), 2); assert.equal((await f.coordinator.tryRequest(request())).reason, 'rate-limited');
    await f.tick(70000 - f.clock.value); assert.equal((await complete(f, 43)).status, 'completed');
  }
});

test('failed unexpected recovery holds airtime until RadioManager actually terminates the generation', async () => {
  const f = await setup({ quietMs: 0 }); await f.tick(10000); let signal;
  await f.radio.runCommand((_, context) => { signal = context.signal; });
  vi.spyOn(f.radio, 'invalidateConnection').mockRejectedValue(Error('SECRET'));
  const result = f.coordinator.tryRequest(request()); await flush(); await f.tick(1000);
  assert.equal((await result).recovery, 'failed'); assert.equal(f.airtime.canRunWhenQuiet(), false);
  await f.radio.stop(); await flush(); assert.equal(f.airtime.canRunWhenQuiet(), true);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('unknown foreground policy fails closed without noisy logs or budget consumption', async () => {
  const f = await setup({ hasForegroundWork: () => { throw Error('SECRET'); } }); await f.tick(10000);
  for (let i = 0; i < 100; i++) assert.equal((await f.coordinator.tryRequest(request())).reason, 'foreground');
  assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 0); assert.equal(f.logger.warn.mock.calls.length, 0);
});

test('all emitted remote logs use allowlisted metadata and exclude payloads, identities and raw exceptions', async () => {
  const lines = []; vi.spyOn(console, 'log').mockImplementation(line => lines.push(JSON.parse(line)));
  vi.spyOn(console, 'error').mockImplementation(line => lines.push(JSON.parse(line)));
  const f = await setup({ logger: createLogger({ level: 'debug' }), quietMs: 0 }); await f.tick(10000);
  const first = f.coordinator.tryRequest(request('telemetry', { permissionMask: 12 })); await flush();
  f.connections[0].emit('rx', sent()); await flush(); f.connections[0].emit('rx', binary(42, [...Buffer.from('PAYLOAD-SECRET')]));
  assert.equal((await first).status, 'completed'); await f.tick(10000);
  f.connections[0].sendCommandSendBinaryReq.mockRejectedValue(Error('SDK-PASSWORD-SECRET'));
  const second = f.coordinator.tryRequest(request()); await flush(); assert.equal((await second).reason, 'write-error');
  const remote = lines.filter(line => line.source === 'services.remoteRequests'); assert.equal(remote.length, 3);
  const allowed = new Set(['requestId', 'operation', 'generation', 'phase', 'outcome', 'route', 'recovery']);
  for (const line of remote) {
    assert.ok(['info', 'warn'].includes(line.level)); assert.equal(line.reqInfo, undefined); assert.ok(line.message);
    assert.equal(line.meta.requestId, request().requestId); for (const key of Object.keys(line.meta)) assert.ok(allowed.has(key));
  }
  const serialized = JSON.stringify(lines); assert.doesNotMatch(serialized, /PAYLOAD-SECRET|SDK-PASSWORD-SECRET|permissionMask/);
  assert.equal(JSON.stringify(remote).includes(request().targetPublicKey), false);
});
