// Test-only real-entrypoint harness. Local IPC substitutes for physical RF;
// UI/broker network methods throw if startup unexpectedly invokes them.
import { RadioManager } from '../../src/radio/radio-manager.js';
import { MetricsStore } from '../../src/metrics/store.js';
import { MetricsSampler } from '../../src/metrics/sampler.js';
import { MetricsServer } from '../../src/web/metrics-server.js';
import { MqttManager } from '../../src/mqtt/mqtt-manager.js';
import { RemoteRequestCoordinator } from '../../src/radio/remote-request-coordinator.js';
import { loadConfig } from '../../src/config/index.js';
import { telemetryLifecycleResults, TELEMETRY_OBSERVER, TELEMETRY_TARGET } from './telemetry-store.js';
import { telemetryVariantKey } from '../../src/telemetry/telemetry-validation.js';

const RANGE={start:0,end:Number.MAX_SAFE_INTEGER};
let store,run,radio,sampler,radioStarts=0,remoteRequests=0,brokerStarts=0,httpStarts=0,mqttPublications=0;
const begin=MetricsStore.prototype.beginObserverRun;
MetricsStore.prototype.beginObserverRun=function(input){store=this;run=begin.call(this,input);return run;};
const startSampler=MetricsSampler.prototype.start;
MetricsSampler.prototype.start=function(){sampler=this;return startSampler.call(this);};
RadioManager.prototype.getDeviceInfo=()=>({name:'Offline telemetry fixture',publicKey:TELEMETRY_OBSERVER});
RadioManager.prototype.start=function(){radio=this;radioStarts++;console.log('TELEMETRY_FIXTURE_RADIO_STARTED');process.send?.({ready:true});};
RadioManager.prototype.stop=async()=>{};
MqttManager.prototype.connectAll=()=>{brokerStarts++;throw new Error('Unexpected broker network startup in offline fixture');};
const publish=MqttManager.prototype.publish;
MqttManager.prototype.publish=function(...args){mqttPublications++;return publish.apply(this,args);};
MqttManager.prototype.publishRegion=async()=>{mqttPublications++;throw new Error('Unexpected region publication');};
MetricsServer.prototype.start=()=>{httpStarts++;throw new Error('Unexpected HTTP startup in offline fixture');};
RemoteRequestCoordinator.prototype.tryRequest=()=>{remoteRequests++;throw new Error('Unexpected automatic remote request');};
const close=MetricsStore.prototype.close;
MetricsStore.prototype.close=function(){close.call(this);if(store===this&&process.connected)process.disconnect();};

process.on('message',message=>{
  if(message.action==='seed') {
    const inputs=telemetryLifecycleResults(run,Math.max(Date.now(),run.startedAt+1));
    for(const input of inputs)store.recordTelemetryResult(input);
    process.send({seeded:true,inputs});
  }
  if(message.action==='snapshot') {
    const config=loadConfig(),observations=store.queryTelemetryObservations(RANGE),outcomes=store.queryTelemetryOutcomes(RANGE);
    const variants=new Map(outcomes.outcomes.map(x=>[telemetryVariantKey(x.variant),x.variant]));
    const now=message.now??Math.max(Date.now(),...outcomes.outcomes.map(x=>x.completedAt));
    process.send({runId:run.runId,instanceId:run.instanceId,observations,outcomes,
      latest:[...variants.values()].map(variant=>store.getTelemetryLatest({observerPublicKey:TELEMETRY_OBSERVER,
        targetPublicKey:TELEMETRY_TARGET,variant,now,windowMs:config.telemetry.freshnessWindowMs})),
      config:{freshnessWindowMs:config.telemetry.freshnessWindowMs,retentionDays:config.metricsUi.retentionDays},
      runs:store.queryObserverRuns(RANGE),resources:store.queryProcessSamples(RANGE),
      nodes:store.countNodesByType('REPEATER'),adverts:store.queryAdvertTotals(RANGE),
      packets:store.queryPacketTotals(RANGE),topology:store.queryTopologyPaths(),
      counts:{radioStarts,remoteRequests,brokerStarts,httpStarts,mqttPublications}});
  }
  if(message.action==='sample')sampler.once('sample',()=>process.send({sampled:true}));
  if(message.action==='capture') {
    radio.emit('radio.packet',{raw:Buffer.from('0D0001020304','hex'),lastSnr:-1,lastRssi:-100});
    process.send({captured:true});
  }
  if(message.action==='stop')process.emit('SIGINT');
});
await import('../../src/index.js');
