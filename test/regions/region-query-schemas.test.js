import { test } from 'vitest';
import assert from 'node:assert/strict';
import { assertRegionQueryInput } from '../../src/regions/region-query-validation.js';
import * as schemas from '../../src/regions/region-query-schemas.js';
import { parseRegionResponseBody } from '../../src/regions/region-response-parser.js';
import { compileSchema } from '../../src/validation/ajv.js';

const requestId='12345678-1234-4abc-8def-123456789abc',runId='22345678-1234-4abc-8def-123456789abc';
const otherId='32345678-1234-4abc-8def-123456789abc',observerPublicKey='BE'.repeat(32),targetPublicKey='AC'.repeat(32);
const scope={ observerPublicKey,targetPublicKey },identity={ ...scope,requestId,runId };
const policy={ queryRefreshIntervalMs:86400000,queryRetryBaseMs:900000,queryRetryMaxMs:21600000,queryMaxAttempts:3 };
const valid=(schema,value)=>assertRegionQueryInput(schema,value);
const rejects=(schema,value)=>assert.throws(()=>valid(schema,value),error=>error.message==='Invalid region query data');
const completion=()=>({ ...identity,policy:{ ...policy },jitterRatio:0.1,result:{
  outcome:{ ...identity,startedAt:1000,completedAt:2000,clockAnomaly:false,status:'answered',reason:null,route:'direct' },
  answer:{ ...parseRegionResponseBody({ body:[0,0,0,0] }).answer,observedAt:1500 },brokerIds:[] } });

test('candidate pages strictly bound scopes/time/window/cursor/page size without supplying eligibility', () => {
  const query={ observerPublicKey,now:0,windowMs:72*3600000 };
  valid(schemas.regionPollCandidateQuerySchema,query);
  for(const limit of [1,100,200])valid(schemas.regionPollCandidateQuerySchema,{ ...query,limit,afterPublicKey:targetPublicKey });
  for(const extra of [{ limit:0 },{ limit:201 },{ now:-1 },{ now:Number.MAX_SAFE_INTEGER+1 },
    { now:1.5 },{ now:'1000' },{ windowMs:3600001 },{ afterPublicKey:'' },{ afterPublicKey:targetPublicKey.toLowerCase() },
    { eligible:true },{ offset:0 },{ targetPublicKey }])rejects(schemas.regionPollCandidateQuerySchema,{ ...query,...extra });
});

test('deferrals have fixed reasons, original observation times and nonpast due times', () => {
  const deferred={ ...scope,runId,observedAt:1000,nextDueAt:1000,reason:'contact-missing' };
  for(const reason of schemas.regionPollDeferralSchema.properties.reason.enum)valid(schemas.regionPollDeferralSchema,{ ...deferred,reason });
  for(const extra of [{ nextDueAt:999 },{ reason:'busy' },{ reason:'SECRET-error' },{ tag:42 },{ observedAt:null }])rejects(schemas.regionPollDeferralSchema,{ ...deferred,...extra });
});

test('reservation policy is bounded and has no caller-controlled wire tag or claimed transmission', () => {
  const reserved={ ...identity,reservedAt:0,policy:{ ...policy },jitterRatio:0 };
  valid(schemas.regionPollReservationSchema,reserved);
  for(const extra of [{ reservedAt:-1 },{ jitterRatio:-0.01 },{ jitterRatio:0.10001 },{ jitterRatio:NaN },
    { requestId:'not-a-uuid' },{ tag:42 },{ sent:true },{ cycleReservations:1 }])rejects(schemas.regionPollReservationSchema,{ ...reserved,...extra });
  for(const change of [{ queryMaxAttempts:0 },{ queryMaxAttempts:11 },{ queryRefreshIntervalMs:3600001 },
    { queryRetryBaseMs:7200000,queryRetryMaxMs:3600000 },{ extra:true }])rejects(schemas.regionPollReservationSchema,{ ...reserved,policy:{ ...policy,...change } });
});

test('completion binds immutable reservation identity to validated terminal result and permits measured empty success', () => {
  valid(schemas.regionPollCompletionSchema,completion());
  for(const field of ['requestId','runId','observerPublicKey','targetPublicKey']) {
    const input=completion();input.result.outcome[field]=field.endsWith('Id')?otherId:'CD'.repeat(32);rejects(schemas.regionPollCompletionSchema,input);
  }
  for(const change of [{ brokerIds:['first'] },{ tag:42 },{ rawBody:[1] }]) {
    const input=completion();Object.assign(input.result,change);
    assert.equal(compileSchema(schemas.regionPollCompletionSchema)(input),false,'AJV rejects broker staging/unknown fields before semantic processing');
    rejects(schemas.regionPollCompletionSchema,input);
  }
  const input=completion();input.result.answer.observedAt=2001;rejects(schemas.regionPollCompletionSchema,input);
  input.result.outcome.clockAnomaly=true;valid(schemas.regionPollCompletionSchema,input);
});

test('completion preserves separate failure/unsupported contracts and strict answer semantics', () => {
  for(const [status,reason] of [['failed','response-timeout'],['unsupported','unsupported']]) {
    const input=completion();delete input.result.answer;Object.assign(input.result.outcome,{ status,reason,route:null });valid(schemas.regionPollCompletionSchema,input);
  }
  const input=completion();input.result.answer.regions=['é'];input.result.answer.csvBytes=1;rejects(schemas.regionPollCompletionSchema,input);
  for(const change of [{ status:'deferred',reason:'busy' },{ completedAt:999 },{ route:'flood' }]) {
    const input=completion();Object.assign(input.result.outcome,change);rejects(schemas.regionPollCompletionSchema,input);
  }
});

test('only known schemas can validate query inputs and cross-field policy checks follow strict shape checks', () => {
  rejects({},policy);valid(schemas.regionQueryPolicySchema,policy);
  rejects(schemas.regionQueryPolicySchema,{ ...policy,queryRetryBaseMs:7200000,queryRetryMaxMs:3600000 });
  const config={ ...schemas.REGION_QUERY_DEFAULTS,answerFreshnessWindowMs:72*3600000 };
  valid(schemas.regionQueryConfigSchema,config);
  rejects(schemas.regionQueryConfigSchema,{ ...config,queryRetryBaseMs:7200000,queryRetryMaxMs:3600000 });
  rejects(schemas.regionQueryConfigSchema,{ ...config,discoveryEnabled:'false' });
});
test('producer response variants require original dispatch/receipt/context and reject unknown or phase-incompatible fields', () => {
  const context = { requestId, targetPublicKey, observerPublicKey, generation: 1, operation: 'anonymous-regions', params: {} };
  const response = { status: 'completed', context, dispatchedAt: 1000, receivedAt: 1001,
    tag: 42, route: 'direct', body: [0,0,0,0], provenance: 'companion-tag-attributed' };
  valid(schemas.regionSchedulerResponseSchema, response);
  for (const field of Object.keys(response)) {
    const incomplete = { ...response }; delete incomplete[field]; rejects(schemas.regionSchedulerResponseSchema, incomplete);
  }
  for (const change of [{ route:'flood' }, { extra:true }, { body:[] }, { receivedAt:-1 }, { context:{ ...context, runId } }]) {
    rejects(schemas.regionSchedulerResponseSchema, { ...response, ...change });
  }
  valid(schemas.regionSchedulerResponseSchema, { status:'deferred', reason:'foreground' });
  valid(schemas.regionSchedulerResponseSchema, { status:'failed', reason:'preflight-timeout', context, recovery:'reset' });
  valid(schemas.regionSchedulerResponseSchema, { status:'failed', reason:'response-timeout', context, dispatchedAt:1000, tag:42, route:'direct' });
  rejects(schemas.regionSchedulerResponseSchema, { status:'deferred', reason:'foreground', dispatchedAt:1000 });
  rejects(schemas.regionSchedulerResponseSchema, { status:'failed', reason:'response-timeout', dispatchedAt:1000 });
});
