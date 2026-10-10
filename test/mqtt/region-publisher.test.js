import { test,afterEach,vi } from 'vitest';
import assert from 'node:assert/strict';
import { createPollFixture,reservation,completion,OBSERVER,TARGET } from '../fixtures/region-poll.js';
import { RegionPublisher } from '../../src/mqtt/region-publisher.js';
import { REGION_PUBLICATION_DEFAULTS } from '../../src/mqtt/region-publication-schemas.js';

const fixtures=[];
afterEach(async()=>{
  for(const f of fixtures.splice(0)){f.worker?.stop();await f.worker?.drain().catch(()=>{});f.cleanup();}
  vi.useRealTimers();
});
const settings={ ...REGION_PUBLICATION_DEFAULTS,enabled:true,tickIntervalMs:1000,publishTimeoutMs:1000,retryBaseMs:1000,retryMaxMs:4000 };
function fixture(brokers=[{ id:'one',enabled:true,regionPublication:settings }]) {
  vi.useFakeTimers({ toFake:['setInterval','clearInterval'] });
  const f=createPollFixture();fixtures.push(f);f.now=5000;f.snapshot={ ready:true,generation:1,observerPublicKey:OBSERVER.toLowerCase() };
  f.calls=[];f.connected=true;f.logs=[];f.behavior=async()=>({ outcome:'sent' });
  f.logger=Object.fromEntries(['warn','info','debug','error'].map(level=>[level,(...args)=>f.logs.push({ level,args })]));
  f.mqtt={ getBroker:()=>({ isConnected:()=>f.connected }),publishRegion:async input=>{f.calls.push(input);return f.behavior(input);} };
  f.build=()=>new RegionPublisher({ store:f.store,runId:f.run.runId,radio:{ getConnectionSnapshot:()=>f.snapshot },
    mqttManager:f.mqtt,brokers,logger:f.logger,now:()=>f.now,monotonicNow:()=>f.now-5000 });
  f.worker=f.build();f.tick=async(ms=1000)=>{f.now+=ms;await vi.advanceTimersByTimeAsync(ms);};
  f.answer=(csv='',changes={},options={})=>{
    const input=reservation(f.run,1000,changes);
    return f.store.recordRegionResult(completion(input,{ csv,...options }).result);
  };
  f.publications=(brokerId='one')=>f.store.queryRegionPublications({ brokerId }).publications;
  return f;
}
test('disabled/opt-out brokers have no timer, store, identity or transport work',async()=>{
  const f=fixture([{ id:'off',enabled:false,regionPublication:settings },{ id:'no',enabled:true }]);
  f.snapshot=null;f.worker.start();f.worker.start();await f.tick(10000);
  assert.equal(f.calls.length,0);assert.equal(vi.getTimerCount(),0);
  f.worker.stop();f.worker.start();assert.equal(vi.getTimerCount(),0);
});
test('saved empty/case/wildcard answers publish independently only to opted-in brokers with original milliseconds',async()=>{
  const f=fixture([{ id:'one',enabled:true,regionPublication:settings },{ id:'two',enabled:true,regionPublication:settings },{ id:'off',enabled:true }]);
  f.answer();f.answer('Be,*,be,Be',{ targetPublicKey:'CD'.repeat(32) });f.worker.start();
  await f.tick();await f.tick();
  assert.equal(f.calls.length,4);assert.equal(f.calls.some(c=>c.brokerId==='off'),false);
  for(const call of f.calls) {
    assert.equal(call.topic,'meshcore/client/'+'be'.repeat(32)+'/regions');
    assert.equal(call.payload.timestamp,'1970-01-01T00:00:01.010Z');assert.equal(call.payload.truncated,true);
  }
  assert.deepEqual(f.calls.find(c=>c.payload.target==='cd'.repeat(32)).payload.regions,['Be','*','be','Be']);
  assert.equal(f.publications().every(p=>p.state==='published'),true);
  assert.equal(f.logs.filter(l=>l.level==='info').length,4);
});
test('offline publication stages safe latest answers without consuming attempts and does not need discovery/UI',async()=>{
  const f=fixture();f.answer('old');f.answer('new',{}, { at:1100 });f.connected=false;f.worker.start();await f.tick(10000);
  assert.equal(f.calls.length,0);assert.equal(f.publications().length,1);assert.equal(f.publications()[0].attemptCount,0);
  f.connected=true;await f.tick();assert.deepEqual(f.calls[0].payload.regions,['new']);
});
test('one hung broker has one admitted job while others finish and timers cannot queue overlap',async()=>{
  const f=fixture([{ id:'one',enabled:true,regionPublication:settings },{ id:'two',enabled:true,regionPublication:settings }]);
  let release;f.behavior=input=>input.brokerId==='one'?new Promise(resolve=>{release=resolve;}):Promise.resolve({ outcome:'sent' });
  f.answer();f.worker.start();await f.tick(10000);
  assert.equal(f.calls.filter(c=>c.brokerId==='one').length,1);assert.equal(f.publications('two')[0].state,'published');
  f.worker.stop();const draining=f.worker.drain();release({ outcome:'sent' });await draining;
  assert.equal(f.publications()[0].state,'published');assert.equal(vi.getTimerCount(),0);
});
test('fixed durable exponential backoff caps and retry preserves exactly the original payload',async()=>{
  const f=fixture();f.answer();f.behavior=async()=>({ outcome:'failed' });f.worker.start();
  await f.tick();assert.equal(f.publications()[0].nextDueAt,7000);
  await f.tick();assert.equal(f.publications()[0].nextDueAt,9000);
  await f.tick();assert.equal(f.calls.length,2);await f.tick();assert.equal(f.publications()[0].nextDueAt,13000);
  await f.tick(4000);assert.equal(f.publications()[0].nextDueAt,17000);
  assert.equal(f.calls.length,4);for(const call of f.calls)assert.deepEqual(call,f.calls[0]);
  f.behavior=async()=>({ outcome:'sent' });await f.tick(4000);assert.equal(f.publications()[0].state,'published');
  assert.equal(f.publications()[0].downstreamIngestion,'unknown');
});
test('restart keeps source run/time, due deadline and opt-out queued data; a new broker receives latest only',async()=>{
  const f=fixture();f.answer('original');f.behavior=async()=>({ outcome:'failed' });f.worker.start();await f.tick();
  const original=JSON.parse(JSON.stringify(f.calls[0]));f.worker.stop();await f.worker.drain();f.restart(6000);f.worker=f.build();f.worker.start();
  await f.tick();assert.deepEqual(f.calls[1],original);assert.equal(f.publications()[0].attemptCount,2);
  f.worker.stop();await f.worker.drain();f.behavior=async()=>({ outcome:'sent' });
  f.worker=new RegionPublisher({ store:f.store,runId:f.run.runId,radio:{ getConnectionSnapshot:()=>f.snapshot },
    mqttManager:f.mqtt,brokers:[{ id:'new',enabled:true,regionPublication:settings }],logger:f.logger,
    now:()=>f.now,monotonicNow:()=>f.now-5000 });f.worker.start();await f.tick();
  assert.equal(f.publications()[0].state,'pending');assert.equal(f.publications('new')[0].state,'published');
});
test('identity unavailable/changed cannot publish another reporter; anomalous/conflicting/future remain local',async()=>{
  const f=fixture();f.answer();f.answer('bad',{ targetPublicKey:'01'.repeat(32) },{ clockAnomaly:true });
  f.answer('first',{ targetPublicKey:'02'.repeat(32) });f.answer('conflict',{ targetPublicKey:'02'.repeat(32) });
  f.answer('future',{ targetPublicKey:'03'.repeat(32) },{ at:100000 });
  f.snapshot={ ready:false,generation:1,observerPublicKey:null };f.worker.start();await f.tick();assert.equal(f.publications().length,0);
  f.snapshot={ ready:true,generation:2,observerPublicKey:'EF'.repeat(32) };await f.tick();assert.equal(f.calls.length,0);
  f.snapshot={ ready:true,generation:3,observerPublicKey:OBSERVER };await f.tick();assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].payload.target,TARGET.toLowerCase());
});
test('clock rollback pauses new deliveries and restored agreement resumes without rewriting observation',async()=>{
  const f=fixture();f.answer();f.connected=false;f.worker.start();await f.tick();
  f.connected=true;f.now=5000;await vi.advanceTimersByTimeAsync(1000);assert.equal(f.calls.length,0);
  f.now=6000;await vi.advanceTimersByTimeAsync(1000);assert.equal(f.calls.length,1);
});
test('local resolution failure retries only the save, blocks clean drain and logs fixed secret-free explanations',async()=>{
  const f=fixture();f.answer();const resolve=f.store.resolveRegionPublication.bind(f.store);
  f.store.resolveRegionPublication=()=>{throw Error('PASSWORD-private');};f.worker.start();await f.tick();await f.tick(5000);
  assert.equal(f.calls.length,1);assert.equal(f.publications()[0].state,'publishing');
  f.worker.stop();await assert.rejects(f.worker.drain(),/clean shutdown cannot be confirmed/);
  assert.equal(JSON.stringify(f.logs).includes('PASSWORD-private'),false);
  assert.equal(f.logs.some(l=>l.args[1].includes('could not be saved')),true);
  f.store.resolveRegionPublication=resolve;await f.worker.drain();assert.equal(f.publications()[0].state,'published');
});
test('late old-run acknowledgement cannot certify a recovered current-run claim',async()=>{
  const f=fixture();f.answer();let release;f.behavior=()=>new Promise(r=>{release=r;});f.worker.start();await f.tick();f.worker.stop();
  // Simulate new owned run recovery while the old actor still retains its callback.
  f.restart(7000);const next=f.store.claimRegionPublication({ brokerId:'one',observerPublicKey:OBSERVER,runId:f.run.runId,now:7000 });
  release({ outcome:'sent' });await assert.rejects(f.worker.drain(),/clean shutdown/);
  assert.equal(f.publications()[0].state,'publishing');
  assert.equal(f.store.resolveRegionPublication({ answerId:next.answerId,brokerId:'one',runId:next.runId,claimToken:next.claimToken,resolvedAt:7001,status:'published' }),true);
});
test('unknown transport results/throws are fixed retry outcomes; selection errors do not grant network permission',async()=>{
  const f=fixture();f.answer();f.behavior=async()=>({ outcome:'sent',secret:'private' });f.worker.start();await f.tick();
  assert.equal(f.publications()[0].state,'pending');f.behavior=async()=>{throw Error('PASSWORD-private');};await f.tick();
  assert.equal(f.publications()[0].lastError,'publish-failed');assert.equal(JSON.stringify(f.logs).includes('PASSWORD-private'),false);
  f.snapshot={ ...f.snapshot,extra:true };await f.tick(2000);assert.equal(f.calls.length,2);
});
