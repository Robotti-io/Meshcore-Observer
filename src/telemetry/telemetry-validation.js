import { compileSchema } from '../validation/ajv.js';
import * as schemas from './telemetry-schemas.js';

const known = [schemas.telemetryVariantSchema, schemas.telemetryDecoderInputSchema, schemas.telemetryObservationSchema,
  schemas.telemetryOutcomeSchema, schemas.telemetryResultSchema, schemas.telemetryConfigSchema, schemas.telemetryEnvSchema,
  schemas.telemetryLatestQuerySchema, schemas.telemetryObservationPageSchema, schemas.telemetryOutcomePageSchema];
const validators = new Map(known.map(schema => [schema, compileSchema(schema)]));
const invalid = () => new Error('Invalid telemetry data'); // Never disclose inbound fields/values.

function variantKey(variant) {
  const { component, params, profile } = variant;
  if (component === 'status') return `status:${profile.layout}:${profile.evidence}`;
  if (component === 'sensors') return `sensors:${params.permissionMask}`;
  return `neighbours:${params.version}:${params.count}:${params.offset}:${params.orderBy}:${params.prefixLength}`;
}

/** Fixed internal scope key; callers cannot supply SQL or a free-text variant. */
export function telemetryVariantKey(variant) {
  assertTelemetryInput(schemas.telemetryVariantSchema, variant);
  return variantKey(variant);
}

function assertTime(outcome) {
  if (!outcome.clockAnomaly && (outcome.completedAt < outcome.startedAt || (outcome.receivedAt !== null
    && (outcome.receivedAt < outcome.startedAt || outcome.receivedAt > outcome.completedAt)))) throw invalid();
}

function assertObservation(value) {
  const { variant, data, quality, diagnostic, bodyBytes, decodedBytes, paddingBytes, uninterpretedBytes } = value;
  if (bodyBytes !== decodedBytes + paddingBytes + uninterpretedBytes
    || (quality === 'decoded' && (diagnostic !== null || uninterpretedBytes !== 0))
    || (quality !== 'decoded' && diagnostic === null)
    || (paddingBytes > 0 && uninterpretedBytes > 0)) throw invalid();
  if (variant.component === 'status') {
    const established = variant.profile.evidence === 'established';
    const width = established && variant.profile.layout === 'current56' ? 56 : 48;
    if (decodedBytes !== width || bodyBytes > (established ? width + 15 : 71)
      || (established ? quality !== 'decoded' : quality !== 'prefix-only')
      || (!established && (diagnostic.code !== 'status-profile-unknown' || paddingBytes !== 0))
      || data.lastSnrDb !== data.lastSnrQuarterDb / 4) throw invalid();
    for (const field of ['rxAirtimeSeconds', 'receiveErrors']) {
      if ((width === 56) === (data[field] === null)) throw invalid();
    }
  } else if (variant.component === 'sensors') {
    if (quality === 'prefix-only' || (data.emitterProfile === 'unknown' && (quality === 'decoded' || paddingBytes > 0))
      || (diagnostic && !['sensor-profile-unknown', 'unsupported-sensor-type', 'excluded-sensor-type', 'ambiguous-channel'].includes(diagnostic.code))) throw invalid();
    let previousEnd = 0;
    let previousOrder = -1;
    const occurrences = new Map();
    for (const reading of data.readings) {
      const field = schemas.TELEMETRY_SENSOR_FIELDS[reading.type];
      const occurrenceKey = `${reading.channel}:${reading.type}`;
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      const end = reading.byteOffset + 2 + field.width;
      if (reading.value !== reading.rawValue / field.divisor || reading.order <= previousOrder
        || reading.byteOffset < previousEnd || end > decodedBytes || reading.occurrence !== occurrence
        || (quality === 'decoded' && (reading.order !== previousOrder + 1 || reading.byteOffset !== previousEnd))) throw invalid();
      occurrences.set(occurrenceKey, occurrence + 1);
      previousOrder = reading.order; previousEnd = end;
    }
    if (diagnostic && 'byteOffset' in diagnostic && (diagnostic.byteOffset > bodyBytes
      || diagnostic.remainingBytes !== bodyBytes - diagnostic.byteOffset)) throw invalid();
    if (diagnostic && ['unsupported-sensor-type', 'excluded-sensor-type'].includes(diagnostic.code)
      && schemas.TELEMETRY_SENSOR_FIELDS[diagnostic.type]) throw invalid();
    if (diagnostic?.code === 'excluded-sensor-type') {
      const width = schemas.TELEMETRY_EXCLUDED_SENSOR_WIDTHS[diagnostic.type];
      if (!width || diagnostic.byteOffset + 2 + width > decodedBytes) throw invalid();
    }
    if (diagnostic && ['unsupported-sensor-type', 'ambiguous-channel'].includes(diagnostic.code)
      && (diagnostic.byteOffset !== decodedBytes || diagnostic.remainingBytes !== uninterpretedBytes
        || diagnostic.remainingBytes < 2)) throw invalid();
    // A fully decoded supported payload has no gaps or silently excluded records.
    if (quality === 'decoded' && previousEnd !== decodedBytes) throw invalid();
  } else {
    const { count, offset, prefixLength } = variant.params;
    if (quality !== 'decoded' || data.receivedCount !== data.entries.length || data.receivedCount > count
      || data.receivedCount > Math.max(0, data.reportedTotal - offset)
      || decodedBytes !== 4 + data.receivedCount * (prefixLength + 5)) throw invalid();
    for (const [index, entry] of data.entries.entries()) {
      if (entry.order !== index || entry.prefix.length !== prefixLength * 2 || entry.snrDb !== entry.snrQuarterDb / 4) throw invalid();
    }
  }
}

/** AJV precedes all cross-field/byte invariants; no mutation or side effects. */
export function assertTelemetryInput(schema, value) {
  if (validators.get(schema)?.(value) !== true) throw invalid();
  if (schema === schemas.telemetryDecoderInputSchema && value.variant.component === 'status') {
    const { profile } = value.variant;
    const width = profile.evidence === 'established' && profile.layout === 'current56' ? 56 : 48;
    if (value.body.length < width || value.body.length > (profile.evidence === 'established' ? width + 15 : 71)) throw invalid();
  }
  if (schema === schemas.telemetryDecoderInputSchema && value.variant.component === 'neighbours' && value.body.length < 4) throw invalid();
  if (schema === schemas.telemetryObservationSchema) assertObservation(value);
  if (schema === schemas.telemetryOutcomeSchema) assertTime(value);
  if (schema === schemas.telemetryResultSchema) {
    assertTime(value.outcome);
    if (value.observation) {
      assertObservation(value.observation);
      if (value.observation.observedAt !== value.outcome.receivedAt
        || variantKey(value.observation.variant) !== variantKey(value.outcome.variant)
        || (value.outcome.status === 'answered') !== (value.observation.quality === 'decoded')) throw invalid();
    }
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > schemas.TELEMETRY_RESULT_MAX_BYTES) throw invalid();
  }
  if (schema === schemas.telemetryObservationPageSchema || schema === schemas.telemetryOutcomePageSchema) {
    if (value.start > value.end || (value.component && value.variant && value.component !== value.variant.component)) throw invalid();
  }
}

export function assertTelemetryResult(value) { assertTelemetryInput(schemas.telemetryResultSchema, value); }
