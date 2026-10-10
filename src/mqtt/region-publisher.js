import { compileSchema } from '../validation/ajv.js';
import { assertRegionQueryInput } from '../regions/region-query-validation.js';
import { regionSchedulerSnapshotSchema,regionSchedulerClockSchema } from '../regions/region-query-schemas.js';
import { regionClaimPublicationSchema } from '../regions/region-schemas.js';
import { assertRegionInput } from '../regions/region-validation.js';
import { REGION_PUBLICATION_DEFAULTS,regionPublicationConfigSchema,regionPublicationBrokerIdsSchema,
  regionTransportResultSchema } from './region-publication-schemas.js';
import { buildRegionPublication } from './region-payload.js';
import { performance } from 'node:perf_hooks';

const settingsValid=compileSchema(regionPublicationConfigSchema),idsValid=compileSchema(regionPublicationBrokerIdsSchema);
const resultValid=compileSchema(regionTransportResultSchema);
const at=(now,delay)=>Math.min(Number.MAX_SAFE_INTEGER,now+delay);

/** One bounded job per opted-in broker. SQLite owns the queue, retries and
 * original observation. Runtime memory holds only current jobs/cursors and
 * at most one unsaved transport resolution per broker. */
export class RegionPublisher {
  #store;#runId;#radio;#mqtt;#logger;#now;#monotonic;
  #destinations;#timers=[];#jobs=new Map();#unsaved=new Map();#faults=new Map();#cursors=new Map();
  #started=false;#stopped=false;#highWater=0;#anchor=null;
  constructor({ store,runId,radio,mqttManager,brokers,logger,now=Date.now,monotonicNow=()=>performance.now() }) {
    this.#destinations=brokers.filter(b=>b.enabled && b.regionPublication?.enabled).map(b=>{
      const settings={ ...REGION_PUBLICATION_DEFAULTS,...b.regionPublication };
      if(!settingsValid(settings) || settings.retryBaseMs>settings.retryMaxMs) throw new Error('Invalid region publication configuration');
      return Object.freeze({ id:b.id,settings:Object.freeze(settings) });
    });
    if(!idsValid(this.#destinations.map(b=>b.id))) throw new Error('Invalid region publication destinations');
    // The shared claim schema validates run identity even when no broker is on.
    assertRegionInput(regionClaimPublicationSchema,{ brokerId:'validation',runId,now:0 });
    this.#store=store;this.#runId=runId;this.#radio=radio;this.#mqtt=mqttManager;this.#logger=logger;
    this.#now=now;this.#monotonic=monotonicNow;
  }
  start() {
    if(this.#started || this.#stopped) return;
    this.#started=true;
    for(const destination of this.#destinations) {
      const timer=setInterval(()=>this.#launch(destination),destination.settings.tickIntervalMs);
      timer.unref();this.#timers.push(timer);
    }
  }
  stop() { this.#stopped=true;for(const timer of this.#timers)clearInterval(timer);this.#timers=[]; }
  async drain() {
    await Promise.all([...this.#jobs.values()]);
    for(const destination of this.#destinations) this.#persist(destination.id);
    if(this.#unsaved.size) throw new Error('Region publication result was not persisted; clean shutdown cannot be confirmed');
  }
  #warn(id,reason) {
    if(this.#faults.get(id)===reason) return;
    this.#faults.set(id,reason);
    this.#logger.warn('services.regionPublication',reason==='persistence'
      ? 'Region delivery result could not be saved. This broker is paused while the result is retried locally; its saved answer remains protected.'
      : reason==='publish-failed'
        ? 'Region publication failed or its acknowledgement timed out. The saved observation will be retried; verify client-topic ACL permissions and broker availability.'
        : 'Region publication deferred because identity, clock or saved data could not be validated. Saved answers remain available locally.',
    { broker:id,outcome:reason });
  }
  #launch(destination) {
    if(this.#stopped || this.#jobs.has(destination.id)) return;
    const job=this.#step(destination).catch(()=>this.#warn(destination.id,'validation')).finally(()=>this.#jobs.delete(destination.id));
    this.#jobs.set(destination.id,job);
  }
  #clock() {
    const sample={ wall:this.#now(),monotonic:this.#monotonic() };
    assertRegionQueryInput(regionSchedulerClockSchema,sample);
    this.#anchor ??= sample;
    const projected=this.#anchor.wall+Math.floor(Math.max(0,sample.monotonic-this.#anchor.monotonic)/1000)*1000;
    this.#highWater=Math.max(this.#highWater,projected,this.#store.getRegionPollHighWater());
    const paused=sample.wall<this.#highWater;
    if(!paused && sample.wall>projected)this.#anchor=sample;
    this.#highWater=Math.max(this.#highWater,sample.wall);
    return { now:sample.wall,paused };
  }
  #snapshot() {
    const snapshot=this.#radio.getConnectionSnapshot();
    assertRegionQueryInput(regionSchedulerSnapshotSchema,snapshot);
    return { ...snapshot,observerPublicKey:snapshot.observerPublicKey?.toUpperCase() ?? null };
  }
  #persist(id) {
    const resolution=this.#unsaved.get(id);if(!resolution)return true;
    try {
      if(!this.#store.resolveRegionPublication(resolution)) throw new Error('Unconfirmed publication resolution');
      this.#unsaved.delete(id);this.#faults.delete(id);return true;
    } catch { this.#warn(id,'persistence');return false; }
  }
  async #step({ id,settings }) {
    if(!this.#persist(id) || this.#stopped)return;
    const snapshot=this.#snapshot(),clock=this.#clock();
    if(!snapshot.ready || snapshot.generation===null || !snapshot.observerPublicKey || clock.paused)return;
    let cursor=this.#cursors.get(id);
    if(cursor?.observer!==snapshot.observerPublicKey)cursor=null;
    const page=this.#store.stageRegionLatestPublications({ brokerId:id,observerPublicKey:snapshot.observerPublicKey,
      now:clock.now,limit:20,...(cursor?.key?{ afterPublicKey:cursor.key }:{}) });
    this.#cursors.set(id,{ observer:snapshot.observerPublicKey,key:page.afterPublicKey });
    if(!this.#mqtt.getBroker(id)?.isConnected())return;
    const claim=this.#store.claimRegionPublication({ brokerId:id,runId:this.#runId,now:clock.now,
      observerPublicKey:snapshot.observerPublicKey });
    if(!claim)return;
    // Every admitted claim must acquire a durable terminal resolution even
    // when payload construction, final identity checks or transport reject.
    let outcome='failed';
    try {
      const built=buildRegionPublication({ observerPublicKey:claim.observerPublicKey,
        targetPublicKey:claim.targetPublicKey,answer:claim.answer });
      const current=this.#snapshot();
      if(!this.#stopped && current.ready && current.generation===snapshot.generation
        && current.observerPublicKey===claim.observerPublicKey) {
        const result=await this.#mqtt.publishRegion({ brokerId:id,...built,timeoutMs:settings.publishTimeoutMs });
        if(!resultValid(result))throw new Error('Invalid region transport completion');
        outcome=result.outcome;
      } else outcome='skipped';
    } catch { /* fixed safe retry classification below */ }
    // Completion time schedules delivery, never changes observedAt. Clamp
    // against the admission time on rollback while retaining source evidence.
    let resolvedAt=clock.now;
    try { resolvedAt=Math.max(clock.now,this.#clock().now); } catch { /* safe captured admission time */ }
    const identity={ answerId:claim.answerId,brokerId:id,runId:this.#runId,claimToken:claim.claimToken,resolvedAt };
    const delay=Math.min(settings.retryMaxMs,settings.retryBaseMs*2**Math.min(30,Math.max(0,claim.attemptCount-1)));
    const resolution=outcome==='sent'?{ ...identity,status:'published' }
      :{ ...identity,status:'pending',reason:outcome==='skipped'?'broker-unavailable':'publish-failed',nextDueAt:at(resolvedAt,delay) };
    this.#unsaved.set(id,resolution);this.#persist(id);
    if(outcome==='failed' && !this.#unsaved.has(id))this.#warn(id,'publish-failed');
    else if(outcome==='sent' && !this.#unsaved.has(id)) {
      this.#faults.delete(id);this.#logger.info('services.regionPublication','Region observation accepted by broker; downstream ingestion is not confirmed.',
        { broker:id,outcome:'broker-accepted',answerId:claim.answerId });
    }
  }
}
