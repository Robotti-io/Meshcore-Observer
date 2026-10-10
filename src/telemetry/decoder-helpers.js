import { telemetryParseInputSchema, telemetryObservationSchema } from './telemetry-schemas.js';
import { assertTelemetryInput } from './telemetry-validation.js';

export const malformedTelemetry = reason => ({ status: 'malformed', reason });

/** Validate all structured input before buffer allocation or field access. */
export function prepareTelemetryDecode(input, component) {
  try { assertTelemetryInput(telemetryParseInputSchema, input); }
  catch { return malformedTelemetry('invalid-input'); }
  if (input.response.variant.component !== component) return malformedTelemetry('wrong-component');
  return { bytes: Buffer.from(input.response.body) };
}

/** A bounded suffix, checked only AFTER structural fields/complete records. */
export function isTelemetryZeroPadding(bytes, offset) {
  const remaining = bytes.length - offset;
  return remaining <= 15 && bytes.subarray(offset).every(byte => byte === 0);
}

/** Detached normalized output, strictly validated before any future writer. */
export function finishTelemetryDecode(input, data, metadata) {
  const variant = JSON.parse(JSON.stringify(input.response.variant));
  const observation = { observedAt: input.observedAt, decoderVersion: 1,
    provenance: 'companion-tag-attributed', coverage: 'response-only',
    variant, data, bodyBytes: input.response.body.length, ...metadata };
  try { assertTelemetryInput(telemetryObservationSchema, observation); }
  catch { return malformedTelemetry('invalid-observation'); }
  return { status: 'accepted', observation };
}
