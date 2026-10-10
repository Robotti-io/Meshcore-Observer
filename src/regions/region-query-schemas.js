import { REMOTE_FRAME_MAX_BYTES } from '../radio/remote-request-schemas.js';
import { regionConfigSchema, regionResultSchema } from './region-schemas.js';

export const REGION_QUERY_DEFAULTS = Object.freeze({
  discoveryEnabled: false, queryRefreshIntervalMs: 24 * 3600000,
  queryRetryBaseMs: 15 * 60000, queryRetryMaxMs: 6 * 3600000, queryMaxAttempts: 3,
  queryTickIntervalMs: 10000, queryStartupDelayMs: 60000, queryPreflightTimeoutMs: 5000
});
export const REGION_QUERY_ENABLED_ENV_KEY = 'PACKETCAPTURE_REGION_DISCOVERY_ENABLED';
export const REGION_QUERY_NUMERIC_SETTINGS = Object.freeze([
  ['queryRefreshIntervalMs','PACKETCAPTURE_REGION_QUERY_REFRESH_HOURS',3600000,1,8760],
  ['queryRetryBaseMs','PACKETCAPTURE_REGION_QUERY_RETRY_BASE_MINUTES',60000,3,1440],
  ['queryRetryMaxMs','PACKETCAPTURE_REGION_QUERY_RETRY_MAX_HOURS',3600000,1,168],
  ['queryMaxAttempts','PACKETCAPTURE_REGION_QUERY_MAX_ATTEMPTS',1,1,10],
  ['queryTickIntervalMs','PACKETCAPTURE_REGION_QUERY_TICK_INTERVAL_MS',1,1000,60000],
  ['queryStartupDelayMs','PACKETCAPTURE_REGION_QUERY_STARTUP_DELAY_MS',1,10000,3600000],
  ['queryPreflightTimeoutMs','PACKETCAPTURE_REGION_QUERY_PREFLIGHT_TIMEOUT_MS',1,1000,30000]
].map(([field,key,scale,min,max]) => Object.freeze({ field,key,scale,min,max })));

const epoch = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const key = { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9A-F]{64}$' };
const uuid = { type: 'string', minLength: 36, maxLength: 36,
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const byte = { type: 'integer', minimum: 0, maximum: 255 };
function object(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, properties, required };
}
const numericProperties = Object.fromEntries(REGION_QUERY_NUMERIC_SETTINGS.map(({ field,scale,min,max }) =>
  [field,{ type: 'integer', minimum: min * scale, maximum: max * scale, multipleOf: scale }]));
export const regionQueryEnvSchema = object({
  [REGION_QUERY_ENABLED_ENV_KEY]: { type: 'string', minLength: 1, maxLength: 32,
    pattern: '^\\s*(?:[Tt][Rr][Uu][Ee]|[Ff][Aa][Ll][Ss][Ee])\\s*$' },
  ...Object.fromEntries(REGION_QUERY_NUMERIC_SETTINGS.map(({ key }) => [key,
    { type: 'string', minLength: 1, maxLength: 32, pattern: '^\\s*-?\\d+\\s*$' }]))
}, []);
// Compose the existing freshness contract without changing its standalone
// schema or creating an import cycle with the result/history schemas.
export const regionQueryConfigSchema = object({ ...regionConfigSchema.properties,
  discoveryEnabled: { type: 'boolean' }, ...numericProperties });
export const regionQueryPolicySchema = object(Object.fromEntries(
  ['queryRefreshIntervalMs','queryRetryBaseMs','queryRetryMaxMs','queryMaxAttempts'].map(field => [field,numericProperties[field]])));

export const regionQueryTargetSchema = object({ targetPublicKey: key });
const frameBytes = { type: 'array', minItems: 1, maxItems: REMOTE_FRAME_MAX_BYTES, items: byte };
export const regionContactInputSchema = object({ targetPublicKey: key, bytes: frameBytes });
// Pinned Companion layout: code + key32 + type/flags/path-length + path64
// + name32 + four uint32 fields. Names/paths are not decoded or returned.
export const REGION_CONTACT_FRAME_BYTES = 148;
export const regionContactFrameSchema = object({ bytes: {
  ...frameBytes, minItems: REGION_CONTACT_FRAME_BYTES, maxItems: REGION_CONTACT_FRAME_BYTES,
  items: [{ const: 0x03 }, ...Array.from({ length: REGION_CONTACT_FRAME_BYTES - 1 }, () => byte)], additionalItems: false
} });
export const regionPreflightErrorFrameSchema = object({ bytes: {
  ...frameBytes, minItems: 2, maxItems: 2, items: [{ const: 0x01 }, byte], additionalItems: false
} });

const scope = { observerPublicKey: key, targetPublicKey: key };
export const regionPollStateQuerySchema = object(scope);
const reservationIdentity = { ...scope, runId: uuid, requestId: uuid };
const jitterRatio = { type: 'number', minimum: 0, maximum: 0.1 };
export const regionPollCandidateQuerySchema = object({ observerPublicKey: key, now: epoch,
  windowMs: regionConfigSchema.properties.answerFreshnessWindowMs, afterPublicKey: key,
  limit: { type: 'integer', minimum: 1, maximum: 200 }
}, ['observerPublicKey','now','windowMs']);
export const regionPollDeferralSchema = object({ ...scope, runId: uuid, observedAt: epoch, nextDueAt: epoch,
  reason: { enum: ['contact-missing','unsafe-route','preflight-unsupported','preflight-failed'] } });
export const regionPollReservationSchema = object({ ...reservationIdentity, reservedAt: epoch,
  policy: regionQueryPolicySchema, jitterRatio });
const pollResultSchema = { oneOf: regionResultSchema.oneOf.map(branch => ({ ...branch,
  properties: { ...branch.properties, brokerIds: { ...branch.properties.brokerIds, maxItems: 0 } }
})) };
export const regionPollCompletionSchema = object({ ...reservationIdentity, result: pollResultSchema,
  policy: regionQueryPolicySchema, jitterRatio });
