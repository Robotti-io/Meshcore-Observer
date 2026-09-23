/**
 * Pure, DOM-free logic extracted from dashboard.js: range/query handling,
 * response-to-chart-data transformation, and formatting. Every export here
 * takes plain data in and returns plain data out - no `document`/`window`/
 * `fetch`/Chart.js reference anywhere in this file - specifically so it can
 * run and be unit-tested directly under Node (see
 * test/web/client/dashboard-logic.test.js), the same way any other module
 * in this codebase is tested, rather than requiring a browser or a DOM
 * shim dependency this project doesn't have (see AGENTS.md's dependency
 * policy). dashboard.js imports this module and supplies the real DOM/
 * Chart.js/fetch calls around it.
 */

/** @returns {string} e.g. "1d 2h 3m 4s" (only as many leading units as needed). */
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(days + 'd');
  if (days || hours) parts.push(hours + 'h');
  if (days || hours || minutes) parts.push(minutes + 'm');
  parts.push(seconds + 's');
  return parts.join(' ');
}

/** @returns {string} a locale-formatted timestamp, or "never" if value is falsy. */
export function formatTimestamp(value) {
  return value ? new Date(value).toLocaleString() : 'never';
}

/**
 * Sub-day buckets only need a time; anything a day or wider is easier to
 * read as a date.
 */
export function formatBucketLabel(bucketStartMs, bucketWidthMs) {
  return bucketWidthMs < 86400000
    ? new Date(bucketStartMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : new Date(bucketStartMs).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** @returns {string} e.g. "45s", "15m", "3h", "7d" - the coarsest unit that fits. */
export function formatBucketWidthLabel(widthMs) {
  if (widthMs < 60000) return Math.round(widthMs / 1000) + 's';
  if (widthMs < 3600000) return Math.round(widthMs / 60000) + 'm';
  if (widthMs < 86400000) return Math.round(widthMs / 3600000) + 'h';
  return Math.round(widthMs / 86400000) + 'd';
}

/** @returns {string} a URL query string, e.g. "range=24h". */
export function buildQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  return search.toString();
}

/**
 * Resolves the range selector's current UI state into the query object
 * GET /api/metrics/history and friends expect - null if a custom range is
 * selected but hasn't been applied yet (both bounds still unset), so the
 * caller knows not to fetch.
 *
 * @param {{range: string, customStartMs: number|null, customEndMs: number|null}} state
 * @returns {{range: string}|{start: number, end: number}|null}
 */
export function resolveRangeQuery({ range, customStartMs, customEndMs }) {
  if (range === 'custom') {
    return customStartMs !== null && customEndMs !== null ? { start: customStartMs, end: customEndMs } : null;
  }
  return { range };
}

/**
 * Validates and converts the custom-range date inputs' raw string values
 * into an epoch-ms `[start, end]` pair. Custom dates are day-granularity
 * inputs; the end date is treated as inclusive by running the window
 * through the end of that day.
 *
 * @param {string} startValue - an <input type="date"> value, or "".
 * @param {string} endValue - an <input type="date"> value, or "".
 * @returns {{ok: true, start: number, end: number}|{ok: false, error: string}}
 */
export function parseCustomRangeInputs(startValue, endValue) {
  if (!startValue || !endValue) {
    return { ok: false, error: 'Pick both a start and end date.' };
  }
  const start = new Date(startValue).getTime();
  const end = new Date(endValue).getTime() + 86400000 - 1;
  if (!(start < end)) {
    return { ok: false, error: 'Start must be before end.' };
  }
  return { ok: true, start, end };
}

/**
 * Shapes GET /api/metrics/history's buckets into the line chart's plain
 * data arrays - one label per bucket, one "received (raw)" series, and one
 * series per configured packet-type bucket, defaulting a bucket's missing
 * count to 0 rather than leaving a gap.
 *
 * @param {{bucketStart: number, bucketWidthMs: number, packetsReceived: number, countsByType: Record<string, number>}[]} buckets
 * @param {{key: string}[]} packetTypeBuckets
 * @returns {{labels: string[], receivedData: number[], typeSeriesData: number[][]}} typeSeriesData is one array per packetTypeBuckets entry, same order.
 */
export function buildHistoryChartData(buckets, packetTypeBuckets) {
  return {
    labels: buckets.map((b) => formatBucketLabel(b.bucketStart, b.bucketWidthMs)),
    receivedData: buckets.map((b) => b.packetsReceived),
    typeSeriesData: packetTypeBuckets.map((series) => buckets.map((b) => b.countsByType[series.key] ?? 0))
  };
}

/**
 * @returns {string} the packet-activity chart's note text for the current buckets.
 */
export function chartNoteForBuckets(buckets) {
  if (buckets.length === 0) {
    return 'No data recorded for this range yet.';
  }
  const widthLabel = formatBucketWidthLabel(buckets[0].bucketWidthMs);
  return `Bucketed into ${widthLabel} windows (${buckets.length} buckets), computed on the server.`;
}

/**
 * Re-orders GET /api/metrics/packet-types' totals (an unordered array,
 * possibly omitting zero-count buckets) into the fixed display order
 * packetTypeBuckets defines, defaulting a missing bucket's count to 0 -
 * shared by the table's cell values and the pie chart's data array, so
 * the two can never disagree on order.
 *
 * @param {{packetTypeBucket: string, total: number}[]} totals
 * @param {{key: string}[]} packetTypeBuckets
 * @returns {number[]} one count per packetTypeBuckets entry, same order.
 */
export function buildPacketTypeTotals(totals, packetTypeBuckets) {
  const totalsByKey = Object.fromEntries(totals.map((t) => [t.packetTypeBucket, t.total]));
  return packetTypeBuckets.map((bucket) => totalsByKey[bucket.key] ?? 0);
}
