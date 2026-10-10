import { REMOTE_FRAME_MAX_BYTES } from './remote-request-schemas.js';
import { regionQueryConfigSchema } from '../regions/region-query-schemas.js';

export const remotePreflightLimitsSchema = {
  type: 'object', additionalProperties: false, required: ['preflightTimeoutMs'],
  properties: { preflightTimeoutMs: regionQueryConfigSchema.properties.queryPreflightTimeoutMs }
};

export const REMOTE_REQUEST_DEFAULTS = Object.freeze({
  ackTimeoutMs: 5000, responseTimeoutMaxMs: 30000, minIntervalMs: 60000, maxPerMinute: 1
});

export const REMOTE_REQUEST_ENV_KEYS = Object.freeze({
  ackTimeoutMs: 'PACKETCAPTURE_REMOTE_REQUEST_ACK_TIMEOUT_MS',
  responseTimeoutMaxMs: 'PACKETCAPTURE_REMOTE_REQUEST_RESPONSE_TIMEOUT_MAX_MS',
  minIntervalMs: 'PACKETCAPTURE_REMOTE_REQUEST_MIN_INTERVAL_MS',
  maxPerMinute: 'PACKETCAPTURE_REMOTE_REQUEST_MAX_PER_MINUTE'
});

export const remoteRequestEnvSchema = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(Object.values(REMOTE_REQUEST_ENV_KEYS).map(key => [key,
    { type: 'string', minLength: 1, maxLength: 32, pattern: '^\\s*-?\\d+\\s*$' }]))
};

export const remoteRequestBudgetSchema = {
  type: 'object', additionalProperties: false, required: ['minIntervalMs', 'maxPerMinute'],
  properties: {
    minIntervalMs: { type: 'integer', minimum: 10000, maximum: 3600000 },
    maxPerMinute: { type: 'integer', minimum: 1, maximum: 6 }
  }
};

export const remoteCoordinatorLimitsSchema = {
  type: 'object', additionalProperties: false,
  required: ['ackTimeoutMs', 'responseTimeoutMaxMs', 'minIntervalMs', 'maxPerMinute'],
  properties: {
    ackTimeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 },
    responseTimeoutMaxMs: { type: 'integer', minimum: 1000, maximum: 120000 },
    ...remoteRequestBudgetSchema.properties
  }
};

export const remoteDispatchOptionsSchema = {
  type: 'object', additionalProperties: false,
  properties: { expectedRoute: { enum: ['direct', 'flood'] } }
};

// Only associate a malformed binary layout with a known tag. The full
// parser and future domain owner still validate the response body.
export const remoteBinaryHeaderSchema = {
  type: 'object', additionalProperties: false, required: ['bytes'],
  properties: { bytes: { type: 'array', minItems: 6, maxItems: REMOTE_FRAME_MAX_BYTES,
    items: { type: 'integer', minimum: 0, maximum: 255 } } }
};
