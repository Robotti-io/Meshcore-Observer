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

export const validateMetricsHistoryQuery = compileSchema(metricsHistoryQuerySchema);
export const validateRangeOnlyQuery = compileSchema(rangeOnlyQuerySchema);

// The only fields either schema above ever expects as a number - every
// other key (including one AJV's additionalProperties: false is about to
// reject) is carried through as a plain string.
const NUMERIC_FIELDS = new Set(['start', 'end', 'maxBuckets']);

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
