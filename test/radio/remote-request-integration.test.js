import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { NodeJSSerialConnection, TCPConnection, Constants } from '@liamcottle/meshcore.js';
import { RadioManager } from '../../src/radio/radio-manager.js';
import { RemoteRequestCoordinator } from '../../src/radio/remote-request-coordinator.js';
import { AirtimeCoordinator } from '../../src/radio/airtime-coordinator.js';
import { FloodAdvertScheduler } from '../../src/radio/flood-advert-scheduler.js';
import { ReplyQueue } from '../../src/bots/reply-queue.js';
import { ChannelBot } from '../../src/bots/channel-bot.js';
import { createReplyDispatcher } from '../../src/bots/reply-dispatcher.js';
import { deriveHashtagChannelKey } from '../../src/bots/channel-key.js';
import { MetricsStore } from '../../src/metrics/store.js';
import { PacketPipeline } from '../../src/packets/packet-pipeline.js';
import { ObserverPublisher } from '../../src/mqtt/observer-publisher.js';
import { LetsMeshAuth } from '../../src/mqtt/letsmesh-auth.js';
import { buildRawFrame, RouteType, PayloadType } from '../fixtures/packet-frames.js';

const fixtures = [];
const OBSERVER = 'BE'.repeat(32);
const key = deriveHashtagChannelKey('#echo'); // Public test hashtag, no credential.
const request = index => ({ requestId: '12345678-1234-4abc-8def-' + String(index).padStart(12, '0'),
  targetPublicKey: 'AC'.repeat(32), operation: 'status', params: {} });
const noop = () => {};
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
function sent(tag, route = 0) {
  const bytes = Buffer.alloc(10); bytes[0] = 6; bytes[1] = route;
  bytes.writeUInt32LE(tag, 2); bytes.writeUInt32LE(5000, 6); return [...bytes];
}
function binary(tag) {
  const bytes = Buffer.alloc(8); bytes[0] = 0x8C; bytes.writeUInt32LE(tag, 2); bytes[6] = 1; return [...bytes];
}
function groupText(text = 'Fixture: !echo') {
  const header = Buffer.alloc(5); header.writeUInt32LE(1700000000, 0);
  const unpadded = Buffer.concat([header, Buffer.from(text), Buffer.from([0])]);
  const plain = Buffer.concat([unpadded, Buffer.alloc(Math.ceil(unpadded.length / 16) * 16 - unpadded.length)]);
  const cipher = createCipheriv('aes-128-ecb', key, null); cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac('sha256', Buffer.concat([key, Buffer.alloc(16)])).update(ciphertext).digest().subarray(0, 2);
  const payload = Buffer.concat([createHash('sha256').update(key).digest().subarray(0, 1), mac, ciphertext]);
  return buildRawFrame({ payloadType: PayloadType.GRP_TXT, routeType: RouteType.FLOOD, hops: ['AC'], payload });
}
async function rig({ kind = 'serial', actors = false, responseTimeoutMaxMs = 10000 } = {}) {
  vi.useFakeTimers(); const clock = { value: 0 }; const sdk = []; const attempts = []; const publications = [];
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const store = new MetricsStore({ dbPath: ':memory:' });
  function openTransport() {
    const connection = kind === 'serial' ? new NodeJSSerialConnection('UNUSED') : new TCPConnection('unused', 0);
    connection.getSelfInfo = async () => ({ publicKey: [...Buffer.from(OBSERVER, 'hex')], name: 'Offline fixture' });
    connection.getDeviceTime = async () => ({ epochSecs: Math.floor(Date.now() / 1000) });
    connection.setDeviceTime = async () => {}; connection.deviceQuery = async () => ({});
    connection.getChannels = async () => [{ channelIdx: 0, name: '#echo', secret: key }];
    connection.sendChannelTextMessage = vi.fn(async () => {});
    connection.sendFloodAdvert = vi.fn(async () => {});
    connection.sign = vi.fn(async () => new Uint8Array(64).fill(7));
    connection.sendToRadioFrame = vi.fn(async bytes => {
      attempts.push({ at: clock.value, bytes: [...bytes] });
      if (connection.failWrite) throw Error('fixture raw exception must not enter logs');
    });
    // Native close methods, stub drivers only; neither transport connects.
    if (kind === 'serial') connection.serialPort = { close: () => { connection.onDisconnected(); return connection.serialPort; } };
    else connection.socket = { destroy: () => connection.onDisconnected() };
    connection.probe = noop; connection.on('rx', connection.probe); sdk.push(connection); return connection;
  }
  const radio = new RadioManager({ config: { radio: { reconnect: { maxRetries: 0, initialDelayMs: 10, maxDelayMs: 10 } } },
    logger, openTransport, closeTimeoutMs: 100 });
  const airtime = new AirtimeCoordinator({ quietMs: 20, now: () => clock.value });
  const pipeline = new PacketPipeline({ logger, getObserverIdentity: () => ({ origin: 'Offline fixture', originId: OBSERVER }) });
  const publisher = new ObserverPublisher({ iata: 'CVG', clientVersion: '2.4.0',
    mqttManager: { publish: async (...args) => { publications.push(args); return []; } } });
  pipeline.on('packet', packet => publisher.publishPacket(packet));
  radio.on('radio.packet', raw => pipeline.handleRawPacket(raw));
  radio.on('radio.packet', () => airtime.noteActivity());
  let replyQueue, bot, scheduler;
  if (actors) {
    const bots = new Map();
    replyQueue = new ReplyQueue({ ttlMs: 60000, pollIntervalMs: 5, logger, store,
      airtimeCoordinator: airtime, dispatch: createReplyDispatcher(bots), now: () => clock.value });
    bot = new ChannelBot({ radioManager: radio, replyQueue, logger, now: () => clock.value,
      botConfig: { name: 'echo', channel: '#echo', enabled: true, minHops: 1,
        commands: [{ trigger: '!echo', response: 'reply to {sender}' }] } });
    bots.set('echo', bot); bot.start(); replyQueue.start();
    scheduler = new FloodAdvertScheduler({ radioManager: radio, airtimeCoordinator: airtime, store, logger,
      intervalHours: 0, pollIntervalMs: 5, now: () => clock.value }); scheduler.start();
  }
  const coordinator = new RemoteRequestCoordinator({ radio, logger, airtimeCoordinator: airtime,
    hasForegroundWork: () => (replyQueue?.size ?? 0) > 0 || ['pending', 'sending'].includes(store.getFloodAdvertState().status),
    ackTimeoutMs: 1000, responseTimeoutMaxMs, minIntervalMs: 10000, maxPerMinute: 6,
    now: () => clock.value, uniquenessBytes: () => [1, 2, 3, 4] });
  const f = { clock, radio, airtime, coordinator, sdk, store, logger, attempts, publications, pipeline, replyQueue, bot, scheduler,
    current: () => sdk.at(-1),
    tick: async ms => { clock.value += ms; await vi.advanceTimersByTimeAsync(ms); await flush(); } };
  fixtures.push(f);
  const ready = new Promise(resolve => radio.once('radio.connected', resolve)); radio.start(); await ready; await flush();
  clock.value = 10000; await f.tick(5);
  if (bot) assert.equal(bot.isReady(), true);
  return f;
}
async function frame(f, bytes, connection = f.current()) {
  const data = Buffer.from(bytes);
  const wire = Buffer.concat([Buffer.from([Constants.SerialFrameTypes.Incoming, data.length & 255, data.length >> 8]), data]);
  if (connection instanceof TCPConnection) {
    connection.onSocketDataReceived(wire.subarray(0, 2)); connection.onSocketDataReceived(wire.subarray(2));
  } else { await connection.onDataReceived(wire.subarray(0, 2)); await connection.onDataReceived(wire.subarray(2)); }
  await f.tick(1);
}
async function packet(f, raw = groupText(), count = 1) {
  for (let n = 0; n < count; n++) f.current().emit(Constants.PushCodes.LogRxData, { raw, lastSnr: 4, lastRssi: -90 });
  await f.tick(1);
}
async function idle(f) {
  await flush();
  assert.equal(f.current().eventListenersMap.get('rx').length, 1, 'only unrelated raw probe remains');
  assert.equal(f.current().readBuffer.length, 0, 'fragmented frame buffer drained');
  let signal; await f.radio.runCommand((_, context) => { signal = context.signal; });
  assert.equal(getEventListeners(signal, 'abort').length, 0, 'owned cancellation listeners removed');
  assert.equal(f.radio.listenerCount('radio.connected'), f.bot ? 2 : 0);
  assert.equal(f.radio.listenerCount('radio.disconnected'), f.scheduler ? 1 : 0);
  assert.equal(vi.getTimerCount(), f.scheduler ? 1 : 0);
}
afterEach(async () => {
  try {
    for (const f of fixtures.splice(0)) {
      const stopping = f.coordinator.stop(); await f.tick(101); await stopping;
      f.bot?.stop(); await f.scheduler?.stop(); await f.replyQueue?.stop();
      const closed = f.radio.stop(); await f.tick(101); await closed;
      for (const connection of f.sdk) {
        connection.off('rx', connection.probe);
        assert.equal([...connection.eventListenersMap.values()].flat().length, 0, 'SDK owned listeners drained at stop');
      }
      f.store.close(); assert.equal(vi.getTimerCount(), 0);
    }
  } finally { vi.useRealTimers(); }
});

for (const kind of ['serial', 'tcp']) test(`${kind}: bot, advert, signing and packet publication continue during a remote reply wait`, async () => {
  const f = await rig({ kind, actors: true }); const connection = f.current();
  assert.equal(connection.sendFloodAdvert.mock.calls.length, 1, 'existing startup advert only');
  await f.tick(20); const result = f.coordinator.tryRequest(request(1)); await flush();
  assert.equal(f.attempts.length, 1); await frame(f, sent(42));
  let settled = false; result.then(() => { settled = true; });
  await packet(f, groupText(), 2); assert.equal(f.publications.length, 2, 'every physical reception published');
  assert.equal(f.replyQueue.size, 1, 'bot duplicate filtering accepts only one invocation'); await f.tick(30);
  assert.equal(connection.sendChannelTextMessage.mock.calls.length, 1); assert.equal(f.bot.getRepliesSent(), 1);
  assert.deepEqual(connection.sendChannelTextMessage.mock.calls[0], [0, 'reply to Fixture']);
  f.store.requestFloodAdvert(f.clock.value); await f.tick(30); assert.equal(connection.sendFloodAdvert.mock.calls.length, 2);
  const auth = new LetsMeshAuth({ radioManager: f.radio, audience: 'fixture', logger: f.logger });
  const token = await auth.createToken(); assert.equal(connection.sign.mock.calls.length, 1); assert.equal(token.split('.').length, 3);
  assert.equal(await f.radio.runCommand(() => 'local query'), 'local query'); assert.equal(settled, false);
  const keys = ['RSSI', 'SNR', 'direction', 'hash', 'len', 'origin', 'origin_id', 'packet_type', 'payload_len', 'raw', 'route', 'timestamp', 'type'].sort();
  for (const [topic, serialized, options] of f.publications) {
    const value = JSON.parse(serialized); assert.deepEqual(Object.keys(value).sort(), keys);
    assert.ok(topic.includes(OBSERVER)); assert.deepEqual(options, { retain: false });
    assert.equal(value.raw, groupText().toString('hex').toUpperCase()); assert.equal(value.origin_id, OBSERVER);
    assert.equal(value.SNR, '4'); assert.equal(value.RSSI, '-90'); assert.equal(value.route, 'F'); assert.equal(value.type, 'PACKET');
  }
  assert.equal(JSON.parse(f.publications[0][1]).hash, JSON.parse(f.publications[1][1]).hash);
  assert.equal(JSON.stringify(Object.values(f.logger).flatMap(method => method.mock.calls)).includes(token), false);
  await frame(f, binary(42)); assert.equal((await result).status, 'completed'); await idle(f);
});

test('durable foreground arriving while a remote command is queued cancels the background dispatch', async () => {
  const f = await rig({ actors: true }); await f.tick(20);
  let release; const local = f.radio.runCommand(() => new Promise(resolve => { release = resolve; })); await flush();
  const result = f.coordinator.tryRequest(request(1)); await flush(); await packet(f);
  assert.equal(f.replyQueue.size, 1); release(); await local; await flush();
  assert.equal((await result).reason, 'foreground'); assert.equal(f.attempts.length, 0);
  await f.tick(30); assert.equal(f.bot.getRepliesSent(), 1); await f.tick(20);
  const next = f.coordinator.tryRequest(request(2)); await flush(); await frame(f, sent(43)); await frame(f, binary(43));
  assert.equal((await next).status, 'completed'); await idle(f);
});

test('1,000 mixed terminal cycles bound ownership, timers, listeners, budgets and reconnect work', async () => {
  const f = await rig({ responseTimeoutMaxMs: 1000 }); const outcomes = {};
  for (let index = 0; index < 1000; index++) {
    f.clock.value += 20000;
    const connection = f.current(), mode = index % 8, tag = index + 1;
    connection.failWrite = mode === 6;
    const result = f.coordinator.tryRequest(request(index + 1), { expectedRoute: 'direct' });
    assert.equal((await f.coordinator.tryRequest(request(index + 2))).reason, 'busy'); await flush();
    assert.equal(f.attempts.length, index + 1);
    if (mode === 0 || mode === 3) {
      if (mode === 3) await frame(f, binary(tag)); // pre-ACK response ignored
      await frame(f, sent(tag));
      if (mode === 3) await frame(f, binary(tag + 10000));
      await frame(f, binary(tag));
    } else if (mode === 1) await frame(f, [1, 2]);
    else if (mode === 2) { await frame(f, sent(tag)); await f.tick(1000); }
    else if (mode === 4) { connection.emit('rx', [6]); await f.tick(2); } // malformed owned envelope, no unsafe SDK offset read
    else if (mode === 5) await f.tick(1002);
    else if (mode === 6) await f.tick(2);
    else await frame(f, sent(tag, 1));
    const terminal = await result; const outcome = terminal.reason ?? terminal.status;
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if ([4, 5, 6].includes(mode)) { assert.equal(terminal.recovery, 'reset'); await f.tick(10); assert.notEqual(f.current(), connection); }
    // Already scheduled/raw callbacks on retired transports cannot touch a new owner.
    connection.emit('rx', binary(tag)); await f.tick(1); await idle(f);
    const last = f.attempts.at(-1).at;
    assert.ok(f.attempts.filter(attempt => last - attempt.at < 60000).length <= 6);
    if (index > 0) assert.ok(last - f.attempts[index - 1].at >= 10000);
    if (index % 20 === 0) {
      for (const previous of f.sdk.slice(0, -1)) assert.equal([...previous.eventListenersMap.values()].flat().length, 1);
    }
  }
  assert.deepEqual(outcomes, { completed: 250, 'command-error': 125, 'response-timeout': 125,
    'protocol-error': 125, 'ack-timeout': 125, 'write-error': 125, 'route-mismatch': 125 });
  assert.equal(f.sdk.length, 376, 'one captured-generation reconnect per ambiguous ACK failure');
  assert.equal(JSON.stringify(f.logger.warn.mock.calls).includes('fixture raw exception'), false);
  console.info('Remote cycle fixture:', { cycles: 1000, completed: 250, failed: 750, generations: f.sdk.length,
    ownedListenersAfterCycle: 0, ownedTimersAfterCycle: 0, maxAttemptsPerMinute: 6, minimumSpacingMs: 10000 });
}, 60000);

test('continuous busy air yields bounded deferrals and uninterrupted capture without retries or catch-up', async () => {
  const f = await rig();
  for (let n = 0; n < 1000; n++) {
    f.clock.value += 250; await packet(f);
    assert.equal((await f.coordinator.tryRequest(request(n + 1))).reason, 'quiet-air');
    assert.equal(vi.getTimerCount(), 0);
  }
  assert.equal(f.publications.length, 1000); assert.equal(f.attempts.length, 0);
  await f.tick(20); assert.equal(f.attempts.length, 0, 'no coordinator retry/backlog');
  const result = f.coordinator.tryRequest(request(1001)); await flush(); await frame(f, sent(1001)); await frame(f, binary(1001));
  assert.equal((await result).status, 'completed'); assert.equal(f.attempts.length, 1); await idle(f);
}, 30000);
