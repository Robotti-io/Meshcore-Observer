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
 * Creates a small latest-request gate for independent dashboard sections.
 * Each new request invalidates older generations; callers can therefore keep
 * their own AbortController while using the same stale-response rule for
 * range views and future focused reporting sections.
 */
export function createRequestGeneration() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(generation) {
      return generation === current;
    },
    invalidate() {
      current += 1;
      return current;
    }
  };
}

/** @returns {{status: string, requestId: number|null, lastSuccessAt: number|null, error: string|null, data: unknown}} */
export function createSectionState() {
  return { status: 'idle', requestId: null, lastSuccessAt: null, error: null, data: null };
}

export function beginSectionRequest(state, requestId) {
  return { ...state, status: 'loading', requestId, error: null };
}

export function completeSectionRequest(state, requestId, data, timestamp) {
  if (state.requestId !== requestId) return state;
  return { ...state, status: 'ready', lastSuccessAt: timestamp, error: null, data };
}

export function failSectionRequest(state, requestId, error) {
  if (state.requestId !== requestId) return state;
  return { ...state, status: 'error', error: String(error), data: state.data };
}

/**
 * Turns retained-range metadata into a short, operator-facing scope label.
 * The helper accepts the deliberately varied response shapes used by the
 * focused reporting routes and never invents completeness when metadata is
 * absent.
 */
export function formatReportingScope({ countScope = null, coverage = null, freshness = null } = {}) {
  const parts = [];
  if (typeof countScope === 'string' && countScope.length > 0) {
    parts.push(countScope.replaceAll('-', ' '));
  }
  const lowerBound = coverage?.isLowerBound === true || coverage?.lowerBound === true;
  if (lowerBound) parts.push('lower bound');
  const stale = freshness?.stale === true || freshness?.state === 'stale';
  if (stale) parts.push('stale');
  return parts.length > 0 ? parts.join(' · ') : 'Scope unavailable';
}

/**
 * Formats a nullable dashboard value without turning missing evidence into a
 * numeric zero. Numbers retain locale-aware grouping; callers can supply a
 * different unavailable label for a field with a more specific explanation.
 */
export function formatReportingValue(value, unavailable = 'Unavailable') {
  if (value === null || value === undefined) return unavailable;
  if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString();
  return String(value);
}

/**
 * Normalizes the focused bot reporting responses into the small shape the
 * browser needs for tiles and bounded tables. Missing response sections stay
 * empty so an unavailable report cannot be mistaken for zero activity.
 */
export function summarizeBotReporting(usage = {}, outcomes = {}) {
  const usageTotals = usage.totals ?? {};
  const outcomeTotals = outcomes.totals ?? {};
  return {
    accepted: usageTotals.accepted ?? null,
    distinctSenderNames: usageTotals.distinctSenderNames ?? null,
    outcomes: {
      sent: outcomeTotals.sent ?? null,
      failed: outcomeTotals.failed ?? null,
      expired: outcomeTotals.expired ?? null,
      cancelled: outcomeTotals.cancelled ?? null
    },
    usageGroups: usage.groups?.groups ?? [],
    outcomeGroups: outcomes.groups?.groups ?? []
  };
}

/** @returns {{events: number|null, distinctNodes: number|null, newDiscoveries: number|null, rehears: number|null, byType: object[], nodes: object[]}} */
export function summarizeAdvertReporting(response = {}) {
  return {
    events: response.totals?.events ?? null,
    distinctNodes: response.totals?.distinctNodes ?? null,
    newDiscoveries: response.totals?.newDiscoveries ?? null,
    rehears: response.totals?.rehears ?? null,
    byType: Array.isArray(response.byType) ? response.byType : [],
    nodes: response.nodes?.nodes ?? []
  };
}

/** @returns {{buckets: object[], latest: object|null, samples: number|null, suppressedEvents: number|null, failedEvents: number|null}} */
export function summarizeProcessReporting(history = {}, samples = {}) {
  const buckets = Array.isArray(history.buckets) ? history.buckets : [];
  const latest = buckets.length > 0 ? buckets[buckets.length - 1] : null;
  return {
    buckets,
    latest,
    samples: samples.total ?? null,
    suppressedEvents: latest?.suppressedEvents ?? null,
    failedEvents: latest?.failedEvents ?? null
  };
}

/** @returns {{events: number|null, rows: object[]}} */
export function summarizeRuntimeReporting(response = {}) {
  return { events: response.total ?? null, rows: Array.isArray(response.events) ? response.events : [] };
}

/** @returns {{observations: number|null, outcomes: number|null, latestObservation: object|null, latestOutcome: object|null}} */
export function summarizeTelemetryReporting(observations = {}, outcomes = {}) {
  return {
    observations: observations.total ?? null,
    outcomes: outcomes.total ?? null,
    latestObservation: observations.observations?.[0] ?? null,
    latestOutcome: outcomes.outcomes?.[0] ?? null
  };
}

/** @returns {{paths: number|null, rows: object[], coverageSamples: number|null}} */
export function summarizeTopologyReporting(paths = {}, coverage = {}) {
  return {
    paths: paths.total ?? null,
    rows: Array.isArray(paths.paths) ? paths.paths : [],
    coverageSamples: coverage.total ?? null
  };
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
 * @returns {string} the node table's pagination note, e.g. "1-25 of 137" or
 * "No repeaters found." for an empty result set - shared logic for the
 * offset math so dashboard.js's Prev/Next handlers and this note can never
 * disagree on where a page starts/ends.
 */
export function formatNodePageRange(offset, limit, total) {
  if (total === 0) {
    return 'No repeaters found.';
  }
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return `${from}-${to} of ${total}`;
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

/**
 * Returns a stable color for a categorical series. Use the dashboard's
 * validated palette first, then spread additional categories around the
 * hue wheel so configured bot commands remain individually distinguishable.
 *
 * @param {number} index - Stable config-order index for this category.
 * @param {string[]} palette - Theme-aware CSS colors for the first categories.
 * @param {{saturation: string, lightness: string}} generatedColor - CSS HSL components for overflow categories.
 * @returns {string}
 */
export function categoryColor(index, palette, { saturation, lightness }) {
  if (index < palette.length) {
    return palette[index];
  }
  const hue = (index * 137.508) % 360;
  return `hsl(${hue.toFixed(1)} ${saturation} ${lightness})`;
}
