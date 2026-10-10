import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTelemetryFixture, telemetryResult, TELEMETRY_OBSERVER, TELEMETRY_TARGET } from '../fixtures/telemetry-store.js';
import { telemetryBytes, telemetryWire, neighbourPage } from '../fixtures/telemetry-wire.js';
import { createTelemetryReads } from '../../src/metrics/telemetry-reads.js';

const HOUR = 3600000, RANGE = { start: 0, end: Number.MAX_SAFE_INTEGER };
const fixtures = new Set();
afterEach(() => { for (const f of fixtures) f.cleanup(); fixtures.clear(); });
function fixture() { const f = createTelemetryFixture(); fixtures.add(f); return f; }
function result(f, options) { return telemetryResult(f.run,options); }
function save(f, options) { const input = result(f,options); f.store.recordTelemetryResult(input); return input; }
function latest(f, options = {}) {
  return f.store.getTelemetryLatest({ observerPublicKey: TELEMETRY_OBSERVER, targetPublicKey: TELEMETRY_TARGET,
    variant: result(f).outcome.variant, now: 2000, windowMs: 72*HOUR, ...options });
}

test('empty, failed-only and history-only scopes return unknown without invented values or decoded samples', () => {
  const f = fixture(), empty = latest(f);
  assert.equal(empty.observation,null); assert.equal(empty.freshness,'unknown'); assert.equal(empty.ageMs,null);
  assert.equal(empty.fullyDecoded.observation,null); assert.equal(empty.latestOutcome,null);
  assert.deepEqual(empty.coverage,{ retainedRecords:0,earliestRetainedAt:null,latestRetainedAt:null,
    retainedHistoryOnly:true,historyCompleteness:'unknown' });
  save(f,{status:'failed'}); assert.equal(latest(f).latestOutcome.status,'failed');
  save(f,{clockAnomaly:true,observedAt:1500}); const historyOnly = latest(f);
  assert.equal(historyOnly.observation,null); assert.equal(historyOnly.coverage.retainedRecords,1);
  const history = f.store.queryTelemetryObservations(RANGE).observations[0];
  assert.equal(history.latestEligible,false); assert.equal(history.clockAnomaly,true);
  assert.equal(history.observedAt,1500);
});

test('new partial, older decoded and latest failure keep their original context, quality and independent age', () => {
  const f = fixture(), decoded = save(f,{observedAt:1000});
  const partial = save(f,{observedAt:HOUR+1000,body:[...telemetryBytes(telemetryWire.sensors),5,250]});
  save(f,{observedAt:HOUR+1500,status:'failed'});
  const read = latest(f,{now:HOUR+2000,windowMs:HOUR});
  assert.equal(read.observation.requestId,partial.outcome.requestId); assert.equal(read.observation.quality,'partial');
  assert.equal(read.freshness,'fresh'); assert.equal(read.ageMs,1000);
  assert.equal(read.fullyDecoded.observation.requestId,decoded.outcome.requestId);
  assert.equal(read.fullyDecoded.observation.quality,'decoded'); assert.equal(read.fullyDecoded.ageMs,HOUR+1000);
  assert.equal(read.fullyDecoded.freshness,'stale'); assert.equal(read.latestOutcome.status,'failed');
  assert.equal(read.observation.coverage,'response-only'); assert.equal(read.observation.provenance,'companion-tag-attributed');
  assert.equal(read.observation.runId,f.run.runId); assert.equal(read.observation.decoderVersion,1);
  read.observation.data.readings[0].value=999; read.variant.params.permissionMask=7;
  assert.deepEqual(latest(f,{now:HOUR+2000}).observation.data,partial.observation.data);
  assert.deepEqual(latest(f).variant,partial.outcome.variant);
});

test('late decoded arrival updates its own snapshot without replacing newer partial data', () => {
  const f=fixture(); save(f,{observedAt:3000,body:[1,250]}); save(f,{observedAt:2000});
  const read=latest(f,{now:4000}); assert.equal(read.observation.observedAt,3000);
  assert.equal(read.observation.data.readings.length,0); assert.equal(read.fullyDecoded.observation.observedAt,2000);
  const other=fixture(); save(other,{body:[1,250]}); assert.equal(latest(other).fullyDecoded.freshness,'unknown');
});

test('strict expiry equality, whole-hour override, process rollback and invalid read cannot renew or poison age', () => {
  const f=fixture(); save(f);
  assert.throws(()=>latest(f,{now:Number.MAX_SAFE_INTEGER,sql:'SECRET'}),/^Error: Invalid telemetry data$/);
  assert.equal(latest(f,{now:1000+HOUR-1,windowMs:HOUR}).fresh,true);
  assert.equal(latest(f,{now:1000+HOUR,windowMs:HOUR}).freshness,'stale');
  assert.equal(latest(f,{now:1000+HOUR,windowMs:2*HOUR}).fresh,true);
  const rollback=latest(f,{now:2000,windowMs:HOUR}); assert.equal(rollback.clockRollback,true);
  assert.equal(rollback.freshness,'stale'); assert.equal(rollback.ageMs,HOUR);
  assert.equal(rollback.fullyDecoded.freshness,'stale'); assert.equal(rollback.observation.observedAt,1000);
});

test('durable run time guards clean and abrupt reopen without needing dashboard or read-time writes', () => {
  for (const clean of [false,true]) {
    const f=fixture(); save(f);
    const times={runId:f.run.runId,observedAt:1000+72*HOUR,observedDurationMs:1000+72*HOUR};
    if(clean) f.store.endObserverRun({...times,reason:'SIGINT'}); else f.store.checkpointObserverRun(times);
    f.close(); f.open(); const read=latest(f);
    assert.equal(read.clockRollback,true); assert.equal(read.freshness,'stale');
    assert.equal(read.effectiveNow,1000+72*HOUR); assert.equal(read.observation.runId,f.run.runId);
    assert.equal(read.fullyDecoded.observation.observedAt,1000);
  }
});

test('future observations and source-run clock anomalies never claim freshness; source flag stays separate', () => {
  const f=fixture(); save(f,{observedAt:5000});
  const future=latest(f); assert.equal(future.freshness,'future'); assert.equal(future.ageMs,null);
  assert.equal(future.futureDated,true); assert.equal(future.fullyDecoded.fresh,false);
  f.store.checkpointObserverRun({runId:f.run.runId,observedAt:10000,observedDurationMs:10000});
  f.store.checkpointObserverRun({runId:f.run.runId,observedAt:9000,observedDurationMs:11000});
  const anomaly=latest(f,{now:11000}); assert.equal(anomaly.freshness,'clock-anomaly');
  assert.equal(anomaly.observation.clockAnomaly,false); assert.equal(anomaly.observation.sourceRunClockAnomaly,true);
  assert.equal(anomaly.fullyDecoded.freshness,'clock-anomaly');
});

test('equal-time conflicts remain ambiguous after pruning a peer, with deterministic latest request identity', () => {
  const f=fixture(), ids=['10000000-0000-4000-8000-000000000000','20000000-0000-4000-8000-000000000000'];
  for(const requestId of ids.reverse()) save(f,{requestId});
  f.store.pruneOlderThan(5000); const read=latest(f,{now:6000});
  assert.equal(read.freshness,'ambiguous'); assert.equal(read.fresh,false);
  assert.equal(read.observation.requestId,'20000000-0000-4000-8000-000000000000');
  assert.equal(read.fullyDecoded.freshness,'ambiguous'); assert.equal(read.coverage.retainedRecords,1);
  f.close(); f.open(); assert.equal(latest(f).freshness,'ambiguous');
});

test('full reporter/target identity, component, permission mask, layout evidence and neighbour page scope never merge', () => {
  const f=fixture(), inputs=[save(f),save(f,{observer:'EF'.repeat(32)}),save(f,{target:'EF'.repeat(32)}),
    save(f,{permissionMask:7}),save(f,{component:'status'}),save(f,{component:'status',evidence:'unknown'}),
    save(f,{component:'status',layout:'current56',body:telemetryBytes(telemetryWire.status56)}),
    save(f,{component:'neighbours'}),save(f,{component:'neighbours',offset:1,body:neighbourPage([],{total:1})})];
  for(const input of inputs) {
    const o=input.outcome,read=latest(f,{observerPublicKey:o.observerPublicKey,targetPublicKey:o.targetPublicKey,variant:o.variant});
    assert.equal(read.coverage.retainedRecords,1); assert.equal(read.observation.requestId,o.requestId);
    assert.deepEqual(read.observation.data,input.observation.data);
    assert.equal(f.store.queryTelemetryObservations({...RANGE,observerPublicKey:o.observerPublicKey,
      targetPublicKey:o.targetPublicKey,variant:o.variant}).total,1);
  }
  assert.equal(latest(f,{targetPublicKey:'12'.repeat(32)}).freshness,'unknown');
  assert.equal(latest(f,{variant:inputs[5].outcome.variant}).fullyDecoded.observation,null);
  const empty=latest(f,{variant:inputs[8].outcome.variant}); assert.deepEqual(empty.observation.data.entries,[]);
  assert.equal(empty.observation.data.reportedTotal,1); assert.equal(empty.fresh,true);
});

test('history uses original independent receipt/completion half-open bounds and validated run/component/status filters', () => {
  const f=fixture(); save(f,{observedAt:1000,completedAt:2000}); save(f,{observedAt:1500,observer:'EF'.repeat(32)});
  save(f,{observedAt:2000,component:'status'}); const failed=save(f,{status:'failed',observedAt:3000});
  assert.equal(f.store.queryTelemetryObservations({start:1000,end:2000}).total,2);
  assert.equal(f.store.queryTelemetryObservations({start:1000,end:1000}).total,0);
  assert.equal(f.store.queryTelemetryOutcomes({start:2000,end:3000}).total,2);
  assert.equal(f.store.queryTelemetryOutcomes({...RANGE,status:'failed'}).outcomes[0].requestId,failed.outcome.requestId);
  assert.equal(f.store.queryTelemetryObservations({...RANGE,runId:f.run.runId}).total,3);
  assert.equal(f.store.queryTelemetryObservations({...RANGE,runId:randomUUID()}).total,0);
  assert.equal(f.store.queryTelemetryObservations({...RANGE,component:'status'}).total,1);
  assert.equal(f.store.queryTelemetryOutcomes({...RANGE,observerPublicKey:TELEMETRY_OBSERVER}).total,3);
});

test('pages default 100/cap 200, preserve bounded values and order ties before hydration', () => {
  const f=fixture(),ids=[];
  // Maximum supported sensor payload: 56 independent three-byte readings.
  const body=Array.from({length:56},(_,i)=>[i+1,104,0]).flat();
  for(let i=0;i<205;i++) ids.push(f.store.recordTelemetryResult(result(f,{body})).observationId);
  assert.equal(f.store.queryTelemetryObservations(RANGE).observations.length,100);
  const page=f.store.queryTelemetryObservations({...RANGE,limit:200}); assert.equal(page.total,205);
  assert.deepEqual(page.observations.map(x=>x.observationId),ids.slice(5).reverse());
  assert.equal(page.observations[0].data.readings.length,56); assert.equal(page.observations[0].data.readings[0].value,0);
  assert.equal(page.coverage.retainedRecords,205); assert.equal(page.coverage.earliestRetainedAt,1000);
  assert.equal(page.coverage.historyCompleteness,'unknown');
  assert.equal(f.store.queryTelemetryObservations({...RANGE,offset:205}).observations.length,0);
  assert.equal(f.store.queryTelemetryObservations({...RANGE,offset:0x7FFFFFFF}).total,205);
  const outcomes=f.store.queryTelemetryOutcomes({...RANGE,limit:200}); assert.equal(outcomes.outcomes.length,200);
  assert.deepEqual(outcomes.outcomes.map(x=>x.requestId),outcomes.outcomes.map(x=>x.requestId).sort().reverse());
});

test('all read boundaries reject secrets, injection, bad shapes/units/filters before SQL or high-water mutation', () => {
  const f=fixture(); f.close(); f.inspect(db=>{
    let calls=0; const reads=createTelemetryReads({prepare(sql){const stmt=db.prepare(sql);
      return {get(...args){calls++;return stmt.get(...args);},all(...args){calls++;return stmt.all(...args);}};}});
    const before=calls;
    for(const bad of [null,[],42,'SECRET',{...RANGE,limit:201},{...RANGE,offset:-1},{...RANGE,start:2,end:1},
      {...RANGE,sql:'DROP TABLE'},{...RANGE,targetPublicKey:"'; DROP TABLE observer_runs;--"},
      {...RANGE,variant:'sensors:0'},{...RANGE,component:'status',variant:result(f).outcome.variant},
      {...RANGE,runId:'SECRET'},{...RANGE,end:'1000'}]) {
      assert.throws(()=>reads.observations(bad),/^Error: Invalid telemetry data$/);
      assert.throws(()=>reads.outcomes(bad),/^Error: Invalid telemetry data$/);
    }
    assert.throws(()=>reads.observations({...RANGE,status:'failed'}),/Invalid telemetry data/);
    assert.throws(()=>reads.outcomes({...RANGE,status:'deferred'}),/Invalid telemetry data/);
    for(const windowMs of [0,3600001,8761*HOUR,'72',null]) assert.throws(()=>reads.latest({observerPublicKey:TELEMETRY_OBSERVER,
      targetPublicKey:TELEMETRY_TARGET,variant:result(f).outcome.variant,now:0,windowMs}),/Invalid telemetry data/);
    assert.equal(calls,before);
  });
});

test('pruned retained coverage is honest while both stale snapshots and their source context survive reopen', () => {
  const f=fixture(); save(f,{observedAt:100}); save(f,{observedAt:200});
  save(f,{observedAt:300,body:[1,250]}); save(f,{observedAt:400,status:'unsupported'});
  f.store.pruneOlderThan(1000); f.close(); f.open(); const read=latest(f,{now:1000+72*HOUR});
  assert.equal(read.freshness,'stale'); assert.equal(read.fullyDecoded.freshness,'stale');
  assert.equal(read.observation.observedAt,300); assert.equal(read.fullyDecoded.observation.observedAt,200);
  assert.equal(read.coverage.retainedRecords,2); assert.equal(read.coverage.earliestRetainedAt,200);
  assert.equal(read.coverage.latestRetainedAt,300); assert.equal(read.coverage.historyCompleteness,'unknown');
  assert.equal(f.store.queryTelemetryOutcomes(RANGE).total,2); assert.ok(f.store.getObserverRun({runId:f.run.runId}));
});

test('corrupt stored variants and normalized bodies fail safely without exposing a stored secret', () => {
  for(const table of ['telemetry_observations','telemetry_query_outcomes']) {
    const f=fixture(); save(f); f.close(); f.inspect(db=>{
      db.exec('PRAGMA ignore_check_constraints=ON');
      if(table==='telemetry_observations') db.prepare("UPDATE telemetry_observations SET normalized_json=?").run('{"SECRET":true}');
      else db.prepare("UPDATE telemetry_query_outcomes SET variant_json=?").run('{"SECRET":true}');
    }); f.open();
    assert.throws(()=>latest(f),/^Error: Invalid stored telemetry data$/);
    assert.throws(()=>f.store.queryTelemetryObservations(RANGE),/^Error: Invalid stored telemetry data$/);
    if(table==='telemetry_query_outcomes') assert.throws(()=>f.store.queryTelemetryOutcomes(RANGE),/^Error: Invalid stored telemetry data$/);
  }
});
