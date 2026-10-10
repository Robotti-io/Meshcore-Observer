import { test } from 'vitest';
import assert from 'node:assert/strict';
import { assertRegionInput, assertRegionResult } from '../../src/regions/region-validation.js';
import * as schemas from '../../src/regions/region-schemas.js';
import { parseRegionResponseBody } from '../../src/regions/region-response-parser.js';

const uuid = '12345678-1234-4abc-8def-123456789abc';
const key = 'AC'.repeat(32), observer = 'BE'.repeat(32);
const outcome = () => ({ requestId: uuid, runId: uuid, targetPublicKey: key, observerPublicKey: observer,
  startedAt: 1000, completedAt: 2000, clockAnomaly: false, status: 'answered', reason: null, route: 'direct' });
const answer = () => ({ ...parseRegionResponseBody({ body: [0, 0, 0, 0, 42] }).answer, observedAt: 1500 });
const result = () => ({ outcome: outcome(), answer: answer(), brokerIds: ['first', 'second'] });
const valid = (schema, input) => assertRegionInput(schema, input);
const rejects = (schema, input) => assert.throws(() => valid(schema, input), error => error.message === 'Invalid region data');

test('terminal outcome union separates direct successful answers from failure/unsupported and deferral', () => {
  assertRegionResult(result()); assertRegionResult({ outcome: outcome(), answer: answer() });
  for (const reason of schemas.REGION_FAILURE_REASONS) {
    const failed = { ...outcome(), status: 'failed', reason, route: null };
    valid(schemas.regionOutcomeSchema, failed); assertRegionResult({ outcome: failed, brokerIds: [] });
    rejects(schemas.regionResultSchema, { outcome: failed, answer: answer() });
    rejects(schemas.regionResultSchema, { outcome: failed, brokerIds: ['first'] });
  }
  for (const reason of ['unsupported', 'anonymous-adapter-unavailable']) {
    assertRegionResult({ outcome: { ...outcome(), status: 'unsupported', reason, route: null } });
  }
  for (const input of [{ outcome: { ...outcome(), status: 'deferred', reason: 'busy' } },
    { outcome: outcome() }, { ...result(), outcome: { ...outcome(), route: 'flood' } },
    { ...result(), outcome: { ...outcome(), reason: 'timeout' } }, { ...result(), secret: 'SECRET' },
    { outcome: { ...outcome(), status: 'failed', reason: 'raw exception SECRET' } }]) rejects(schemas.regionResultSchema, input);
});

test('exact UUID/full-key identities, unknown fields and units reject coercion at every result level', () => {
  for (const field of ['requestId', 'runId']) for (const value of [uuid + '\n', uuid.toUpperCase(), 'prefix', 17]) {
    rejects(schemas.regionResultSchema, { ...result(), outcome: { ...outcome(), [field]: value } });
  }
  for (const field of ['observerPublicKey', 'targetPublicKey']) for (const value of [key.toLowerCase(), key + '\n', key.slice(2), 'GG'.repeat(32)]) {
    rejects(schemas.regionResultSchema, { ...result(), outcome: { ...outcome(), [field]: value } });
  }
  for (const changes of [{ startedAt: -1 }, { completedAt: '2000' }, { completedAt: Infinity }, { completedAt: 1.5 },
    { clockAnomaly: 0 }, { tag: 1 }, { generation: 1 }, { params: {} }, { error: 'SECRET' }]) {
    rejects(schemas.regionResultSchema, { ...result(), outcome: { ...outcome(), ...changes } });
  }
  rejects(schemas.regionResultSchema, { ...result(), answer: { ...answer(), observedAt: '1500' } });
  rejects(schemas.regionResultSchema, { ...result(), answer: { ...answer(), raw: 'SECRET' } });
  rejects({}, result());
});

test('wall-time anomalies are explicit instead of rejecting or rewriting original evidence', () => {
  const input = result(); input.outcome.completedAt = 500;
  rejects(schemas.regionResultSchema, input);
  input.outcome.clockAnomaly = true; assertRegionResult(input);
  assert.equal(input.answer.observedAt, 1500);
  const earlier = result(); earlier.answer.observedAt = 999;
  rejects(schemas.regionResultSchema, earlier); earlier.outcome.clockAnomaly = true; assertRegionResult(earlier);
  const later = result(); later.answer.observedAt = 2001;
  rejects(schemas.regionResultSchema, later); later.outcome.clockAnomaly = true; assertRegionResult(later);
  const terminal = { ...outcome(), completedAt: 999 };
  rejects(schemas.regionOutcomeSchema, terminal); terminal.clockAnomaly = true; valid(schemas.regionOutcomeSchema, terminal);
  const observed = answer(); valid(schemas.regionObservedAnswerSchema, observed);
  rejects(schemas.regionObservedAnswerSchema, { ...observed, csvBytes: 0 });
});

test('bounded explicit broker destinations preserve exact IDs and cannot smuggle secrets or duplicate fan-out', () => {
  const input = { answerId: 1, brokerIds: Array.from({ length: 64 }, (_, n) => 'broker-' + n) };
  valid(schemas.regionStagePublicationsSchema, input); assertRegionResult({ ...result(), brokerIds: input.brokerIds });
  valid(schemas.regionStagePublicationsSchema, { answerId: 1, brokerIds: [] });
  valid(schemas.regionStagePublicationsSchema, { answerId: 1, brokerIds: ['A', 'a', 'x'.repeat(256)] });
  for (const value of [['first', 'first'], Array(65).fill('first'), [''], ['x'.repeat(257)], [1], [{ host: 'SECRET' }]]) {
    rejects(schemas.regionStagePublicationsSchema, { answerId: 1, brokerIds: value });
    rejects(schemas.regionResultSchema, { ...result(), brokerIds: value });
  }
  rejects(schemas.regionStagePublicationsSchema, { ...input, answerId: 0 });
});

test('history pages enforce strict ranges, limits, identities and domain-specific filters', () => {
  const page = { start: 1000, end: 2000, limit: 200, offset: 0, observerPublicKey: observer, targetPublicKey: key, runId: uuid };
  for (const schema of [schemas.regionAnswerPageSchema, schemas.regionOutcomePageSchema]) {
    valid(schema, page); valid(schema, { ...page, start: 2000 });
    for (const change of [{ start: 2001 }, { limit: 201 }, { limit: 0 }, { offset: -1 }, { offset: .5 },
      { end: '2000' }, { targetPublicKey: 'AC' }, { sql: 'SECRET' }]) rejects(schema, { ...page, ...change });
    rejects(schema, {});
  }
  valid(schemas.regionOutcomePageSchema, { ...page, status: 'failed' });
  rejects(schemas.regionOutcomePageSchema, { ...page, status: 'deferred' });
  rejects(schemas.regionAnswerPageSchema, { ...page, status: 'answered' });
});

test('latest-answer contract bounds whole-hour freshness separately from RF eligibility and poll cadence', () => {
  const input = { observerPublicKey: observer, targetPublicKey: key, now: 2000, windowMs: 72 * 3600000 };
  for (const hours of [1, 72, 8760]) valid(schemas.regionLatestQuerySchema, { ...input, windowMs: hours * 3600000 });
  for (const value of [0, 3600001, 8761 * 3600000, '72', NaN]) rejects(schemas.regionLatestQuerySchema, { ...input, windowMs: value });
  rejects(schemas.regionLatestQuerySchema, { ...input, radius: 0 });
  rejects(schemas.regionLatestQuerySchema, { ...input, now: -1 });
});

test('publication read, stage and owned claim DTOs are strict and expose no broker credentials', () => {
  const page = { brokerId: 'first', limit: 200, offset: 0, state: 'pending', observerPublicKey: observer, targetPublicKey: key };
  valid(schemas.regionPublicationPageSchema, page);
  for (const change of [{ limit: 201 }, { state: 'ingested' }, { token: 'SECRET' }, { brokerId: '' }]) {
    rejects(schemas.regionPublicationPageSchema, { ...page, ...change });
  }
  const claim = { brokerId: 'first', runId: uuid, now: 2000 }; valid(schemas.regionClaimPublicationSchema, claim);
  rejects(schemas.regionClaimPublicationSchema, { ...claim, runId: 'old' });
  rejects(schemas.regionClaimPublicationSchema, { ...claim, password: 'SECRET' });
});

test('publication resolution requires captured ownership and distinguishes transport success from retry', () => {
  const input = { answerId: 1, brokerId: 'first', runId: uuid, claimToken: uuid, resolvedAt: 2000, status: 'published' };
  valid(schemas.regionResolvePublicationSchema, input);
  for (const reason of schemas.REGION_PUBLICATION_FAILURE_REASONS) {
    const retry = { ...input, status: 'pending', reason, nextDueAt: 2000 };
    valid(schemas.regionResolvePublicationSchema, retry);
    rejects(schemas.regionResolvePublicationSchema, { ...retry, nextDueAt: 1999 });
  }
  for (const change of [{ status: 'ingested' }, { claimToken: 'old' }, { status: 'pending' },
    { reason: 'SECRET' }, { nextDueAt: 3000 }, { rawError: 'SECRET' }, { answerId: 0 }]) {
    rejects(schemas.regionResolvePublicationSchema, { ...input, ...change });
  }
});
