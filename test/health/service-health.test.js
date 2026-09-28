import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ServiceHealth } from '../../src/health/service-health.js';

function fakeRadioManager() {
  const emitter = new EventEmitter();
  let connected = false;
  return {
    on: (event, handler) => emitter.on(event, handler),
    emit: (event, ...args) => emitter.emit(event, ...args),
    isConnected: () => connected,
    setConnected: (value) => {
      connected = value;
    }
  };
}

function fakeMqttManager(initialStates = {}) {
  const emitter = new EventEmitter();
  let states = initialStates;
  return {
    on: (event, handler) => emitter.on(event, handler),
    emit: (event, ...args) => emitter.emit(event, ...args),
    getStates: () => states,
    setStates: (next) => {
      states = next;
    }
  };
}

function fakePacketPipeline() {
  const emitter = new EventEmitter();
  return {
    on: (event, handler) => emitter.on(event, handler),
    emit: (event, ...args) => emitter.emit(event, ...args)
  };
}

function fakeBot({ ready = false, repliesSent = 0, repeatsConfirmed = 0, repeatsUnconfirmed = 0 } = {}) {
  return {
    isReady: () => ready,
    getRepliesSent: () => repliesSent,
    getRepeatsConfirmed: () => repeatsConfirmed,
    getRepeatsUnconfirmed: () => repeatsUnconfirmed
  };
}

test('reports a sensible initial snapshot before anything has happened', () => {
  const radioManager = fakeRadioManager();
  const mqttManager = fakeMqttManager({ okimesh: 'connecting' });
  const packetPipeline = fakePacketPipeline();

  const health = new ServiceHealth({
    radioManager,
    mqttManager,
    packetPipeline,
    bots: [{ name: 'echo', enabled: true, bot: fakeBot() }],
    now: () => new Date('2024-01-01T00:00:00.000Z')
  });

  const snapshot = health.snapshot();
  assert.equal(snapshot.startedAt.toISOString(), '2024-01-01T00:00:00.000Z');
  assert.equal(snapshot.radioConnected, false);
  assert.equal(snapshot.radioLastConnectedAt, null);
  assert.equal(snapshot.radioReconnectCount, 0);
  assert.equal(snapshot.packetsReceived, 0);
  assert.equal(snapshot.packetsDecoded, 0);
  assert.deepEqual(snapshot.packetsByType, {});
  assert.deepEqual(snapshot.mqtt, {
    okimesh: { connected: false, lastConnectedAt: null, deliveries: { sent: 0, skipped: 0, failed: 0 } }
  });
  assert.deepEqual(snapshot.bots, [
    { name: 'echo', enabled: true, ready: false, repliesSent: 0, repeatsConfirmed: 0, repeatsUnconfirmed: 0 }
  ]);
});

test('the first radio.connected does not count as a reconnect; subsequent ones do', () => {
  const radioManager = fakeRadioManager();
  const health = new ServiceHealth({
    radioManager,
    mqttManager: fakeMqttManager(),
    packetPipeline: fakePacketPipeline(),
    bots: []
  });

  radioManager.setConnected(true);
  radioManager.emit('radio.connected', {});
  assert.equal(health.snapshot().radioReconnectCount, 0);
  assert.ok(health.snapshot().radioLastConnectedAt);

  radioManager.emit('radio.connected', {});
  assert.equal(health.snapshot().radioReconnectCount, 1);

  radioManager.emit('radio.connected', {});
  assert.equal(health.snapshot().radioReconnectCount, 2);
});

test('radioConnected always reflects the radio manager live, not a cached flag', () => {
  const radioManager = fakeRadioManager();
  const health = new ServiceHealth({
    radioManager,
    mqttManager: fakeMqttManager(),
    packetPipeline: fakePacketPipeline(),
    bots: []
  });

  radioManager.setConnected(true);
  radioManager.emit('radio.connected', {});
  assert.equal(health.snapshot().radioConnected, true);

  // Disconnected without an explicit event - snapshot must still reflect
  // live state rather than a stale "true" from the last connected event.
  radioManager.setConnected(false);
  assert.equal(health.snapshot().radioConnected, false);
});

test('counts raw packets received and packets that made it through the pipeline separately', () => {
  const radioManager = fakeRadioManager();
  const packetPipeline = fakePacketPipeline();
  const health = new ServiceHealth({
    radioManager,
    mqttManager: fakeMqttManager(),
    packetPipeline,
    bots: []
  });

  radioManager.emit('radio.packet', {});
  radioManager.emit('radio.packet', {});
  radioManager.emit('radio.packet', {});
  packetPipeline.emit('packet', {});

  const snapshot = health.snapshot();
  assert.equal(snapshot.packetsReceived, 3);
  assert.equal(snapshot.packetsDecoded, 1);
});

test('tallies published packets by their packet_type code', () => {
  const packetPipeline = fakePacketPipeline();
  const health = new ServiceHealth({
    radioManager: fakeRadioManager(),
    mqttManager: fakeMqttManager(),
    packetPipeline,
    bots: []
  });

  packetPipeline.emit('packet', { packet_type: '4' }); // ADVERT
  packetPipeline.emit('packet', { packet_type: '4' });
  packetPipeline.emit('packet', { packet_type: '5' }); // GRP_TXT
  packetPipeline.emit('packet', { packet_type: '15' }); // RAW_CUSTOM

  assert.deepEqual(health.snapshot().packetsByType, { 4: 2, 5: 1, 15: 1 });
});

test('tracks per-broker lastConnectedAt while connected reflects the current state live', () => {
  const mqttManager = fakeMqttManager({ okimesh: 'connecting' });
  const health = new ServiceHealth({
    radioManager: fakeRadioManager(),
    mqttManager,
    packetPipeline: fakePacketPipeline(),
    bots: [],
    now: () => new Date('2024-01-01T00:00:00.000Z')
  });

  mqttManager.setStates({ okimesh: 'connected' });
  mqttManager.emit('broker.connected', 'okimesh');

  let snapshot = health.snapshot();
  assert.deepEqual(snapshot.mqtt.okimesh, {
    connected: true,
    lastConnectedAt: new Date('2024-01-01T00:00:00.000Z'),
    deliveries: { sent: 0, skipped: 0, failed: 0 }
  });

  // Broker drops to retrying: connected flips live, but the last-connected
  // timestamp is retained rather than reset to null.
  mqttManager.setStates({ okimesh: 'retrying' });
  snapshot = health.snapshot();
  assert.equal(snapshot.mqtt.okimesh.connected, false);
  assert.deepEqual(snapshot.mqtt.okimesh.lastConnectedAt, new Date('2024-01-01T00:00:00.000Z'));
});

test('recordPublishResults tallies cumulative per-broker sent/skipped/failed outcomes', () => {
  const mqttManager = fakeMqttManager({ okimesh: 'connected', letsmesh: 'connected' });
  const health = new ServiceHealth({
    radioManager: fakeRadioManager(),
    mqttManager,
    packetPipeline: fakePacketPipeline(),
    bots: []
  });

  health.recordPublishResults([
    { brokerId: 'okimesh', outcome: 'sent' },
    { brokerId: 'letsmesh', outcome: 'skipped' }
  ]);
  health.recordPublishResults([
    { brokerId: 'okimesh', outcome: 'sent' },
    { brokerId: 'letsmesh', outcome: 'failed' }
  ]);

  const snapshot = health.snapshot();
  assert.deepEqual(snapshot.mqtt.okimesh.deliveries, { sent: 2, skipped: 0, failed: 0 });
  assert.deepEqual(snapshot.mqtt.letsmesh.deliveries, { sent: 0, skipped: 1, failed: 1 });
});

test('an earlier snapshot\'s deliveries stay frozen at their point in time, unaffected by later recordPublishResults calls', () => {
  // Regression test: snapshot() used to return the #brokerDeliveries Map's
  // own object by reference, so an earlier snapshot's counts silently kept
  // changing underneath callers as more publishes were recorded - which
  // broke metrics-sample.js's tick-to-tick delta (prevSnapshot and the new
  // snapshot ended up aliasing the same mutated object, so every delta
  // after the first collapsed to ~0 regardless of real publish volume).
  const mqttManager = fakeMqttManager({ okimesh: 'connected' });
  const health = new ServiceHealth({
    radioManager: fakeRadioManager(),
    mqttManager,
    packetPipeline: fakePacketPipeline(),
    bots: []
  });

  health.recordPublishResults([{ brokerId: 'okimesh', outcome: 'sent' }]);
  const firstSnapshot = health.snapshot();

  health.recordPublishResults([{ brokerId: 'okimesh', outcome: 'sent' }]);
  health.recordPublishResults([{ brokerId: 'okimesh', outcome: 'sent' }]);
  const secondSnapshot = health.snapshot();

  assert.deepEqual(firstSnapshot.mqtt.okimesh.deliveries, { sent: 1, skipped: 0, failed: 0 });
  assert.deepEqual(secondSnapshot.mqtt.okimesh.deliveries, { sent: 3, skipped: 0, failed: 0 });
});

test('each bot reports its own live ready/repliesSent, not a snapshot taken once', () => {
  const bot = fakeBot({ ready: false, repliesSent: 0 });
  const health = new ServiceHealth({
    radioManager: fakeRadioManager(),
    mqttManager: fakeMqttManager(),
    packetPipeline: fakePacketPipeline(),
    bots: [{ name: 'echo', enabled: true, bot }]
  });

  assert.equal(health.snapshot().bots[0].ready, false);

  bot.isReady = () => true;
  bot.getRepliesSent = () => 5;

  const snapshot = health.snapshot();
  assert.equal(snapshot.bots[0].ready, true);
  assert.equal(snapshot.bots[0].repliesSent, 5);
});

test('reports multiple independent bots, including a disabled one', () => {
  const health = new ServiceHealth({
    radioManager: fakeRadioManager(),
    mqttManager: fakeMqttManager(),
    packetPipeline: fakePacketPipeline(),
    bots: [
      { name: 'echo', enabled: true, bot: fakeBot({ ready: true, repliesSent: 2 }) },
      { name: 'weather', enabled: false, bot: fakeBot({ ready: false, repliesSent: 0 }) }
    ]
  });

  const snapshot = health.snapshot();
  assert.equal(snapshot.bots.length, 2);
  assert.deepEqual(snapshot.bots[0], {
    name: 'echo',
    enabled: true,
    ready: true,
    repliesSent: 2,
    repeatsConfirmed: 0,
    repeatsUnconfirmed: 0
  });
  assert.deepEqual(snapshot.bots[1], {
    name: 'weather',
    enabled: false,
    ready: false,
    repliesSent: 0,
    repeatsConfirmed: 0,
    repeatsUnconfirmed: 0
  });
});

test('defaults replyQueue to a zero size when none is provided', () => {
  const health = new ServiceHealth({
    radioManager: fakeRadioManager(),
    mqttManager: fakeMqttManager(),
    packetPipeline: fakePacketPipeline(),
    bots: []
  });

  assert.deepEqual(health.snapshot().replyQueue, { size: 0 });
});

test('reports the injected replyQueue\'s live size, not a snapshot taken once', () => {
  let stats = { size: 1 };
  const replyQueue = { getStats: () => stats };
  const health = new ServiceHealth({
    radioManager: fakeRadioManager(),
    mqttManager: fakeMqttManager(),
    packetPipeline: fakePacketPipeline(),
    bots: [],
    replyQueue
  });

  assert.deepEqual(health.snapshot().replyQueue, stats);

  stats = { size: 0 };
  assert.deepEqual(health.snapshot().replyQueue, stats);
});
