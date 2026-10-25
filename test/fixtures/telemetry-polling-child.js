// Real entrypoint with synthetic SDK transport frames and controlled clocks.
// No scheduler/coordinator/parser is replaced; no network or hardware opens.
import { readFileSync, appendFileSync } from 'node:fs';
import { mock } from 'node:test';
import { performance } from 'node:perf_hooks';
import net from 'node:net';
import { TCPConnection, Constants } from '@liamcottle/meshcore.js';
import { MetricsStore } from '../../src/metrics/store.js';
import { RadioManager } from '../../src/radio/radio-manager.js';
import { MetricsServer } from '../../src/web/metrics-server.js';
import mqtt from 'mqtt';
import { loadConfig } from '../../src/config/index.js';
import { telemetryWire, telemetryBytes, neighbourPage } from './telemetry-wire.js';
import { telemetryContactFrame, telemetryInventoryBoundary } from './telemetry-radio-wire.js';

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { observerPublicKey, targetPublicKey, startAt, ledger } = fixture;
mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: startAt });
// Jump elapsed wall/monotonic time without replaying every missed sampler tick.
// Timer progression remains explicit; new packet timestamps use this same clock.
let clockOffset = 0;
const timerNow = Date.now;
Date.now = () => timerNow() + clockOffset;
Object.defineProperty(performance, 'now', { value: () => Date.now() - startAt });
for (const [set, clear] of [['setTimeout', 'clearTimeout'], ['setInterval', 'clearInterval']]) {
  const originalSet = globalThis[set], originalClear = globalThis[clear];
  globalThis[set] = (...args) => ({ handle: originalSet(...args), unref() { return this; } });
  globalThis[clear] = timer => originalClear(timer?.handle ?? timer);
}
net.createConnection = () => { throw Error('Unexpected real network connection'); };
mqtt.default.connect = () => { throw Error('Unexpected broker connection'); };
MetricsServer.prototype.start = () => { throw Error('Unexpected HTTP listener'); };
let store, run, radio, closed = false, identity = observerPublicKey;
let writeFault = fixture.writeFault ?? false, mode = fixture.mode ?? 'success';
let pending = null, serverTimestamp = fixture.serverTimestamp ?? 100;
const connections = [], writes = [], replies = [], publishTopics = [], localCalls = [];
const range = { start: 0, end: Number.MAX_SAFE_INTEGER };
const record = value => appendFileSync(ledger, JSON.stringify(value) + '\n');
const crash = (boundary, component) => {
  if (fixture.phase === boundary && component === (fixture.crashComponent ?? 'sensors')) process.exit(17);
};
async function pump(ms = 0) {
  do {
    const step = Math.min(ms, 1000); mock.timers.tick(step); ms -= step;
    for (let n = 0; n < 100; n++) { await Promise.resolve(); mock.timers.tick(0); }
  } while (ms > 0);
}
function feed(bytes, connection = connections.at(-1)) {
  const data = Buffer.from(bytes);
  const wire = Buffer.concat([Buffer.from([Constants.SerialFrameTypes.Incoming, data.length & 255, data.length >> 8]), data]);
  connection.onSocketDataReceived(wire.subarray(0, 2));
  connection.onSocketDataReceived(wire.subarray(2));
}
function ack(tag, route = 0) {
  const bytes = Buffer.alloc(10); bytes[0] = 6; bytes[1] = route;
  bytes.writeUInt32LE(tag, 2); bytes.writeUInt32LE(1000, 6); return [...bytes];
}
function guest() {
  if (mode === 'legacy') return [0x85, 0, ...Buffer.from(targetPublicKey, 'hex').subarray(0, 6)];
  if (mode === 'denied') return [0x86, 0, ...Buffer.from(targetPublicKey, 'hex').subarray(0, 6)];
  const bytes = Buffer.alloc(14); bytes[0] = 0x85; bytes[1] = mode === 'admin' ? 1 : 0;
  bytes.set(Buffer.from(targetPublicKey, 'hex').subarray(0, 6), 2);
  bytes.writeUInt32LE(serverTimestamp, 8); bytes[12] = mode === 'read-write' ? 2 : 0; bytes[13] = 2;
  return [...bytes];
}
function binary(tag, component) {
  const header = Buffer.alloc(6); header[0] = 0x8C; header.writeUInt32LE(tag, 2);
  const body = mode === 'malformed' ? [1] : component === 'status' ? telemetryBytes(telemetryWire.status48)
    : component === 'sensors' ? telemetryBytes(telemetryWire.sensors)
      : mode === 'empty' ? [0, 0, 0, 0] : neighbourPage([{ prefix: 'DD'.repeat(32), age: 5, snr: -16 }], { prefixLength: 32 });
  return [...header, ...body];
}
TCPConnection.prototype.connect = async function () {
  this.socket = { destroy: () => this.onDisconnected() };
  connections.push(this); this.onConnected(); return this.socket;
};
TCPConnection.prototype.getSelfInfo = async () => ({ publicKey: [...Buffer.from(identity, 'hex')], name: 'Offline polling fixture' });
TCPConnection.prototype.getDeviceTime = async () => ({ epochSecs: Math.floor(Date.now() / 1000) });
TCPConnection.prototype.deviceQuery = async () => ({});
TCPConnection.prototype.getChannels = async () => [{ channelIdx: 0, name: '#echo', secret: fixture.channelKey }];
TCPConnection.prototype.sendFloodAdvert = async () => {};
TCPConnection.prototype.sendChannelTextMessage = async (channel, text) => { replies.push({ channel, text }); };
TCPConnection.prototype.sign = async () => { localCalls.push('sign'); return new Uint8Array(64).fill(7); };
TCPConnection.prototype.sendToRadioFrame = async function (bytes) {
  const code = bytes[0], component = code === 26 ? 'guest-login' : code === 50
    ? ({ 1: 'status', 3: 'sensors', 6: 'neighbours' })[bytes[33]] : null;
  // Password-bearing guest wire buffers never enter IPC, logs or the ledger.
  const write = { at: Date.now(), generation: connections.indexOf(this) + 1, code, component };
  if (component) {
    const reservation = store.getTelemetryPollState({ observerPublicKey: identity, targetPublicKey, variant: variants().find(v => v.component === component) });
    if (reservation?.reason !== 'reserved' || reservation.reservedAt !== Date.now()) throw Error('Physical send lacks durable reservation');
    write.requestId = reservation.requestId;
  }
  writes.push(write); record(write);
  if (code === 4) {
    if (fixture.contact === 'unsupported') { feed([1, 1], this); return; }
    feed(telemetryInventoryBoundary(2, 1), this);
    feed(telemetryContactFrame({ key: targetPublicKey }), this);
    if (fixture.contact === 'collision') feed(telemetryContactFrame({ key: targetPublicKey.slice(0, 12) + 'EE'.repeat(26) }), this);
    feed(telemetryInventoryBoundary(4), this); return;
  }
  if (code === 30) {
    feed(telemetryContactFrame({ key: targetPublicKey,
      encodedPathLength: fixture.contact === 'flood' ? 255 : fixture.contact === 'out-of-radius' ? 2 : 0,
      path: fixture.contact === 'out-of-radius' ? [1, 2] : [] }), this); return;
  }
  // Contact reconciliation is a local companion command, not a telemetry RF
  // request. Acknowledge the real SDK method so entrypoint fixtures exercise
  // the subsequent exact-key read and login/data flow.
  if (code === Constants.CommandCodes.AddUpdateContact || code === Constants.CommandCodes.RemoveContact) {
    feed([Constants.ResponseCodes.Ok], this); return;
  }
  if (!component) throw Error('Unexpected contact mutation or command');
  crash('after-send', component);
  if (mode === 'unsupported') { feed([1, 1], this); return; }
  const tag = component === 'guest-login' ? Buffer.from(targetPublicKey, 'hex').readUInt32LE(0) : Buffer.from(bytes).readUInt32LE(34);
  pending = { tag, component, connection: this };
  if (mode === 'ack-wait') return;
  feed(ack(tag, mode === 'flood-ack' ? 1 : 0), this);
  if (mode === 'hold' || mode === 'flood-ack') return;
  feed(component === 'guest-login' ? guest() : binary(tag, component), this);
};
const begin = MetricsStore.prototype.beginObserverRun;
MetricsStore.prototype.beginObserverRun = function (input) { store = this; run = begin.call(this, input); return run; };
const reserve = MetricsStore.prototype.reserveTelemetryPoll;
MetricsStore.prototype.reserveTelemetryPoll = function (input) {
  crash('before-reservation', input.variant.component); const result = reserve.call(this, input);
  if (result.reserved) crash('after-reservation', input.variant.component); return result;
};
for (const [method, componentOf] of [['completeTelemetryAuthentication', () => 'guest-login'],
  ['completeTelemetryPoll', input => input.result.outcome.variant.component]]) {
  const original = MetricsStore.prototype[method];
  MetricsStore.prototype[method] = function (input) {
    const component = componentOf(input); crash('before-completion', component);
    if (writeFault && component === (fixture.faultComponent ?? 'sensors')) throw Error('PRIVATE-ONLY7');
    const result = original.call(this, input); if (result.completed) crash('after-completion', component); return result;
  };
}
const start = RadioManager.prototype.start;
RadioManager.prototype.start = function () { radio = this; return start.call(this); };
const close = MetricsStore.prototype.close;
MetricsStore.prototype.close = function () {
  record({ closedRun: store.getObserverRun({ runId: run.runId }).state }); close.call(this);
  closed = true; if (process.connected) process.disconnect();
};
// Empty broker configuration keeps the actual MQTT manager offline. Observe
// capture through its ordinary publication call without opening a connection.
const { MqttManager } = await import('../../src/mqtt/mqtt-manager.js');
const publish = MqttManager.prototype.publish;
MqttManager.prototype.publish = function (topic, ...args) { publishTopics.push(topic); return publish.call(this, topic, ...args); };
function variants() {
  const c = loadConfig().telemetryPolling;
  const profile = c.targetProfiles.find(p => p.targetPublicKey === targetPublicKey)?.statusProfile ?? c.statusProfile;
  return [{ component: 'guest-login', params: {} }, { component: 'status', params: {}, profile },
    { component: 'sensors', params: { permissionMask: 0 } }, { component: 'neighbours', params: c.neighbourParams }];
}
function snapshot() {
  return { now: Date.now(), runId: run.runId, instanceId: run.instanceId, radio: radio.getConnectionSnapshot(), writes,
    replies, localCalls, publishTopics, runs: store.queryObserverRuns(range),
    auth: store.queryTelemetryAuthenticationOutcomes(range), outcomes: store.queryTelemetryOutcomes(range),
    observations: store.queryTelemetryObservations(range),
    states: variants().map(variant => store.getTelemetryPollState({ observerPublicKey, targetPublicKey, variant })),
    inventory: store.countNodesByType('REPEATER'), advertTotals: store.queryAdvertTotals(range),
    candidates: store.queryTelemetryPollCandidates({ observerPublicKey: identity, now: Date.now(), windowMs: 72 * 3600000, radius: 2 }),
    botUsage: store.queryBotUsageTotals(range), resources: store.queryProcessSamples(range) };
}
let commands = Promise.resolve();
process.on('message', message => {
  commands = commands.then(async () => {
    if (message.action === 'tick') await pump(message.ms);
    if (message.action === 'jump') { clockOffset += message.ms; await pump(1000); }
    if (message.action === 'advert' || message.action === 'group') {
      const raw = Buffer.from(message.action === 'advert' ? (message.raw ?? fixture.advertRaw) : fixture.groupRaw, 'hex');
      for (let n = 0; n < (message.count ?? 1); n++) connections.at(-1).emit(Constants.PushCodes.LogRxData, { raw, lastSnr: 4, lastRssi: -90 });
      // Signature verification yields through crypto; drain actual callbacks.
      for (let n = 0; n < 4; n++) { await new Promise(resolve => setImmediate(resolve)); await pump(); }
    }
    if (message.action === 'due') {
      const c = loadConfig().telemetryPolling;
      const policy = Object.fromEntries(['refreshIntervalMs', 'retryBaseMs', 'retryMaxMs', 'maxAttempts', 'authCooldownMs'].map(k => [k, c[k]]));
      for (const variant of variants().filter(v => v.component !== 'guest-login' && c.components[v.component])) {
        store.deferTelemetryPoll({ observerPublicKey, targetPublicKey, variant, runId: run.runId,
          observedAt: Date.now(), nextDueAt: Date.now(), reason: 'rate-limited', policy });
      }
    }
    if (message.action === 'mode') { mode = message.value ?? mode; writeFault = message.writeFault ?? writeFault; serverTimestamp = message.serverTimestamp ?? serverTimestamp; }
    if (message.action === 'reply') { feed(pending.component === 'guest-login' ? guest() : binary(message.tag ?? pending.tag, pending.component),
      connections[message.connection ?? connections.length - 1]); await pump(); }
    if (message.action === 'disconnect') { identity = message.identity ?? identity; connections.at(-1).onDisconnected(); await pump(); }
    if (message.action === 'sign') { await radio.runCommand(connection => connection.sign([1, 2])); await pump(); }
    if (message.action === 'stop') { process.emit('SIGINT'); await pump(); if (!closed) await pump(10000); return; }
    if (message.action === 'snapshot') await pump();
    process.send(snapshot());
  }).catch(error => { console.error(error); process.exit(2); });
});
await import('../../src/index.js');
for (let n = 0; n < 8; n++) { await new Promise(resolve => setImmediate(resolve)); await pump(); }
if (radio) {
  await pump(250); process.send({ ready: radio.getConnectionSnapshot().ready });
} else if (process.connected) process.disconnect();
