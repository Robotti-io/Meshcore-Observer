import { REMOTE_FRAME_MAX_BYTES } from './remote-request-schemas.js';

export const remoteCoordinatorLimitsSchema = {
  type: 'object', additionalProperties: false, required: ['ackTimeoutMs', 'responseTimeoutMaxMs'],
  properties: {
    ackTimeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 },
    responseTimeoutMaxMs: { type: 'integer', minimum: 1000, maximum: 120000 }
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
