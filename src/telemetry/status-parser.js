import { TELEMETRY_STATUS_FIELDS } from './telemetry-schemas.js';
import { prepareTelemetryDecode, finishTelemetryDecode, isTelemetryZeroPadding, malformedTelemetry } from './decoder-helpers.js';

/** Previously correlated post-tag bytes only. No layout selection by length. */
export function parseStatusResponseBody(input) {
  const prepared = prepareTelemetryDecode(input, 'status');
  if (prepared.status === 'malformed') return prepared;
  const { bytes } = prepared;
  const { profile } = input.response.variant;
  const established = profile.evidence === 'established';
  const width = established && profile.layout === 'current56' ? 56 : 48;
  // Input validation already bounds this profile's width and response envelope.
  // Never trim zeros: genuine structural zeros must be read first.
  const data = {};
  for (const [name, field] of Object.entries(TELEMETRY_STATUS_FIELDS)) {
    data[name] = field.offset >= width ? null : field.signed
      ? bytes.readIntLE(field.offset, field.width) : bytes.readUIntLE(field.offset, field.width);
  }
  data.lastSnrDb = data.lastSnrQuarterDb / 4;
  if (established && !isTelemetryZeroPadding(bytes, width)) return malformedTelemetry('invalid-padding');
  return finishTelemetryDecode(input, data, {
    quality: established ? 'decoded' : 'prefix-only', decodedBytes: width,
    paddingBytes: established ? bytes.length - width : 0,
    uninterpretedBytes: established ? 0 : bytes.length - width,
    diagnostic: established ? null : { code: 'status-profile-unknown' }
  });
}
