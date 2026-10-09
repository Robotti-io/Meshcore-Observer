// Test-only entrypoint harness: no hardware, broker or internet connection.
import { RadioManager } from '../../src/radio/radio-manager.js';
import { NodeRegistry } from '../../src/nodes/node-registry.js';
import { MetricsStore } from '../../src/metrics/store.js';
import { advertSigner, signedAdvertPacket } from './signed-advert.js';

const mode = process.argv[2];
let store; let radio; let releaseStop; let releaseAdvert;
const originalBegin = MetricsStore.prototype.beginObserverRun;
MetricsStore.prototype.beginObserverRun = function (input) {
  const result = originalBegin.call(this, input); store = this; return result;
};
const stopGate = new Promise((resolve) => { releaseStop = resolve; });
const advertGate = new Promise((resolve) => { releaseAdvert = resolve; });
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
RadioManager.prototype.stop = async () => { if (mode === 'delayed-stop') await stopGate; };
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
