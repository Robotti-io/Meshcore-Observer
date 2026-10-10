import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { MetricsStore } from '../../src/metrics/store.js';
import { parseRegionResponseBody } from '../../src/regions/region-response-parser.js';
import { dropTelemetrySchema } from './telemetry-downgrade.js';

export const OBSERVER='BE'.repeat(32), TARGET='AC'.repeat(32), HOUR=3600000;
export const POLICY={ queryRefreshIntervalMs:24*HOUR,queryRetryBaseMs:15*60000,
  queryRetryMaxMs:6*HOUR,queryMaxAttempts:3 };
export const SCOPE={ observerPublicKey:OBSERVER,targetPublicKey:TARGET };
export const start = (store,at=0) => store.beginObserverRun({ runId:randomUUID(),startedAt:at,observedAt:at,
  observedDurationMs:0,appVersion:'2.4.0',nodeVersion:process.version,platform:process.platform,architecture:process.arch });
export function createPollFixture(sql) {
  const dir=mkdtempSync(join(tmpdir(),'region-poll-')),path=join(dir,'metrics.sqlite3');
  const f={ path,store:new MetricsStore({ dbPath:path }) };
  f.close=()=>{ f.store?.close(); f.store=null; };
  f.inspect=work=>{ if(f.store) throw Error('Close owned fixture before external inspection');
    const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');try{return work(db);}finally{db.close();} };
  f.open=()=>{ f.store=new MetricsStore({ dbPath:path });return f.store; };
  f.restart=at=>{ f.close();f.open();f.run=start(f.store,at);return f.run; };
  f.cleanup=()=>{ f.close();rmSync(dir,{ recursive:true,force:true }); };
  if(sql){f.close();f.inspect(db=>db.exec(sql));f.open();}
  f.run=start(f.store);return f;
}
export const reservation=(run,at=1000,changes={})=>({ ...SCOPE,runId:run.runId,requestId:randomUUID(),
  reservedAt:at,policy:{ ...POLICY },jitterRatio:0,...changes });
export function completion(input,{ status='answered',reason=null,csv='',at=input.reservedAt+10,
  observedAt=at,clockAnomaly=false }={}) {
  const { observerPublicKey,targetPublicKey,runId,requestId,policy,jitterRatio }=input;
  return { observerPublicKey,targetPublicKey,runId,requestId,policy,jitterRatio,
    result:{ outcome:{ observerPublicKey,targetPublicKey,runId,requestId,startedAt:input.reservedAt,
      completedAt:at,clockAnomaly,status,reason,route:status==='answered'?'direct':null },
    ...(status==='answered'?{ answer:{ ...parseRegionResponseBody({ body:[0,0,0,0,...Buffer.from(csv)] }).answer,observedAt } }:{}),
    brokerIds:[] } };
}
export function observe(store,key=TARGET,at=1000,hops=0,type='REPEATER') {
  store.recordVerifiedAdvert({ publicKeyHex:key,eventDigest:key.toLowerCase(),name:null,type,receivedAt:at,hopCount:hops });
}
export function pollSnapshot(db) {
  return Object.fromEntries(['region_query_outcomes','region_answers','region_latest','region_publications','region_poll_state']
    .map(table=>[table,db.prepare('SELECT * FROM '+table).all().map(row=>({ ...row }))]));
}
export const dropPollSchema=dropTelemetrySchema+' DROP TABLE region_poll_state; DROP INDEX idx_nodes_type_key;';
