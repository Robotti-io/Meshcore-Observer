const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nonnegative = { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullableCount = { ...count, type: ['integer', 'null'] };
const nullableNumber = { ...nonnegative, type: ['number', 'null'] };
const runId = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };

export const cpuReadingSchema = {
  type: 'object', additionalProperties: false, required: ['user', 'system'],
  properties: { user: count, system: count }
};
export const memoryReadingSchema = {
  type: 'object', additionalProperties: false, required: ['rss', 'heapTotal', 'heapUsed', 'external'],
  properties: { rss: count, heapTotal: count, heapUsed: count, external: count, arrayBuffers: count }
};
export const eventLoopReadingSchema = {
  type: 'object', additionalProperties: false, required: ['active', 'idle', 'utilization'],
  properties: { active: nonnegative, idle: nonnegative, utilization: { type: 'number', minimum: 0, maximum: 1 } }
};
export const monotonicReadingSchema = nonnegative;

const measurements = {
  intervalMs: { type: ['number', 'null'], exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  cpuUserUs: nullableCount, cpuSystemUs: nullableCount, cpuPercent: nullableNumber,
  rssBytes: nullableCount, heapTotalBytes: nullableCount, heapUsedBytes: nullableCount, externalBytes: nullableCount,
  eventLoopActiveMs: nullableNumber, eventLoopIdleMs: nullableNumber,
  eventLoopUtilization: { type: ['number', 'null'], minimum: 0, maximum: 1 }
};
const cpuFields = ['cpuUserUs', 'cpuSystemUs', 'cpuPercent'];
const loopFields = ['eventLoopActiveMs', 'eventLoopIdleMs', 'eventLoopUtilization'];
function availableGroup(fields) {
  return { anyOf: [
    { properties: Object.fromEntries(fields.map((key) => [key, { type: 'null' }])) },
    { properties: { intervalMs: { type: 'number', exclusiveMinimum: 0 },
      ...Object.fromEntries(fields.map((key) => [key, { type: 'number' }])) } }
  ] };
}
export const processMeasurementSchema = {
  $id: 'meshcore-observer/metrics/process-measurement',
  type: 'object', additionalProperties: false, required: Object.keys(measurements), properties: measurements,
  allOf: [availableGroup(cpuFields), availableGroup(loopFields)]
};
export const processSampleSchema = {
  $id: 'meshcore-observer/metrics/process-sample',
  type: 'object', additionalProperties: false,
  required: ['runId', 'sampleAt', 'suppressedEvents', 'failedEvents', ...Object.keys(measurements)],
  properties: { runId, sampleAt: count, suppressedEvents: count, failedEvents: count, ...measurements },
  allOf: [availableGroup(cpuFields), availableGroup(loopFields)]
};

export const RUNTIME_EVENT_KINDS = ['radio.connected', 'radio.disconnected', 'radio.connect-error', 'broker.state', 'bot.readiness'];
export const runtimeEventSchema = {
  $id: 'meshcore-observer/metrics/runtime-event',
  type: 'object', additionalProperties: false,
  required: ['runId', 'observedAt', 'kind', 'serviceId', 'state', 'precision', 'observationWindowMs'],
  properties: {
    runId, observedAt: count, kind: { enum: RUNTIME_EVENT_KINDS },
    serviceId: { type: ['string', 'null'], minLength: 1 },
    state: { enum: ['connected', 'disconnected', 'ready', 'not-ready', null] },
    precision: { enum: ['event', 'sample'] }, observationWindowMs: nullableNumber
  },
  oneOf: [
    ...['connected', 'disconnected'].map((state) => ({ properties: {
      kind: { const: `radio.${state}` }, serviceId: { type: 'null' }, state: { const: state },
      precision: { const: 'event' }, observationWindowMs: { type: 'null' }
    } })),
    { properties: { kind: { const: 'radio.connect-error' }, serviceId: { type: 'null' }, state: { type: 'null' },
      precision: { const: 'event' }, observationWindowMs: { type: 'null' } } },
    { properties: { kind: { const: 'broker.state' }, serviceId: { type: 'string' },
      state: { enum: ['connected', 'disconnected'] }, precision: { const: 'sample' }, observationWindowMs: nonnegative } },
    { properties: { kind: { const: 'bot.readiness' }, serviceId: { type: 'string' },
      state: { enum: ['ready', 'not-ready'] }, precision: { const: 'sample' }, observationWindowMs: nonnegative } }
  ]
};
export const readinessSnapshotSchema = {
  type: 'object', additionalProperties: false, required: ['brokers', 'bots'],
  properties: {
    brokers: { type: 'object', additionalProperties: { type: 'boolean' } },
    bots: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'enabled', 'ready'],
      properties: { name: { type: 'string', minLength: 1 }, enabled: { type: 'boolean' }, ready: { type: 'boolean' } } }
    }
  }
};
export const runtimeEventBudgetSchema = { type: 'integer', minimum: 1, maximum: 600 };
const range = { start: count, end: count, runId };
const page = { limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: count };
export const processPageSchema = {
  $id: 'meshcore-observer/metrics/process-page', type: 'object', additionalProperties: false,
  required: ['start', 'end', 'limit', 'offset'], properties: { ...range, ...page }
};
export const processHistorySchema = {
  $id: 'meshcore-observer/metrics/process-history', type: 'object', additionalProperties: false,
  required: ['start', 'end', 'maxBuckets', 'sampleIntervalMs'],
  properties: { ...range, maxBuckets: { type: 'integer', minimum: 1, maximum: 1000 },
    sampleIntervalMs: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }
};
export const runtimeEventPageSchema = {
  $id: 'meshcore-observer/metrics/runtime-event-page', type: 'object', additionalProperties: false,
  required: ['start', 'end', 'limit', 'offset'],
  properties: { ...range, ...page, kind: { enum: RUNTIME_EVENT_KINDS }, serviceId: { type: 'string', minLength: 1 } }
};
