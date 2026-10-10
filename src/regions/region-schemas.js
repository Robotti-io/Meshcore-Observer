import { REMOTE_BODY_MAX_BYTES } from '../radio/remote-request-schemas.js';

// Host-envelope bounds, not a firmware export budget or completeness test.
export const REGION_BODY_MAX_BYTES = REMOTE_BODY_MAX_BYTES;
export const REGION_CSV_MAX_BYTES = REGION_BODY_MAX_BYTES - 4;
export const REGION_MAX_NAMES = Math.floor((REGION_CSV_MAX_BYTES + 1) / 2);
export const REGION_MAX_BROKERS = 64;
export const REGION_FAILURE_REASONS = Object.freeze([
  'eligibility-error', 'disconnected', 'stopped', 'command-error', 'ack-timeout',
  'response-timeout', 'write-error', 'protocol-error', 'retired-tag',
  'route-mismatch', 'malformed-response'
]);
export const REGION_PUBLICATION_FAILURE_REASONS = Object.freeze([
  'publish-failed', 'broker-unavailable', 'broker-disabled', 'identity-unavailable'
]);

const epoch = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const id = { ...epoch, minimum: 1 };
const byte = { type: 'integer', minimum: 0, maximum: 255 };
const uuid = { type: 'string', minLength: 36, maxLength: 36,
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const key = { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9A-F]{64}$' };
const brokerId = { type: 'string', minLength: 1, maxLength: 256 };
const brokers = { type: 'array', maxItems: REGION_MAX_BROKERS, uniqueItems: true, items: brokerId };
const route = { enum: [null, 'direct', 'flood'] };
const page = { limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: epoch };
const filters = { observerPublicKey: key, targetPublicKey: key, runId: uuid };
const publicationState = { enum: ['pending', 'publishing', 'published'] };
function object(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, properties, required };
}

export const regionBodySchema = object({
  body: { type: 'array', minItems: 4, maxItems: REGION_BODY_MAX_BYTES, items: byte }
});
const answerProperties = {
  regions: { type: 'array', maxItems: REGION_MAX_NAMES, items: {
    type: 'string', minLength: 1, maxLength: REGION_CSV_MAX_BYTES,
    not: { pattern: '[,\\u0000-\\u001F\\u007F-\\u009F]' }
  } },
  repeaterClock: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0, maximum: 0xFFFFFFFF }] },
  bodyBytes: { type: 'integer', minimum: 4, maximum: REGION_BODY_MAX_BYTES },
  csvBytes: { type: 'integer', minimum: 0, maximum: REGION_CSV_MAX_BYTES },
  parserVersion: { const: 1 }, completeness: { const: 'unknown' },
  provenance: { const: 'companion-tag-attributed' }
};
export const regionAnswerSchema = object(answerProperties);
export const regionObservedAnswerSchema = object({ ...answerProperties, observedAt: epoch });

const outcomeProperties = {
  requestId: uuid, runId: uuid, observerPublicKey: key, targetPublicKey: key,
  startedAt: epoch, completedAt: epoch, clockAnomaly: { type: 'boolean' }
};
const answered = object({ ...outcomeProperties, status: { const: 'answered' }, reason: { const: null }, route: { const: 'direct' } });
const failed = object({ ...outcomeProperties, status: { const: 'failed' }, reason: { enum: REGION_FAILURE_REASONS }, route });
const unsupported = object({ ...outcomeProperties, status: { const: 'unsupported' },
  reason: { enum: ['unsupported', 'anonymous-adapter-unavailable'] }, route });
export const regionOutcomeSchema = { oneOf: [answered, failed, unsupported] };
export const regionResultSchema = { oneOf: [
  object({ outcome: answered, answer: regionObservedAnswerSchema, brokerIds: brokers }, ['outcome', 'answer']),
  object({ outcome: { oneOf: [failed, unsupported] }, brokerIds: { ...brokers, maxItems: 0 } }, ['outcome'])
] };

const windowMs = { type: 'integer', minimum: 3600000, maximum: 8760 * 3600000, multipleOf: 3600000 };
export const regionLatestQuerySchema = object({ observerPublicKey: key, targetPublicKey: key, now: epoch, windowMs });
export const regionAnswerPageSchema = object({ ...filters, start: epoch, end: epoch, ...page }, ['start', 'end', 'limit', 'offset']);
export const regionOutcomePageSchema = object({ ...filters, start: epoch, end: epoch, ...page,
  status: { enum: ['answered', 'failed', 'unsupported'] } }, ['start', 'end', 'limit', 'offset']);
export const regionPublicationPageSchema = object({ brokerId, observerPublicKey: key, targetPublicKey: key,
  state: publicationState, ...page }, ['brokerId', 'limit', 'offset']);
export const regionStagePublicationsSchema = object({ answerId: id, brokerIds: brokers });
export const regionClaimPublicationSchema = object({ brokerId, runId: uuid, now: epoch });
const resolution = { answerId: id, brokerId, runId: uuid, claimToken: uuid, resolvedAt: epoch };
export const regionResolvePublicationSchema = { oneOf: [
  object({ ...resolution, status: { const: 'published' } }),
  object({ ...resolution, status: { const: 'pending' }, reason: { enum: REGION_PUBLICATION_FAILURE_REASONS }, nextDueAt: epoch })
] };
