// Test-only entrypoint harness: no hardware, broker or internet connection.
import { RadioManager } from '../../src/radio/radio-manager.js';
import { NodeRegistry } from '../../src/nodes/node-registry.js';
import { MetricsStore } from '../../src/metrics/store.js';
import { advertSigner, signedAdvertPacket } from './signed-advert.js';
import { RemoteRequestCoordinator } from '../../src/radio/remote-request-coordinator.js';
import { RemoteRequestBudget } from '../../src/radio/remote-request-budget.js';
import { MetricsSampler } from '../../src/metrics/sampler.js';
import { MqttManager } from '../../src/mqtt/mqtt-manager.js';
import { parseRegionResponseBody } from '../../src/regions/region-response-parser.js';
import { randomUUID } from 'node:crypto';
import { RegionDiscoveryScheduler } from '../../src/regions/region-discovery-scheduler.js';

const mode = process.argv[2];
let store; let radio; let releaseStop; let releaseAdvert;
let activeRun; let remoteRequestCalls = 0; let mqttPublishCalls = 0;
if (mode === 'region-lifecycle') {
  const originalTry = RemoteRequestCoordinator.prototype.tryRequest, originalPublish = MqttManager.prototype.publish;
  RemoteRequestCoordinator.prototype.tryRequest = function (...args) { remoteRequestCalls++; return originalTry.call(this,...args); };
  MqttManager.prototype.publish = function (...args) { mqttPublishCalls++; return originalPublish.call(this,...args); };
}
let resourcesBeforeStop = null;
if (mode === 'delayed-stop') {
  const originalStop = MetricsSampler.prototype.stop;
  MetricsSampler.prototype.stop = function () {
    originalStop.call(this);
    resourcesBeforeStop = store.queryProcessSamples({ start: 0, end: Number.MAX_SAFE_INTEGER }).total;
  };
}
const originalBegin = MetricsStore.prototype.beginObserverRun;
MetricsStore.prototype.beginObserverRun = function (input) {
  const result = originalBegin.call(this, input); store = this; activeRun = result; return result;
};
const stopGate = new Promise((resolve) => { releaseStop = resolve; });
const advertGate = new Promise((resolve) => { releaseAdvert = resolve; });
if (mode === 'discovery-lifecycle') {
  let started = 0, admissionStopped = false, remoteStopped = false;
  RegionDiscoveryScheduler.prototype.start = function () { started++; };
  RegionDiscoveryScheduler.prototype.stop = function () { admissionStopped = true; };
  RegionDiscoveryScheduler.prototype.drain = async function () {
    process.send({ discoveryDraining: true, started, admissionStopped, remoteStopped });
    await stopGate;
  };
  const originalStop = RemoteRequestCoordinator.prototype.stop;
  RemoteRequestCoordinator.prototype.stop = async function () { await originalStop.call(this); remoteStopped = true; };
}
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
  if (mode === 'remote-lifecycle' || mode === 'discovery-lifecycle') process.send({ radioStopping: true });
};
const originalClose = MetricsStore.prototype.close;
MetricsStore.prototype.close = function () {
  originalClose.call(this);
  if (store === this && process.connected) process.disconnect();
};
process.on('message', (message) => {
  if (message.action === 'snapshot') process.send({ snapshot: store.queryObserverRuns({ start: 0, end: Number.MAX_SAFE_INTEGER }),
    resourcesBeforeStop,
    ...(mode === 'region-lifecycle' ? { regions: {
      runId: activeRun.runId, remoteRequestCalls, mqttPublishCalls,
      latest: store.getRegionLatest({ observerPublicKey: 'CD'.repeat(32),targetPublicKey: 'AC'.repeat(32),now:Date.now(),windowMs:72*3600000 }),
      answers: store.queryRegionAnswers({ start:0,end:Number.MAX_SAFE_INTEGER }),
      outcomes: store.queryRegionOutcomes({ start:0,end:Number.MAX_SAFE_INTEGER }),
      first: store.queryRegionPublications({ brokerId:'first' }), second: store.queryRegionPublications({ brokerId:'second' })
    } } : {}),
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
  if (message.action === 'region-seed' && mode === 'region-lifecycle') {
    const at = Date.now()-4;
    for (const [observedAt,body,brokerIds] of [[at,[0,0,0,0,...Buffer.from('*,Be,be-vlg')],['first','second']],
      [at+1,[0,0,0,0,0,0,0,0],['first']]]) store.recordRegionResult({
      outcome: { requestId: randomUUID(),runId:activeRun.runId,observerPublicKey:'CD'.repeat(32),targetPublicKey:'AC'.repeat(32),
        startedAt:observedAt-1,completedAt:observedAt+1,clockAnomaly:false,status:'answered',reason:null,route:'direct' },
      answer: { ...parseRegionResponseBody({ body }).answer,observedAt },brokerIds });
    if (parseRegionResponseBody({ body:[0,0,0,0,...Buffer.from('bad,,list')] }).status !== 'malformed') throw new Error('Malformed region fixture unexpectedly accepted');
    store.recordRegionResult({ outcome: { requestId:randomUUID(),runId:activeRun.runId,
      observerPublicKey:'CD'.repeat(32),targetPublicKey:'AC'.repeat(32),startedAt:at,completedAt:at+3,
      clockAnomaly:false,status:'failed',reason:'malformed-response',route:'direct' } });
    const first = store.claimRegionPublication({ brokerId:'first',runId:activeRun.runId,now:Date.now() });
    const second = store.claimRegionPublication({ brokerId:'second',runId:activeRun.runId,now:Date.now() });
    store.resolveRegionPublication({ answerId:second.answerId,brokerId:'second',runId:activeRun.runId,
      claimToken:second.claimToken,resolvedAt:Date.now(),status:'published' });
    process.send({ regionFixture:true,claim:first });
  }
  if (message.action === 'region-prune' && mode === 'region-lifecycle') { store.pruneOlderThan(Date.now()+1); process.send({ regionPruned:true }); }
  if (message.action === 'region-claim' && mode === 'region-lifecycle') {
    process.send({ claim:store.claimRegionPublication({ brokerId:'first',runId:activeRun.runId,now:Date.now() }) });
  }
  if (message.action === 'stop') process.emit('SIGINT');
  if (message.action === 'release') { releaseStop(); releaseAdvert(); }
});
await import('../../src/index.js');
