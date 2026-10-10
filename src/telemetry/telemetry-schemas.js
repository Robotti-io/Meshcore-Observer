import { REMOTE_BODY_MAX_BYTES } from '../radio/remote-request-schemas.js';

export const TELEMETRY_BODY_MAX_BYTES = REMOTE_BODY_MAX_BYTES;
export const TELEMETRY_RESULT_MAX_BYTES = 16 * 1024;
export const TELEMETRY_READ_DEFAULT_LIMIT = 100;
export const TELEMETRY_MAX_READINGS = Math.floor(REMOTE_BODY_MAX_BYTES / 3);
export const TELEMETRY_MAX_NEIGHBOURS = Math.floor((REMOTE_BODY_MAX_BYTES - 4) / 6);
export const TELEMETRY_FRESHNESS_DEFAULT_HOURS = 72;
export const TELEMETRY_FRESHNESS_ENV_KEY = 'PACKETCAPTURE_TELEMETRY_FRESHNESS_HOURS';
export const TELEMETRY_FAILURE_REASONS = Object.freeze([
  'disconnected', 'stopped', 'command-error', 'ack-timeout', 'response-timeout',
  'write-error', 'protocol-error', 'retired-tag', 'route-mismatch', 'malformed-response'
]);

// Pinned MeshCore a366955: little-endian status fields, with two extensions
// only under an established current56 interpretation. Units are snapshots,
// never derived battery health, rates or a claim about a board's calibration.
export const TELEMETRY_STATUS_FIELDS = Object.freeze(Object.fromEntries([
  ['batteryMillivolts', 0, 2, false, 'mV'], ['txQueueLength', 2, 2, false, 'items'],
  ['noiseFloorDbm', 4, 2, true, 'dBm'], ['lastRssiDbm', 6, 2, true, 'dBm'],
  ['packetsReceived', 8, 4, false, 'count'], ['packetsSent', 12, 4, false, 'count'],
  ['txAirtimeSeconds', 16, 4, false, 's'], ['uptimeSeconds', 20, 4, false, 's'],
  ['sentFlood', 24, 4, false, 'count'], ['sentDirect', 28, 4, false, 'count'],
  ['receivedFlood', 32, 4, false, 'count'], ['receivedDirect', 36, 4, false, 'count'],
  ['errorEventFlags', 40, 2, false, 'bitmask'], ['lastSnrQuarterDb', 42, 2, true, 'quarter-dB'],
  ['directDuplicates', 44, 2, false, 'count'], ['floodDuplicates', 46, 2, false, 'count'],
  ['rxAirtimeSeconds', 48, 4, false, 's'], ['receiveErrors', 52, 4, false, 'count']
].map(([name, offset, width, signed, unit]) => [name, Object.freeze({ offset, width, signed, unit, endian: 'LE' })])));

// Actual CayenneLPP 1.6.1 getTypeSigned/addField, not its unsigned header
// comments: voltage AND current are signed. No location type is accepted.
export const TELEMETRY_SENSOR_FIELDS = Object.freeze(Object.fromEntries([
  [116, 'voltage', 2, true, 100, 'V'], [117, 'current', 2, true, 1000, 'A'],
  [103, 'temperature', 2, true, 10, 'degC'], [104, 'humidity', 1, false, 2, '%'],
  [115, 'pressure', 2, false, 10, 'hPa']
].map(([type, name, width, signed, divisor, unit]) => [type, Object.freeze({ name, width, signed, divisor, unit, endian: 'BE' })])));

// Reviewed GPS has nine value bytes. Only its width/type can be represented
// in exclusion metadata; neither coordinates nor an opaque value are stored.
export const TELEMETRY_EXCLUDED_SENSOR_WIDTHS = Object.freeze({ 136: 9 });

export const TELEMETRY_NEIGHBOUR_FIELDS = Object.freeze({
  reportedTotal: Object.freeze({ offset: 0, width: 2, signed: false, endian: 'LE', unit: 'count' }),
  receivedCount: Object.freeze({ offset: 2, width: 2, signed: false, endian: 'LE', unit: 'count' }),
  heardSecondsAgo: Object.freeze({ width: 4, signed: false, endian: 'LE', unit: 's' }),
  snrQuarterDb: Object.freeze({ width: 1, signed: true, divisor: 4, unit: 'dB' })
});

const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const epoch = integer(0, Number.MAX_SAFE_INTEGER);
const byte = integer(0, 255);
const uint16 = integer(0, 65535);
const uint32 = integer(0, 0xFFFFFFFF);
const uuid = { type: 'string', minLength: 36, maxLength: 36,
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const key = { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9A-F]{64}$' };
const windowMs = { ...integer(3600000, 8760 * 3600000), multipleOf: 3600000 };
function object(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, properties, required };
}
function wireInteger(width, signed) {
  return integer(signed ? -(2 ** (width * 8 - 1)) : 0,
    2 ** (width * 8 - (signed ? 1 : 0)) - 1);
}
const profile = object({ layout: { enum: ['common48', 'current56'] }, evidence: { enum: ['established', 'unknown'] } });
const sensorProfile = { enum: ['positive-channels', 'unknown'] };
const neighbourParams = object({ version: { const: 0 }, count: integer(1, 255), offset: uint16,
  orderBy: { enum: [0, 1, 2, 3] }, prefixLength: integer(1, 32) });
const variants = {
  status: object({ component: { const: 'status' }, params: object({}), profile }),
  sensors: object({ component: { const: 'sensors' }, params: object({ permissionMask: byte }) }),
  neighbours: object({ component: { const: 'neighbours' }, params: neighbourParams })
};
export const telemetryVariantSchema = { oneOf: Object.values(variants) };
const body = { type: 'array', minItems: 1, maxItems: TELEMETRY_BODY_MAX_BYTES, items: byte };
export const telemetryDecoderInputSchema = { oneOf: Object.entries(variants).map(([component, variant]) =>
  object({ variant, body, ...(component === 'sensors' ? { emitterProfile: sensorProfile } : {}) })) };

const statusData = object({ ...Object.fromEntries(Object.entries(TELEMETRY_STATUS_FIELDS).map(([name, field]) => {
  const wire = wireInteger(field.width, field.signed);
  return [name, field.offset >= 48 ? { anyOf: [wire, { type: 'null' }] } : wire];
})), lastSnrDb: { type: 'number', minimum: -8192, maximum: 8191.75 } });
const sensorReading = { oneOf: Object.entries(TELEMETRY_SENSOR_FIELDS).map(([type, field]) => {
  const raw = wireInteger(field.width, field.signed);
  return object({ channel: integer(1, 255), type: { const: Number(type) }, name: { const: field.name },
    order: integer(0, TELEMETRY_MAX_READINGS - 1), occurrence: integer(0, TELEMETRY_MAX_READINGS - 1),
    byteOffset: integer(0, TELEMETRY_BODY_MAX_BYTES - 3), rawValue: raw,
    divisor: { const: field.divisor }, unit: { const: field.unit },
    value: { type: 'number', minimum: raw.minimum / field.divisor, maximum: raw.maximum / field.divisor } });
}) };
const sensorData = object({ emitterProfile: sensorProfile,
  readings: { type: 'array', maxItems: TELEMETRY_MAX_READINGS, items: sensorReading } });
const neighbourData = object({ reportedTotal: uint16, receivedCount: uint16,
  entries: { type: 'array', maxItems: TELEMETRY_MAX_NEIGHBOURS, items: object({
    order: integer(0, TELEMETRY_MAX_NEIGHBOURS - 1),
    prefix: { type: 'string', minLength: 2, maxLength: 64, pattern: '^[0-9A-F]+$' },
    heardSecondsAgo: uint32, snrQuarterDb: integer(-128, 127),
    snrDb: { type: 'number', minimum: -32, maximum: 31.75 }
  }) } });
const diagnostic = { oneOf: [
  { type: 'null' },
  object({ code: { const: 'status-profile-unknown' } }),
  object({ code: { const: 'sensor-profile-unknown' } }),
  object({ code: { enum: ['unsupported-sensor-type', 'excluded-sensor-type', 'ambiguous-channel'] },
    type: byte, byteOffset: integer(0, TELEMETRY_BODY_MAX_BYTES - 1),
    remainingBytes: integer(0, TELEMETRY_BODY_MAX_BYTES) })
] };
const observationProperties = {
  observedAt: epoch, decoderVersion: { const: 1 }, provenance: { const: 'companion-tag-attributed' },
  coverage: { const: 'response-only' }, quality: { enum: ['decoded', 'prefix-only', 'partial'] },
  bodyBytes: integer(1, TELEMETRY_BODY_MAX_BYTES), decodedBytes: integer(0, TELEMETRY_BODY_MAX_BYTES),
  paddingBytes: integer(0, 15), uninterpretedBytes: integer(0, TELEMETRY_BODY_MAX_BYTES), diagnostic
};
export const telemetryObservationSchema = { oneOf: Object.entries({ status: statusData, sensors: sensorData,
  neighbours: neighbourData }).map(([component, data]) => object({ ...observationProperties, variant: variants[component], data })) };

const outcome = {
  requestId: uuid, runId: uuid, observerPublicKey: key, targetPublicKey: key, variant: telemetryVariantSchema,
  startedAt: epoch, completedAt: epoch, receivedAt: { anyOf: [epoch, { type: 'null' }] },
  clockAnomaly: { type: 'boolean' }, tag: { anyOf: [uint32, { type: 'null' }] },
  route: { enum: [null, 'direct', 'flood'] }
};
const accepted = object({ ...outcome, status: { enum: ['answered', 'partial'] }, reason: { const: null },
  receivedAt: epoch, tag: uint32, route: { enum: ['direct', 'flood'] } });
const rejected = { oneOf: [
  object({ ...outcome, status: { const: 'failed' }, reason: { enum: TELEMETRY_FAILURE_REASONS } }),
  object({ ...outcome, status: { const: 'unsupported' }, reason: { enum: ['unsupported', 'unsupported-layout', 'unsupported-profile'] } })
] };
export const telemetryOutcomeSchema = { oneOf: [accepted, rejected] };
export const telemetryResultSchema = { oneOf: [
  object({ decoderVersion: { const: 1 }, outcome: accepted, observation: telemetryObservationSchema }),
  object({ decoderVersion: { const: 1 }, outcome: rejected })
] };
export const telemetryConfigSchema = object({ freshnessWindowMs: windowMs });
export const telemetryEnvSchema = object({ [TELEMETRY_FRESHNESS_ENV_KEY]: {
  type: 'string', minLength: 1, maxLength: 32, pattern: '^\\s*\\d+\\s*$'
} }, []);
export const telemetryLatestQuerySchema = object({ observerPublicKey: key, targetPublicKey: key,
  variant: telemetryVariantSchema, now: epoch, windowMs });
const range = { start: epoch, end: epoch, observerPublicKey: key, targetPublicKey: key, runId: uuid,
  component: { enum: ['status', 'sensors', 'neighbours'] }, variant: telemetryVariantSchema,
  limit: integer(1, 200), offset: integer(0, 0x7FFFFFFF) };
export const telemetryObservationPageSchema = object(range, ['start', 'end']);
export const telemetryOutcomePageSchema = object({ ...range, status: { enum: ['answered', 'partial', 'failed', 'unsupported'] } }, ['start', 'end']);
