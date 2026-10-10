import { compileSchema } from '../validation/ajv.js';
import { assertRegionResult } from './region-validation.js';
import { regionQueryConfigSchema, regionQueryPolicySchema, regionQueryTargetSchema,
  regionPollCandidateQuerySchema, regionPollDeferralSchema, regionPollReservationSchema,
  regionPollCompletionSchema } from './region-query-schemas.js';

const schemas = [regionQueryConfigSchema, regionQueryPolicySchema, regionQueryTargetSchema,
  regionPollCandidateQuerySchema, regionPollDeferralSchema, regionPollReservationSchema, regionPollCompletionSchema];
const validators = new Map(schemas.map(schema => [schema,compileSchema(schema)]));
const invalid = () => new Error('Invalid region query data');

/** Structural AJV validation always precedes cross-field/identity checks. */
export function assertRegionQueryInput(schema, value) {
  if (validators.get(schema)?.(value) !== true) throw invalid();
  const policy = schema === regionQueryConfigSchema || schema === regionQueryPolicySchema ? value : value.policy;
  // Comparing two independently bounded values is a semantic invariant,
  // following the existing region-result byte/time guards.
  if (policy && policy.queryRetryBaseMs > policy.queryRetryMaxMs) throw invalid();
  if (schema === regionPollDeferralSchema && value.nextDueAt < value.observedAt) throw invalid();
  if (schema === regionPollCompletionSchema) {
    try { assertRegionResult(value.result); } catch { throw invalid(); }
    const outcome = value.result.outcome;
    if (['requestId','runId','observerPublicKey','targetPublicKey'].some(field => value[field] !== outcome[field])) throw invalid();
  }
}
