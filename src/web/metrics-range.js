const RANGE_DURATIONS_MS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000
};

export const RANGE_ENUM = [...Object.keys(RANGE_DURATIONS_MS), 'all'];

export class RangeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RangeError';
  }
}

/**
 * Resolves a validated `{range}` or `{start, end}` query into a concrete
 * `[start, end)` epoch-ms window. Kept separate from AJV schema validation
 * (which only checks shape/types/exclusivity) because "start < end" and
 * "don't return an empty future window" are cross-field/data-dependent
 * checks that don't fit a JSON Schema cleanly - same split used in
 * src/config/index.js between schema validation and its manual checks.
 *
 * @param {{range?: string, start?: number, end?: number, now?: number, earliestSampleAt?: number|null}} options
 * @returns {{start: number, end: number}}
 * @throws {RangeError} if an explicit start/end pair is invalid.
 */
export function resolveRangeWindow({ range, start, end, now = Date.now(), earliestSampleAt = null }) {
  if (range !== undefined) {
    if (range === 'all') {
      return { start: earliestSampleAt ?? now, end: now };
    }
    const durationMs = RANGE_DURATIONS_MS[range];
    return { start: now - durationMs, end: now };
  }

  if (start >= end) {
    throw new RangeError('start must be before end');
  }

  // A future end date is clamped to "now" rather than left as-is, so a
  // picked future end doesn't silently return an empty window that looks
  // like a bug rather than an out-of-range selection.
  const clampedEnd = Math.min(end, now);
  if (start >= clampedEnd) {
    throw new RangeError('start must be before end');
  }

  return { start, end: clampedEnd };
}
