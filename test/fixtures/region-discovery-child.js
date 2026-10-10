// Actual entrypoint/coordinator/scheduler/store with only SDK drivers and
// clocks substituted. No real TCP socket, radio, broker or dashboard opens.
import { readFileSync, appendFileSync } from 'node:fs';
import { mock } from 'node:test';
import { performance } from 'node:perf_hooks';
import net from 'node:net';
import { TCPConnection, Constants } from '@liamcottle/meshcore.js';
import { MetricsStore } from '../../src/metrics/store.js';
import { RadioManager } from '../../src/radio/radio-manager.js';
import { MqttManager } from '../../src/mqtt/mqtt-manager.js';

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { observerPublicKey, targetPublicKey, startAt, ledger, phase = null } = fixture;
mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: startAt });
Object.defineProperty(performance, 'now', { value: () => Date.now() - startAt });
// Node's builtin mocked handles need the unref contract used by production.
for (const [set, clear] of [['setTimeout', 'clearTimeout'], ['setInterval', 'clearInterval']]) {
  const originalSet = globalThis[set], originalClear = globalThis[clear];
  globalThis[set] = (...args) => ({ handle: originalSet(...args), unref() { return this; } });
  globalThis[clear] = timer => originalClear(timer?.handle ?? timer);
}
net.createConnection = () => { throw Error('Fixture attempted a real network connection'); };
let store, run, radio, closed = false, writeFault = fixture.writeFault ?? false;
let contacts = fixture.contact ?? 'direct', answer = fixture.answer ?? 'nonempty', tag = 17;
const connections = [], writes = [], replies = [], adverts = [], publishTopics = [], localCalls = [];
const record = value => appendFileSync(ledger, JSON.stringify(value) + '\n');
const crash = boundary => { if (phase === boundary) process.exit(17); };
async function pump(ms = 0) {
  mock.timers.tick(ms);
  for (let n = 0; n < 48; n++) { await Promise.resolve(); mock.timers.tick(0); }
}
function feed(bytes, connection = connections.at(-1)) {
  const data = Buffer.from(bytes);
  const wire = Buffer.concat([Buffer.from([Constants.SerialFrameTypes.Incoming, data.length & 255, data.length >> 8]), data]);
  connection.onSocketDataReceived(wire.subarray(0, 2));
  connection.onSocketDataReceived(wire.subarray(2));
}
function contact(key = targetPublicKey, path = 0) {
  const bytes = Array(148).fill(0); bytes[0] = 3; bytes[33] = 2; bytes[35] = path;
  bytes.splice(1, 32, ...Buffer.from(key, 'hex')); return bytes;
}
function sent(route = 0) {
  const bytes = Buffer.alloc(10); bytes[0] = 6; bytes[1] = route;
  bytes.writeUInt32LE(tag, 2); bytes.writeUInt32LE(1000, 6); return [...bytes];
}
function binary(body = [0, 0, 0, 0, ...Buffer.from('*,BE,be-vlg')], responseTag = tag) {
  const bytes = Buffer.alloc(6); bytes[0] = 0x8C; bytes.writeUInt32LE(responseTag, 2);
  return [...bytes, ...body];
}
TCPConnection.prototype.connect = async function () {
  this.socket = { destroy: () => this.onDisconnected() };
  connections.push(this); this.onConnected(); return this.socket;
};
TCPConnection.prototype.getSelfInfo = async () => ({ publicKey: [...Buffer.from(observerPublicKey, 'hex')], name: 'Offline acceptance fixture' });
TCPConnection.prototype.getDeviceTime = async () => ({ epochSecs: Math.floor(Date.now() / 1000) });
TCPConnection.prototype.deviceQuery = async () => ({});
TCPConnection.prototype.getChannels = async () => [{ channelIdx: 0, name: '#echo', secret: fixture.channelKey }];
TCPConnection.prototype.sendFloodAdvert = async () => { adverts.push(Date.now()); };
TCPConnection.prototype.sendChannelTextMessage = async (channel, text) => { replies.push({ channel, text }); };
TCPConnection.prototype.sign = async () => { localCalls.push('sign'); return new Uint8Array(64).fill(7); };
TCPConnection.prototype.sendToRadioFrame = async function (bytes) {
  const write = { at: Date.now(), generation: connections.indexOf(this) + 1, bytes: [...bytes] };
  writes.push(write); record(write);
  if (bytes[0] === 0x1E) {
    if (contacts === 'direct') feed(contact(Buffer.from(bytes.slice(1, 33)).toString('hex').toUpperCase()), this);
    if (contacts === 'unsafe') feed(contact(targetPublicKey, 1), this);
    if (contacts === 'missing') feed([1, 2], this);
    if (contacts === 'full') feed([1, 3], this);
    if (contacts === 'unsupported') feed([1, 1], this);
    if (contacts === 'wrong-key') feed(contact('DD'.repeat(32)), this);
    return;
  }
  if (bytes[0] !== 0x39) throw Error('Forbidden fixture contact/auth command');
  crash('after-send');
  if (answer === 'unsupported') { feed([1, 1], this); return; }
  if (answer === 'ack-wait') return;
  feed(sent(answer === 'flood' ? 1 : 0), this);
  if (answer === 'timeout' || answer === 'hold' || answer === 'flood') return;
  if (answer === 'empty') feed(binary([0, 0, 0, 0]), this);
  if (answer === 'nonempty') feed(binary(), this);
  if (answer === 'malformed') feed(binary([0, 0, 0, 0, ...Buffer.from('bad,,list')]), this);
};
const originalBegin = MetricsStore.prototype.beginObserverRun;
MetricsStore.prototype.beginObserverRun = function (input) {
  store = this; run = originalBegin.call(this, input); return run;
};
const originalReserve = MetricsStore.prototype.reserveRegionPoll;
MetricsStore.prototype.reserveRegionPoll = function (input) {
  crash('before-reservation'); const result = originalReserve.call(this, input);
  if (result.reserved) crash('after-reservation'); return result;
};
const originalComplete = MetricsStore.prototype.completeRegionPoll;
MetricsStore.prototype.completeRegionPoll = function (input) {
  crash('before-completion');
  if (writeFault) throw Error('Private fixture failure must not enter logs');
  const result = originalComplete.call(this, input); if (result.completed) crash('after-completion'); return result;
};
const originalStart = RadioManager.prototype.start;
RadioManager.prototype.start = function () { radio = this; return originalStart.call(this); };
const originalPublish = MqttManager.prototype.publish;
MqttManager.prototype.publish = function (topic, ...args) { publishTopics.push(topic); return originalPublish.call(this, topic, ...args); };
const originalClose = MetricsStore.prototype.close;
MetricsStore.prototype.close = function () {
  record({ closedRun: store.getObserverRun({ runId: run.runId }).state });
  originalClose.call(this); closed = true; if (process.connected) process.disconnect();
};
const range = { start: 0, end: Number.MAX_SAFE_INTEGER };
function snapshot() {
  return { now: Date.now(), runId: run.runId, radio: radio.getConnectionSnapshot(), writes, replies, adverts,
    publishTopics, localCalls, runs: store.queryObserverRuns(range),
    state: store.getRegionPollState({ observerPublicKey, targetPublicKey }),
    latest: store.getRegionLatest({ observerPublicKey, targetPublicKey, now: Date.now(), windowMs: 72 * 3600000 }),
    outcomes: store.queryRegionOutcomes(range), answers: store.queryRegionAnswers(range),
    publications: store.queryRegionPublications({ brokerId: 'unused' }),
    inventory: store.countNodesByType('REPEATER'), advertTotals: store.queryAdvertTotals(range),
    botUsage: store.queryBotUsageTotals(range), pendingReplies: store.countPendingReplyItems(),
    resources: store.queryProcessSamples(range), topology: store.queryTopologyPaths() };
}
let commands = Promise.resolve();
process.on('message', message => {
  commands = commands.then(async () => {
    if (message.action === 'tick') await pump(message.ms);
    if (message.action === 'advert' || message.action === 'group') {
      const raw = Buffer.from(message.action === 'advert' ? (message.second ? fixture.secondAdvertRaw : fixture.advertRaw) : fixture.groupRaw, 'hex');
      for (let n = 0; n < (message.count ?? 1); n++) connections.at(-1).emit(Constants.PushCodes.LogRxData, { raw, lastSnr: 4, lastRssi: -90 });
      await pump();
    }
    if (message.action === 'answer-mode') { answer = message.value; contacts = message.contact ?? contacts; writeFault = message.writeFault ?? writeFault; }
    if (message.action === 'reply') { feed(binary(message.body, message.tag ?? tag), connections[message.connection ?? connections.length - 1]); await pump(); }
    if (message.action === 'disconnect') { connections.at(-1).onDisconnected(); await pump(); }
    if (message.action === 'prune') store.pruneOlderThan(Date.now() + 1);
    if (message.action === 'sign') { await radio.runCommand(connection => connection.sign([1, 2])); await pump(); }
    if (message.action === 'flood-advert') store.requestFloodAdvert(Date.now());
    if (message.action === 'next-tag') tag++;
    if (message.action === 'stop') { process.emit('SIGINT'); await pump(); if (!closed) await pump(10000); return; }
    if (message.action === 'snapshot') await pump();
    process.send(snapshot());
  }).catch(error => { console.error(error); process.exit(2); });
});
await import('../../src/index.js');
for (let n = 0; n < 8; n++) { await new Promise(resolve => setImmediate(resolve)); await pump(); }
await pump(250); // Let the real startup advert finish before advancing discovery.
process.send({ ready: radio?.getConnectionSnapshot().ready ?? false });
