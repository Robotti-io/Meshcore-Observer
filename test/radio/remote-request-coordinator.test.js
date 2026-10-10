import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { Connection } from '@liamcottle/meshcore.js';
import { RemoteRequestCoordinator } from '../../src/radio/remote-request-coordinator.js';
import { RadioManager } from '../../src/radio/radio-manager.js';
import { prepareRegionContactRead } from '../../src/regions/region-radio-adapter.js';

// T3 ownership tests isolate admission. T4 exercises the real shared airtime
// and bounded attempt policy in remote-request-admission.test.js.
const ownershipControls = {
  airtimeCoordinator: { canRunWhenQuiet: () => true, tryRunWhenQuiet: send => Promise.resolve().then(send) },
  hasForegroundWork: () => false,
  budget: { canAttempt: () => true, recordAttempt: () => true },
  logger: { info: () => {}, warn: () => {} }
};
const fixtures = [];
const target = 'AC'.repeat(32);
const observer = 'BE'.repeat(32);
const request = (operation = 'status', params = {}) => ({
  requestId: '12345678-1234-4abc-8def-123456789abc', targetPublicKey: target, operation, params
});
const limits = { ackTimeoutMs: 1000, responseTimeoutMaxMs: 2000 };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function sent(tag = 42, estimate = 100, route = 0) {
  const buffer = Buffer.alloc(10); buffer[0] = 6; buffer[1] = route;
  buffer.writeUInt32LE(tag, 2); buffer.writeUInt32LE(estimate, 6);
  return [...buffer];
}
function binary(tag = 42, body = [0, 255], reserved = 0) {
  const buffer = Buffer.alloc(6); buffer[0] = 0x8C; buffer[1] = reserved; buffer.writeUInt32LE(tag, 2);
  return [...buffer, ...body];
}
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
async function tick(ms) {
  for (const fixture of fixtures) fixture.clock.value += ms;
  await vi.advanceTimersByTimeAsync(ms); await flush();
}
function connection(sdk = false) {
  const conn = sdk ? new Connection() : new EventEmitter();
  conn.getSelfInfo = async () => ({ publicKey: [...Buffer.from(observer, 'hex')], name: 'Fixture', radioFreq: 915 });
  conn.getDeviceTime = async () => ({ epochSecs: Math.floor(Date.now() / 1000) });
  conn.setDeviceTime = async () => {};
  conn.deviceQuery = async () => ({});
  conn.close = vi.fn(async () => conn.emit('disconnected'));
  if (sdk) {
    conn.sendToRadioFrame = vi.fn(async () => {});
    vi.spyOn(conn, 'sendCommandSendBinaryReq');
  } else conn.sendCommandSendBinaryReq = vi.fn(async () => {});
  return conn;
}
async function setup({ sdk = false, ...options } = {}) {
  vi.useFakeTimers();
  const connections = [connection(sdk), connection(sdk)];
  let opens = 0;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const radio = new RadioManager({ config: { radio: { reconnect: { maxRetries: 0, initialDelayMs: 10, maxDelayMs: 10 } } },
    logger, closeTimeoutMs: 100, openTransport: async () => connections[opens++] });
  const ready = new Promise(resolve => radio.once('radio.connected', resolve));
  radio.start(); await ready;
  assert.equal(radio.getConnectionSnapshot().ready, true);
  const clock = { value: 0 };
  const coordinator = new RemoteRequestCoordinator({ ...ownershipControls, radio, logger, ...limits, now: () => clock.value,
    uniquenessBytes: () => [1, 2, 3, 4], ...options });
  const fixture = { radio, coordinator, connections, logger, clock, opens: () => opens };
  fixtures.push(fixture);
  return fixture;
}
async function emit(conn, bytes, sdk = false) { conn.emit('rx', bytes); await flush(); if (sdk || conn.eventListenersMap) await tick(1); }
function rxCount(conn) { return conn.eventListenersMap ? (conn.eventListenersMap.get('rx') ?? []).length : conn.listenerCount('rx'); }
function contact(path = 0, key = target) {
  const bytes = Array(148).fill(0); bytes[0] = 3;
  bytes.splice(1, 32, ...Buffer.from(key, 'hex')); bytes[33] = 2; bytes[35] = path;
  return bytes;
}
const regionRequest = (f, eligible = () => true, reserve = () => true) =>
  f.coordinator.tryRequest(request('anonymous-regions'), {}, eligible, reserve);
function clean(fixture) {
  assert.equal(rxCount(fixture.connections[0]), 0);
  assert.equal(fixture.radio.listenerCount('radio.connected'), 0);
  assert.equal(fixture.radio.listenerCount('radio.disconnected'), 0);
}
afterEach(async () => {
  try {
    for (const fixture of fixtures.splice(0)) {
      const stopped = fixture.coordinator.stop(); await tick(101); await stopped;
      const closed = fixture.radio.stop(); const observed = closed.catch(() => {}); await tick(101); await observed;
    }
  } finally { vi.useRealTimers(); }
});

test('one lease outlives Sent, releases the command queue and returns truthful bounded context', async () => {
  const f = await setup(); const conn = f.connections[0];
  const unrelated = vi.fn(); conn.on('rx', unrelated);
  const descriptor = request();
  const result = f.coordinator.tryRequest(descriptor);
  descriptor.targetPublicKey = 'FF'.repeat(32); descriptor.params.extra = true;
  assert.deepEqual(await f.coordinator.tryRequest(request()), { status: 'deferred', reason: 'busy' });
  await flush();
  assert.deepEqual(conn.sendCommandSendBinaryReq.mock.calls[0], [[...Buffer.from(target, 'hex')], [1, 0, 0, 0, 0, 1, 2, 3, 4]]);
  await emit(conn, binary()); // No pre-ACK buffering.
  await emit(conn, [0]); await emit(conn, sent());
  const local = vi.fn(() => 'local-command');
  assert.equal(await f.radio.runCommand(local), 'local-command');
  assert.deepEqual(await f.coordinator.tryRequest(request('telemetry', { permissionMask: 1 })), { status: 'deferred', reason: 'busy' });
  await emit(conn, [1, 2]); await emit(conn, sent(900)); await emit(conn, binary(99));
  const bytes = binary(); await emit(conn, bytes); bytes[6] = 123;
  assert.deepEqual(await result, { status: 'completed', context: {
    requestId: request().requestId, targetPublicKey: target, operation: 'status', params: {},
    generation: 1, observerPublicKey: observer.toLowerCase()
  }, tag: 42, route: 'direct', body: [0, 255], provenance: 'companion-tag-attributed' });
  assert.equal(rxCount(conn), 1); conn.off('rx', unrelated); clean(f);
  assert.equal(conn.close.mock.calls.length, 0); assert.equal(vi.getTimerCount(), 0);
});

test('strict admission rejects invalid DTO/options/generated bytes before policy or radio effects', async () => {
  const f = await setup(); const predicate = vi.fn(() => true);
  for (const dto of [{ ...request(), credential: 'NEVER-LOG' }, { ...request(), targetPublicKey: 'bad' }, request('login'), request('telemetry')]) {
    assert.throws(() => f.coordinator.tryRequest(dto, {}, predicate), /Invalid remote request/);
  }
  assert.throws(() => f.coordinator.tryRequest(request(), { expectedRoute: 'zero-hop' }), /Invalid remote dispatch/);
  assert.throws(() => f.coordinator.tryRequest(request(), { password: 'NEVER-LOG' }), /Invalid remote dispatch/);
  const invalid = new RemoteRequestCoordinator({ ...ownershipControls, radio: f.radio, ...limits, uniquenessBytes: () => [1, '2', 3, 4] });
  assert.throws(() => invalid.tryRequest(request()), /Invalid remote request uniqueness/);
  assert.equal(predicate.mock.calls.length, 0); assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 0);
  clean(f); assert.equal(vi.getTimerCount(), 0);
  for (const opts of [{ ackTimeoutMs: 999 }, { ackTimeoutMs: 30001 }, { responseTimeoutMaxMs: 999 },
    { responseTimeoutMaxMs: 120001 }, { ackTimeoutMs: '1000' }, { ackTimeoutMs: 1000.5 }]) {
    assert.throws(() => new RemoteRequestCoordinator({ ...ownershipControls, radio: f.radio, ...limits, ...opts }), /Invalid remote request limits/);
  }
});

test('anonymous preflight holds the command transaction, reserves once before RF and timestamps the matched event', async () => {
  let wall = 1000;
  const recorded = vi.fn(() => true), reserved = vi.fn(() => true), unique = vi.fn();
  const airtime = vi.fn(send => Promise.resolve().then(send));
  const f = await setup({ sdk: true, wallNow: () => wall, uniquenessBytes: unique,
    budget: { canAttempt: () => true, recordAttempt: recorded },
    airtimeCoordinator: { canRunWhenQuiet: () => true, tryRunWhenQuiet: airtime } });
  const conn = f.connections[0], eligible = vi.fn(() => true);
  const result = regionRequest(f, eligible, reserved); await flush();
  assert.deepEqual(conn.sendToRadioFrame.mock.calls.map(([bytes]) => bytes), [[0x1E, ...Buffer.from(target, 'hex')]]);
  assert.equal(airtime.mock.calls.length, 0); assert.equal(recorded.mock.calls.length, 0);
  assert.equal((await regionRequest(f)).reason, 'busy');
  const local = vi.fn(() => 'local'); const waiting = f.radio.runCommand(local); await flush();
  assert.equal(local.mock.calls.length, 0);
  await emit(conn, contact(0, 'FF'.repeat(32))); await emit(conn, binary());
  assert.equal(reserved.mock.calls.length, 0);
  wall = 2000; await emit(conn, contact());
  assert.equal(eligible.mock.calls.length, 2); assert.equal(reserved.mock.calls.length, 1);
  assert.equal(Object.isFrozen(reserved.mock.calls[0][0]), true);
  assert.equal(reserved.mock.calls[0][0].observerPublicKey, observer);
  assert.equal(recorded.mock.calls.length, 1); assert.equal(unique.mock.calls.length, 0);
  assert.deepEqual(conn.sendToRadioFrame.mock.calls[1][0], [0x39, ...Buffer.from(target, 'hex'), 1, 0]);
  await emit(conn, binary()); assert.equal(local.mock.calls.length, 0);
  await emit(conn, sent()); assert.equal(await waiting, 'local');
  assert.equal((await regionRequest(f)).reason, 'busy');
  const read = f.radio.runCommand(connection => connection.sendToRadioFrame(prepareRegionContactRead({ targetPublicKey: target })));
  await read; await emit(conn, contact()); await emit(conn, [1, 2]); await emit(conn, binary(99));
  wall = 3000; await emit(conn, binary()); wall = 9000; await flush();
  const outcome = await result;
  assert.equal(outcome.status, 'completed'); assert.equal(outcome.dispatchedAt, 2000); assert.equal(outcome.receivedAt, 3000);
  assert.deepEqual(outcome.body, [0, 255]); clean(f);
  assert.ok(conn.sendToRadioFrame.mock.calls.every(([bytes]) => [0x1E, 0x39].includes(bytes[0])));
});

for (const [error, reason] of [[1, 'preflight-unsupported'], [2, 'contact-missing'], [3, 'preflight-failed']]) {
  test('anonymous contact Err ' + error + ' never sends RF or mutates contacts', async () => {
    const reserve = vi.fn(() => true), record = vi.fn(() => true);
    const f = await setup({ sdk: true, budget: { canAttempt: () => true, recordAttempt: record } });
    const result = regionRequest(f, () => true, reserve); await flush(); await emit(f.connections[0], [1, error]);
    assert.equal((await result).reason, reason); assert.equal(reserve.mock.calls.length, 0); assert.equal(record.mock.calls.length, 0);
    assert.equal(f.connections[0].sendToRadioFrame.mock.calls.length, 1); clean(f);
    if (error === 1) {
      const warnings = f.logger.warn.mock.calls.length;
      assert.equal((await regionRequest(f)).reason, 'preflight-paused');
      assert.equal(f.logger.warn.mock.calls.length, warnings, 'unsupported generation warns only once');
    }
  });
}
for (const path of [1, 0xFF, 0x40]) test('anonymous nonzero or encoded contact path ' + path + ' defers without RF', async () => {
  const f = await setup({ sdk: true }); const result = regionRequest(f); await flush(); await emit(f.connections[0], contact(path));
  assert.equal((await result).reason, 'unsafe-route'); assert.equal(f.connections[0].sendToRadioFrame.mock.calls.length, 1);
  assert.equal(f.connections[0].close.mock.calls.length, 0); clean(f);
});

test('anonymous missing callbacks, flood option and invalid preflight deadline reject before side effects', async () => {
  const f = await setup({ sdk: true });
  assert.equal((await f.coordinator.tryRequest(request('anonymous-regions'))).reason, 'reservation-unavailable');
  assert.throws(() => f.coordinator.tryRequest(request('anonymous-regions'), { expectedRoute: 'flood' }, () => true, () => true), /direct route/);
  for (const preflightTimeoutMs of [0, 999, 30001, 1000.5, '5000']) {
    assert.throws(() => new RemoteRequestCoordinator({ ...ownershipControls, radio: f.radio, preflightTimeoutMs }), /preflight limits/);
  }
  assert.equal(f.connections[0].sendToRadioFrame.mock.calls.length, 0); clean(f);
});

for (const mode of ['false', 'throw', 'promise', 'priority', 'stopped', 'expired']) test('anonymous final reservation ' + mode + ' prevents RF', async () => {
  let foreground = false;
  const f = await setup({ sdk: true, hasForegroundWork: () => foreground });
  const reserve = () => {
    if (mode === 'false') return false;
    if (mode === 'throw') throw Error('SECRET');
    if (mode === 'promise') return Promise.reject(Error('SECRET'));
    if (mode === 'priority') foreground = true;
    if (mode === 'stopped') f.coordinator.stop();
    if (mode === 'expired') f.clock.value = 1001;
    return true;
  };
  const result = regionRequest(f, () => true, reserve); await flush(); await emit(f.connections[0], contact());
  const outcome = await result; assert.notEqual(outcome.status, 'completed'); assert.equal(outcome.dispatchedAt, undefined);
  assert.equal(f.connections[0].sendToRadioFrame.mock.calls.length, 1); assert.equal(f.connections[0].close.mock.calls.length, 0);
  assert.equal(JSON.stringify(f.logger.warn.mock.calls).includes('SECRET'), false); clean(f);
});

for (const mode of ['eligibility', 'foreground', 'airtime']) test('anonymous ' + mode + ' changing during preflight prevents RF', async () => {
  let permit = true, foreground = false, quiet = true;
  const reserve = vi.fn(() => true);
  const f = await setup({ sdk: true, hasForegroundWork: () => foreground,
    airtimeCoordinator: { canRunWhenQuiet: () => quiet, tryRunWhenQuiet: send => quiet ? Promise.resolve().then(send) : null } });
  const result = regionRequest(f, () => permit, reserve); await flush();
  if (mode === 'eligibility') permit = false;
  if (mode === 'foreground') foreground = true;
  if (mode === 'airtime') quiet = false;
  await emit(f.connections[0], contact());
  assert.equal((await result).status, 'deferred'); assert.equal(reserve.mock.calls.length, 0);
  assert.equal(f.connections[0].sendToRadioFrame.mock.calls.length, 1); clean(f);
});

for (const mode of ['timeout', 'write', 'throw', 'malformed-contact', 'malformed-err', 'stop']) {
  test('anonymous uncertain contact ' + mode + ' retires the captured generation before queue reuse', async () => {
    const f = await setup({ sdk: true, preflightTimeoutMs: 1000 }); const conn = f.connections[0];
    if (mode === 'write') conn.sendToRadioFrame.mockRejectedValue(Error('SECRET'));
    if (mode === 'throw') conn.sendToRadioFrame.mockImplementation(() => { throw Error('SECRET'); });
    const result = regionRequest(f); await flush();
    if (mode === 'timeout') await tick(1000);
    if (mode === 'malformed-contact') await emit(conn, contact().slice(0, -1));
    if (mode === 'malformed-err') await emit(conn, [1]);
    if (mode === 'stop') f.coordinator.stop();
    await tick(1);
    assert.equal((await result).status, 'failed'); assert.equal((await result).recovery, 'reset');
    assert.equal(conn.close.mock.calls.length, 1); assert.equal(conn.sendToRadioFrame.mock.calls.length, 1);
    const warnings = JSON.stringify(f.logger.warn.mock.calls);
    assert.ok(warnings.includes('Capture may pause')); assert.equal(warnings.includes('SECRET'), false); clean(f);
    await tick(10); conn.emit('rx', contact()); conn.emit('rx', [1, 2]);
    if (mode !== 'stop') {
      const next = regionRequest(f); await flush(); await emit(f.connections[1], [1, 2]);
      assert.equal((await next).reason, 'contact-missing', 'replacement generation can preflight again');
    }
  });
}

test('anonymous authoritative Contact ignores a late preflight write rejection during RF ACK', async () => {
  const f = await setup({ sdk: true }); const conn = f.connections[0], write = deferred();
  conn.sendToRadioFrame.mockImplementationOnce(() => write.promise);
  const result = regionRequest(f); await flush(); await emit(conn, contact());
  write.reject(Error('SECRET')); await flush(); assert.equal(conn.close.mock.calls.length, 0);
  await emit(conn, sent()); await emit(conn, binary()); assert.equal((await result).status, 'completed'); clean(f);
});

test('anonymous disconnect during preflight cleans listeners and ignores retired contact events', async () => {
  const f = await setup({ sdk: true }); const result = regionRequest(f); await flush();
  f.connections[0].emit('disconnected'); await tick(1); assert.equal((await result).reason, 'disconnected'); clean(f);
  await tick(10); const next = regionRequest(f); await flush();
  await emit(f.connections[0], contact()); assert.equal(f.connections[1].sendToRadioFrame.mock.calls.length, 1);
  await emit(f.connections[1], [1, 2]); assert.equal((await next).reason, 'contact-missing'); clean(f);
});

test('anonymous ACK, flood, retired tag and response deadlines retain the shared terminal policy', async () => {
  const f = await setup({ sdk: true, preflightTimeoutMs: 1000 });
  for (const [index, mode] of ['success', 'retired', 'flood', 'response', 'ack'].entries()) {
    const result = regionRequest(f); await flush(); const conn = f.radio.getConnectionSnapshot().connection ?? f.connections[0];
    await emit(conn, contact()); await emit(conn, binary(42));
    if (mode === 'ack') { await tick(1000); await tick(1); }
    else {
      await emit(conn, sent(index <= 1 ? 42 : 42 + index, 100, mode === 'flood' ? 1 : 0));
      if (mode === 'success') await emit(conn, binary(42));
      if (mode === 'response') await tick(1100);
    }
    assert.equal((await result).reason ?? 'success', {
      success: 'success', retired: 'retired-tag', flood: 'route-mismatch', response: 'response-timeout', ack: 'ack-timeout'
    }[mode]); clean(f); await flush();
  }
});

test('anonymous queue expiry leaves one unsent tombstone and no local contact read', async () => {
  const f = await setup({ sdk: true }); let release;
  const held = f.radio.runCommand(() => new Promise(resolve => { release = resolve; })); await flush();
  const result = regionRequest(f); await flush(); await tick(1000);
  assert.equal((await result).reason, 'queue-timeout'); assert.equal((await regionRequest(f)).reason, 'busy');
  assert.equal(f.connections[0].sendToRadioFrame.mock.calls.length, 0);
  release(); await held; await flush(); clean(f);
});

test('anonymous failed preflight recovery holds uncertain queue ownership fail-closed', async () => {
  const f = await setup({ sdk: true, preflightTimeoutMs: 1000 });
  const invalidate = vi.spyOn(f.radio, 'invalidateConnection').mockRejectedValue(Error('SECRET'));
  const result = regionRequest(f); await flush(); await tick(1000);
  assert.equal((await result).recovery, 'failed'); assert.equal((await regionRequest(f)).reason, 'recovery-failed');
  const local = vi.fn(); const waiting = f.radio.runCommand(local).catch(e => e.code); await flush();
  assert.equal(local.mock.calls.length, 0);
  const stopping = f.radio.stop(); await tick(1); await stopping; assert.equal(await waiting, 'stopped');
  invalidate.mockRestore(); clean(f);
});

test('anonymous read closure failure is bounded and blocks all subsequent requests', async () => {
  const f = await setup({ sdk: true, preflightTimeoutMs: 1000 }); const conn = f.connections[0];
  conn.close.mockImplementation(() => new Promise(() => {}));
  const result = regionRequest(f); await flush(); await tick(1000);
  assert.equal((await regionRequest(f)).reason, 'busy'); await tick(100);
  assert.equal((await result).recovery, 'close-timeout');
  assert.equal((await regionRequest(f)).reason, 'recovery-failed');
  assert.equal((await f.coordinator.tryRequest(request())).reason, 'recovery-failed'); clean(f);
});

test('anonymous requests without a trusted reservation hook have no eligibility, byte generation or connection effects', async () => {
  const f = await setup(); const predicate = vi.fn();
  const bytes = vi.fn(); const c = new RemoteRequestCoordinator({ ...ownershipControls, radio: f.radio, ...limits, uniquenessBytes: bytes });
  assert.deepEqual(await c.tryRequest(request('anonymous-regions'), {}, predicate), { status: 'deferred', reason: 'reservation-unavailable' });
  assert.equal(bytes.mock.calls.length, 0); assert.equal(predicate.mock.calls.length, 0); clean(f);
});

test('disconnected, not-ready and ineligible admission defers without queued work', async () => {
  const f = await setup();
  assert.deepEqual(await f.coordinator.tryRequest(request(), {}, () => false), { status: 'deferred', reason: 'ineligible' });
  const stub = new EventEmitter(); stub.getConnectionSnapshot = () => ({ generation: null, ready: false });
  const c = new RemoteRequestCoordinator({ ...ownershipControls, radio: stub, ...limits });
  assert.deepEqual(await c.tryRequest(request()), { status: 'deferred', reason: 'disconnected' });
  stub.getConnectionSnapshot = () => ({ generation: 1, ready: false });
  assert.deepEqual(await c.tryRequest(request()), { status: 'deferred', reason: 'not-ready' });
  clean(f); assert.equal(vi.getTimerCount(), 0);
});

test('eligibility is checked again after queue wait and its exceptions stay safe', async () => {
  const f = await setup(); const blocker = deferred();
  const queued = f.radio.runCommand(() => blocker.promise); await flush();
  let eligible = true;
  const predicate = vi.fn(() => eligible);
  const result = f.coordinator.tryRequest(request(), {}, predicate); await flush(); eligible = false;
  blocker.resolve(); await queued; await flush();
  assert.equal((await result).reason, 'ineligible'); assert.equal(predicate.mock.calls.length, 2);
  assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 0); clean(f);
  const error = await f.coordinator.tryRequest(request(), {}, () => { throw Error('NEVER-LOG'); });
  assert.deepEqual(error, { status: 'failed', reason: 'eligibility-error' });
});

test('queue deadline cancels unsent work and permits at most one cancelled tombstone', async () => {
  const f = await setup(); const blocker = deferred();
  const queued = f.radio.runCommand(() => blocker.promise); await flush();
  const result = f.coordinator.tryRequest(request()); await flush(); await tick(1000);
  assert.equal((await result).reason, 'queue-timeout');
  for (let i = 0; i < 20; i++) assert.equal((await f.coordinator.tryRequest(request())).reason, 'busy');
  assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 0); clean(f);
  blocker.resolve(); await queued; await flush();
  const next = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[0], sent()); await emit(f.connections[0], binary());
  assert.equal((await next).status, 'completed');
});

test('queue deadline and ACK deadline are separate bounded phases', async () => {
  const f = await setup(); const blocker = deferred();
  const queued = f.radio.runCommand(() => blocker.promise); await flush();
  const result = f.coordinator.tryRequest(request()); await flush(); await tick(999);
  blocker.resolve(); await queued; await flush(); await tick(999);
  assert.equal(f.connections[0].close.mock.calls.length, 0);
  await emit(f.connections[0], sent()); await emit(f.connections[0], binary());
  assert.equal((await result).status, 'completed'); clean(f);
});

test('ACK timeout retires its generation before queued local commands can execute', async () => {
  const f = await setup(); const conn = f.connections[0]; const hungWrite = deferred();
  conn.sendCommandSendBinaryReq.mockImplementation(() => hungWrite.promise);
  const result = f.coordinator.tryRequest(request()); await flush();
  const local = vi.fn(); const abandoned = f.radio.runCommand(local).catch(e => e.code);
  await tick(1000);
  const outcome = await result;
  assert.equal(outcome.reason, 'ack-timeout'); assert.equal(outcome.recovery, 'reset');
  assert.equal(await abandoned, 'invalidated'); assert.equal(local.mock.calls.length, 0); clean(f);
  await tick(10); assert.equal(f.opens(), 2);
  const next = f.coordinator.tryRequest(request()); await flush();
  conn.emit('rx', sent()); conn.emit('rx', binary()); hungWrite.reject(Error('NEVER-LOG')); await flush();
  await emit(f.connections[1], sent(43)); await emit(f.connections[1], binary(43));
  assert.equal((await next).status, 'completed');
  assert.equal(JSON.stringify(f.logger.warn.mock.calls).includes('NEVER-LOG'), false);
});

test('write rejection and synchronous throw reset ownership without leaking raw errors', async () => {
  for (const synchronous of [false, true]) {
    const f = await setup(); f.connections[0].sendCommandSendBinaryReq.mockImplementation(() => {
      if (synchronous) throw Error('SECRET'); return Promise.reject(Error('SECRET'));
    });
    const result = f.coordinator.tryRequest(request()); await flush();
    assert.equal((await result).reason, 'write-error'); assert.equal(f.connections[0].close.mock.calls.length, 1);
    assert.equal(JSON.stringify(f.logger.warn.mock.calls).includes('SECRET'), false); clean(f);
  }
});

test('malformed ACK resets; structurally invalid/unrelated/pre-ACK binary input is ignored', async () => {
  const f = await setup(); const result = f.coordinator.tryRequest(request()); await flush();
  for (const bytes of [null, [256], [], Array(177).fill(0), [0], [0x85], binary(42, [], 1)]) await emit(f.connections[0], bytes);
  assert.equal(f.connections[0].close.mock.calls.length, 0);
  await emit(f.connections[0], [6, 0]);
  assert.equal((await result).reason, 'protocol-error'); assert.equal(f.connections[0].close.mock.calls.length, 1); clean(f);
});

test('malformed Err is ambiguous but a validated Err safely releases without reset', async () => {
  const f = await setup(); const result = f.coordinator.tryRequest(request()); await flush();
  await emit(f.connections[0], [1, 3]);
  assert.equal((await result).reason, 'command-error'); assert.equal((await result).errorReason, 'table-full');
  assert.equal(f.connections[0].close.mock.calls.length, 0); clean(f);
  await flush(); const second = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[0], [1]);
  assert.equal((await second).reason, 'protocol-error');
});

test('matching malformed body fails without reset while malformed wrong-tag responses stay unrelated', async () => {
  const f = await setup(); const result = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[0], sent());
  for (const frame of [[6], [1], [0x8C], binary(90, [], 1)]) await emit(f.connections[0], frame);
  await emit(f.connections[0], binary(42, [], 1));
  assert.equal((await result).reason, 'protocol-error'); assert.equal(f.connections[0].close.mock.calls.length, 0); clean(f);
});

test('unexpected flood reports the route and retires the tag without pretending to undo RF', async () => {
  const f = await setup(); const result = f.coordinator.tryRequest(request(), { expectedRoute: 'direct' }); await flush();
  await emit(f.connections[0], sent(0xFFFFFFFF, 0xFFFFFFFF, 1));
  assert.equal((await result).reason, 'route-mismatch'); assert.equal((await result).route, 'flood');
  assert.equal((await result).tag, 0xFFFFFFFF); assert.equal(f.connections[0].close.mock.calls.length, 0); clean(f);
});

test('response deadline clamps zero and absurd estimates, ignores wall-clock changes and never resets', async () => {
  for (const [estimate, wait] of [[0, 1000], [100, 1100], [0xFFFFFFFF, 2000]]) {
    const f = await setup(); const result = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[0], sent(estimate, estimate));
    vi.setSystemTime(new Date('1999-01-01')); await tick(wait - 1);
    assert.equal(rxCount(f.connections[0]), 1); await tick(1);
    assert.equal((await result).reason, 'response-timeout'); assert.equal(f.connections[0].close.mock.calls.length, 0); clean(f);
  }
});

test('deadline checks reject a late frame even before its delayed timer callback runs', async () => {
  let clock = 0; const f = await setup({ now: () => clock });
  const result = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[0], sent());
  clock = 1100; await emit(f.connections[0], binary());
  assert.equal((await result).reason, 'response-timeout'); clean(f);
});

test('early timer delivery rechecks monotonic time and rollback cannot extend an expired deadline', async () => {
  let clock = 100; const f = await setup({ now: () => clock }); const result = f.coordinator.tryRequest(request()); await flush();
  await emit(f.connections[0], sent(42, 0)); clock = 50; await tick(1000);
  assert.equal(rxCount(f.connections[0]), 1); clock = 1100; await emit(f.connections[0], binary());
  assert.equal((await result).reason, 'response-timeout'); clean(f);
});

test('disconnect releases ACK and response ownership; old callbacks cannot affect the replacement', async () => {
  for (const acknowledged of [false, true]) {
    const f = await setup(); const conn = f.connections[0]; const result = f.coordinator.tryRequest(request()); await flush();
    if (acknowledged) await emit(conn, sent());
    const old = conn.listeners('rx')[0]; conn.emit('disconnected'); await flush();
    assert.equal((await result).reason, 'disconnected'); clean(f); assert.equal(f.opens(), 2);
    const next = f.coordinator.tryRequest(request()); await flush(); old(sent(99)); old(binary(99)); await flush();
    await emit(f.connections[1], sent(43)); await emit(f.connections[1], binary(43)); assert.equal((await next).status, 'completed');
  }
});

test('stop before queue execution never sends and remains idempotent', async () => {
  const f = await setup(); const blocker = deferred(); const queued = f.radio.runCommand(() => blocker.promise); await flush();
  const result = f.coordinator.tryRequest(request()); await flush(); await f.coordinator.stop(); await f.coordinator.stop();
  assert.equal((await result).reason, 'stopped'); clean(f); blocker.resolve(); await queued; await flush();
  assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 0);
  assert.equal((await f.coordinator.tryRequest(request())).reason, 'stopped');
});

test('stop before ACK uses targeted cancellation recovery; stop after ACK does not reset', async () => {
  for (const acknowledged of [false, true]) {
    const f = await setup(); const result = f.coordinator.tryRequest(request()); await flush();
    if (acknowledged) await emit(f.connections[0], sent());
    await Promise.all([f.coordinator.stop(), f.coordinator.stop()]);
    assert.equal((await result).reason, 'stopped'); assert.equal(f.connections[0].close.mock.calls.length, acknowledged ? 0 : 1);
    if (!acknowledged) assert.match(f.logger.warn.mock.calls[0][1], /stopped before acknowledgement/);
    clean(f);
  }
});

test('failed closure keeps the lease until bounded recovery and blocks further transport sends', async () => {
  const f = await setup(); f.connections[0].close.mockImplementation(() => new Promise(() => {}));
  const result = f.coordinator.tryRequest(request()); await flush(); await tick(1000);
  assert.equal((await f.coordinator.tryRequest(request())).reason, 'busy');
  const stopped = f.coordinator.stop(); await tick(100); await stopped;
  assert.equal((await result).recovery, 'close-timeout'); clean(f); await tick(10000); assert.equal(f.opens(), 1);
});

test('retired tags survive reconnect, reject reuse and expire at the fixed retention boundary', async () => {
  const f = await setup(); let result = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[0], sent(0)); await emit(f.connections[0], binary(0));
  assert.equal((await result).status, 'completed'); await flush(); f.connections[0].emit('disconnected'); await flush();
  result = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[1], sent(0));
  assert.equal((await result).reason, 'retired-tag'); await flush();
  await tick(62000); result = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[1], sent(0)); await emit(f.connections[1], binary(0));
  assert.equal((await result).status, 'completed');
});

test('retired tag memory has a strict 32-entry cap with oldest eviction', async () => {
  const f = await setup();
  for (let tag = 0; tag < 33; tag++) {
    const result = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[0], sent(tag)); await emit(f.connections[0], binary(tag));
    assert.equal((await result).status, 'completed'); await flush();
  }
  const evicted = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[0], sent(0)); await emit(f.connections[0], binary(0));
  assert.equal((await evicted).status, 'completed'); await flush();
  const retained = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[0], sent(32)); assert.equal((await retained).reason, 'retired-tag');
});

test('installed SDK deferred emitter preserves exact on/off cleanup and ignores already scheduled duplicates', async () => {
  const f = await setup({ sdk: true }); const conn = f.connections[0];
  const unrelated = vi.fn(); conn.on('rx', unrelated);
  const result = f.coordinator.tryRequest(request()); await flush();
  assert.deepEqual([...conn.sendToRadioFrame.mock.calls[0][0]], [50, ...Buffer.from(target, 'hex'), 1, 0, 0, 0, 0, 1, 2, 3, 4]);
  await emit(conn, binary(), true); await emit(conn, sent(), true);
  conn.emit('rx', binary()); conn.emit('rx', binary()); await tick(1);
  assert.equal((await result).status, 'completed'); assert.equal(rxCount(conn), 1); conn.off('rx', unrelated); clean(f);
  assert.equal(vi.getTimerCount(), 0);
});

test('late SDK write settlement after a valid ACK cannot corrupt another queued command', async () => {
  const f = await setup(); const write = deferred(); f.connections[0].sendCommandSendBinaryReq.mockImplementation(() => write.promise);
  const result = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[0], sent());
  assert.equal(await f.radio.runCommand(() => 'local'), 'local'); write.reject(Error('SECRET')); await flush();
  await emit(f.connections[0], binary()); assert.equal((await result).status, 'completed'); assert.equal(f.connections[0].close.mock.calls.length, 0); clean(f);
});

test('eligibility side effects cannot send after stop or generation change', async () => {
  const f = await setup(); let calls = 0;
  const result = f.coordinator.tryRequest(request(), {}, () => { if (++calls === 2) f.coordinator.stop(); return true; });
  await flush(); assert.equal((await result).reason, 'stopped'); assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 0); clean(f);
});

test('signal listeners return to baseline after ACK and remote completion', async () => {
  const f = await setup(); let signal;
  await f.radio.runCommand((_, transaction) => { signal = transaction.signal; });
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  const result = f.coordinator.tryRequest(request()); await flush();
  assert.equal(getEventListeners(signal, 'abort').length, 3);
  await emit(f.connections[0], sent()); assert.equal(getEventListeners(signal, 'abort').length, 1);
  await emit(f.connections[0], binary()); assert.equal((await result).status, 'completed');
  assert.equal(getEventListeners(signal, 'abort').length, 0); clean(f);
});

test('direct RadioManager shutdown settles a response and an ACK wait without coordinator teardown', async () => {
  for (const acknowledged of [false, true]) {
    const f = await setup(); const result = f.coordinator.tryRequest(request()); await flush();
    if (acknowledged) await emit(f.connections[0], sent());
    await f.radio.stop(); assert.equal((await result).reason, 'disconnected'); clean(f);
    assert.equal(vi.getTimerCount(), 0);
  }
});

test('queued generation loss settles without executing and admission policy cannot reenter a second lease', async () => {
  const f = await setup(); const blocker = deferred();
  const queued = f.radio.runCommand(() => blocker.promise).catch(e => e.code); await flush();
  const result = f.coordinator.tryRequest(request()); await flush(); f.connections[0].emit('disconnected'); await flush();
  assert.equal((await result).reason, 'disconnected'); assert.equal(await queued, 'disconnected'); clean(f);
  assert.equal(f.connections[0].sendCommandSendBinaryReq.mock.calls.length, 0);
  let inner;
  const outer = await f.coordinator.tryRequest(request(), {}, () => { inner = f.coordinator.tryRequest(request()); return true; });
  assert.deepEqual(outer, { status: 'deferred', reason: 'busy' });
  await flush(); await emit(f.connections[1], sent(45)); await emit(f.connections[1], binary(45));
  assert.equal((await inner).status, 'completed');
});

test('installed SDK callbacks queued before generation retirement are inert during the next request', async () => {
  const f = await setup({ sdk: true }); const conn = f.connections[0];
  const result = f.coordinator.tryRequest(request()); await flush();
  conn.emit('disconnected'); conn.emit('rx', sent()); conn.emit('rx', binary()); await tick(1);
  assert.equal((await result).reason, 'disconnected'); clean(f);
  const next = f.coordinator.tryRequest(request()); await flush(); await emit(f.connections[1], sent(43), true); await emit(f.connections[1], binary(43), true);
  assert.equal((await next).status, 'completed');
});

test('the standalone coordinator uses no legacy helpers and creates no RF traffic until called', async () => {
  const f = await setup({ sdk: true }); const conn = f.connections[0]; const once = vi.spyOn(conn, 'once');
  await tick(100000); assert.equal(conn.sendCommandSendBinaryReq.mock.calls.length, 0);
  const c = new RemoteRequestCoordinator({ ...ownershipControls, radio: f.radio, ...limits });
  const result = c.tryRequest(request('neighbours', { version: 0, count: 1, offset: 256, orderBy: 2, prefixLength: 4 }), { expectedRoute: 'flood' });
  await flush(); assert.equal(once.mock.calls.length, 0);
  await emit(conn, sent(123, 0, 1), true); await emit(conn, binary(123), true);
  assert.equal((await result).status, 'completed'); await c.stop(); clean(f);
});

test('recovery failure and a superseded reset return typed outcomes without exposing exception content', async () => {
  for (const outcome of ['close-failed', 'stale-generation', 'unexpected', 'reject']) {
    const f = await setup();
    const invalidate = vi.spyOn(f.radio, 'invalidateConnection').mockImplementation(async () => {
      if (outcome === 'reject') throw Error('SECRET'); return { status: outcome };
    });
    const result = f.coordinator.tryRequest(request()); await flush(); await tick(1000);
    const final = await result;
    assert.equal(final.recovery, ['unexpected', 'reject'].includes(outcome) ? 'failed' : outcome);
    assert.equal(JSON.stringify(final).includes('SECRET'), false); clean(f);
    if (outcome !== 'stale-generation') assert.equal((await f.coordinator.tryRequest(request())).reason, 'recovery-failed');
    if (['unexpected', 'reject'].includes(outcome)) {
      const local = vi.fn(); const waiting = f.radio.runCommand(local).catch(e => e.code); await flush();
      assert.equal(local.mock.calls.length, 0); await f.radio.stop(); assert.equal(await waiting, 'stopped');
    }
    invalidate.mockRestore();
  }
});
