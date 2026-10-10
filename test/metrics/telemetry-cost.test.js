import { test } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createTelemetryFixture, telemetryResult, TELEMETRY_OBSERVER, TELEMETRY_TARGET } from '../fixtures/telemetry-store.js';
import { createTelemetryReads } from '../../src/metrics/telemetry-reads.js';
import { telemetryVariantKey } from '../../src/telemetry/telemetry-validation.js';

const RANGE={start:0,end:1000000},HOUR=3600000;
const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
const ms=value=>Number(value.toFixed(3));

test('20k observations/20k failures prove real indexed bounded hydration and durable write/read cost gates',()=>{
  const f=createTelemetryFixture();
  try {
    const template=telemetryResult(f.run),variant=template.outcome.variant,variantKey=telemetryVariantKey(variant);
    f.close(); let fixtureBytes;
    f.inspect(db=>{
      // Batch only synthetic corpus setup, never the measured owned writes.
      db.exec('BEGIN');
      const outcome=db.prepare(`INSERT INTO telemetry_query_outcomes(request_id,run_id,observer_public_key,target_public_key,
        component,variant_key,variant_json,decoder_version,started_at,completed_at,received_at,clock_anomaly,tag,route,status,reason)
        VALUES(?,?,?,?,'sensors',?,?,1,?,?,?,0,1,'direct',?,?)`);
      const observation=db.prepare(`INSERT INTO telemetry_observations(request_id,observer_public_key,target_public_key,
        component,variant_key,outcome_status,observed_at,quality,normalized_json,latest_eligible)
        VALUES(?,?,?,'sensors',?,'answered',?,'decoded',?,1)`);
      let id;
      for(let i=0;i<20000;i++) {
        const requestId=randomUUID(),at=1000+i;
        outcome.run(requestId,f.run.runId,TELEMETRY_OBSERVER,TELEMETRY_TARGET,variantKey,JSON.stringify(variant),
          at-1,at+1,at,'answered',null);
        id=Number(observation.run(requestId,TELEMETRY_OBSERVER,TELEMETRY_TARGET,variantKey,at,
          JSON.stringify({...template.observation,observedAt:at})).lastInsertRowid);
        outcome.run(randomUUID(),f.run.runId,TELEMETRY_OBSERVER,TELEMETRY_TARGET,variantKey,JSON.stringify(variant),
          30000+i,30001+i,null,'failed','response-timeout');
      }
      db.prepare(`INSERT INTO telemetry_latest(observer_public_key,target_public_key,component,variant_key,
        observation_id,decoded_observation_id) VALUES(?,?,'sensors',?,?,?)`).run(TELEMETRY_OBSERVER,TELEMETRY_TARGET,variantKey,id,id);
      db.exec('COMMIT'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
      fixtureBytes=db.prepare('PRAGMA page_count').get().page_count*db.prepare('PRAGMA page_size').get().page_size;
      // Inspect actual SQL produced by the read model rather than lookalike queries.
      const plans=[];
      const reads=createTelemetryReads({prepare(sql){
        const stmt=db.prepare(sql); function verify(args){
          const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(x=>x.detail).join('\n');
          plans.push({sql,plan});
          if(sql.includes('WITH page')) {
            assert.match(plan,/MATERIALIZE page/);
            const header=sql.slice(0,sql.indexOf(')\n      SELECT'));
            assert.doesNotMatch(header,/normalized_json|variant_json/);
          }
        }
        return {get(...args){verify(args);return stmt.get(...args);},all(...args){verify(args);return stmt.all(...args);}};
      }});
      reads.latest({observerPublicKey:TELEMETRY_OBSERVER,targetPublicKey:TELEMETRY_TARGET,variant,now:100000,windowMs:72*HOUR});
      reads.observations({...RANGE,limit:200}); reads.outcomes({...RANGE,limit:200});
      reads.observations({...RANGE,observerPublicKey:TELEMETRY_OBSERVER,targetPublicKey:TELEMETRY_TARGET,variant,limit:200});
      reads.outcomes({...RANGE,observerPublicKey:TELEMETRY_OBSERVER,targetPublicKey:TELEMETRY_TARGET,variant,limit:200});
      reads.observations({...RANGE,runId:f.run.runId,limit:200}); reads.outcomes({...RANGE,runId:f.run.runId,limit:200});
      for(const index of ['PRIMARY KEY','idx_telemetry_observations_at','idx_telemetry_observations_scope_at',
        'idx_telemetry_outcomes_at','idx_telemetry_outcomes_scope_at','idx_telemetry_outcomes_run_at']) {
        assert.ok(plans.some(x=>x.plan.includes(index)),`actual read plans must use ${index}`);
      }
      for(const {plan} of plans.filter(x=>x.sql.includes('WITH page'))) assert.doesNotMatch(plan,/SCAN [ao](?:\n|$)/);
    });
    f.open(); f.start();
    const writes=[],failedWrites=[];
    // Maximum supported sensor payload also exercises the bounded byte/value path.
    const body=Array.from({length:56},(_,i)=>[i+1,104,0]).flat();
    for(let i=0;i<200;i++) {
      const input=telemetryResult(f.run,{observedAt:100000+i,body});
      const before=performance.now(); f.store.recordTelemetryResult(input); writes.push(performance.now()-before);
      const failed=telemetryResult(f.run,{observedAt:200000+i,status:'failed'}),at=performance.now();
      f.store.recordTelemetryResult(failed); failedWrites.push(performance.now()-at);
    }
    const scope={observerPublicKey:TELEMETRY_OBSERVER,targetPublicKey:TELEMETRY_TARGET,variant};
    const readCosts={};
    for(const [name,read,key] of [
      ['latest',()=>f.store.getTelemetryLatest({...scope,now:300000,windowMs:72*HOUR}),null],
      ['observations',()=>f.store.queryTelemetryObservations({...RANGE,limit:200}),'observations'],
      ['scopedObservations',()=>f.store.queryTelemetryObservations({...RANGE,...scope,limit:200}),'observations'],
      ['runObservations',()=>f.store.queryTelemetryObservations({...RANGE,runId:f.run.runId,limit:200}),'observations'],
      ['outcomes',()=>f.store.queryTelemetryOutcomes({...RANGE,limit:200}),'outcomes'],
      ['scopedOutcomes',()=>f.store.queryTelemetryOutcomes({...RANGE,...scope,limit:200}),'outcomes'],
      ['failures',()=>f.store.queryTelemetryOutcomes({...RANGE,status:'failed',limit:200}),'outcomes'],
      ['deepOffset',()=>f.store.queryTelemetryObservations({...RANGE,limit:200,offset:19000}),'observations']
    ]) {
      const costs=[];
      for(let i=0;i<20;i++) {const before=performance.now(),page=read();costs.push(performance.now()-before);
        if(key) assert.equal(page[key].length,200); else assert.equal(page.observation.data.readings.length,56);}
      readCosts[name]=ms(p95(costs));
      assert.ok(p95(costs)<100,`${name} bounded read p95 ${p95(costs)}ms must remain below 100ms`);
    }
    assert.ok(p95(writes)<10,'normal synchronous telemetry write p95 must remain below 10ms');
    assert.ok(p95(failedWrites)<10,'normal synchronous failure write p95 must remain below 10ms');
    const before=performance.now(); f.store.pruneOlderThan(250000); const pruneMs=performance.now()-before;
    assert.equal(f.store.queryTelemetryObservations(RANGE).total,1);
    assert.equal(f.store.getTelemetryLatest({...scope,now:300000,windowMs:HOUR}).observation.observedAt,100199);
    f.close(); f.inspect(db=>assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]));
    console.info('Telemetry cost fixture:',{observations:20000,failures:20000,maximumSensorReadings:56,
      normalWriteP95Ms:ms(p95(writes)),failureWriteP95Ms:ms(p95(failedWrites)),readP95Ms:readCosts,
      pruneMs:ms(pruneMs),fixtureBytes,platform:process.platform,node:process.version,
      targets:{normalWriteP95Ms:10,readP95Ms:100}});
  } finally {f.cleanup();}
},30000);
