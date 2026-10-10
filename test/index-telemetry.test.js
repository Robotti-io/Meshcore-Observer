import {test,afterEach} from 'vitest';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,existsSync,copyFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MetricsStore} from '../src/metrics/store.js';
import {startTelemetryRun,telemetryLifecycleResults,telemetryResult,telemetrySnapshot,
  TELEMETRY_OBSERVER} from './fixtures/telemetry-store.js';
import {dropTelemetrySchema} from './fixtures/telemetry-downgrade.js';
import {dropRegionSchema} from './fixtures/region-downgrade.js';

const DAY=86400000,HOUR=3600000;
const children=new Set(),dirs=new Set();
afterEach(async()=>{
  for(const child of children){child.process.kill();await child.exited;}children.clear();
  for(const dir of dirs)rmSync(dir,{recursive:true,force:true});dirs.clear();
});
function environment(){
  const dir=mkdtempSync(join(tmpdir(),'telemetry-entrypoint-'));dirs.add(dir);
  const bots=join(dir,'bots.json'),brokers=join(dir,'brokers.json');writeFileSync(bots,'[]');writeFileSync(brokers,'[]');
  const env={...process.env,PACKETCAPTURE_CONNECTION_TYPE:'tcp',PACKETCAPTURE_TCP_HOST:'127.0.0.1',
    PACKETCAPTURE_TCP_PORT:'1',PACKETCAPTURE_IATA:'CVG',PACKETCAPTURE_BOTS_CONFIG_FILE:bots,
    PACKETCAPTURE_BROKERS_CONFIG_FILE:brokers,PACKETCAPTURE_METRICS_UI_ENABLED:'false',
    PACKETCAPTURE_REGION_DISCOVERY_ENABLED:'false',PACKETCAPTURE_METRICS_UI_DB_PATH:join(dir,'metrics.sqlite3'),
    PACKETCAPTURE_METRICS_UI_SAMPLE_INTERVAL_MS:'1000',PACKETCAPTURE_METRICS_UI_RETENTION_DAYS:'0',
    PACKETCAPTURE_REPEATER_FINGERPRINT_PRUNE_AFTER_DAYS:'0',PACKETCAPTURE_TOPOLOGY_PRUNE_AFTER_DAYS:'0'};
  delete env.PACKETCAPTURE_TELEMETRY_FRESHNESS_HOURS;return env;
}
function launch(env){
  const childProcess=spawn(process.execPath,[resolve('test/fixtures/telemetry-lifecycle-child.js')],
    {env,cwd:process.cwd(),stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  let output='';const mailbox=[],waiting=[];
  childProcess.stdout.on('data',x=>{output+=x;});childProcess.stderr.on('data',x=>{output+=x;});
  childProcess.on('message',message=>{const next=waiting.shift();if(next)next.resolve(message);else mailbox.push(message);});
  const child={process:childProcess,exited:new Promise(resolve=>childProcess.on('exit',(code,signal)=>{
    children.delete(child);for(const next of waiting.splice(0))next.reject(new Error('Child exited before fixture reply: '+output));
    resolve({code,signal,output});
  })),next:()=>mailbox.length?Promise.resolve(mailbox.shift()):new Promise((resolve,reject)=>waiting.push({resolve,reject}))};
  children.add(child);return child;
}
async function command(child,action,extra={}){child.process.send({action,...extra});return child.next();}
async function stop(child){child.process.send({action:'stop'});const ended=await child.exited;assert.equal(ended.code,0,ended.output);}
function inspect(path,work){const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');try{return work(db);}finally{db.close();}}
function noCollection(snapshot,mqttPublications=0){assert.deepEqual(snapshot.counts,{radioStarts:1,remoteRequests:0,brokerStarts:0,httpStarts:0,mqttPublications});}
function sameData(before,after,mqttPublications=0){
  assert.deepEqual(after.observations,before.observations);assert.deepEqual(after.outcomes,before.outcomes);
  assert.deepEqual(after.latest.map(x=>[x.observation,x.fullyDecoded.observation,x.latestOutcome,x.coverage]),
    before.latest.map(x=>[x.observation,x.fullyDecoded.observation,x.latestOutcome,x.coverage]));
  assert.equal(after.instanceId,before.instanceId);noCollection(after,mqttPublications);
}
function seedLegacy(path){
  const store=new MetricsStore({dbPath:path}),run=startTelemetryRun(store);
  try{
    store.recordVerifiedAdvert({publicKeyHex:'EF'.repeat(32),eventDigest:'ef'.repeat(32),name:'Retained fixture',
      type:'REPEATER',receivedAt:1000,hopCount:0});
    store.recordTopologyObservation({runId:run.runId,observerPublicKey:TELEMETRY_OBSERVER,receivedAt:1000,
      route:1,kind:'flood-traversed',payloadVersion:0,hashWidth:1,prefixes:['EF'],transportCodes:null,containsRepeatedPrefix:false});
    store.recordPacketSample({sampleAt:1000,intervalMs:1000,packetsReceived:1,packetsDecoded:1,
      radioConnected:true,brokersConnected:0,brokersTotal:0,botsReady:0,botsTotal:0,replyQueueSize:0,
      packetsByType:{advert:1},brokerDeliveries:{}});
    store.endObserverRun({runId:run.runId,observedAt:2000,observedDurationMs:2000,reason:'SIGINT'});
  }finally{store.close();}return run;
}

for(const version of [13,14,15])test(`offline real entrypoint upgrades v${version} to 16, preserving legacy capture/inventory/topology and inventing no telemetry`,async()=>{
  const env=environment(),path=env.PACKETCAPTURE_METRICS_UI_DB_PATH;seedLegacy(path);
  inspect(path,db=>{
    if(version===13)db.exec(dropRegionSchema);
    else if(version===14)db.exec(dropTelemetrySchema+' DROP TABLE region_poll_state; DROP INDEX idx_nodes_type_key;');
    else db.exec(dropTelemetrySchema);
    db.exec(`PRAGMA user_version=${version}`);
  });
  const child=launch(env);assert.equal((await child.next()).ready,true);const saved=await command(child,'snapshot');
  assert.equal(saved.observations.total,0);assert.equal(saved.outcomes.total,0);assert.deepEqual(saved.latest,[]);
  assert.equal(saved.nodes,1);assert.equal(saved.adverts.events,1);assert.equal(saved.topology.total,1);
  assert.equal(saved.packets.received,1);noCollection(saved);await stop(child);
  inspect(path,db=>{assert.equal(db.prepare('PRAGMA user_version').get().user_version,16);
    assert.equal(db.prepare('SELECT name FROM nodes').get().name,'Retained fixture');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);});
});

for(const ending of ['clean','abrupt'])test(`supported/partial/empty observations and terminal failures survive offline ${ending} restart with original source context`,async()=>{
  const env=environment(),child=launch(env);await child.next();const seeded=await command(child,'seed');
  assert.equal(seeded.seeded,true);const before=await command(child,'snapshot');
  assert.equal(before.observations.total,8);assert.equal(before.outcomes.total,10);assert.equal(before.latest.length,6);noCollection(before);
  const sensor=before.latest.find(x=>x.variant.component==='sensors');assert.equal(sensor.observation.quality,'partial');
  assert.equal(sensor.fullyDecoded.observation.quality,'decoded');assert.equal(sensor.latestOutcome.status,'unsupported');
  assert.equal(sensor.observation.data.readings[0].unit,'V');assert.equal(sensor.observation.data.readings[0].value,3.3);
  const common=before.latest.find(x=>x.variant.component==='status'&&x.variant.profile.evidence==='established'&&x.variant.profile.layout==='common48');
  assert.equal(common.observation.data.rxAirtimeSeconds,null);assert.equal(common.observation.data.batteryMillivolts,3300);
  const empty=before.latest.find(x=>x.variant.component==='neighbours'&&x.variant.params.offset===0);
  assert.deepEqual(empty.observation.data.entries,[]);assert.equal(empty.observation.data.reportedTotal,0);
  if(ending==='clean')await stop(child);else{child.process.kill();await child.exited;}
  const next=launch(env);await next.next();const after=await command(next,'snapshot');sameData(before,after);
  assert.notEqual(after.runId,before.runId);assert.equal(after.runs.runs.find(x=>x.runId===before.runId).state,ending==='clean'?'clean':'unclean');
  const now=Date.now()+73*HOUR,stale=await command(next,'snapshot',{now});assert.ok(stale.latest.every(x=>x.freshness==='stale'));
  assert.ok(stale.latest.every(x=>x.fullyDecoded.observation===null||x.fullyDecoded.freshness==='stale'));
  const rollback=await command(next,'snapshot');assert.ok(rollback.latest.every(x=>x.clockRollback&&x.freshness==='stale'));
  await stop(next);inspect(env.PACKETCAPTURE_METRICS_UI_DB_PATH,db=>assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]));
});

test('closed checkpointed backup restores full telemetry, source instance/run identity and readonly restart semantics through real entrypoint',async()=>{
  const env=environment(),path=env.PACKETCAPTURE_METRICS_UI_DB_PATH,child=launch(env);await child.next();await command(child,'seed');
  const before=await command(child,'snapshot');await stop(child);assert.equal(existsSync(path+'-wal'),false);
  const backup=join(dirname(path),'telemetry-backup.sqlite3');copyFileSync(path,backup);
  const saved=inspect(path,telemetrySnapshot);assert.deepEqual(inspect(backup,telemetrySnapshot),saved);
  const restored=launch({...env,PACKETCAPTURE_METRICS_UI_DB_PATH:backup});await restored.next();const after=await command(restored,'snapshot');
  sameData(before,after);assert.equal(after.runs.runs.find(x=>x.runId===before.runId).state,'clean');await stop(restored);
  inspect(backup,db=>{assert.deepEqual(telemetrySnapshot(db),saved);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);});
});

for(const retentionDays of [0,7,36500])test(`real dashboard-disabled sampler honors ${retentionDays}-day shared retention with protected useful/decoded/empty source evidence`,async()=>{
  const env={...environment(),PACKETCAPTURE_METRICS_UI_RETENTION_DAYS:String(retentionDays)},path=env.PACKETCAPTURE_METRICS_UI_DB_PATH;
  const store=new MetricsStore({dbPath:path}),run=startTelemetryRun(store),inputs=telemetryLifecycleResults(run,DAY);
  const disposable=telemetryResult(run,{clockAnomaly:true,observedAt:2*DAY,observer:'EF'.repeat(32)});
  try{for(const input of [...inputs,disposable])store.recordTelemetryResult(input);
    store.endObserverRun({runId:run.runId,observedAt:3*DAY,observedDurationMs:3*DAY,reason:'SIGINT'});
  }finally{store.close();}
  const child=launch(env);await child.next();const before=await command(child,'snapshot');assert.equal(before.observations.total,9);
  assert.equal((await command(child,'sample')).sampled,true);const after=await command(child,'snapshot');noCollection(after);
  assert.equal(after.observations.total,retentionDays===7?7:9);assert.equal(after.outcomes.total,retentionDays===7?7:11);
  assert.ok(after.latest.every(x=>x.freshness==='stale'));assert.ok(after.runs.runs.some(x=>x.runId===run.runId));
  assert.equal(after.resources.samples[0].runId,after.runId);await stop(child);
  inspect(path,db=>assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]));
});

for(const setting of [undefined,'1','8760'])test(`real offline startup and internal consumer use telemetry freshness ${setting??'omitted default'} without collection`,async()=>{
  const env=environment();if(setting!==undefined)env.PACKETCAPTURE_TELEMETRY_FRESHNESS_HOURS=setting;
  const child=launch(env);await child.next();const saved=await command(child,'snapshot');
  assert.equal(saved.config.freshnessWindowMs,Number(setting??72)*HOUR);assert.equal(saved.config.retentionDays,0);noCollection(saved);await stop(child);
});

for(const setting of ['', '0','8761','1.5','not-a-number'])test(`invalid explicit telemetry freshness ${JSON.stringify(setting)} fails before store/hardware/network startup`,()=>{
  const env={...environment(),PACKETCAPTURE_TELEMETRY_FRESHNESS_HOURS:setting};
  const result=spawnSync(process.execPath,[resolve('test/fixtures/telemetry-lifecycle-child.js')],
    {env,cwd:process.cwd(),encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(result.status,1);assert.match(result.stdout+result.stderr,/Configuration error:/);
  assert.doesNotMatch(result.stdout+result.stderr,/TELEMETRY_FIXTURE_RADIO_STARTED|meshcore-observer starting|Unexpected/);
  assert.equal(existsSync(env.PACKETCAPTURE_METRICS_UI_DB_PATH),false);
});

for(const kind of ['directory','corrupt'])test(`${kind} database is startup-fatal before radio/broker/HTTP lifecycle`,()=>{
  const env=environment(),path=env.PACKETCAPTURE_METRICS_UI_DB_PATH;
  if(kind==='directory')mkdirSync(path);else writeFileSync(path,'synthetic invalid sqlite data');
  const result=spawnSync(process.execPath,[resolve('test/fixtures/telemetry-lifecycle-child.js')],
    {env,cwd:process.cwd(),encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(result.status,1);assert.match(result.stdout+result.stderr,/failed to open the persisted data store/);
  assert.doesNotMatch(result.stdout+result.stderr,/TELEMETRY_FIXTURE_RADIO_STARTED|Unexpected/);
});

test('real startup migration failure rolls back v15/schema/legacy data, releases ownership and allows repaired retry',async()=>{
  const env=environment(),path=env.PACKETCAPTURE_METRICS_UI_DB_PATH;seedLegacy(path);
  inspect(path,db=>db.exec(dropTelemetrySchema+' PRAGMA user_version=15; CREATE INDEX idx_telemetry_latest_decoded ON nodes(name);'));
  const result=spawnSync(process.execPath,[resolve('test/fixtures/telemetry-lifecycle-child.js')],
    {env,cwd:process.cwd(),encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(result.status,1);assert.match(result.stdout+result.stderr,/idx_telemetry_latest_decoded/);
  assert.doesNotMatch(result.stdout+result.stderr,/TELEMETRY_FIXTURE_RADIO_STARTED|Unexpected/);
  inspect(path,db=>{assert.equal(db.prepare('PRAGMA user_version').get().user_version,15);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'telemetry_%'").get().n,0);
    assert.equal(db.prepare('SELECT name FROM nodes').get().name,'Retained fixture');db.exec('DROP INDEX idx_telemetry_latest_decoded');});
  const child=launch(env);await child.next();noCollection(await command(child,'snapshot'));await stop(child);
  inspect(path,db=>assert.equal(db.prepare('PRAGMA user_version').get().user_version,16));
});

test('live telemetry database ownership rejects a second startup clearly; capture still samples and original telemetry survives',async()=>{
  const env=environment(),child=launch(env);await child.next();await command(child,'seed');const before=await command(child,'snapshot');
  const blocked=spawnSync(process.execPath,[resolve('test/fixtures/telemetry-lifecycle-child.js')],
    {env,cwd:process.cwd(),encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(blocked.status,1);assert.match(blocked.stdout+blocked.stderr,/Only one Observer can use this database at a time/);
  assert.match(blocked.stdout+blocked.stderr,/Stop the other Observer instance/);assert.doesNotMatch(blocked.stdout+blocked.stderr,/TELEMETRY_FIXTURE_RADIO_STARTED|Unexpected/);
  assert.equal((await command(child,'capture')).captured,true);assert.equal((await command(child,'sample')).sampled,true);
  const after=await command(child,'snapshot');sameData(before,after,1);assert.ok(after.packets.received>=1);assert.ok(after.resources.total>=1);
  await stop(child);
});
