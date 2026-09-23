import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MqttManager } from '../../src/mqtt/mqtt-manager.js';

function silentLogger() {
  const calls = { warn: [] };
  return {
    calls,
    debug: () => {},
    info: () => {},
    warn: (source, message, meta) => calls.warn.push({ source, message, meta }),
    error: () => {}
  };
}

function fakeBroker(id, { connected = true, publishError = null } = {}) {
  const publishCalls = [];
  return {
    id,
    getState: () => (connected ? 'connected' : 'retrying'),
    isConnected: () => connected,
    connect: () => {},
    close: async () => {},
    publish: async (topic, payload, options) => {
      publishCalls.push({ topic, payload, options });
      if (publishError) {
        throw publishError;
      }
    },
    publishCalls
  };
}

test('publishes independently to every connected broker, skipping disconnected ones', async () => {
  const brokerA = fakeBroker('a', { connected: true });
  const brokerB = fakeBroker('b', { connected: false });
  const brokerC = fakeBroker('c', { connected: true });

  const manager = new MqttManager({
    config: { brokers: [{}, {}, {}] },
    logger: silentLogger(),
    createBroker: (() => {
      const queue = [brokerA, brokerB, brokerC];
      return () => queue.shift();
    })()
  });

  await manager.publish('meshcore/CVG/ABC/packets', '{}');

  assert.equal(brokerA.publishCalls.length, 1);
  assert.equal(brokerB.publishCalls.length, 0);
  assert.equal(brokerC.publishCalls.length, 1);
});

test('one broker failing to publish does not affect the others', async () => {
  const logger = silentLogger();
  const brokerA = fakeBroker('a', { connected: true, publishError: new Error('down') });
  const brokerB = fakeBroker('b', { connected: true });

  const manager = new MqttManager({
    config: { brokers: [{}, {}] },
    logger,
    createBroker: (() => {
      const queue = [brokerA, brokerB];
      return () => queue.shift();
    })()
  });

  await manager.publish('t', 'p');

  assert.equal(brokerA.publishCalls.length, 1);
  assert.equal(brokerB.publishCalls.length, 1);
  assert.equal(logger.calls.warn.length, 1);
  assert.equal(logger.calls.warn[0].meta.broker, 'a');
});

test('publish() returns one outcome per configured broker: sent, skipped (disconnected), or failed', async () => {
  const brokerA = fakeBroker('a', { connected: true });
  const brokerB = fakeBroker('b', { connected: false });
  const brokerC = fakeBroker('c', { connected: true, publishError: new Error('down') });

  const manager = new MqttManager({
    config: { brokers: [{}, {}, {}] },
    logger: silentLogger(),
    createBroker: (() => {
      const queue = [brokerA, brokerB, brokerC];
      return () => queue.shift();
    })()
  });

  const results = await manager.publish('t', 'p');

  assert.deepEqual(results.map((r) => ({ brokerId: r.brokerId, outcome: r.outcome })), [
    { brokerId: 'a', outcome: 'sent' },
    { brokerId: 'b', outcome: 'skipped' },
    { brokerId: 'c', outcome: 'failed' }
  ]);
  assert.equal(results[2].error, 'down');
});

test('forwards connectAll(will) to every broker and re-emits broker.connected with the broker id', () => {
  const receivedWills = [];
  const onConnects = [];
  const brokerA = {
    id: 'a',
    getState: () => 'connecting',
    isConnected: () => false,
    connect: (will) => receivedWills.push(will),
    close: async () => {}
  };

  const manager = new MqttManager({
    config: { brokers: [{ id: 'a' }] },
    logger: silentLogger(),
    createBroker: (options) => {
      onConnects.push(options.onConnect);
      return brokerA;
    }
  });

  const events = [];
  manager.on('broker.connected', (id) => events.push(id));

  const will = { topic: 't', payload: 'p' };
  manager.connectAll(will);
  assert.deepEqual(receivedWills, [will]);

  onConnects[0]();
  assert.deepEqual(events, ['a']);
});

test('getBroker returns the matching broker by id, or null if not found', () => {
  const brokerA = fakeBroker('a', { connected: true });
  const manager = new MqttManager({
    config: { brokers: [{ id: 'a' }] },
    logger: silentLogger(),
    createBroker: () => brokerA
  });

  assert.equal(manager.getBroker('a'), brokerA);
  assert.equal(manager.getBroker('missing'), null);
});

test('passes per-broker credential hooks from getCredentialHooks through to createBroker', () => {
  const seen = [];
  const usernameFn = async () => 'v1_ABC';
  const manager = new MqttManager({
    config: { brokers: [{ id: 'letsmesh' }, { id: 'okimesh' }] },
    logger: silentLogger(),
    createBroker: (options) => {
      seen.push(options);
      return fakeBroker(options.config.id, { connected: false });
    },
    getCredentialHooks: (brokerConfig) => (brokerConfig.id === 'letsmesh' ? { getUsername: usernameFn } : {})
  });

  assert.ok(manager instanceof MqttManager);
  assert.equal(seen[0].getUsername, usernameFn);
  assert.equal(seen[1].getUsername, undefined);
});

test('getStates reports each broker id to its current state', () => {
  const brokerA = fakeBroker('a', { connected: true });
  const brokerB = fakeBroker('b', { connected: false });

  const manager = new MqttManager({
    config: { brokers: [{}, {}] },
    logger: silentLogger(),
    createBroker: (() => {
      const queue = [brokerA, brokerB];
      return () => queue.shift();
    })()
  });

  assert.deepEqual(manager.getStates(), { a: 'connected', b: 'retrying' });
  assert.equal(manager.hasAnyConnected(), true);
});
