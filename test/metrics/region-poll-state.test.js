import { test,afterEach,vi } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { OBSERVER,TARGET,HOUR,POLICY,SCOPE,createPollFixture,reservation,completion,
  observe,pollSnapshot,dropPollSchema } from '../fixtures/region-poll.js';

const fixtures=[];
const fixture=sql=>{const f=createPollFixture(sql);fixtures.push(f);return f;};
afterEach(()=>{vi.restoreAllMocks();for(const f of fixtures.splice(0))f.cleanup();});
const query=(now=1000,extra={})=>({ observerPublicKey:OBSERVER,now,windowMs:72*HOUR,...extra });

test('migration 15 upgrades v14 atomically without touching any legacy data or staging a query',()=>{
  const f=fixture();observe(f.store);
  f.store.recordRegionResult(completion(reservation(f.run,0)).result);
  f.store.stageRegionPublications({ answerId:f.store.getRegionLatest({ ...SCOPE,now:1000,windowMs:72*HOUR }).answer.answerId,brokerIds:['fixture'] });
  f.close();
  const prior=f.inspect(db=>{
    db.exec(dropPollSchema+' PRAGMA user_version=14');
    return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({name})=>[name,db.prepare('SELECT * FROM '+name).all().map(row=>({...row}))]);
  });
  f.open();assert.equal(f.store.getRegionPollState(SCOPE),null);f.close();
  f.inspect(db=>{
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,16);
    for(const [table,rows] of prior)assert.deepEqual(db.prepare('SELECT * FROM '+table).all().map(row=>({...row})),rows);
    assert.equal(db.prepare('SELECT count(*) AS n FROM region_poll_state').get().n,0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  });
});

test('the final migration index failure rolls back the table, all poll indexes and schema version',()=>{
  const f=fixture();observe(f.store);f.close();
  f.inspect(db=>db.exec(dropPollSchema+" PRAGMA user_version=14; CREATE INDEX idx_nodes_type_key ON nodes(name)"));
  assert.throws(()=>f.open(),/idx_nodes_type_key/);
  f.inspect(db=>{
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'region_poll_%' OR name LIKE 'idx_region_poll_%'").get().n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM nodes').get().n,1);db.exec('DROP INDEX idx_nodes_type_key');
  });
  f.open();f.close();f.inspect(db=>assert.equal(db.prepare('PRAGMA user_version').get().user_version,16));
});

test('candidate pages require fresh verified direct repeater evidence and strict keyset limits',()=>{
  const f=fixture();
  observe(f.store);observe(f.store,'AB'.repeat(32),1000,1);observe(f.store,'AD'.repeat(32),1000,0,'CHAT');
  observe(f.store,'AE'.repeat(32),1001);observe(f.store,'AF'.repeat(32),0);
  f.store.upsertNode({ publicKeyHex:'AA'.repeat(32),name:null,type:'REPEATER',heardAt:1000 });
  const page=f.store.queryRegionPollCandidates(query());
  assert.deepEqual(page.candidates.map(row=>row.targetPublicKey),['AF'.repeat(32),TARGET].sort());
  assert.equal(page.limit,100);assert.equal(page.exhausted,true);
  const cursor=f.store.queryRegionPollCandidates(query(1000,{ limit:1 }));
  assert.equal(cursor.candidates.length,1);assert.equal(cursor.exhausted,false);
  assert.equal(f.store.queryRegionPollCandidates(query(1000,{ afterPublicKey:cursor.nextCursor })).candidates.length,1);
  assert.equal(f.store.queryRegionPollCandidates(query(72*HOUR)).candidates.some(row=>row.targetPublicKey==='AF'.repeat(32)),false);
});

test('validation rejects every scheduling input before writes and does not echo untrusted values',()=>{
  const f=fixture(),r=reservation(f.run);
  for(const input of [null,{}, {...r,tag:42},{...r,observerPublicKey:OBSERVER.toLowerCase()},
    {...r,policy:{...POLICY,queryMaxAttempts:11}},{...r,reservedAt:'SECRET'}]) {
    assert.throws(()=>f.store.reserveRegionPoll(input),error=>error.message==='Invalid region query data');
  }
  for(const input of [{...query(),limit:201},{...query(),eligible:true},{...query(),afterPublicKey:''}]) {
    assert.throws(()=>f.store.queryRegionPollCandidates(input),/Invalid region query data/);
  }
  assert.throws(()=>f.store.getRegionPollState({...SCOPE,extra:true}),/Invalid region query data/);
  assert.throws(()=>f.store.deferRegionPoll({...SCOPE,runId:f.run.runId,observedAt:1000,nextDueAt:999,reason:'contact-missing'}),/Invalid region query data/);
  assert.equal(f.store.getRegionPollState(SCOPE),null);assert.equal(f.store.queryRegionOutcomes({start:0,end:10000}).total,0);
});

test('only the current active owned run can reserve, defer or complete scheduling state',()=>{
  const f=fixture(),r=reservation(f.run);
  assert.throws(()=>f.store.reserveRegionPoll({...r,runId:randomUUID()}),/active owned run/);
  assert.throws(()=>f.store.deferRegionPoll({...SCOPE,runId:randomUUID(),observedAt:1000,nextDueAt:2000,reason:'unsafe-route'}),/active owned run/);
  f.store.reserveRegionPoll(r);
  f.store.endObserverRun({runId:f.run.runId,observedAt:2000,observedDurationMs:2000,reason:'SIGTERM'});
  assert.throws(()=>f.store.completeRegionPoll(completion(r)),/active owned run/);
});

test('reservation persists before RF permission, survives abrupt reopen and creates no terminal evidence',()=>{
  const f=fixture(),r=reservation(f.run),saved=f.store.reserveRegionPoll(r);
  assert.equal(saved.reserved,true);assert.equal(saved.state.cycleReservations,1);
  assert.equal(saved.state.nextDueAt,1000+POLICY.queryRetryBaseMs);
  assert.equal(f.store.queryRegionOutcomes({start:0,end:10*HOUR}).total,0);
  f.restart(2000);
  assert.deepEqual(f.store.getRegionPollState(SCOPE),saved.state);
  assert.equal(f.store.reserveRegionPoll(reservation(f.run,2000)).reason,'not-due');
  assert.throws(()=>f.store.completeRegionPoll(completion(r)),/active owned run/);
  const previous=completion(r);previous.runId=f.run.runId;previous.result.outcome.runId=f.run.runId;
  assert.equal(f.store.completeRegionPoll(previous).reason,'stale-reservation');
  const next=f.store.reserveRegionPoll(reservation(f.run,saved.state.nextDueAt));
  assert.equal(next.reserved,true);assert.equal(next.state.cycleReservations,2);
  assert.equal(f.store.queryRegionOutcomes({start:0,end:10*HOUR}).total,0);
});

test('recent measured empty success seeds a persisted reporter-scoped cooldown without fabricated retries',()=>{
  const f=fixture(),prior=completion(reservation(f.run,0),{at:1000}).result;
  f.store.recordRegionResult(prior);observe(f.store);
  assert.equal(f.store.queryRegionPollCandidates(query(2000)).candidates.length,0);
  const seeded=f.store.reserveRegionPoll(reservation(f.run,2000));
  assert.equal(seeded.reason,'not-due');assert.equal(seeded.state.reason,'seeded-success');
  assert.equal(seeded.state.cycleReservations,0);assert.equal(seeded.state.nextDueAt,1000+POLICY.queryRefreshIntervalMs);
  const other=f.store.reserveRegionPoll(reservation(f.run,2000,{observerPublicKey:'DD'.repeat(32)}));
  assert.equal(other.reserved,true);assert.equal(other.state.cycleReservations,1);
});

for(const mode of ['future','clock-anomaly','ambiguous'])test(mode+' latest does not authorize a fresh-answer cooldown',()=>{
  const f=fixture(),input=completion(reservation(f.run,0),{at:1000,clockAnomaly:mode==='clock-anomaly'}).result;
  if(mode==='future')input.answer.observedAt=100000;
  if(mode==='future')input.outcome.clockAnomaly=true;
  f.store.recordRegionResult(input);
  if(mode==='ambiguous')f.store.recordRegionResult({...input,outcome:{...input.outcome,requestId:randomUUID()},
    answer:{...input.answer,regions:['A'],bodyBytes:5,csvBytes:1}});
  assert.equal(f.store.reserveRegionPoll(reservation(f.run,2000)).reserved,true);
});

test('retained failure or unsupported evidence initializes at least its appropriate cooldown',()=>{
  for(const status of ['failed','unsupported']){
    const f=fixture();f.store.recordRegionResult(completion(reservation(f.run,0),
      {status,reason:status==='failed'?'response-timeout':'unsupported',at:1000}).result);
    const saved=f.store.reserveRegionPoll(reservation(f.run,2000));
    assert.equal(saved.reason,'not-due');
    assert.equal(saved.state.nextDueAt,1000+(status==='failed'?POLICY.queryRetryBaseMs:POLICY.queryRefreshIntervalMs));
    assert.equal(saved.state.cycleReservations,0);
  }
});

test('conditional completion atomically saves a measured empty answer, resets the cycle and stages no broker',()=>{
  const f=fixture(),r=reservation(f.run);f.store.reserveRegionPoll(r);
  const done=f.store.completeRegionPoll(completion(r,{at:1100}));
  assert.equal(done.completed,true);assert.equal(done.state.cycleReservations,0);
  assert.equal(done.state.nextDueAt,1100+POLICY.queryRefreshIntervalMs);
  assert.equal(f.store.getRegionLatest({...SCOPE,now:1200,windowMs:72*HOUR}).presence,'empty');
  assert.equal(f.store.queryRegionPublications({brokerId:'fixture'}).total,0);
  assert.equal(f.store.completeRegionPoll(completion(r,{at:1100})).reason,'already-completed');
  assert.equal(f.store.queryRegionOutcomes({start:0,end:10000}).total,1);
});

test('wrong/stale request, reporter, target and reservation run cannot write terminal evidence',()=>{
  const f=fixture(),r=reservation(f.run);f.store.reserveRegionPoll(r);
  for(const field of ['requestId','observerPublicKey','targetPublicKey']){
    const done=completion(r),value=field==='requestId'?randomUUID():'DD'.repeat(32);
    done[field]=value;done.result.outcome[field]=value;
    assert.equal(f.store.completeRegionPoll(done).reason,'stale-reservation');
  }
  const second=reservation(f.run,1000+POLICY.queryRetryBaseMs);f.store.reserveRegionPoll(second);
  assert.equal(f.store.completeRegionPoll(completion(r)).reason,'stale-reservation');
  assert.equal(f.store.queryRegionOutcomes({start:0,end:10*HOUR}).total,0);
});

test('malformed completion, identity mismatch, broker staging and backdated start are rejected before effects',()=>{
  const f=fixture(),r=reservation(f.run);f.store.reserveRegionPoll(r);
  for(const mutate of [
    input=>{input.result.brokerIds=[''];},input=>{input.result.outcome.requestId=randomUUID();},
    input=>{input.result.answer.regions=['é'];input.result.answer.csvBytes=1;},
    input=>{input.result.outcome.startedAt=999;}]){
    const input=completion(r);mutate(input);
    assert.throws(()=>f.store.completeRegionPoll(input),/Invalid region query data/);
  }
  assert.equal(f.store.getRegionPollState(SCOPE).reason,'reserved');
  assert.equal(f.store.queryRegionOutcomes({start:0,end:10*HOUR}).total,0);
});

test('failure retries grow exponentially with positive capped jitter, exhaustion survives restart and adverts',()=>{
  const f=fixture();let now=1000;
  for(let count=1;count<=3;count++){
    const r=reservation(f.run,now,{jitterRatio:0.1});
    assert.equal(f.store.reserveRegionPoll(r).state.cycleReservations,count);
    const done=f.store.completeRegionPoll(completion(r,{status:'failed',reason:'response-timeout'}));
    const delay=count===3?POLICY.queryRefreshIntervalMs:Math.ceil(POLICY.queryRetryBaseMs*2**(count-1)*1.1);
    assert.equal(done.state.nextDueAt,now+10+delay);now=done.state.nextDueAt;
    if(count===3){
      f.restart(now-1);observe(f.store,TARGET,now-1);
      assert.equal(f.store.reserveRegionPoll(reservation(f.run,now-1)).reason,'not-due');
      assert.equal(f.store.queryRegionPollCandidates(query(now-1)).candidates.length,0);
    }
  }
  assert.equal(f.store.reserveRegionPoll(reservation(f.run,now)).state.cycleReservations,1);
});

test('retry cap applies after jitter and unsupported pauses a whole refresh interval',()=>{
  const f=fixture(),policy={...POLICY,queryRetryBaseMs:60*60000,queryRetryMaxMs:HOUR,queryMaxAttempts:10};
  const r=reservation(f.run,1000,{policy,jitterRatio:0.1});
  assert.equal(f.store.reserveRegionPoll(r).state.nextDueAt,1000+HOUR);
  const failed=f.store.completeRegionPoll(completion(r,{status:'failed',reason:'command-error'}));
  assert.equal(failed.state.nextDueAt,1010+HOUR);
  const next=reservation(f.run,failed.state.nextDueAt,{policy});
  f.store.reserveRegionPoll(next);
  const done=f.store.completeRegionPoll(completion(next,{status:'unsupported',reason:'unsupported'}));
  assert.equal(done.state.reason,'unsupported');assert.equal(done.state.cycleReservations,0);
  assert.equal(done.state.nextDueAt,next.reservedAt+10+policy.queryRefreshIntervalMs);
});

test('configured contact deferrals preserve deadlines/counts and never create outcome rows',()=>{
  const f=fixture(),r=reservation(f.run),saved=f.store.reserveRegionPoll(r).state;
  const input={...SCOPE,runId:f.run.runId,observedAt:1000,nextDueAt:2000,reason:'contact-missing'};
  assert.equal(f.store.deferRegionPoll(input).reason,'not-due');
  input.observedAt=saved.nextDueAt;input.nextDueAt=input.observedAt+POLICY.queryRetryBaseMs;
  const done=f.store.deferRegionPoll(input);assert.equal(done.deferred,true);assert.equal(done.transitioned,true);
  assert.equal(done.state.cycleReservations,1);assert.equal(done.state.requestId,r.requestId);
  assert.equal(f.store.completeRegionPoll(completion(r)).reason,'already-completed');
  assert.equal(f.store.queryRegionOutcomes({start:0,end:10*HOUR}).total,0);
  const again=f.store.deferRegionPoll({...input,observedAt:input.nextDueAt,nextDueAt:input.nextDueAt+1});
  assert.equal(again.transitioned,false);
});

test('shortened cadence or raised attempts cannot accelerate a saved cooldown; lowered attempts stop an active cycle',()=>{
  const f=fixture(),r=reservation(f.run,1000);
  const saved=f.store.reserveRegionPoll(r).state;
  const smaller={...POLICY,queryRetryBaseMs:3*60000,queryRetryMaxMs:HOUR,queryMaxAttempts:10};
  assert.equal(f.store.reserveRegionPoll(reservation(f.run,2000,{policy:smaller})).reason,'not-due');
  assert.equal(f.store.getRegionPollState(SCOPE).nextDueAt,saved.nextDueAt);
  const lowered={...POLICY,queryMaxAttempts:1};
  const stopped=f.store.reserveRegionPoll(reservation(f.run,saved.nextDueAt,{policy:lowered}));
  assert.equal(stopped.reason,'not-due');assert.equal(stopped.state.nextDueAt,1000+POLICY.queryRefreshIntervalMs);
  assert.equal(f.store.reserveRegionPoll(reservation(f.run,saved.nextDueAt,{policy:smaller})).reason,'not-due');
});

test('rollback is blocked from durable policy/run high water across reopen without falsifying terminal timestamps',()=>{
  const f=fixture(),r=reservation(f.run,10000);f.store.reserveRegionPoll(r);
  const done=completion(r,{status:'failed',reason:'response-timeout',at:9000,clockAnomaly:true});
  assert.equal(f.store.completeRegionPoll(done).completed,true);
  assert.equal(f.store.getRegionPollState(SCOPE).lastPolicyAt,10000);
  f.restart(9500);
  assert.equal(f.store.getRegionPollHighWater(),10000);
  assert.equal(f.store.queryRegionPollCandidates(query(9999)).clockRollback,true);
  assert.equal(f.store.reserveRegionPoll(reservation(f.run,9999)).reason,'clock-rollback');
  assert.equal(f.store.deferRegionPoll({...SCOPE,runId:f.run.runId,observedAt:9999,nextDueAt:10001,reason:'unsafe-route'}).reason,'clock-rollback');
  assert.equal(f.store.queryRegionOutcomes({start:0,end:20000}).outcomes[0].completedAt,9000);
});

test('request identities cannot be reused to consume another reservation or overwrite prior outcome evidence',()=>{
  const f=fixture(),r=reservation(f.run);f.store.reserveRegionPoll(r);
  assert.equal(f.store.reserveRegionPoll(r).reason,'duplicate-reservation');
  f.store.completeRegionPoll(completion(r));
  assert.equal(f.store.reserveRegionPoll({...r,reservedAt:24*HOUR+2000}).reason,'duplicate-reservation');
  const different=reservation(f.run,24*HOUR+2000,{requestId:r.requestId,targetPublicKey:'DD'.repeat(32)});
  assert.equal(f.store.reserveRegionPoll(different).reason,'duplicate-reservation');
  assert.equal(f.store.queryRegionOutcomes({start:0,end:30*HOUR}).total,1);
});

test('terminal failure retains a prior measured answer without pretending silence means unsupported',()=>{
  const f=fixture(),prior=completion(reservation(f.run,0),{at:1000,csv:'Kept'}).result;
  f.store.recordRegionResult(prior);const r=reservation(f.run,25*HOUR);
  f.store.reserveRegionPoll(r);const done=f.store.completeRegionPoll(completion(r,{status:'failed',reason:'response-timeout'}));
  assert.equal(done.state.cycleReservations,1);
  const saved=f.store.getRegionLatest({...SCOPE,now:r.reservedAt+20,windowMs:72*HOUR});
  assert.deepEqual(saved.answer.regions,['Kept']);assert.equal(saved.answer.observedAt,1000);
  assert.equal(saved.latestOutcome.status,'failed');assert.equal(saved.latestOutcome.reason,'response-timeout');
});

test('current cadence lengthens an initialized receipt baseline while shorter cadence retains the saved deadline',()=>{
  const f=fixture(),r=reservation(f.run,1000);observe(f.store);f.store.reserveRegionPoll(r);
  f.store.completeRegionPoll(completion(r));
  const longer={...POLICY,queryRefreshIntervalMs:48*HOUR},now=24*HOUR+1010;
  assert.equal(f.store.queryRegionPollCandidates(query(now),longer).candidates.length,0);
  const saved=f.store.reserveRegionPoll(reservation(f.run,now,{policy:longer}));
  assert.equal(saved.reason,'not-due');assert.equal(saved.state.nextDueAt,48*HOUR+1010);
  const shorter={...POLICY,queryRefreshIntervalMs:HOUR};
  assert.equal(f.store.reserveRegionPoll(reservation(f.run,now,{policy:shorter})).reason,'not-due');
  assert.equal(f.store.queryRegionPollCandidates(query(now),shorter).candidates.length,0);
});

test('custom deferral policy seeds a recent answer conservatively without consuming a reservation',()=>{
  const f=fixture(),input=completion(reservation(f.run,0),{at:1000}).result;f.store.recordRegionResult(input);
  const saved=f.store.deferRegionPoll({...SCOPE,runId:f.run.runId,observedAt:2000,nextDueAt:3000,reason:'unsafe-route'},
    {...POLICY,queryRefreshIntervalMs:48*HOUR});
  assert.equal(saved.state.nextDueAt,48*HOUR+1000);assert.equal(saved.state.cycleReservations,0);
  assert.equal(f.store.queryRegionOutcomes({start:0,end:3000}).total,1);
});

test('an ambiguous measured answer preserves bounded retries without replacing its original timestamp',()=>{
  const f=fixture(),prior=completion(reservation(f.run,0),{at:1000,csv:'Old'}).result;f.store.recordRegionResult(prior);
  const second={...prior,outcome:{...prior.outcome,requestId:randomUUID()},answer:{...prior.answer,regions:['New']}};
  f.store.recordRegionResult(second);const r=reservation(f.run,2000);f.store.reserveRegionPoll(r);
  const result=completion(r,{at:2010,csv:'Changed',observedAt:1000,clockAnomaly:true});
  const done=f.store.completeRegionPoll(result);
  assert.equal(done.recorded.observationTimeConflict,true);assert.equal(done.state.cycleReservations,1);
  assert.equal(done.state.reason,'clock-anomaly');
  assert.equal(f.store.queryRegionAnswers({start:0,end:3000}).answers[0].observedAt,1000);
});

test('clock upper bounds do not grant a reservation without room for the saved cooldown',()=>{
  const f=fixture();assert.equal(f.store.reserveRegionPoll(reservation(f.run,Number.MAX_SAFE_INTEGER)).reason,'clock-range');
  assert.equal(f.store.getRegionPollState(SCOPE),null);
});

for(const point of ['region_query_outcomes','region_answers','region_latest','region_poll_state']) {
  test('completion failure at '+point+' rolls back both terminal data and scheduling state',()=>{
    const trigger=point==='region_poll_state'?'BEFORE UPDATE':'BEFORE INSERT';
    const f=fixture('CREATE TRIGGER fail_poll '+trigger+' ON '+point+" BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    const r=reservation(f.run);const saved=f.store.reserveRegionPoll(r).state;
    assert.throws(()=>f.store.completeRegionPoll(completion(r)),/fixture failure/);
    assert.deepEqual(f.store.getRegionPollState(SCOPE),saved);
    assert.equal(f.store.queryRegionOutcomes({start:0,end:10000}).total,0);
    assert.equal(f.store.getRegionLatest({...SCOPE,now:2000,windowMs:72*HOUR}).answer,null);
  });
}

test('reservation and commit faults never grant permission and preserve prior database state',()=>{
  const f=fixture("CREATE TRIGGER fail_reserve BEFORE INSERT ON region_poll_state BEGIN SELECT RAISE(ABORT,'fixture reservation'); END");
  assert.throws(()=>f.store.reserveRegionPoll(reservation(f.run)),/fixture reservation/);
  assert.equal(f.store.getRegionPollState(SCOPE),null);
  const second=fixture(),r=reservation(second.run);const exec=DatabaseSync.prototype.exec;
  const spy=vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(sql){
    if(sql==='COMMIT')throw Error('fixture commit');return exec.call(this,sql);
  });
  assert.throws(()=>second.store.reserveRegionPoll(r),/fixture commit/);spy.mockRestore();
  assert.equal(second.store.getRegionPollState(SCOPE),null);
});

test('an atomic completion commit fault preserves the reservation cooldown and prior latest answer',()=>{
  const f=fixture(),prior=completion(reservation(f.run,0),{at:10,csv:'Kept'}).result;
  f.store.recordRegionResult(prior);const r=reservation(f.run,25*HOUR);const saved=f.store.reserveRegionPoll(r).state;
  const exec=DatabaseSync.prototype.exec;
  const spy=vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(sql){
    if(sql==='COMMIT')throw Error('fixture commit');return exec.call(this,sql);
  });
  assert.throws(()=>f.store.completeRegionPoll(completion(r,{csv:'New'})),/fixture commit/);spy.mockRestore();
  assert.deepEqual(f.store.getRegionPollState(SCOPE),saved);
  assert.deepEqual(f.store.getRegionLatest({...SCOPE,now:25*HOUR+10,windowMs:72*HOUR}).answer.regions,['Kept']);
});

test('schedule/source-run FKs survive pruning while old completion cannot recreate pruned terminal history',()=>{
  const f=fixture(),r=reservation(f.run),source=f.run.runId;f.store.reserveRegionPoll(r);
  const done=completion(r,{status:'failed',reason:'response-timeout'});f.store.completeRegionPoll(done);
  f.store.endObserverRun({runId:source,observedAt:2000,observedDurationMs:2000,reason:'SIGTERM'});
  f.restart(48*HOUR);f.store.pruneOlderThan(48*HOUR);
  assert.notEqual(f.store.getObserverRun({runId:source}),null);
  assert.equal(f.store.queryRegionOutcomes({start:0,end:50*HOUR}).total,0);
  assert.equal(f.store.getRegionPollState(SCOPE).requestId,r.requestId);
  assert.throws(()=>f.store.completeRegionPoll(done),/active owned run/);
  f.store.reserveRegionPoll(reservation(f.run,48*HOUR));
  f.store.pruneOlderThan(48*HOUR);
  assert.equal(f.store.getObserverRun({runId:source}),null);
  assert.notEqual(f.store.getRegionPollState(SCOPE),null);
  f.close();f.inspect(db=>assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]));
});

test('stored clock rollback markers and direct eligibility are independent from retained history and reporter names',()=>{
  const f=fixture();observe(f.store);const first=f.store.queryRegionPollCandidates(query(1000));assert.equal(first.candidates.length,1);
  assert.equal(f.store.queryRegionPollCandidates(query(999)).clockRollback,true);
  assert.equal(f.store.queryRegionPollCandidates(query(1000)).candidates.length,1);
  f.store.recordVerifiedAdvert({publicKeyHex:TARGET,eventDigest:'dd'.repeat(32),name:'Renamed',type:'REPEATER',receivedAt:2000,hopCount:1});
  assert.equal(f.store.queryRegionPollCandidates(query(72*HOUR+1000)).candidates.length,0,'expiry equality is not renewed by relayed reception');
});

test('fresh database poll CHECK constraints and schema contain no wire replay or credential data',()=>{
  const f=fixture();f.close();f.inspect(db=>{
    const fields=db.prepare('PRAGMA table_info(region_poll_state)').all().map(row=>row.name);
    assert.doesNotMatch(fields.join(' '),/tag|body|password|credential|path|broker/);
    const sql="INSERT INTO region_poll_state(observer_public_key,target_public_key,next_due_at,cycle_started_at,cycle_reservations,last_policy_at,last_reason) VALUES(?,?,?,0,?,0,'ready')";
    for(const args of [[OBSERVER,TARGET,-1,0],[OBSERVER,TARGET,0,11],[OBSERVER.toLowerCase(),TARGET,0,0]]){
      assert.throws(()=>db.prepare(sql).run(...args),/CHECK/);
    }
    assert.equal(pollSnapshot(db).region_poll_state.length,0);
  });
});
