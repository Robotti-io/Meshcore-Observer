import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Connection, Constants, NodeJSSerialConnection, TCPConnection } from '@liamcottle/meshcore.js';
import { RadioManager } from '../../src/radio/radio-manager.js';
import { createRunShutdown } from '../../src/metrics/run-history.js';

const managers = new Set();

afterEach(async () => {
  const activeManagers = [...managers];
  managers.clear();
  try {
    await Promise.all(activeManagers.map((manager) => manager.stop()));
  } finally {
    vi.useRealTimers();
  }
});

function silentLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function baseRadioConfig(overrides = {}) {
  return {
    type: 'serial',
    serialPorts: ['FAKE0'],
    tcpHost: null,
    tcpPort: null,
    reconnect: { maxRetries: 0, initialDelayMs: 5, maxDelayMs: 10 },
    ...overrides
  };
}

function onceEvent(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function makeManager(options) {
  const manager = new RadioManager(options);
  managers.add(manager);
  return manager;
}

function createFakeConnection() {
  const connection = new EventEmitter();
  connection.closed = false;
  connection.getSelfInfo = async () => ({
    publicKey: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    name: 'Test Node',
    radioFreq: 915,
    radioBw: 250,
    radioSf: 10,
    radioCr: 5,
    txPower: 20,
    maxTxPower: 22
  });
  connection.getDeviceTime = async () => ({ epochSecs: Math.floor(Date.now() / 1000) });
  connection.setDeviceTime = async () => {};
  connection.deviceQuery = async () => ({ firmwareVer: 7, firmware_build_date: '19 Feb 2025', manufacturerModel: 'Heltec V3' });
  connection.close = async () => {
    connection.closed = true;
    connection.emit('disconnected');
  };
  return connection;
}

test('connects successfully and emits radio.connected with normalized device info', async () => {
  const connection = createFakeConnection();
  const manager = makeManager({
    config: { radio: baseRadioConfig() },
    logger: silentLogger(),
    openTransport: async () => connection
  });

  const connected = onceEvent(manager, 'radio.connected');
  manager.start();
  const deviceInfo = await connected;

  assert.equal(deviceInfo.publicKey, 'deadbeef');
  assert.equal(deviceInfo.name, 'Test Node');
  assert.equal(deviceInfo.model, 'Heltec V3');
  assert.equal(deviceInfo.firmwareVersion, '7 (19 Feb 2025)');
  assert.equal(manager.isConnected(), true);
  assert.deepEqual(manager.getDeviceInfo(), deviceInfo);

  await manager.stop();
});

test('a failed device query does not block connection, and leaves model/firmwareVersion null', async () => {
  const connection = createFakeConnection();
  connection.deviceQuery = async () => {
    throw new Error('unsupported command');
  };
  const manager = makeManager({
    config: { radio: baseRadioConfig() },
    logger: silentLogger(),
    openTransport: async () => connection
  });

  const connected = onceEvent(manager, 'radio.connected');
  manager.start();
  const deviceInfo = await connected;

  assert.equal(deviceInfo.model, null);
  assert.equal(deviceInfo.firmwareVersion, null);

  await manager.stop();
});

test('strips trailing null-padding and any packed data after it from manufacturerModel', async () => {
  const connection = createFakeConnection();
  connection.deviceQuery = async () => ({
    firmwareVer: 13,
    firmware_build_date: '14-Aug-2026',
    // Real firmware packs the model name, null padding, and a git-describe
    // string into this single "remainder of frame" field.
    manufacturerModel: 'Heltec V3\0\0\0\0\0v1.17.1-d929643\0\0'
  });
  const manager = makeManager({
    config: { radio: baseRadioConfig() },
    logger: silentLogger(),
    openTransport: async () => connection
  });

  const connected = onceEvent(manager, 'radio.connected');
  manager.start();
  const deviceInfo = await connected;

  assert.equal(deviceInfo.model, 'Heltec V3');

  await manager.stop();
});

test('retries with backoff after a failed transport attempt, then succeeds', async () => {
  vi.useFakeTimers();
  const connection = createFakeConnection();
  let attempts = 0;
  const openTransport = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('port busy');
    }
    return connection;
  };

  const manager = makeManager({
    config: { radio: baseRadioConfig() },
    logger: silentLogger(),
    openTransport
  });

  const error = onceEvent(manager, 'radio.error');
  const connected = onceEvent(manager, 'radio.connected');
  manager.start();

  const errorDetail = await error;
  assert.equal(errorDetail.phase, 'connect');
  assert.equal(errorDetail.fatal, undefined);

  await vi.advanceTimersByTimeAsync(5);
  await connected;
  assert.equal(attempts, 2);

  await manager.stop();
});

test('reconnects automatically when the active connection disconnects', async () => {
  const firstConnection = createFakeConnection();
  const secondConnection = createFakeConnection();
  const connections = [firstConnection, secondConnection];
  const openTransport = async () => connections.shift();

  const manager = makeManager({
    config: { radio: baseRadioConfig() },
    logger: silentLogger(),
    openTransport
  });

  const firstConnected = onceEvent(manager, 'radio.connected');
  manager.start();
  await firstConnected;

  const disconnected = onceEvent(manager, 'radio.disconnected');
  const reconnected = onceEvent(manager, 'radio.connected');
  firstConnection.emit('disconnected');

  await disconnected;
  await reconnected;
  assert.equal(manager.isConnected(), true);

  await manager.stop();
});

test('stop() closes the active connection and suppresses its own disconnect from reconnecting', async () => {
  const connection = createFakeConnection();
  const manager = makeManager({
    config: { radio: baseRadioConfig() },
    logger: silentLogger(),
    openTransport: async () => connection
  });

  await new Promise((resolve) => {
    manager.once('radio.connected', resolve);
    manager.start();
  });

  let reconnectAttempted = false;
  manager.once('radio.connected', () => {
    reconnectAttempted = true;
  });

  vi.useFakeTimers();
  await manager.stop();
  assert.equal(connection.closed, true);

  await vi.advanceTimersByTimeAsync(30);
  assert.equal(reconnectAttempted, false);
  assert.equal(manager.isConnected(), false);
});

test('runCommand rejects when not connected and runs through the queue when connected', async () => {
  const connection = createFakeConnection();
  connection.ping = async () => 'pong';

  const manager = makeManager({
    config: { radio: baseRadioConfig() },
    logger: silentLogger(),
    openTransport: async () => connection
  });

  await assert.rejects(manager.runCommand(() => Promise.resolve('nope')), /not connected/);

  const connected = onceEvent(manager, 'radio.connected');
  manager.start();
  await connected;

  const result = await manager.runCommand((conn) => conn.ping());
  assert.equal(result, 'pong');

  await manager.stop();
});

test('gives up after exceeding a finite retry limit and emits a fatal radio.error', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const openTransport = async () => {
    attempts += 1;
    throw new Error('always fails');
  };

  const manager = makeManager({
    config: { radio: baseRadioConfig({ reconnect: { maxRetries: 1, initialDelayMs: 5, maxDelayMs: 5 } }) },
    logger: silentLogger(),
    openTransport
  });

  const errors = [];
  manager.on('radio.error', (detail) => errors.push(detail));

  manager.start();
  await vi.advanceTimersByTimeAsync(5);

  assert.equal(attempts, 2);
  assert.equal(errors.at(-1).fatal, true);

  const attemptsAfterGiveUp = attempts;
  await vi.advanceTimersByTimeAsync(30);
  assert.equal(attempts, attemptsAfterGiveUp);

  await manager.stop();
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function connectedManager(connections, extra = {}) {
  let opens = 0;
  const manager = makeManager({ config: { radio: baseRadioConfig() }, logger: silentLogger(),
    openTransport: async () => connections[opens++], ...extra });
  const ready = onceEvent(manager, 'radio.connected'); manager.start(); await ready;
  return { manager, opens: () => opens };
}

test('immutable generation snapshot becomes ready only after the existing handshake finishes', async () => {
  const connection = createFakeConnection(); const query = deferred(); const entered = deferred();
  connection.deviceQuery = () => { entered.resolve(); return query.promise; };
  const manager = makeManager({ config: { radio: baseRadioConfig() }, logger: silentLogger(), openTransport: async () => connection });
  const connected = onceEvent(manager, 'radio.connected'); manager.start(); await entered.promise;
  assert.equal(manager.isConnected(), true);
  const pending = manager.getConnectionSnapshot();
  assert.deepEqual(pending, { generation: 1, ready: false, observerPublicKey: 'deadbeef' });
  assert.equal(Object.isFrozen(pending), true);
  let sent = 0;
  await assert.rejects(manager.runCommand(() => { sent++; }, { generation: 1, requireReady: true }), { code: 'not-ready' });
  assert.equal(sent, 0);
  query.resolve({ firmwareVer: 13, manufacturerModel: 'Ready' }); await connected;
  assert.equal(manager.getConnectionSnapshot().ready, true);
  assert.equal(pending.ready, false);
  const context = await manager.runCommand((_connection, context) => context, { generation: 1, requireReady: true });
  assert.equal(context.generation, 1); assert.equal(Object.isFrozen(context), true);
  assert.equal(context.signal.aborted, false);
  await manager.stop(); assert.equal(context.signal.aborted, true);
  assert.deepEqual(manager.getConnectionSnapshot(), { generation: null, ready: false, observerPublicKey: null });
});

test('disconnect settles an abandoned transaction and rejects stale queued callbacks before a new handshake', async () => {
  const first = createFakeConnection(), second = createFakeConnection();
  const { manager } = await connectedManager([first, second]);
  const gate = deferred(), entered = deferred(); let queuedCalls = 0;
  const abandoned = manager.runCommand(() => { entered.resolve(); return gate.promise; });
  const abandonedCheck = assert.rejects(abandoned, { code: 'disconnected' });
  await entered.promise;
  const queued = manager.runCommand(() => { queuedCalls++; });
  const queuedCheck = assert.rejects(queued, { code: 'disconnected' });
  const ready = onceEvent(manager, 'radio.connected'); first.emit('disconnected');
  await Promise.all([abandonedCheck, queuedCheck, ready]);
  assert.equal(queuedCalls, 0); assert.equal(manager.getConnectionSnapshot().generation, 2);
  assert.equal(await manager.runCommand(() => 'new-command'), 'new-command');
  gate.reject(new Error('late old rejection')); await Promise.resolve();
  assert.equal(manager.getConnectionSnapshot().ready, true);
});

test('a stop between admission and actual execution cancels the queued callback without effects', async () => {
  const { manager } = await connectedManager([createFakeConnection()]); let calls = 0;
  const command = manager.runCommand(() => { calls++; });
  const check = assert.rejects(command, { code: 'stopped' });
  await manager.stop(); await check; assert.equal(calls, 0);
});

test('stop settles a hung command, is idempotent and permits a fresh explicitly started generation', async () => {
  const first = createFakeConnection(), second = createFakeConnection(); let closes = 0;
  first.close = async () => { closes++; first.emit('disconnected'); };
  const { manager } = await connectedManager([first, second]);
  const gate = deferred(), entered = deferred();
  const command = manager.runCommand(() => { entered.resolve(); return gate.promise; });
  const check = assert.rejects(command, { code: 'stopped' }); await entered.promise;
  const firstStop = manager.stop(), repeatedStop = manager.stop(); assert.equal(firstStop, repeatedStop);
  await firstStop; await check; assert.equal(closes, 1);
  const ready = onceEvent(manager, 'radio.connected'); manager.start(); await ready;
  assert.equal(manager.getConnectionSnapshot().generation, 2);
  gate.resolve('late success'); await Promise.resolve();
  assert.equal(await manager.runCommand(() => 'current'), 'current');
});

test('disconnect during a hung self-info handshake cannot publish the old identity after reconnect', async () => {
  const first = createFakeConnection(), second = createFakeConnection(); const gate = deferred(), entered = deferred();
  first.getSelfInfo = () => { entered.resolve(); return gate.promise; };
  let opens = 0; const manager = makeManager({ config: { radio: baseRadioConfig() }, logger: silentLogger(),
    openTransport: async () => [first, second][opens++] });
  const connected = []; manager.on('radio.connected', (info) => connected.push(info));
  manager.start(); await entered.promise;
  assert.equal(manager.isConnected(), false); assert.equal(manager.getConnectionSnapshot().ready, false);
  const ready = onceEvent(manager, 'radio.connected'); first.emit('disconnected'); await ready;
  gate.resolve({ ...(await second.getSelfInfo()), name: 'Obsolete' }); await Promise.resolve();
  assert.equal(connected.length, 1); assert.equal(manager.getDeviceInfo().name, 'Test Node');
  assert.equal(manager.getConnectionSnapshot().generation, 2);
});

test('disconnect during clock sync prevents a late read from setting a retired device clock', async () => {
  const first = createFakeConnection(), second = createFakeConnection(); const gate = deferred(), entered = deferred();
  first.getDeviceTime = () => { entered.resolve(); return gate.promise; };
  let sets = 0; first.setDeviceTime = async () => { sets++; };
  let opens = 0; const manager = makeManager({ config: { radio: baseRadioConfig() }, logger: silentLogger(),
    openTransport: async () => [first, second][opens++] });
  manager.start(); await entered.promise;
  const ready = onceEvent(manager, 'radio.connected'); first.emit('disconnected'); await ready;
  gate.resolve({ epochSecs: 1 }); await Promise.resolve();
  assert.equal(sets, 0); assert.equal(manager.getConnectionSnapshot().ready, true);
});

test('late device-query data cannot mutate replacement metadata or emit a false connected event', async () => {
  const first = createFakeConnection(), second = createFakeConnection(); const gate = deferred(), entered = deferred();
  first.deviceQuery = () => { entered.resolve(); return gate.promise; };
  second.deviceQuery = async () => ({ firmwareVer: 13, manufacturerModel: 'Replacement' });
  let opens = 0; const manager = makeManager({ config: { radio: baseRadioConfig() }, logger: silentLogger(),
    openTransport: async () => [first, second][opens++] });
  const infos = []; manager.on('radio.connected', (info) => infos.push(info)); manager.start(); await entered.promise;
  const oldInfo = manager.getDeviceInfo(); const ready = onceEvent(manager, 'radio.connected');
  first.emit('disconnected'); await ready;
  gate.resolve({ firmwareVer: 1, manufacturerModel: 'Wrong' }); await Promise.resolve();
  assert.equal(infos.length, 1); assert.equal(manager.getDeviceInfo().model, 'Replacement');
  assert.equal(oldInfo.model, null);
});

test('stop while handshake is pending cannot emit readiness or queue a later device command', async () => {
  const connection = createFakeConnection(); const gate = deferred(), entered = deferred(); let queries = 0;
  connection.getDeviceTime = () => { entered.resolve(); return gate.promise; };
  connection.deviceQuery = async () => { queries++; return {}; };
  const manager = makeManager({ config: { radio: baseRadioConfig() }, logger: silentLogger(), openTransport: async () => connection });
  let ready = 0; manager.on('radio.connected', () => ready++); manager.start(); await entered.promise;
  await manager.stop(); gate.resolve({ epochSecs: 1 }); await Promise.resolve();
  assert.equal(ready, 0); assert.equal(queries, 0); assert.equal(manager.isConnected(), false);
});

test('retired packet/channel/disconnect callbacks are detached and harmless even if already scheduled', async () => {
  const first = createFakeConnection(), second = createFakeConnection(); const { manager } = await connectedManager([first, second]);
  const oldPacket = first.listeners(Constants.PushCodes.LogRxData)[0];
  const oldChannel = first.listeners(Constants.ResponseCodes.ChannelMsgRecv)[0];
  const oldDisconnected = first.listeners('disconnected')[0];
  const packets = [], messages = []; manager.on('radio.packet', (value) => packets.push(value));
  manager.on('radio.channelMessage', (value) => messages.push(value));
  first.emit(Constants.PushCodes.LogRxData, { id: 'valid-first' });
  const ready = onceEvent(manager, 'radio.connected'); first.emit('disconnected'); await ready;
  oldPacket({ id: 'old' }); oldChannel({ id: 'old' }); oldDisconnected();
  const packet = { id: 'new' }, message = { text: 'unchanged' };
  second.emit(Constants.PushCodes.LogRxData, packet); second.emit(Constants.ResponseCodes.ChannelMsgRecv, message);
  assert.deepEqual(packets, [{ id: 'valid-first' }, packet]); assert.deepEqual(messages, [message]);
  for (const code of ['disconnected', Constants.PushCodes.LogRxData, Constants.ResponseCodes.ChannelMsgRecv]) {
    assert.equal(first.listenerCount(code), 0);
  }
  assert.equal(manager.getConnectionSnapshot().generation, 2);
});

test('targeted invalidation waits for close confirmation and uses one existing backoff retry', async () => {
  vi.useFakeTimers();
  const first = createFakeConnection(), second = createFakeConnection(); let closeCalls = 0;
  first.close = () => { closeCalls++; }; // intentionally returns before closure
  const warnings = []; const logger = { ...silentLogger(), warn: (...args) => warnings.push(args) };
  const { manager, opens } = await connectedManager([first, second], { logger, closeTimeoutMs: 100 });
  const generation = manager.getConnectionSnapshot().generation;
  const resetting = manager.invalidateConnection({ generation, reason: 'ack-timeout' });
  assert.equal(manager.isConnected(), false);
  await vi.advanceTimersByTimeAsync(20); assert.equal(opens(), 1); assert.equal(closeCalls, 1);
  first.emit('disconnected'); assert.deepEqual(await resetting, { status: 'reset' });
  const ready = onceEvent(manager, 'radio.connected');
  await vi.advanceTimersByTimeAsync(5); await ready; assert.equal(opens(), 2);
  assert.match(warnings[0][1], /acknowledgement timed out.*late acknowledgement/);
  assert.deepEqual(warnings[0][2], { generation, reason: 'ack-timeout' });
  assert.deepEqual(await manager.invalidateConnection({ generation, reason: 'protocol-error' }), { status: 'stale-generation' });
  let effects = 0;
  await assert.rejects(manager.runCommand(() => { effects++; }, { generation }), { code: 'stale-generation' });
  assert.equal(effects, 0); assert.equal(manager.getConnectionSnapshot().generation, 2);
  await manager.stop(); assert.equal(vi.getTimerCount(), 0);
});

test('write/protocol recovery reasons produce fixed safe warnings rather than accepting SDK error text', async () => {
  vi.useFakeTimers();
  for (const reason of ['write-error', 'protocol-error']) {
    const records = []; const logger = { ...silentLogger(), warn: (...args) => records.push(args) };
    const { manager } = await connectedManager([createFakeConnection()], { logger });
    const generation = manager.getConnectionSnapshot().generation;
    assert.deepEqual(await manager.invalidateConnection({ generation, reason }), { status: 'reset' });
    assert.equal(records[0][2].reason, reason); assert.doesNotMatch(JSON.stringify(records), /password|token|rawError/);
    await manager.stop(); assert.equal(vi.getTimerCount(), 0);
  }
});

test('failed or hung close settles within a bound and blocks all replacement connections and restart attempts', async () => {
  vi.useFakeTimers();
  for (const failure of ['reject', 'throw', 'hang', 'return-without-close']) {
    const first = createFakeConnection(), second = createFakeConnection();
    first.close = () => {
      if (failure === 'reject') return Promise.reject(new Error('DO-NOT-LOG'));
      if (failure === 'throw') throw new Error('DO-NOT-LOG');
      if (failure === 'hang') return new Promise(() => {});
    };
    const errors = [], logs = [];
    const { manager, opens } = await connectedManager([first, second], {
      closeTimeoutMs: 25, logger: { ...silentLogger(), error: (...args) => logs.push(args) }
    });
    manager.on('radio.error', (error) => errors.push(error));
    const reset = manager.invalidateConnection({ generation: 1, reason: 'ack-timeout' });
    await vi.advanceTimersByTimeAsync(25);
    const expected = failure === 'reject' || failure === 'throw' ? 'close-failed' : 'close-timeout';
    assert.deepEqual(await reset, { status: expected });
    manager.start(); await vi.advanceTimersByTimeAsync(100);
    assert.equal(opens(), 1); assert.equal(manager.isConnected(), false);
    assert.equal(errors.length, 1); assert.equal(errors[0].fatal, true);
    assert.match(errors[0].message, /verify the transport is closed and restart Observer/);
    assert.doesNotMatch(JSON.stringify(logs), /DO-NOT-LOG/);
    await assert.rejects(manager.runCommand(() => {}), { code: 'not-connected' });
    await assert.rejects(manager.stop(), { code: expected }); managers.delete(manager);
    assert.equal(first.listenerCount('disconnected'), 0); assert.equal(vi.getTimerCount(), 0);
  }
});

test('confirmed disconnection releases recovery even when the close promise never settles', async () => {
  vi.useFakeTimers();
  const first = createFakeConnection(); first.close = () => new Promise(() => {});
  const { manager } = await connectedManager([first], { closeTimeoutMs: 25 });
  const reset = manager.invalidateConnection({ generation: 1, reason: 'ack-timeout' });
  first.emit('disconnected'); assert.deepEqual(await reset, { status: 'reset' });
  await manager.stop(); assert.equal(vi.getTimerCount(), 0);
});

test('stop during transport opening waits for a late returned connection to be closed without publishing readiness', async () => {
  const connection = createFakeConnection(), opening = deferred(); let opens = 0, readCalls = 0;
  connection.getSelfInfo = async () => { readCalls++; return {}; };
  const manager = makeManager({ config: { radio: baseRadioConfig() }, logger: silentLogger(),
    openTransport: () => { opens++; return opening.promise; } });
  let connected = 0; manager.on('radio.connected', () => connected++); manager.start();
  const stop = manager.stop(); manager.start(); assert.equal(opens, 1);
  opening.resolve(connection); await stop;
  assert.equal(connection.closed, true); assert.equal(readCalls, 0); assert.equal(connected, 0);
});

test('an unsettled transport open fails bounded shutdown and any late result is retired safely', async () => {
  vi.useFakeTimers(); const opening = deferred(), connection = createFakeConnection();
  const manager = makeManager({ config: { radio: baseRadioConfig() }, logger: silentLogger(), closeTimeoutMs: 25,
    openTransport: () => opening.promise });
  let connected = 0; manager.on('radio.connected', () => connected++); manager.start();
  const check = assert.rejects(manager.stop(), { code: 'open-timeout' });
  await vi.advanceTimersByTimeAsync(25); await check; managers.delete(manager);
  opening.resolve(connection); await vi.advanceTimersByTimeAsync(0);
  assert.equal(connection.closed, true); assert.equal(connected, 0); assert.equal(vi.getTimerCount(), 0);
});

test('strict recovery/options schemas reject unsafe inputs before queue, close or log side effects', async () => {
  const { manager } = await connectedManager([createFakeConnection()]); let calls = 0;
  for (const options of [null, [], { generation: 0 }, { generation: 1.5 }, { generation: '1' },
    { requireReady: 'true' }, { rawError: 'DO-NOT-LOG' }, { generation: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(manager.runCommand(() => { calls++; }, options), /Invalid radio command options/);
  }
  for (const request of [null, {}, { generation: 0, reason: 'ack-timeout' },
    { generation: 1, reason: 'DO-NOT-LOG' }, { generation: 1, reason: 'ack-timeout', error: 'DO-NOT-LOG' }]) {
    await assert.rejects(manager.invalidateConnection(request), /Invalid radio invalidation/);
  }
  assert.equal(calls, 0); assert.equal(manager.getConnectionSnapshot().ready, true);
  for (const closeTimeoutMs of [0, 5001, 0.5, NaN, '25']) {
    assert.throws(() => new RadioManager({ closeTimeoutMs }), /Invalid radio lifecycle options/);
  }
});

test('actual SDK serial/TCP close timing and queued callbacks obey the same generation guards', async () => {
  vi.useFakeTimers();
  for (const kind of ['serial', 'tcp']) {
    const sdk = kind === 'serial' ? new NodeJSSerialConnection('UNUSED') : new TCPConnection('unused', 0);
    const fake = createFakeConnection();
    for (const method of ['getSelfInfo', 'getDeviceTime', 'setDeviceTime', 'deviceQuery']) sdk[method] = fake[method];
    if (kind === 'serial') sdk.serialPort = { close: () => {
      setTimeout(() => sdk.onDisconnected(), 20); return sdk.serialPort;
    } };
    else sdk.socket = { destroy: () => { setTimeout(() => sdk.onDisconnected(), 20); } };
    const { manager, opens } = await connectedManager([sdk, createFakeConnection()], { closeTimeoutMs: 100 });
    const observed = []; manager.on('radio.packet', (value) => observed.push(value));
    sdk.emit(Constants.PushCodes.LogRxData, { id: 'already-scheduled-old' });
    const reset = manager.invalidateConnection({ generation: 1, reason: 'ack-timeout' });
    await vi.advanceTimersByTimeAsync(19); assert.equal(opens(), 1); assert.equal(observed.length, 0);
    await vi.advanceTimersByTimeAsync(1);
    // The SDK schedules its disconnected subscribers on a separate timer.
    await vi.advanceTimersByTimeAsync(1); assert.deepEqual(await reset, { status: 'reset' });
    await vi.advanceTimersByTimeAsync(5); assert.equal(opens(), 2);
    assert.equal(manager.getConnectionSnapshot().ready, true);
    for (const code of ['disconnected', Constants.PushCodes.LogRxData, Constants.ResponseCodes.ChannelMsgRecv]) {
      assert.equal(sdk.eventListenersMap.get(code).length, 0);
    }
    await manager.stop(); assert.equal(vi.getTimerCount(), 0);
  }
});

test('unconfirmed radio close prevents the existing shutdown owner from recording a clean run', async () => {
  vi.useFakeTimers(); const connection = createFakeConnection();
  connection.close = () => new Promise(() => {});
  const { manager } = await connectedManager([connection], { closeTimeoutMs: 25 });
  let clean = 0, storeClosed = 0; const exits = [], forced = [];
  const shutdown = createRunShutdown({ logger: silentLogger(),
    runHistory: { finishClean: () => { clean++; return true; } },
    metricsStore: { close: () => { storeClosed++; } }, teardown: () => manager.stop(),
    timeoutMs: 100, forceExit: (code) => forced.push(code), setExitCode: (code) => exits.push(code) });
  const stopped = shutdown('SIGINT'); await vi.advanceTimersByTimeAsync(25); await stopped;
  assert.equal(clean, 0); assert.equal(storeClosed, 0); assert.deepEqual(exits, [1]);
  await vi.advanceTimersByTimeAsync(75); assert.deepEqual(forced, [1]);
  managers.delete(manager); assert.equal(vi.getTimerCount(), 0);
});

test('a disconnect already queued by the SDK proves old closure without modifying the replacement', async () => {
  vi.useFakeTimers(); const first = new Connection(), fake = createFakeConnection();
  for (const method of ['getSelfInfo', 'getDeviceTime', 'setDeviceTime', 'deviceQuery']) first[method] = fake[method];
  first.close = () => {}; // already physically closed; no second native close event
  const { manager, opens } = await connectedManager([first, createFakeConnection()], { closeTimeoutMs: 100 });
  first.onDisconnected(); // schedules its original owned listener before invalidation
  const reset = manager.invalidateConnection({ generation: 1, reason: 'ack-timeout' });
  await vi.advanceTimersByTimeAsync(1); assert.deepEqual(await reset, { status: 'reset' });
  await vi.advanceTimersByTimeAsync(5); assert.equal(opens(), 2);
  assert.equal(manager.getConnectionSnapshot().generation, 2);
  assert.equal(manager.getConnectionSnapshot().ready, true);
  assert.equal(first.eventListenersMap.get('disconnected').length, 0);
  await manager.stop(); assert.equal(vi.getTimerCount(), 0);
});
