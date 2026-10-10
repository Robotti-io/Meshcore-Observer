import { prepareTelemetryDecode, finishTelemetryDecode, isTelemetryZeroPadding, malformedTelemetry } from './decoder-helpers.js';

/** One v0 page, with the EXACT captured request parameters, not topology. */
export function parseNeighbourResponseBody(input) {
  const prepared = prepareTelemetryDecode(input, 'neighbours');
  if (prepared.status === 'malformed') return prepared;
  const { bytes } = prepared;
  const { count, offset, prefixLength } = input.response.variant.params;
  const reportedTotal = bytes.readUInt16LE(0), receivedCount = bytes.readUInt16LE(2);
  const entryBytes = prefixLength + 5, decodedBytes = 4 + receivedCount * entryBytes;
  // Check header relationships and the entire entry budget BEFORE any entry
  // read; do not return a valid prefix from a truncated/contradictory page.
  if (receivedCount > count || receivedCount > Math.max(0, reportedTotal - offset)) return malformedTelemetry('invalid-counts');
  if (decodedBytes > bytes.length) return malformedTelemetry('truncated-field');
  if (!isTelemetryZeroPadding(bytes, decodedBytes)) return malformedTelemetry('invalid-padding');
  const entries = [];
  for (let order = 0; order < receivedCount; order++) {
    const start = 4 + order * entryBytes, snrQuarterDb = bytes.readInt8(start + prefixLength + 4);
    entries.push({ order, prefix: bytes.subarray(start, start + prefixLength).toString('hex').toUpperCase(),
      heardSecondsAgo: bytes.readUInt32LE(start + prefixLength), snrQuarterDb, snrDb: snrQuarterDb / 4 });
  }
  return finishTelemetryDecode(input, { reportedTotal, receivedCount, entries }, {
    quality: 'decoded', decodedBytes, paddingBytes: bytes.length - decodedBytes,
    uninterpretedBytes: 0, diagnostic: null
  });
}
