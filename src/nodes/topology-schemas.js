const epoch = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const id = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const key = { type: 'string', pattern: '^[0-9A-F]{64}$' };
const runId = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const width = { enum: [1, 2, 3] };
const prefix = { type: 'string', pattern: '^([0-9A-F]{2}){1,3}$' };
const page = { limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: epoch };
function object(properties, required = Object.keys(properties), extra = {}) {
  return { type: 'object', additionalProperties: false, properties, required, ...extra };
}
const widthRules = [1, 2, 3].map((value) => ({
  if: { properties: { hashWidth: { const: value } }, required: ['hashWidth'] },
  then: { properties: {
    prefixes: { type: 'array', maxItems: Math.min(63, Math.floor(64 / value)),
      items: { type: 'string', pattern: `^[0-9A-F]{${value * 2}}$` } }
  } }
}));
export const topologyConfigSchema = object({
  freshnessWindowMs: { type: 'integer', minimum: 3600000, maximum: 8760 * 3600000, multipleOf: 3600000 },
  maxObservationsPerMinute: { type: 'integer', minimum: 1, maximum: 6000 },
  pruneAfterDays: { type: 'integer', minimum: 0, maximum: 36500 }
});
export const topologyFrameSchema = object({
  raw: { type: 'string', minLength: 4, maxLength: 510, pattern: '^([0-9A-Fa-f]{2})+$' },
  runId, observerPublicKey: key, receivedAt: epoch
});
export const topologyEvidenceSchema = object({
  runId, observerPublicKey: key, receivedAt: epoch, route: { enum: [0, 1, 2, 3] },
  kind: { enum: ['flood-traversed', 'direct-remaining'] }, payloadVersion: { const: 0 },
  hashWidth: width, prefixes: { type: 'array', minItems: 1, maxItems: 63, items: prefix },
  transportCodes: { anyOf: [{ type: 'null' }, { type: 'array', minItems: 2, maxItems: 2,
    items: { type: 'integer', minimum: 0, maximum: 65535 } }] },
  containsRepeatedPrefix: { type: 'boolean' }
}, undefined, { allOf: [...widthRules,
  { if: { properties: { route: { enum: [0, 1] } } }, then: { properties: { kind: { const: 'flood-traversed' } } },
    else: { properties: { kind: { const: 'direct-remaining' } } } },
  { if: { properties: { route: { enum: [0, 3] } } },
    then: { properties: { transportCodes: { type: 'array' } } },
    else: { properties: { transportCodes: { type: 'null' } } } }
] });
export const topologyCounters = Object.fromEntries(['accepted', 'suppressed', 'failed', 'malformed', 'unsupported', 'noRelay']
  .map((name) => [name, epoch]));
export const topologyCoverageSchema = object({ runId, observerPublicKey: key, sampleAt: epoch, ...topologyCounters });
export const topologyPathPageSchema = object({ observerPublicKey: key, kind: topologyEvidenceSchema.properties.kind, ...page }, ['limit', 'offset']);
export const topologyPathIdentitySchema = object({ pathId: id });
export const topologyDetailPageSchema = object({ start: epoch, end: epoch, pathId: id, runId, ...page }, ['start', 'end', 'limit', 'offset']);
export const topologyPrefixPageSchema = object({ hashWidth: width, prefix, ...page }, ['hashWidth', 'prefix', 'limit', 'offset']);
export const topologyProximitySchema = object({ observerPublicKey: key, now: epoch,
  windowMs: topologyConfigSchema.properties.freshnessWindowMs,
  radius: { type: 'integer', minimum: 0, maximum: 63 }, ...page });
export const topologyPruneSchema = object({ cutoffMs: epoch });
