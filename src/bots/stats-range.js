const RANGE_DURATIONS_MS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000
};

/** The recognized !stats range tokens, for config/docs to reference. */
export const STATS_RANGE_TOKENS = [...Object.keys(RANGE_DURATIONS_MS), 'all'];

/**
 * Resolves a !stats range token (e.g. "1h", "all") into a [start, end)
 * window ending at `now`. Returns null for anything unrecognized, including
 * an empty string or undefined - a bare `!stats` with no argument included.
 *
 * "all" means since the earliest data still in the store, not since process
 * start - `earliestSampleAt` should come from MetricsStore#getEarliestSampleAt(),
 * and falls back to `now` (an empty window) when nothing has been sampled yet.
 *
 * @param {string|undefined} token
 * @param {{now: number, earliestSampleAt: number|null}} options
 * @returns {{start: number, end: number}|null}
 */
export function resolveStatsRange(token, { now, earliestSampleAt }) {
  if (typeof token !== 'string' || token.length === 0) {
    return null;
  }

  const normalized = token.toLowerCase();
  if (normalized === 'all') {
    return { start: earliestSampleAt ?? now, end: now };
  }

  const durationMs = RANGE_DURATIONS_MS[normalized];
  if (durationMs === undefined) {
    return null;
  }

  return { start: now - durationMs, end: now };
}
