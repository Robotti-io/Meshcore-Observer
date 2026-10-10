import { TELEMETRY_SENSOR_FIELDS, TELEMETRY_EXCLUDED_SENSOR_WIDTHS } from './telemetry-schemas.js';
import { prepareTelemetryDecode, finishTelemetryDecode, isTelemetryZeroPadding, malformedTelemetry } from './decoder-helpers.js';

/** Whitelisted pinned CayenneLPP fields; never decode/store GPS values. */
export function parseSensorResponseBody(input) {
  const prepared = prepareTelemetryDecode(input, 'sensors');
  if (prepared.status === 'malformed') return prepared;
  const { bytes } = prepared;
  const { emitterProfile } = input.response;
  const readings = [], occurrences = new Map();
  let offset = 0, order = 0, paddingBytes = 0, diagnostic = null;
  while (offset < bytes.length) {
    const remainingBytes = bytes.length - offset;
    if (emitterProfile === 'positive-channels' && isTelemetryZeroPadding(bytes, offset)) {
      paddingBytes = remainingBytes; break;
    }
    // One trailing zero under an unknown emitter may be padding OR an
    // incomplete channel. Preserve it as uninterpreted, never certify empty.
    if (remainingBytes < 2) {
      if (emitterProfile === 'unknown' && bytes[offset] === 0) {
        diagnostic = { code: 'sensor-profile-unknown' }; break;
      }
      return malformedTelemetry('truncated-field');
    }
    const channel = bytes[offset], type = bytes[offset + 1];
    const field = TELEMETRY_SENSOR_FIELDS[type];
    const excludedWidth = TELEMETRY_EXCLUDED_SENSOR_WIDTHS[type];
    const width = field?.width ?? excludedWidth;
    // A truncated known field invalidates the WHOLE response, even when an
    // earlier record was valid or channel zero makes interpretation ambiguous.
    if (width !== undefined && remainingBytes < 2 + width) return malformedTelemetry('truncated-field');
    if (channel === 0 || width === undefined) {
      diagnostic = { code: channel === 0 ? 'ambiguous-channel' : 'unsupported-sensor-type',
        type, byteOffset: offset, remainingBytes }; break;
    }
    if (field) {
      const rawValue = field.signed ? bytes.readIntBE(offset + 2, width) : bytes.readUIntBE(offset + 2, width);
      const key = `${channel}:${type}`, occurrence = occurrences.get(key) ?? 0;
      readings.push({ channel, type, name: field.name, order, occurrence, byteOffset: offset,
        rawValue, divisor: field.divisor, unit: field.unit, value: rawValue / field.divisor });
      occurrences.set(key, occurrence + 1);
    } else {
      // Skip reviewed fixed-width GPS; retain only bounded exclusion evidence.
      diagnostic ??= { code: 'excluded-sensor-type', type, byteOffset: offset, remainingBytes };
    }
    offset += 2 + width; order++;
  }
  if (emitterProfile === 'unknown') diagnostic ??= { code: 'sensor-profile-unknown' };
  return finishTelemetryDecode(input, { emitterProfile, readings }, {
    quality: diagnostic ? 'partial' : 'decoded', decodedBytes: offset, paddingBytes,
    uninterpretedBytes: bytes.length - offset - paddingBytes, diagnostic
  });
}
