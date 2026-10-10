import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MetricsStore } from '../../src/metrics/store.js';
import { REGION_POLL_CANDIDATE_SQL } from '../../src/metrics/region-poll-state.js';
import { OBSERVER,HOUR,POLICY,start,reservation,completion } from '../fixtures/region-poll.js';

const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
const ms=value=>Number(value.toFixed(3));
const key=index=>index.toString(16).padStart(8,'0').padEnd(64,'A').toUpperCase();
test('20k nodes/scheduled pairs use indexed bounded keyset/due reads and durable sub-10ms writes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'region-poll-cost-')),path=join(dir,'metrics.sqlite3');let store;
  try {
    store=new MetricsStore({dbPath:path});start(store);store.close();store=null;
    const db=new DatabaseSync(path);let bytesBefore;
    try {
      db.exec('PRAGMA foreign_keys=ON; BEGIN');
      const node=db.prepare("INSERT INTO nodes(public_key_hex,name,type,first_heard_at,last_heard_at,last_direct_heard_at) VALUES(?,NULL,'REPEATER',0,1000,1000)");
      const state=db.prepare(`INSERT INTO region_poll_state(observer_public_key,target_public_key,next_due_at,cycle_started_at,
        cycle_reservations,last_policy_at,last_reason) VALUES(?,?,0,0,0,0,'ready')`);
      for(let i=0;i<20000;i++){
        node.run(key(i));state.run(i<10000?OBSERVER:'DD'.repeat(32),key(i));
      }
      db.exec('COMMIT');
      const parameters={observer:OBSERVER,now:300000,cutoff:300000-72*HOUR,after:'',limit:200,
        refresh:POLICY.queryRefreshIntervalMs,base:POLICY.queryRetryBaseMs,cap:POLICY.queryRetryMaxMs,attempts:POLICY.queryMaxAttempts};
      const steps=db.prepare('EXPLAIN QUERY PLAN '+REGION_POLL_CANDIDATE_SQL).all(parameters).map(row=>row.detail);
      const plan=JSON.stringify(steps);
      for(const index of ['idx_region_poll_due','idx_nodes_type_key','idx_region_outcomes_scope_at'])assert.ok(plan.includes(index),index);
      assert.doesNotMatch(plan,/SCAN region_answers|SCAN region_query_outcomes/);
      assert.ok(steps.findIndex(step=>step.startsWith('SEARCH s USING'))<steps.findIndex(step=>step.startsWith('SEARCH n USING')),
        'the due range must be visited once before node lookups: '+plan);
      bytesBefore=db.prepare('PRAGMA page_count').get().page_count*db.prepare('PRAGMA page_size').get().page_size;
    } finally { db.close(); }
    store=new MetricsStore({dbPath:path});const run=start(store);
    const query={observerPublicKey:OBSERVER,now:300000,windowMs:72*HOUR,limit:200};
    const readCosts={};
    for(const [name,after,count] of [['first',undefined,200],['middle',key(9999),200],['pastEnd',key(19999),0]]){
      const times=[];
      for(let i=0;i<20;i++){const before=performance.now();const page=store.queryRegionPollCandidates(
        {...query,...(after?{afterPublicKey:after}:{})},POLICY);times.push(performance.now()-before);
        assert.equal(page.candidates.length,count);assert.equal(page.clockRollback,false);}
      readCosts[name]=ms(p95(times));assert.ok(p95(times)<100,name+' candidate p95 below 100ms');
    }
    // A scan visits all candidates by full key, then explicitly wraps with
    // an absent cursor. A producer selecting one advances after that key.
    const seen=new Set();let afterPublicKey;
    for(let pageNumber=0;pageNumber<101;pageNumber++){
      const page=store.queryRegionPollCandidates({...query,...(afterPublicKey?{afterPublicKey}:{})},POLICY);
      for(const row of page.candidates){assert.equal(seen.has(row.targetPublicKey),false);seen.add(row.targetPublicKey);}
      if(page.exhausted){assert.equal(page.candidates.length,0);break;}
      afterPublicKey=page.nextCursor;
    }
    assert.equal(seen.size,20000);
    assert.equal(store.queryRegionPollCandidates(query,POLICY).candidates[0].targetPublicKey,key(0));
    const reserveTimes=[],completionTimes=[];
    for(let i=0;i<200;i++){
      const input=reservation(run,500000+i*3,{targetPublicKey:key(i)});
      let before=performance.now();const permission=store.reserveRegionPoll(input);reserveTimes.push(performance.now()-before);
      assert.equal(permission.reserved,true);
      before=performance.now();const saved=store.completeRegionPoll(completion(input,{at:input.reservedAt+1}));
      completionTimes.push(performance.now()-before);assert.equal(saved.completed,true);
    }
    store.close();store=null;
    const checked=new DatabaseSync(path);let bytesAfter;
    try {
      bytesAfter=checked.prepare('PRAGMA page_count').get().page_count*checked.prepare('PRAGMA page_size').get().page_size;
      assert.equal(checked.prepare('SELECT count(*) AS n FROM region_poll_state').get().n,20000);
      assert.equal(checked.prepare('SELECT count(*) AS n FROM region_query_outcomes').get().n,200);
      assert.equal(checked.prepare('SELECT count(*) AS n FROM region_publications').get().n,0);
      assert.deepEqual(checked.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally {checked.close();}
    console.info('Region poll cost fixture:',{nodes:20000,scheduledPairs:20000,pageLimit:200,
      reservationP95Ms:ms(p95(reserveTimes)),completionP95Ms:ms(p95(completionTimes)),readP95Ms:readCosts,
      allKeysVisited:seen.size,fixtureBytes:bytesBefore,measuredGrowthBytes:bytesAfter-bytesBefore,
      platform:process.platform,node:process.version,targets:{writeP95Ms:10,readP95Ms:100}});
    assert.ok(p95(reserveTimes)<10,'normal reservation p95 below 10ms');
    assert.ok(p95(completionTimes)<10,'normal atomic completion p95 below 10ms');
  }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
},30000);
