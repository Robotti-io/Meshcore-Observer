// Test-only entrypoint harness: no hardware, broker or internet connection.
import { RadioManager } from '../../src/radio/radio-manager.js';
import { NodeRegistry } from '../../src/nodes/node-registry.js';
import { MetricsStore } from '../../src/metrics/store.js';
import { advertSigner, signedAdvertPacket } from './signed-advert.js';
import { RemoteRequestCoordinator } from '../../src/radio/remote-request-coordinator.js';
import { RemoteRequestBudget } from '../../src/radio/remote-request-budget.js';

const mode = process.argv[2];
let store; let radio; let releaseStop; let releaseAdvert;
const originalBegin = MetricsStore.prototype.beginObserverRun;
MetricsStore.prototype.beginObserverRun = function (input) {
  const result = originalBegin.call(this, input); store = this; return result;
};
const stopGate = new Promise((resolve) => { releaseStop = resolve; });
const advertGate = new Promise((resolve) => { releaseAdvert = resolve; });
if (mode === 'remote-lifecycle') {
  const originalTry = RemoteRequestCoordinator.prototype.tryRequest;
  const originalStop = RemoteRequestCoordinator.prototype.stop;
  let automaticRequests = 0;
  RemoteRequestCoordinator.prototype.tryRequest = function (...args) { automaticRequests++; return originalTry.call(this, ...args); };
  // Probe the actual entrypoint foreground closure without waiting one
  // minute or permitting a send. Every probe has pending foreground work.
  RemoteRequestBudget.prototype.canAttempt = () => true;
  RadioManager.prototype.getConnectionSnapshot = () => ({ generation: 1, ready: true, observerPublicKey: 'CD'.repeat(32) });
  RemoteRequestCoordinator.prototype.stop = async function () {
    const dto = { requestId: '12345678-1234-4abc-8def-123456789abc', targetPublicKey: 'AC'.repeat(32), operation: 'status', params: {} };
    const count = MetricsStore.prototype.countPendingReplyItems;
    MetricsStore.prototype.countPendingReplyItems = () => 1;
    const replies = await originalTry.call(this, dto);
    MetricsStore.prototype.countPendingReplyItems = count;
    store.requestFloodAdvert(Date.now()); const pending = await originalTry.call(this, dto);
    store.startFloodAdvertAttempt(Date.now()); const sending = await originalTry.call(this, dto);
    await originalStop.call(this);
    process.send({ remoteStopping: true, automaticRequests, replies: replies.reason, pending: pending.reason, sending: sending.reason });
    await stopGate;
  };
}
if (mode === 'pending-advert') {
  const originalRecord = NodeRegistry.prototype.recordFromDecodedPacket;
  NodeRegistry.prototype.recordFromDecodedPacket = async function (packet) {
    await advertGate; return originalRecord.call(this, packet);
  };
}
RadioManager.prototype.getDeviceInfo = () => ({ name: 'Offline Observer', publicKey: 'CD'.repeat(32) });
RadioManager.prototype.start = function () {
  radio = this;
  if (mode === 'pending-advert') {
    const packet = signedAdvertPacket(advertSigner().payload({ name: 'Saved before stop' }));
    this.emit('radio.packet', { raw: Buffer.from(packet.raw, 'hex'), lastSnr: -1, lastRssi: -100 });
  }
  process.send({ ready: true });
};
RadioManager.prototype.stop = async () => {
  if (mode === 'delayed-stop') await stopGate;
  if (mode === 'remote-lifecycle') process.send({ radioStopping: true });
};
const originalClose = MetricsStore.prototype.close;
MetricsStore.prototype.close = function () {
  originalClose.call(this);
  if (store === this && process.connected) process.disconnect();
};
process.on('message', (message) => {
  if (message.action === 'snapshot') process.send({ snapshot: store.queryObserverRuns({ start: 0, end: Number.MAX_SAFE_INTEGER }),
    summary: store.queryObserverRuntimeSummary(), nodes: store.countNodesByType('REPEATER'),
    resources: store.queryProcessSamples({ start: 0, end: Number.MAX_SAFE_INTEGER }),
    topology: store.queryTopologyPaths(),
    topologyDetails: store.queryTopologyObservations({ start: 0, end: Number.MAX_SAFE_INTEGER }),
    topologyCoverage: store.queryTopologyCoverage({ start: 0, end: Number.MAX_SAFE_INTEGER }),
    events: store.queryRuntimeEvents({ start: 0, end: Number.MAX_SAFE_INTEGER }) });
  if (message.action === 'event-storm') {
    for (let index = 0; index < 100; index++) radio.emit('radio.error', { phase: 'connect', message: 'secret must not enter records' });
    process.send({ storm: true });
  }
  if (message.action === 'topology-storm') {
    for (let index = 0; index < 100; index++) radio.emit('radio.packet', {
      raw: Buffer.from('0D43AC019905E85C01020304', 'hex'), lastSnr: -1, lastRssi: -100 });
    radio.emit('radio.packet', { raw: Buffer.from('0D0001020304', 'hex'), lastSnr: -1, lastRssi: -100 });
    process.send({ topologyStorm: true });
  }
  if (message.action === 'stop') process.emit('SIGINT');
  if (message.action === 'release') { releaseStop(); releaseAdvert(); }
});
await import('../../src/index.js');
