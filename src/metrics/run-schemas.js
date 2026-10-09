const epochMs = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const state = { enum: ['running', 'clean', 'unclean'] };
const evidence = { runId: uuid, observedAt: epochMs, observedDurationMs: epochMs };

export const runStartSchema = {
  $id: 'meshcore-observer/metrics/run-start', type: 'object', additionalProperties: false,
  required: ['runId', 'startedAt', 'observedAt', 'observedDurationMs', 'appVersion', 'nodeVersion', 'platform', 'architecture'],
  properties: {
    ...evidence, startedAt: epochMs,
    appVersion: { type: 'string', minLength: 1, maxLength: 64 },
    nodeVersion: { type: 'string', minLength: 1, maxLength: 64 },
    platform: { type: 'string', minLength: 1, maxLength: 32 },
    architecture: { type: 'string', minLength: 1, maxLength: 32 }
  }
};
export const runCheckpointSchema = {
  $id: 'meshcore-observer/metrics/run-checkpoint', type: 'object', additionalProperties: false,
  required: ['runId', 'observedAt', 'observedDurationMs'], properties: evidence
};
export const runEndSchema = {
  $id: 'meshcore-observer/metrics/run-end', type: 'object', additionalProperties: false,
  required: ['runId', 'observedAt', 'observedDurationMs', 'reason'],
  properties: { ...evidence, reason: { enum: ['SIGINT', 'SIGTERM'] } }
};
export const runIdentitySchema = {
  $id: 'meshcore-observer/metrics/run-identity', type: 'object', additionalProperties: false,
  required: ['runId'], properties: { runId: uuid }
};
export const runPageSchema = {
  $id: 'meshcore-observer/metrics/run-page', type: 'object', additionalProperties: false,
  required: ['start', 'end', 'limit', 'offset'], properties: {
    start: epochMs, end: epochMs, state,
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
  }
};
