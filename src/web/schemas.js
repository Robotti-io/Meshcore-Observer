import { compileSchema } from '../validation/ajv.js';
import { RANGE_ENUM } from './metrics-range.js';

// Shared by every range-aware metrics query endpoint: exactly one of a
// preset `range` or an explicit `start`+`end` pair (epoch ms, sent by the
// dashboard's custom date-range inputs), never both. "start < end" is a
// cross-field check this shape can't express and is enforced afterward by
// resolveRangeWindow() instead - see its module comment.
function rangeProperties() {
  return {
    range: { enum: RANGE_ENUM },
    start: { type: 'integer', minimum: 0 },
    end: { type: 'integer', minimum: 0 }
  };
}

// oneOf, not anyOf: with `range` present, branch 1 matches and branch 2
// (needs start+end) doesn't, so exactly one branch matches. If all three
// are present, both branches match their own `required` subset and oneOf
// correctly rejects it (more than one match) - no need for an explicit
// "not" exclusion. Each branch redeclares its own (empty-schema) property
// stub only because AJV's strict mode requires a `required` property to be
// defined locally, even though the real type constraints live in the
// parent schema's `properties` above.
const RANGE_ONE_OF = [
  { properties: { range: {} }, required: ['range'] },
  { properties: { start: {}, end: {} }, required: ['start', 'end'] }
];

const REPORTING_PAGE = {
  limit: { type: 'integer', minimum: 1, maximum: 200 },
  offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
};
const RUN_ID = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const PUBLIC_KEY = { type: 'string', pattern: '^[0-9A-F]{64}$' };
const REPORTING_TEXT = { type: 'string', minLength: 1, maxLength: 256 };

function reportingQuerySchema(id, properties) {
  return {
    $id: `meshcore-observer/web/${id}`,
    type: 'object',
    additionalProperties: false,
    properties: { ...rangeProperties(), ...properties },
    oneOf: RANGE_ONE_OF
  };
}

export const botUsageQuerySchema = reportingQuerySchema('bot-usage-query', {
  ...REPORTING_PAGE, botName: REPORTING_TEXT, channel: REPORTING_TEXT,
  trigger: REPORTING_TEXT, sender: REPORTING_TEXT
});
export const botOutcomeQuerySchema = reportingQuerySchema('bot-outcome-query', {
  ...REPORTING_PAGE, botName: REPORTING_TEXT, channel: REPORTING_TEXT,
  trigger: REPORTING_TEXT, sender: REPORTING_TEXT
});
export const advertReportQuerySchema = reportingQuerySchema('advert-report-query', {
  ...REPORTING_PAGE, type: { enum: ['CHAT', 'REPEATER'] }
});
export const processHistoryQuerySchema = reportingQuerySchema('process-history-query', {
  runId: RUN_ID, maxBuckets: { type: 'integer', minimum: 10, maximum: 1000 }
});
export const processSamplesQuerySchema = reportingQuerySchema('process-samples-query', {
  ...REPORTING_PAGE, runId: RUN_ID
});
export const runtimeEventsQuerySchema = reportingQuerySchema('runtime-events-query', {
  ...REPORTING_PAGE, runId: RUN_ID,
  kind: { enum: ['radio.connected', 'radio.disconnected', 'radio.connect-error', 'broker.state', 'bot.readiness'] },
  serviceId: REPORTING_TEXT
});
export const telemetryObservationsQuerySchema = reportingQuerySchema('telemetry-observations-query', {
  ...REPORTING_PAGE, observerPublicKey: PUBLIC_KEY, targetPublicKey: PUBLIC_KEY,
  runId: RUN_ID, component: { enum: ['status', 'sensors', 'neighbours'] }
});
export const telemetryOutcomesQuerySchema = reportingQuerySchema('telemetry-outcomes-query', {
  ...REPORTING_PAGE, observerPublicKey: PUBLIC_KEY, targetPublicKey: PUBLIC_KEY,
  runId: RUN_ID, component: { enum: ['status', 'sensors', 'neighbours'] },
  status: { enum: ['answered', 'partial', 'failed', 'unsupported'] }
});
export const telemetryDiagnosticsQuerySchema = reportingQuerySchema('telemetry-diagnostics-query', {
  ...REPORTING_PAGE, observerPublicKey: PUBLIC_KEY, targetPublicKey: PUBLIC_KEY, runId: RUN_ID,
  operation: { enum: ['guest-login', 'status', 'telemetry', 'neighbours'] },
  status: { enum: ['deferred', 'failed', 'unsupported', 'completed'] }
});
export const topologyPathsQuerySchema = {
  $id: 'meshcore-observer/web/topology-paths-query', type: 'object', additionalProperties: false,
  properties: { ...REPORTING_PAGE, observerPublicKey: PUBLIC_KEY,
    kind: { enum: ['flood-traversed', 'direct-remaining'] } }
};
export const topologyPathQuerySchema = {
  $id: 'meshcore-observer/web/topology-path-query', type: 'object', additionalProperties: false,
  properties: { pathId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
  required: ['pathId']
};
export const topologyDetailsQuerySchema = reportingQuerySchema('topology-details-query', {
  ...REPORTING_PAGE, pathId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, runId: RUN_ID
});
export const topologyProximityQuerySchema = {
  $id: 'meshcore-observer/web/topology-proximity-query', type: 'object', additionalProperties: false,
  properties: { ...REPORTING_PAGE, observerPublicKey: PUBLIC_KEY,
    now: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    windowMs: { type: 'integer', minimum: 3600000, maximum: 8760 * 3600000, multipleOf: 3600000 },
    radius: { type: 'integer', minimum: 0, maximum: 63 } },
  required: ['observerPublicKey', 'now', 'windowMs', 'radius']
};

export const metricsHistoryQuerySchema = {
  $id: 'meshcore-observer/web/metrics-history-query',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...rangeProperties(),
    maxBuckets: { type: 'integer', minimum: 10, maximum: 1000 }
  },
  oneOf: RANGE_ONE_OF
};

// Shared, as-is, by every range-aware endpoint that returns non-bucketed
// totals - currently /api/metrics/packet-types and /api/metrics/bots/commands.
// Both need only the range window, never a bucket count.
export const rangeOnlyQuerySchema = {
  $id: 'meshcore-observer/web/range-only-query',
  type: 'object',
  additionalProperties: false,
  properties: rangeProperties(),
  oneOf: RANGE_ONE_OF
};

// GET /api/metrics/nodes: same range/oneOf shape as rangeOnlyQuerySchema,
// plus an optional `type` filter (see nodesListQuerySchema below for why
// its enum is what it is) - the dashboard's "Repeaters" tiles always send
// `type=REPEATER`, but the endpoint itself stays as reusable as every
// other range-only one rather than hardcoding that server-side.
export const nodeTotalsQuerySchema = {
  $id: 'meshcore-observer/web/node-totals-query',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...rangeProperties(),
    type: { enum: ['NONE', 'CHAT', 'REPEATER', 'ROOM', 'SENSOR'] }
  },
  oneOf: RANGE_ONE_OF
};

// Dashboard overview and detail data share one selected range. `view`
// keeps each response focused so the client can request only the active
// page rather than refreshing every dashboard section on every sample.
export const dashboardQuerySchema = {
  $id: 'meshcore-observer/web/dashboard-query',
  type: 'object',
  additionalProperties: false,
  required: ['view'],
  properties: {
    ...rangeProperties(),
    view: { enum: ['overview', 'packets', 'brokers', 'bots', 'repeaters'] },
    maxBuckets: { type: 'integer', minimum: 10, maximum: 1000 }
  },
  oneOf: RANGE_ONE_OF
};

export const validateMetricsHistoryQuery = compileSchema(metricsHistoryQuerySchema);
export const validateRangeOnlyQuery = compileSchema(rangeOnlyQuerySchema);
export const validateNodeTotalsQuery = compileSchema(nodeTotalsQuerySchema);
export const validateDashboardQuery = compileSchema(dashboardQuerySchema);
export const validateBotUsageQuery = compileSchema(botUsageQuerySchema);
export const validateBotOutcomeQuery = compileSchema(botOutcomeQuerySchema);
export const validateAdvertReportQuery = compileSchema(advertReportQuerySchema);
export const validateProcessHistoryQuery = compileSchema(processHistoryQuerySchema);
export const validateProcessSamplesQuery = compileSchema(processSamplesQuerySchema);
export const validateRuntimeEventsQuery = compileSchema(runtimeEventsQuerySchema);
export const validateTelemetryObservationsQuery = compileSchema(telemetryObservationsQuerySchema);
export const validateTelemetryOutcomesQuery = compileSchema(telemetryOutcomesQuerySchema);
export const validateTelemetryDiagnosticsQuery = compileSchema(telemetryDiagnosticsQuerySchema);
export const validateTopologyPathsQuery = compileSchema(topologyPathsQuerySchema);
export const validateTopologyPathQuery = compileSchema(topologyPathQuerySchema);
export const validateTopologyDetailsQuery = compileSchema(topologyDetailsQuerySchema);
export const validateTopologyProximityQuery = compileSchema(topologyProximityQuerySchema);

// GET /api/nodes: the node ("!lookup" repeater registry) search/browse
// table - not range-aware (it's current state, not history - see
// MetricsStore#queryNodes), so it has none of the range/oneOf machinery
// above. `type` is optional and, when given, must be one of the values
// meshcore.js's Advert class can actually produce (see advert.js's
// ADV_TYPE_* constants and getTypeString()).
export const nodesListQuerySchema = {
  $id: 'meshcore-observer/web/nodes-list-query',
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 128 },
    type: { enum: ['NONE', 'CHAT', 'REPEATER', 'ROOM', 'SENSOR'] },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: { type: 'integer', minimum: 0 }
  }
};
export const validateNodesListQuery = compileSchema(nodesListQuerySchema);

const NODES_LIST_NUMERIC_FIELDS = new Set(['limit', 'offset']);

/**
 * Parses a URLSearchParams into GET /api/nodes' candidate query object -
 * same shape/first-value-wins/unrecognized-key-passthrough conventions as
 * parseRangeQuery() above, just against this endpoint's own field set.
 *
 * @param {URLSearchParams} searchParams
 * @returns {{q?: string, type?: string, limit?: number, offset?: number, [key: string]: unknown}}
 */
export function parseNodesListQuery(searchParams) {
  const query = {};
  for (const [key, value] of searchParams.entries()) {
    if (key in query) {
      continue;
    }
    query[key] = NODES_LIST_NUMERIC_FIELDS.has(key) ? Number(value) : value;
  }
  return query;
}

// The only fields either schema above ever expects as a number - every
// other key (including one AJV's additionalProperties: false is about to
// reject) is carried through as a plain string.
const NUMERIC_FIELDS = new Set([
  'start', 'end', 'maxBuckets', 'limit', 'offset', 'pathId', 'now', 'windowMs', 'radius'
]);

/**
 * Parses a URLSearchParams into the plain candidate object the schemas
 * above validate. Every parameter present is carried into the candidate
 * object - not just the ones these schemas happen to recognize - so an
 * unrecognized one (e.g. a typo'd `?range=24h&typo=1`) reaches AJV and is
 * rejected by `additionalProperties: false`, rather than being silently
 * dropped before validation ever sees it. Query params always arrive as
 * strings, so the known numeric fields are converted first; an
 * unparseable numeric value becomes NaN, which the schemas' `integer`
 * type keyword rejects on its own (no special casing needed here).
 *
 * A repeated key (`?range=24h&range=1h`) keeps only its first value,
 * matching `URLSearchParams#get()`'s own first-value-wins convention -
 * later occurrences of an already-seen key are ignored.
 *
 * @param {URLSearchParams} searchParams
 * @returns {{range?: string, start?: number, end?: number, maxBuckets?: number, [key: string]: unknown}}
 */
export function parseRangeQuery(searchParams) {
  const query = {};
  for (const [key, value] of searchParams.entries()) {
    if (key in query) {
      continue;
    }
    query[key] = NUMERIC_FIELDS.has(key) ? Number(value) : value;
  }
  return query;
}
