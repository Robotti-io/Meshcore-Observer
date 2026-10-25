import { REMOTE_FRAME_MAX_BYTES } from '../radio/remote-request-schemas.js';

export const TELEMETRY_CONTACT_FRAME_BYTES = 148;
export const TELEMETRY_CONTACT_PATH_BYTES = 64;
export const TELEMETRY_CONTACT_INVENTORY_MAX = 1024;
export const TELEMETRY_LOGIN_FIRMWARE_LEVEL = 2; // Pinned a366955 protocol level, not a layout attestation.

const object = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const byte = integer(0, 255), uint32 = integer(0, 0xFFFFFFFF);
const key = { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9A-F]{64}$' };
const prefix = { type: 'string', minLength: 12, maxLength: 12, pattern: '^[0-9A-F]{12}$' };
const radius = integer(1, 63);
const monotonic = { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const bytes = (minItems, maxItems = minItems) => ({ type: 'array', minItems, maxItems, items: byte });
const tuple = (code, length, constants = {}) => ({ type: 'array', minItems: length, maxItems: length,
  items: Array.from({ length }, (_, i) => i === 0 ? { const: code } : constants[i] ?? byte), additionalItems: false });

export const telemetryRadioTargetSchema = object({ targetPublicKey: key });
export const telemetryInventoryReadSchema = object({});
export const telemetryRadioFrameSchema = object({ bytes: bytes(1, REMOTE_FRAME_MAX_BYTES) });
export const telemetryContactFrameSchema = object({ bytes: tuple(3, TELEMETRY_CONTACT_FRAME_BYTES) });
export const telemetryContactListStartSchema = object({ bytes: tuple(2, 5) });
export const telemetryContactListEndSchema = object({ bytes: tuple(4, 5) });
export const telemetryContactErrorSchema = object({ bytes: tuple(1, 2) });
export const telemetryContactReadInputSchema = object({ targetPublicKey: key, radius, bytes: bytes(1, REMOTE_FRAME_MAX_BYTES) });
export const telemetryContactPathInputSchema = object({ encodedPathLength: byte,
  pathBytes: bytes(TELEMETRY_CONTACT_PATH_BYTES), radius });
export const telemetryContactInventoryOptionsSchema = object({ targetPublicKey: key, radius,
  startedAt: monotonic, timeoutMs: { ...integer(1000, 30000), multipleOf: 1000 } });
export const telemetryContactInventoryInputSchema = object({ bytes: bytes(1, REMOTE_FRAME_MAX_BYTES), monotonicNow: monotonic });
export const telemetryContactInventoryClockSchema = object({ monotonicNow: monotonic });

export const telemetryLoginFrameInputSchema = object({ targetPublicKey: key, bytes: bytes(1, REMOTE_FRAME_MAX_BYTES) });
export const telemetryLoginSuccessSchema = object({ bytes: tuple(0x85, 14, { 1: integer(0, 1) }) });
export const telemetryLoginLegacySchema = object({ bytes: tuple(0x85, 8, { 1: integer(0, 1) }) });
export const telemetryLoginFailureSchema = object({ bytes: tuple(0x86, 8, { 1: { const: 0 } }) });

const ignored = object({ status: { const: 'ignored' } });
const pending = object({ status: { const: 'pending' }, contactCount: integer(0, TELEMETRY_CONTACT_INVENTORY_MAX) });
const inventoryContact = object({ publicKey: key, contactType: byte, flags: byte, encodedPathLength: byte,
  pathBytes: bytes(TELEMETRY_CONTACT_PATH_BYTES), name: { type: 'string', maxLength: 32 }, lastAdvert: uint32,
  lat: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
  lon: { type: 'integer', minimum: -2147483648, maximum: 2147483647 }, lastMod: uint32 });
const unavailable = reasons => object({ status: { const: 'unavailable' }, reason: { enum: reasons } });
const malformed = reason => object({ status: { const: 'malformed' }, reason: { const: reason } });
export const TELEMETRY_ROUTE_FAILURES = Object.freeze([
  'unsafe-prefix', 'unknown-contact-route', 'unsupported-path-width', 'path-capacity-exceeded', 'radius-exceeded'
]);
export const telemetryContactRouteSchema = object({ encodedPathLength: byte, hashWidth: integer(1, 3),
  relayCount: integer(0, 63), distance: integer(1, 63), pathBytes: bytes(0, TELEMETRY_CONTACT_PATH_BYTES),
  outboundRouteVerified: { const: false } });
export const telemetryContactProofSchema = object({ targetPublicKey: key, contactType: { const: 2 },
  route: telemetryContactRouteSchema });
export const telemetryContactPathResultSchema = { oneOf: [
  object({ status: { const: 'direct-route' }, route: telemetryContactRouteSchema }),
  unavailable(TELEMETRY_ROUTE_FAILURES), malformed('invalid-contact-path')
] };
export const telemetryContactReadResultSchema = { oneOf: [
  object({ status: { const: 'eligible' }, contact: telemetryContactProofSchema }), ignored,
  unavailable([...TELEMETRY_ROUTE_FAILURES, 'non-repeater-contact']), malformed('invalid-contact-frame'),
  object({ status: { const: 'unavailable' }, reason: { enum: ['preflight-unsupported', 'contact-missing', 'preflight-failed'] }, errorCode: byte })
] };
export const telemetryInventoryFrameResultSchema = { oneOf: [
  ignored, malformed('invalid-contact-inventory-frame'), unavailable(['inventory-too-large']),
  object({ status: { const: 'accepted' }, envelope: { oneOf: [
    object({ kind: { const: 'start' }, count: integer(0, TELEMETRY_CONTACT_INVENTORY_MAX) }),
    object({ kind: { const: 'end' } }),
    object({ kind: { const: 'changed' } }),
    object({ kind: { const: 'contact' }, publicKey: key, contactType: byte,
      flags: byte, encodedPathLength: byte, pathBytes: bytes(TELEMETRY_CONTACT_PATH_BYTES), name: { type: 'string', maxLength: 32 },
      lastAdvert: uint32, lat: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
      lon: { type: 'integer', minimum: -2147483648, maximum: 2147483647 }, lastMod: uint32 }),
    object({ kind: { const: 'error' }, errorCode: byte })
  ] } })
] };
export const TELEMETRY_INVENTORY_FAILURES = Object.freeze([
  ...TELEMETRY_ROUTE_FAILURES, 'inventory-too-large', 'contacts-changed', 'invalid-contact-inventory-frame',
  'inventory-protocol-error', 'duplicate-contact', 'login-prefix-collision', 'contact-missing',
  'non-repeater-contact', 'preflight-unsupported', 'preflight-failed', 'preflight-timeout', 'clock-anomaly'
]);
const deferredInventoryReasons = ['preflight-unsupported', 'preflight-failed', 'login-prefix-collision',
  'contacts-changed', 'contact-missing', 'non-repeater-contact', ...TELEMETRY_ROUTE_FAILURES];
const deferredInventoryResult = object({ status: { const: 'deferred' }, reason: { enum: deferredInventoryReasons },
  contactCount: integer(0, TELEMETRY_CONTACT_INVENTORY_MAX) });
export const telemetryContactInventoryResultSchema = { oneOf: [pending, unavailable(TELEMETRY_INVENTORY_FAILURES),
  deferredInventoryResult,
  object({ status: { const: 'complete' }, contactCount: integer(0, TELEMETRY_CONTACT_INVENTORY_MAX),
    contact: { anyOf: [telemetryContactProofSchema, { type: 'null' }] }, contacts: { type: 'array', maxItems: TELEMETRY_CONTACT_INVENTORY_MAX, items: inventoryContact },
    contactIssue: { enum: ['non-repeater-contact', ...TELEMETRY_ROUTE_FAILURES] },
    prefixCollisionChecked: { const: true },
    provenance: { const: 'companion-contact-inventory' } }, ['status', 'contactCount', 'contact', 'contacts',
    'prefixCollisionChecked', 'provenance'])
] };
export const telemetryLoginResultSchema = { oneOf: [ignored, malformed('invalid-login-frame'),
  unavailable(['unsafe-prefix', 'legacy-login-proof', 'unsafe-login-permissions', 'unsupported-login-protocol']),
  object({ status: { const: 'denied' }, reason: { const: 'authentication-denied' }, publicKeyPrefix: prefix }),
  object({ status: { const: 'guest-proof' }, publicKeyPrefix: prefix, serverTimestamp: uint32,
    permissions: { const: 0 }, isAdmin: { const: false }, firmwareLevel: { const: TELEMETRY_LOGIN_FIRMWARE_LEVEL },
    provenance: { const: 'companion-prefix-attributed' } })
] };
export const telemetryLoginAckResultSchema = { oneOf: [ignored, malformed('invalid-login-ack'),
  unavailable(['unsafe-prefix', 'login-tag-mismatch', 'route-mismatch']),
  object({ status: { const: 'unavailable' }, reason: { const: 'login-command-error' }, errorCode: byte }),
  object({ status: { const: 'sent-proof' }, tag: uint32, route: { const: 'direct' }, estimatedTimeoutMs: uint32,
    tagKind: { const: 'static-public-key-prefix' } })
] };
