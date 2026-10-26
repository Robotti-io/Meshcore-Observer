import { remoteRequestSchema, REMOTE_BODY_MAX_BYTES } from '../radio/remote-request-schemas.js';
import { telemetryLoginResultSchema, TELEMETRY_INVENTORY_FAILURES } from './telemetry-radio-schemas.js';

const object = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const integer = (minimum, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum });
const base = remoteRequestSchema.oneOf[0].properties;
export const telemetryGuestRequestSchema = object({ requestId: base.requestId, targetPublicKey: base.targetPublicKey });
export const telemetryOwnedRequestSchema = { oneOf: remoteRequestSchema.oneOf.slice(0, 3).map(schema => ({
  ...schema, properties: { ...schema.properties, params: schema.properties.operation.const === 'telemetry'
    ? object({ permissionMask: { const: 0 } }) : schema.properties.operation.const === 'neighbours'
      ? object({ ...schema.properties.params.properties, count: integer(1, 3), prefixLength: { const: 32 } })
      : schema.properties.params }
})) };
export const telemetryOwnerSnapshotSchema = object({ generation: { anyOf: [integer(1), { type: 'null' }] },
  ready: { type: 'boolean' }, observerPublicKey: { anyOf: [{ ...base.targetPublicKey, pattern: '^[0-9a-fA-F]{64}$' }, { type: 'null' }] } });
export const telemetryReplayReadSchema = object({ serverTimestamp: { anyOf: [integer(0, 0xFFFFFFFF), { type: 'null' }] } });
// Round trip = outbound relays + target + reverse relays. Keep all returned
// hashes/SNRs inside the existing 32/33-entry diagnostic contracts.
export const telemetryTraceRequestSchema = object({ targetPublicKey: base.targetPublicKey,
  path: { type: 'array', maxItems: 15, uniqueItems: true,
    items: { type: 'string', pattern: '^[0-9A-F]{4}$' } } });
export const telemetryTraceFrameSchema = object({ bytes: { type: 'array', minItems: 13, maxItems: 141,
  items: integer(0, 255) } });
export const telemetryOwnerClockSchema = object({ wall: integer(0), monotonic: { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } });
export const telemetryOwnerContextSchema = object({ requestId: base.requestId, targetPublicKey: base.targetPublicKey,
  operation: { enum: ['guest-login', 'status', 'telemetry', 'neighbours'] }, params: { oneOf: [
    object({}), object({ permissionMask: { const: 0 } }), telemetryOwnedRequestSchema.oneOf[2].properties.params
  ] }, generation: integer(1), observerPublicKey: base.targetPublicKey });
export const TELEMETRY_OWNER_REASONS = Object.freeze([...new Set([
  ...TELEMETRY_INVENTORY_FAILURES, 'stopped', 'recovery-failed', 'busy', 'disconnected', 'not-ready',
  'preflight-paused', 'foreground', 'rate-limited', 'quiet-air', 'background-turn', 'ineligible',
  'eligibility-error', 'reservation-unavailable', 'queue-timeout', 'write-error', 'ack-timeout',
  'response-timeout', 'protocol-error', 'command-error', 'retired-tag', 'route-mismatch',
  'trace-timeout', 'trace-malformed', 'trace-write-error', 'trace-login-not-dispatched',
  'guest-session-unavailable', 'login-quarantined', 'login-quarantine-full', 'authentication-denied',
  'legacy-login-proof', 'unsafe-login-permissions', 'unsupported-login-protocol', 'login-tag-mismatch',
  'auth-replay', 'auth-state-unavailable', 'auth-persistence', 'credential-unavailable', 'invalid-login-frame', 'invalid-login-ack'
])]);
export const telemetryOwnerCompletionSchema = object({ status: { enum: ['deferred', 'failed', 'completed'] },
  reason: { enum: TELEMETRY_OWNER_REASONS }, context: telemetryOwnerContextSchema,
  dispatchedAt: integer(0), receivedAt: integer(0), tag: integer(0, 0xFFFFFFFF), route: { enum: ['direct', 'flood'] },
  body: { type: 'array', minItems: 1, maxItems: REMOTE_BODY_MAX_BYTES, items: integer(0, 255) },
  provenance: { const: 'companion-tag-attributed' }, proof: telemetryLoginResultSchema,
  recovery: { enum: ['reset', 'stale-generation', 'close-failed', 'close-timeout', 'failed'] },
  errorCode: integer(0, 255), errorReason: { enum: ['unsupported', 'not-found', 'table-full', 'bad-state', 'file-io', 'illegal-argument', 'unknown'] },
  diagnostics: object({ phase: { enum: ['queued', 'admission', 'preflight', 'ready', 'ack', 'response', 'recovery'] },
    targetName: { anyOf: [{ type: 'string', maxLength: 32 }, { type: 'null' }] },
    routeCandidatePath: { type: 'array', maxItems: 63, items: { type: 'string', pattern: '^[0-9A-F]{4}$' } },
    routeEvidenceSource: { anyOf: [{ enum: ['verified-advert', 'passive-topology', 'telemetry-neighbours'] }, { type: 'null' }] },
    routeFailureReason: { anyOf: [{ type: 'string', minLength: 1, maxLength: 64 }, { type: 'null' }] },
    routeEvidenceAt: { anyOf: [integer(0), { type: 'null' }] },
    routeSupportCount: { anyOf: [integer(0), { type: 'null' }] }, inventoryContactCount: { anyOf: [integer(0, 350), { type: 'null' }] },
    routeHopWeights: { type: 'array', maxItems: 31, items: object({
      position: integer(1, 31), repeaterId: { type: 'string', pattern: '^[0-9A-F]{4}$' },
      anchorSuccessCount: integer(0), pathReceptionCount: integer(0), traceSuccessCount: integer(0), neighbourSupportCount: integer(0)
    }, ['position', 'repeaterId', 'anchorSuccessCount', 'pathReceptionCount']) },
    responseTimeoutMs: { anyOf: [integer(1, 120000), { type: 'null' }] },
    traceOutcome: { anyOf: [{ enum: ['pending', 'response', 'trace-timeout', 'trace-malformed',
      'trace-write-error', 'trace-disconnected', 'invalid-route', 'quiet-air', 'trace-failed', 'trace-not-sent'] }, { type: 'null' }] },
    tracePathHashes: { type: 'array', maxItems: 32, items: { type: 'string', pattern: '^[0-9A-F]{4}$' } },
    traceSnrQuarterDb: { type: 'array', maxItems: 33, items: integer(-128, 127) },
    traceTimeoutMs: { anyOf: [integer(1, 120000), { type: 'null' }] },
    inventoryOutcome: { anyOf: [{ type: 'string', minLength: 1, maxLength: 64 }, { type: 'null' }] },
    contactSyncOutcome: { anyOf: [{ enum: ['unchanged', 'added', 'added-evicted', 'updated', 'deferred', 'failed'] }, { type: 'null' }] },
    targetContactOutcome: { anyOf: [{ type: 'string', minLength: 1, maxLength: 64 }, { type: 'null' }] },
    dispatchMode: { enum: [null, 'direct', 'flood'] }
  }, ['phase', 'targetName', 'routeCandidatePath', 'routeEvidenceSource', 'routeFailureReason',
    'routeEvidenceAt', 'routeSupportCount', 'inventoryContactCount', 'inventoryOutcome',
    'contactSyncOutcome', 'targetContactOutcome', 'dispatchMode']),
}, ['status']);
export const telemetryAuthenticationRecordSchema = object({ context: telemetryOwnerContextSchema,
  dispatchedAt: integer(0), completedAt: integer(0), status: { enum: ['completed', 'failed'] },
  reason: { anyOf: [{ enum: TELEMETRY_OWNER_REASONS }, { type: 'null' }] },
  route: { anyOf: [{ enum: ['direct', 'flood'] }, { type: 'null' }] }, proof: telemetryLoginResultSchema
}, ['context', 'dispatchedAt', 'completedAt', 'status', 'reason', 'route']);
