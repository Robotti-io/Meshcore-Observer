import { prepareTelemetryDecode, finishTelemetryDecode, malformedTelemetry } from './decoder-helpers.js';

/** Decode the authenticated MeshCore owner-info response; discard device name/version. */
export function parseOwnerInfoResponseBody(input) {
  const prepared = prepareTelemetryDecode(input, 'owner-info');
  if (prepared.status === 'malformed') return prepared;
  const { bytes } = prepared;
  if (bytes.length < 6) return malformedTelemetry('invalid-owner-info');
  const textBytes = bytes.subarray(4);
  let payload;
  try { payload = new TextDecoder('utf-8', { fatal: true }).decode(textBytes); }
  catch { return malformedTelemetry('invalid-owner-info'); }
  const first = payload.indexOf('\n');
  const second = first < 0 ? -1 : payload.indexOf('\n', first + 1);
  if (first < 1 || second < 0) return malformedTelemetry('invalid-owner-info');
  const contactInfo = payload.slice(second + 1);
  if ([...contactInfo].length > 160 || [...contactInfo].some(character => {
    const code = character.codePointAt(0);
    return (code < 9 || (code > 10 && code < 32)) || (code >= 127 && code <= 159);
  }))
    return malformedTelemetry('invalid-owner-info');
  return finishTelemetryDecode(input, { contactInfo }, { quality: 'decoded', decodedBytes: bytes.length,
    paddingBytes: 0, uninterpretedBytes: 0, diagnostic: null });
}
