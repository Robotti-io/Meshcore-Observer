import { observerStatsSchema } from '../radio/observer-status-schemas.js';

export const observerStatusPublishOptionsSchema = {
  type: 'object', additionalProperties: false, required: ['retain', 'timeoutMs'],
  properties: { retain: { const: true }, timeoutMs: { type: 'integer', minimum: 1, maximum: 5000 } }
};

export const observerStatusPayloadSchema = {
  type: 'object', additionalProperties: false,
  required: ['status', 'timestamp', 'origin', 'origin_id', 'model', 'firmware_version', 'radio', 'client_version'],
  properties: {
    status: { enum: ['online', 'offline'] },
    timestamp: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' },
    origin: { type: 'string', maxLength: 256 },
    origin_id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[0-9A-F]+$' },
    model: { type: ['string', 'null'], maxLength: 256 },
    firmware_version: { type: ['string', 'null'], maxLength: 128 },
    radio: { type: ['string', 'null'], maxLength: 128 },
    client_version: { type: 'string', minLength: 1, maxLength: 128 },
    repeat: { type: 'boolean' }, stats: observerStatsSchema
  }
};
