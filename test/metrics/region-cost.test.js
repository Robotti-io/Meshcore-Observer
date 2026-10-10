import { test } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { MetricsStore } from '../../src/metrics/store.js';
import { parseRegionResponseBody } from '../../src/regions/region-response-parser.js';

const OBSERVER = 'BE'.repeat(32), TARGET = 'AC'.repeat(32), RANGE = { start: 0, end: 1000000 };
const normalized = parseRegionResponseBody({ body: [0,0,0,0,...Buffer.from('*,Be,be-vlg')] }).answer;
const p95 = values => [...values].sort((a,b) => a-b)[Math.ceil(values.length * .95)-1];
const ms = value => Number(value.toFixed(3));
function start(store) { return store.beginObserverRun({ runId: randomUUID(), startedAt: 0, observedAt: 0,
  observedDurationMs: 0, appVersion: '2.4.0', nodeVersion: process.version, platform: process.platform, architecture: process.arch }); }
function result(run, at, brokerIds) { return { outcome: { requestId: randomUUID(), runId: run.runId,
  observerPublicKey: OBSERVER, targetPublicKey: TARGET, startedAt: at-1, completedAt: at+1,
  clockAnomaly: false, status: 'answered', reason: null, route: 'direct' }, answer: { ...normalized, observedAt: at }, brokerIds }; }

test('20k answers/20k failures/two brokers preserve indexed bounded reads, durable write targets and protected prune semantics', () => {
  const dir = mkdtempSync(join(tmpdir(),'region-cost-')), path = join(dir,'metrics.sqlite3'); let store;
  try {
    store = new MetricsStore({ dbPath: path }); const source = start(store); store.close(); store = null;
    // Only known fixture preparation is batched. Measured operations use the
    // real owned store, validation and normal synchronous commit durability.
    let bytesBefore;
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA foreign_keys=ON; BEGIN');
      const outcome = db.prepare(`INSERT INTO region_query_outcomes(request_id,run_id,observer_public_key,target_public_key,
        started_at,completed_at,clock_anomaly,status,reason,route) VALUES(?,?,?,?,?,?,0,?,?,?)`);
      const answer = db.prepare(`INSERT INTO region_answers(request_id,observer_public_key,target_public_key,observed_at,
        regions_json,repeater_clock,body_bytes,csv_bytes,parser_version,completeness,provenance)
        VALUES(?,?,?,?,?,0,?,?,1,'unknown','companion-tag-attributed')`);
      const publication = db.prepare("INSERT INTO region_publications(answer_id,broker_id,state,attempt_count,next_due_at) VALUES(?,?,'pending',0,?)");
      let lastId;
      for (let i=0;i<20000;i++) {
        const requestId = randomUUID(), at = 1000+i;
        outcome.run(requestId,source.runId,OBSERVER,TARGET,at-1,at+1,'answered',null,'direct');
        lastId = Number(answer.run(requestId,OBSERVER,TARGET,at,JSON.stringify(normalized.regions),normalized.bodyBytes,normalized.csvBytes).lastInsertRowid);
        for (const broker of ['first','second']) publication.run(lastId,broker,at+1);
        outcome.run(randomUUID(),source.runId,OBSERVER,TARGET,30000+i,30001+i,'failed','response-timeout',null);
      }
      db.prepare('INSERT INTO region_latest VALUES(?,?,?)').run(OBSERVER,TARGET,lastId); db.exec('COMMIT');
      bytesBefore = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
      for (const [sql,args,index] of [
        ['SELECT id FROM region_answers WHERE observed_at>=? AND observed_at<? ORDER BY observed_at DESC,id DESC LIMIT 200',[0,100000],'idx_region_answers_at'],
        ['SELECT id FROM region_answers WHERE observer_public_key=? AND target_public_key=? AND observed_at>=? AND observed_at<?',[OBSERVER,TARGET,0,100000],'idx_region_answers_scope_at'],
        ['SELECT request_id FROM region_query_outcomes WHERE completed_at>=? AND completed_at<?',[0,100000],'idx_region_outcomes_at'],
        ['SELECT request_id FROM region_query_outcomes WHERE run_id=? AND completed_at>=? AND completed_at<?',[source.runId,0,100000],'idx_region_outcomes_run_at'],
        ['SELECT request_id FROM region_query_outcomes WHERE observer_public_key=? AND target_public_key=? AND completed_at>=? AND completed_at<?',[OBSERVER,TARGET,0,100000],'idx_region_outcomes_scope_at'],
        [`SELECT p.answer_id FROM region_publications p JOIN region_answers a ON a.id=p.answer_id WHERE p.broker_id=?
          AND p.state='pending' AND p.next_due_at<=? AND a.observation_time_conflict=0 ORDER BY p.next_due_at,p.answer_id LIMIT 1`,['first',100000],'idx_region_publications_due'],
        ['SELECT answer_id FROM region_latest WHERE observer_public_key=? AND target_public_key=?',[OBSERVER,TARGET],'PRIMARY KEY']
      ]) assert.match(JSON.stringify(db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args)),new RegExp(index));
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally { db.close(); }
    store = new MetricsStore({ dbPath: path }); const run = start(store), writeTimes = [], fanOutTimes = [];
    for (let i=0;i<200;i++) { const before = performance.now(); store.recordRegionResult(result(run,100000+i,['first','second'])); writeTimes.push(performance.now()-before); }
    const maximumBrokers = ['first','second',...Array.from({ length: 62 },(_,i)=>'extra-'+i)];
    for (let i=0;i<20;i++) { const before = performance.now(); store.recordRegionResult(result(run,200000+i,maximumBrokers)); fanOutTimes.push(performance.now()-before); }
    const readCosts = {};
    for (const [name,read,key,expected] of [
      ['latest',()=>store.getRegionLatest({ observerPublicKey: OBSERVER,targetPublicKey: TARGET,now: 300000,windowMs: 72*3600000 }),null,null],
      ['answers',()=>store.queryRegionAnswers({ ...RANGE,limit: 200 }),'answers',200],
      ['scopedAnswers',()=>store.queryRegionAnswers({ ...RANGE,observerPublicKey: OBSERVER,targetPublicKey: TARGET,limit: 200 }),'answers',200],
      ['outcomes',()=>store.queryRegionOutcomes({ ...RANGE,limit: 200 }),'outcomes',200],
      ['failures',()=>store.queryRegionOutcomes({ ...RANGE,status: 'failed',limit: 200 }),'outcomes',200],
      ['publications',()=>store.queryRegionPublications({ brokerId: 'first',limit: 200 }),'publications',200],
      ['pendingPublications',()=>store.queryRegionPublications({ brokerId: 'second',state: 'pending',limit: 200 }),'publications',200],
      ['lastAnswerPage',()=>store.queryRegionAnswers({ ...RANGE,offset: 20000,limit: 200 }),'answers',200],
      ['pastEnd',()=>store.queryRegionOutcomes({ ...RANGE,offset: 50000,limit: 200 }),'outcomes',0]
    ]) {
      const times = [];
      for (let i=0;i<20;i++) { const before=performance.now(), page=read(); times.push(performance.now()-before);
        if (key) assert.equal(page[key].length,expected); else assert.equal(page.presence,'non-empty'); }
      readCosts[name]=ms(p95(times));
    }
    const claimTimes = [];
    const backfillTimes=[];
    for(let i=0;i<20;i++) {
      const before=performance.now(),page=store.stageRegionLatestPublications({ observerPublicKey:OBSERVER,brokerId:'backfill',now:300000,limit:20 });
      backfillTimes.push(performance.now()-before);assert.equal(page.visited,1);assert.equal(page.staged,i===0?1:0);
    }
    for (let i=0;i<100;i++) {
      const before=performance.now(), saved=store.claimRegionPublication({ brokerId:'first',runId:run.runId,now:300000,observerPublicKey:OBSERVER }); claimTimes.push(performance.now()-before);
      assert.equal(saved.answer.observedAt,1000+i);
      assert.equal(store.resolveRegionPublication({ answerId:saved.answerId,brokerId:'first',runId:run.runId,
        claimToken:saved.claimToken,status:'published',resolvedAt:300001 }),true);
    }
    assert.equal(store.queryRegionAnswers(RANGE).total,20220); assert.equal(store.queryRegionOutcomes({ ...RANGE,status:'failed' }).total,20000);
    store.close(); store=null;
    const beforePrune = new DatabaseSync(path); let bytesAfter;
    try {
      // Known fixture-only acknowledgements let cleanup exercise all 20k old
      // observations; one disabled broker reference deliberately stays pending.
      beforePrune.exec('PRAGMA foreign_keys=ON; BEGIN');
      beforePrune.prepare(`UPDATE region_publications SET state='published',last_result_at=400000,claim_run_id=NULL,claim_token=NULL
        WHERE answer_id<=20000 AND NOT(answer_id=1 AND broker_id='second')`).run();
      beforePrune.prepare("UPDATE region_publications SET state='pending' WHERE answer_id=1 AND broker_id='second'").run();
      beforePrune.exec('COMMIT');
      bytesAfter=beforePrune.prepare('PRAGMA page_count').get().page_count * beforePrune.prepare('PRAGMA page_size').get().page_size;
    } finally { beforePrune.close(); }
    store=new MetricsStore({ dbPath:path }); start(store); const before=performance.now(); store.pruneOlderThan(400001); const pruneMs=performance.now()-before;
    assert.equal(store.queryRegionAnswers(RANGE).total,221); assert.equal(store.queryRegionOutcomes({ ...RANGE,status:'failed' }).total,0);
    assert.equal(store.queryRegionPublications({ brokerId:'second',state:'pending' }).total,221);
    assert.ok(store.getObserverRun({ runId:source.runId }));
    assert.equal(store.queryRegionAnswers({ ...RANGE,runId:source.runId }).answers[0].observedAt,1000);
    assert.equal(store.getRegionLatest({ observerPublicKey:OBSERVER,targetPublicKey:TARGET,now:500000,windowMs:3600000 }).answer.observedAt,200019);
    store.close(); store=null;
    const checked = new DatabaseSync(path); let reusablePages;
    try { assert.deepEqual(checked.prepare('PRAGMA foreign_key_check').all(),[]); reusablePages=checked.prepare('PRAGMA freelist_count').get().freelist_count; }
    finally { checked.close(); }
    console.info('Region cost fixture:', { answers:20000,terminalFailures:20000,initialPublicationRows:40000,
      normalTwoBrokerWriteP95Ms:ms(p95(writeTimes)),maximum64BrokerWriteP95Ms:ms(p95(fanOutTimes)),readP95Ms:readCosts,
      claimP95Ms:ms(p95(claimTimes)),latestBackfillP95Ms:ms(p95(backfillTimes)),pruneMs:ms(pruneMs),fixtureBytes:bytesBefore,measuredGrowthBytes:bytesAfter-bytesBefore,
      reusablePagesAfterPrune:reusablePages,retainedAnswersAfterPrune:221,platform:process.platform,node:process.version,
      targets:{ normalWriteP95Ms:10,readP95Ms:100 } });
    assert.ok(p95(writeTimes)<10,'normal two-broker synchronous write p95 must remain below 10ms');
    assert.ok(p95(claimTimes)<100,'one-item claim p95 must remain below 100ms');
    assert.ok(p95(backfillTimes)<100,'bounded latest backfill p95 must remain below 100ms');
    for (const [name,cost] of Object.entries(readCosts)) assert.ok(cost<100,`${name} bounded read p95 ${cost}ms must remain below 100ms`);
  } finally { store?.close(); rmSync(dir,{ recursive:true,force:true }); }
},30000);
