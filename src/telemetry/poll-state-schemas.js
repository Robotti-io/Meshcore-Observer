import { compileSchema } from '../validation/ajv.js';
import { telemetryVariantSchema, telemetryResultSchema } from './telemetry-schemas.js';
import { telemetryAuthenticationRecordSchema, TELEMETRY_OWNER_REASONS } from './telemetry-owner-schemas.js';
import { TELEMETRY_POLL_DEFAULTS, TELEMETRY_POLL_NUMERIC_SETTINGS } from './polling-schemas.js';

const object = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const time = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const key = { type: 'string', pattern: '^[0-9A-F]{64}$' };
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const scope = { observerPublicKey: key, targetPublicKey: key };
const timing = ['refreshIntervalMs', 'retryBaseMs', 'retryMaxMs', 'maxAttempts', 'authCooldownMs'];
export const TELEMETRY_STATE_DEFAULT_POLICY = Object.freeze(Object.fromEntries(timing.map(k => [k, TELEMETRY_POLL_DEFAULTS[k]])));
export const telemetryStatePolicySchema = object(Object.fromEntries(TELEMETRY_POLL_NUMERIC_SETTINGS
  .filter(s => timing.includes(s.field)).map(s => [s.field, { type: 'integer', minimum: s.min * s.scale,
    maximum: s.max * s.scale, multipleOf: s.scale }])));
export const telemetryStateScopeSchema = object(scope);
export const telemetryPollVariantSchema = { oneOf: [object({ component: { const: 'guest-login' }, params: object({}) }),
  ...telemetryVariantSchema.oneOf.map(s => ({ ...s, properties: { ...s.properties,
    params: s.properties.component.const === 'sensors' ? object({ permissionMask: { const: 0 } })
      : s.properties.component.const === 'neighbours' ? object({ ...s.properties.params.properties,
        count: { type: 'integer', minimum: 1, maximum: 3 }, prefixLength: { const: 32 } }) : s.properties.params } }))] };
export const telemetryStateQuerySchema = object({ ...scope, variant: telemetryPollVariantSchema });
export const telemetryEvidenceQuerySchema = object({ ...scope, now: time,
  windowMs: { type: 'integer', minimum: 3600000, maximum: 8760 * 3600000, multipleOf: 3600000 },
  radius: { type: 'integer', minimum: 1, maximum: 63 } });
export const telemetryCandidateQuerySchema = object({ ...telemetryEvidenceQuerySchema.properties,
  afterPublicKey: key, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['observerPublicKey', 'now', 'windowMs', 'radius']);
export const telemetryDirectEvidenceSchema = object({ ...scope, runId: uuid, receivedAt: time,
  eventDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' }, hopCount: { const: 0 }, provenance: { const: 'verified-advert' } });
export const telemetryReservationSchema = object({ ...scope, variant: telemetryPollVariantSchema,
  requestId: uuid, runId: uuid, reservedAt: time, policy: telemetryStatePolicySchema,
  windowMs: telemetryEvidenceQuerySchema.properties.windowMs, radius: telemetryEvidenceQuerySchema.properties.radius });
export const telemetryPollCompletionSchema = object({ result: telemetryResultSchema, policy: telemetryStatePolicySchema });
export const telemetryAuthCompletionSchema = object({ runId: uuid, record: telemetryAuthenticationRecordSchema, policy: telemetryStatePolicySchema });
export const telemetryDeferralSchema = object({ ...scope, variant: telemetryPollVariantSchema, runId: uuid,
  observedAt: time, nextDueAt: time, reason: { enum: TELEMETRY_OWNER_REASONS }, policy: telemetryStatePolicySchema });
export const telemetryRecoverySchema = object({ runId: uuid, observedAt: time, policy: telemetryStatePolicySchema,
  afterRequestId: uuid, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['runId', 'observedAt', 'policy']);
export const telemetryAuthPageSchema = object({ ...scope, start: time, end: time,
  afterRequestId: uuid, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['start', 'end']);
const validators = new Map([telemetryStatePolicySchema, telemetryStateScopeSchema, telemetryStateQuerySchema,
  telemetryEvidenceQuerySchema, telemetryCandidateQuerySchema, telemetryDirectEvidenceSchema, telemetryReservationSchema,
  telemetryPollCompletionSchema, telemetryAuthCompletionSchema, telemetryDeferralSchema, telemetryRecoverySchema,
  telemetryAuthPageSchema, telemetryAuthenticationRecordSchema].map(s => [s, compileSchema(s)]));
export function assertTelemetryState(schema, input) {
  if (validators.get(schema)?.(input) !== true || (input.policy && input.policy.retryBaseMs > input.policy.retryMaxMs)
    || (schema === telemetryStatePolicySchema && input.retryBaseMs > input.retryMaxMs)
    || (input.start !== undefined && input.start > input.end)) throw new Error('Invalid telemetry polling data');
}
