import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MqttBroker } from '../../src/mqtt/mqtt-broker.js';

function silentLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function baseBrokerConfig(overrides = {}) {
  return {
    id: 'okimesh',
    enabled: true,
    host: 'mqtt1.okimesh.org',
    port: 1883,
    transport: 'tcp',
    tls: false,
    websocketPath: null,
    keepalive: 60,
    qos: 0,
    retain: true,
    clientIdPrefix: 'meshcore-observer',
    auth: { method: 'none', username: null, password: null, audience: null, tokenTtlSeconds: null },
    ...overrides
  };
}

function createFakeClient() {
  const client = new EventEmitter();
  client.publishCalls = [];
  client.publishError = null;
  client.publish = (topic, payload, opts, cb) => {
    client.publishCalls.push({ topic, payload, opts });
    cb(client.publishError);
  };
  client.endCalls = 0;
  client.end = (force, opts, cb) => {
    client.endCalls += 1;
    cb();
  };
  return client;
}

// connect() resolves credentials asynchronously (needed for LetsMesh's
// on-device-signed token), even when nothing async is actually involved for
// this broker's auth method - so tests must let that resolve before
// touching the (fake) underlying client.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('a disabled broker never connects', async () => {
  const broker = new MqttBroker({ config: baseBrokerConfig({ enabled: false }), logger: silentLogger() });
  assert.equal(broker.getState(), 'disabled');
  broker.connect();
  await flush();
  assert.equal(broker.getState(), 'disabled');
});

test('transitions connecting -> connected on the client "connect" event', async () => {
  let capturedOptions;
  const client = createFakeClient();
  const broker = new MqttBroker({
    config: baseBrokerConfig(),
    logger: silentLogger(),
    createClient: (options) => {
      capturedOptions = options;
      return client;
    }
  });

  broker.connect();
  assert.equal(broker.getState(), 'connecting');
  await flush();

  client.emit('connect');
  assert.equal(broker.getState(), 'connected');
  assert.equal(broker.isConnected(), true);

  assert.equal(capturedOptions.protocol, 'mqtt');
  assert.equal(capturedOptions.host, 'mqtt1.okimesh.org');
  assert.equal(capturedOptions.port, 1883);
});

test('selects protocol wss for a TLS websocket transport broker', async () => {
  let capturedOptions;
  const broker = new MqttBroker({
    config: baseBrokerConfig({
      id: 'letsmesh',
      transport: 'wss',
      tls: true,
      port: 443,
      websocketPath: '/mqtt'
    }),
    logger: silentLogger(),
    createClient: (options) => {
      capturedOptions = options;
      return createFakeClient();
    }
  });

  broker.connect();
  await flush();
  assert.equal(capturedOptions.protocol, 'wss');
  assert.equal(capturedOptions.path, '/mqtt');
});

test('moves to retrying on a reconnect event', async () => {
  const client = createFakeClient();
  const broker = new MqttBroker({
    config: baseBrokerConfig(),
    logger: silentLogger(),
    createClient: () => client
  });

  broker.connect();
  await flush();
  client.emit('connect');
  client.emit('reconnect');
  assert.equal(broker.getState(), 'retrying');
  assert.equal(broker.isConnected(), false);
});

test('publish resolves when connected and rejects when not connected', async () => {
  const client = createFakeClient();
  const broker = new MqttBroker({
    config: baseBrokerConfig(),
    logger: silentLogger(),
    createClient: () => client
  });

  await assert.rejects(broker.publish('meshcore/CVG/ABC/packets', '{}'));

  broker.connect();
  await flush();
  client.emit('connect');
  await broker.publish('meshcore/CVG/ABC/packets', '{}');

  assert.equal(client.publishCalls.length, 1);
  assert.equal(client.publishCalls[0].topic, 'meshcore/CVG/ABC/packets');
  assert.deepEqual(client.publishCalls[0].opts, { qos: 0, retain: true });
});

test('publish propagates a client-reported error', async () => {
  const client = createFakeClient();
  client.publishError = new Error('broker rejected publish');
  const broker = new MqttBroker({
    config: baseBrokerConfig(),
    logger: silentLogger(),
    createClient: () => client
  });

  broker.connect();
  await flush();
  client.emit('connect');
  await assert.rejects(broker.publish('t', 'p'), /broker rejected publish/);
});

test('passes a Last Will through to the client on connect', async () => {
  let capturedOptions;
  const broker = new MqttBroker({
    config: baseBrokerConfig(),
    logger: silentLogger(),
    createClient: (options) => {
      capturedOptions = options;
      return createFakeClient();
    }
  });

  broker.connect({ topic: 'meshcore/CVG/ABC/status', payload: '{"status":"offline"}' });
  await flush();

  assert.deepEqual(capturedOptions.will, {
    topic: 'meshcore/CVG/ABC/status',
    payload: '{"status":"offline"}',
    qos: 0,
    retain: true
  });
});

test('invokes onConnect every time the client (re)connects', async () => {
  const client = createFakeClient();
  let connectCount = 0;
  const broker = new MqttBroker({
    config: baseBrokerConfig(),
    logger: silentLogger(),
    createClient: () => client,
    onConnect: () => {
      connectCount += 1;
    }
  });

  broker.connect();
  await flush();
  client.emit('connect');
  assert.equal(connectCount, 1);

  client.emit('reconnect');
  client.emit('connect');
  assert.equal(connectCount, 2);
});

test('close() ends the client and settles into disconnected, ignoring further close events', async () => {
  const client = createFakeClient();
  const broker = new MqttBroker({
    config: baseBrokerConfig(),
    logger: silentLogger(),
    createClient: () => client
  });

  broker.connect();
  await flush();
  client.emit('connect');
  await broker.close();

  assert.equal(client.endCalls, 1);
  assert.equal(broker.getState(), 'disconnected');

  // A stray "offline" arriving after we intentionally closed must not flip
  // the state back to "retrying".
  client.emit('offline');
  assert.equal(broker.getState(), 'disconnected');
});

test('resolves username/password asynchronously via getUsername/getPassword for token auth', async () => {
  let capturedOptions;
  const broker = new MqttBroker({
    config: baseBrokerConfig({
      id: 'letsmesh',
      auth: { method: 'token', username: null, password: null, audience: 'letsmesh', tokenTtlSeconds: 86400 }
    }),
    logger: silentLogger(),
    createClient: (options) => {
      capturedOptions = options;
      return createFakeClient();
    },
    getUsername: async () => 'v1_ABC123',
    getPassword: async () => 'header.payload.signature'
  });

  broker.connect();
  await flush();

  assert.equal(capturedOptions.username, 'v1_ABC123');
  assert.equal(capturedOptions.password, 'header.payload.signature');
});

test('moves to failed and logs a warning when credential resolution rejects', async () => {
  const warnings = [];
  const logger = {
    ...silentLogger(),
    warn: (source, message, meta) => warnings.push({ source, message, meta })
  };
  const broker = new MqttBroker({
    config: baseBrokerConfig({
      id: 'letsmesh',
      auth: { method: 'token', username: null, password: null, audience: 'letsmesh', tokenTtlSeconds: 86400 }
    }),
    logger,
    createClient: () => createFakeClient(),
    getPassword: async () => {
      throw new Error('on-device signing failed');
    }
  });

  broker.connect();
  await flush();

  assert.equal(broker.getState(), 'failed');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].meta.error, /on-device signing failed/);
});
