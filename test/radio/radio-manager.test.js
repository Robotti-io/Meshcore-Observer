import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RadioManager } from '../../src/radio/radio-manager.js';

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
  const manager = new RadioManager({
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
  const manager = new RadioManager({
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
  const manager = new RadioManager({
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
  const connection = createFakeConnection();
  let attempts = 0;
  const openTransport = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('port busy');
    }
    return connection;
  };

  const manager = new RadioManager({
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

  await connected;
  assert.equal(attempts, 2);

  await manager.stop();
});

test('reconnects automatically when the active connection disconnects', async () => {
  const firstConnection = createFakeConnection();
  const secondConnection = createFakeConnection();
  const connections = [firstConnection, secondConnection];
  const openTransport = async () => connections.shift();

  const manager = new RadioManager({
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
  const manager = new RadioManager({
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

  await manager.stop();
  assert.equal(connection.closed, true);

  // give any errant reconnect scheduling a chance to run
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reconnectAttempted, false);
  assert.equal(manager.isConnected(), false);
});

test('runCommand rejects when not connected and runs through the queue when connected', async () => {
  const connection = createFakeConnection();
  connection.ping = async () => 'pong';

  const manager = new RadioManager({
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
  let attempts = 0;
  const openTransport = async () => {
    attempts += 1;
    throw new Error('always fails');
  };

  const manager = new RadioManager({
    config: { radio: baseRadioConfig({ reconnect: { maxRetries: 1, initialDelayMs: 5, maxDelayMs: 5 } }) },
    logger: silentLogger(),
    openTransport
  });

  const errors = [];
  manager.on('radio.error', (detail) => errors.push(detail));

  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(attempts, 2);
  assert.equal(errors.at(-1).fatal, true);

  const attemptsAfterGiveUp = attempts;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(attempts, attemptsAfterGiveUp);

  await manager.stop();
});
