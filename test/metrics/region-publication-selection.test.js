import { test,afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createPollFixture,reservation,completion,OBSERVER,TARGET,start } from '../fixtures/region-poll.js';
const fixtures=[];const fixture=()=>{const f=createPollFixture();fixtures.push(f);return f;};
afterEach(()=>{for(const f of fixtures.splice(0))f.cleanup();});
function answer(f,changes={},options={}) {
  const input=reservation(f.run,1000,changes),result=completion(input,options).result;
  return f.store.recordRegionResult(result);
}
const claim=(f,brokerId='one',observerPublicKey=OBSERVER,now=5000)=>f.store.claimRegionPublication({ brokerId,observerPublicKey,now,runId:f.run.runId });
test('atomic completion stages only approved destinations; fault rolls back answer, schedule and delivery together',()=>{
  const f=fixture(),reserved=reservation(f.run);f.store.reserveRegionPoll(reserved);
  const result=completion(reserved);result.result.brokerIds=['one','two'];f.store.completeRegionPoll(result);
  for(const id of ['one','two'])assert.equal(f.store.queryRegionPublications({ brokerId:id }).total,1);
  assert.equal(f.store.queryRegionPublications({ brokerId:'opt-out' }).total,0);
  const g=fixture();g.close();g.inspect(db=>db.exec(`CREATE TRIGGER fail_publication BEFORE INSERT ON region_publications
    BEGIN SELECT RAISE(ABORT,'fixture'); END`));g.open();g.run=start(g.store);
  const pending=reservation(g.run);g.store.reserveRegionPoll(pending);const failed=completion(pending);failed.result.brokerIds=['one'];
  assert.throws(()=>g.store.completeRegionPoll(failed));assert.equal(g.store.queryRegionAnswers({ start:0,end:5000 }).total,0);
  assert.equal(g.store.queryRegionPublications({ brokerId:'one' }).total,0);
  assert.equal(g.store.getRegionPollState({ observerPublicKey:OBSERVER,targetPublicKey:TARGET }).reason,'reserved');
});
test('bounded keyset latest backfill skips anomaly/future/conflict and never exports old unstaged history',()=>{
  const f=fixture();answer(f,{}, { csv:'old' });const latest=answer(f,{}, { csv:'new',at:1100 });
  answer(f,{ targetPublicKey:'01'.repeat(32) },{ clockAnomaly:true });
  answer(f,{ targetPublicKey:'02'.repeat(32) },{ observedAt:9000,clockAnomaly:true });
  answer(f,{ targetPublicKey:'03'.repeat(32) },{ csv:'first' });answer(f,{ targetPublicKey:'03'.repeat(32) },{ csv:'conflict' });
  let cursor;let visited=0,staged=0;
  do {
    const page=f.store.stageRegionLatestPublications({ observerPublicKey:OBSERVER,brokerId:'one',now:5000,limit:2,
      ...(cursor?{ afterPublicKey:cursor }:{}) });
    visited+=page.visited;staged+=page.staged;cursor=page.afterPublicKey;
  } while(cursor);
  assert.equal(visited,4);assert.equal(staged,1);assert.equal(claim(f).answerId,latest.answerId);
  assert.equal(f.store.queryRegionAnswers({ start:0,end:10000 }).total,6);
  assert.equal(f.store.stageRegionLatestPublications({ observerPublicKey:OBSERVER,brokerId:'one',now:5000,limit:200 }).staged,0);
});
test('current reporter filter cannot be blocked or reattributed by pending historical identity or unsafe observation',()=>{
  const f=fixture();const other='CD'.repeat(32);
  for(const [changes,options] of [[{ observerPublicKey:other },{}],[{ targetPublicKey:'01'.repeat(32) },{ clockAnomaly:true }],
    [{ targetPublicKey:'02'.repeat(32) },{ observedAt:9000,clockAnomaly:true }],[{},{}]]) {
    const saved=answer(f,changes,options);f.store.stageRegionPublications({ answerId:saved.answerId,brokerIds:['one'] });
  }
  const current=claim(f);assert.equal(current.observerPublicKey,OBSERVER);assert.equal(current.targetPublicKey,TARGET);
  assert.equal(claim(f),null);assert.equal(claim(f,'one',other).observerPublicKey,other);
  assert.equal(f.store.queryRegionPublications({ brokerId:'one',state:'pending' }).total,2);
});
test('backfill validation precedes side effects and a bounded page rolls back if saved content is invalid',()=>{
  const f=fixture();answer(f);
  for(const extra of [{ limit:0 },{ limit:201 },{ brokerId:'' },{ now:-1 },{ afterPublicKey:'a' },{ extra:true }]) {
    assert.throws(()=>f.store.stageRegionLatestPublications({ observerPublicKey:OBSERVER,brokerId:'one',now:5000,...extra }));
  }
  assert.equal(f.store.queryRegionPublications({ brokerId:'one' }).total,0);
  f.close();f.inspect(db=>db.exec("UPDATE region_answers SET csv_bytes=1,body_bytes=5 WHERE id=1"));f.open();
  // Opening alone does not permit writes; start a fresh owned run first.
  f.run=start(f.store,5000);
  assert.throws(()=>f.store.stageRegionLatestPublications({ observerPublicKey:OBSERVER,brokerId:'one',now:5000 }));
  assert.equal(f.store.queryRegionPublications({ brokerId:'one' }).total,0);
});
