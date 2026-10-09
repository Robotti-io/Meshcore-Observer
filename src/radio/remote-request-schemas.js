// Pinned Companion BaseSerialInterface.h (a366955): application frames,
// excluding the serial/TCP frame-type and uint16 length header.
export const REMOTE_FRAME_MAX_BYTES = 176;
export const REMOTE_BODY_MAX_BYTES = REMOTE_FRAME_MAX_BYTES - 6;

const byte = { type: 'integer', minimum: 0, maximum: 255 };
const uint32 = { type: 'integer', minimum: 0, maximum: 0xFFFFFFFF };
const publicKey = { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9A-F]{64}$' };
const requestId = { type: 'string', minLength: 36, maxLength: 36,
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };

function object(properties) {
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) };
}

function bytes(minItems, maxItems = minItems) {
  return { type: 'array', minItems, maxItems, items: byte };
}

const operations = {
  status: object({}),
  telemetry: object({ permissionMask: byte }),
  neighbours: object({
    version: { const: 0 },
    count: { type: 'integer', minimum: 1, maximum: 255 },
    offset: { type: 'integer', minimum: 0, maximum: 65535 },
    orderBy: { enum: [0, 1, 2, 3] },
    prefixLength: { type: 'integer', minimum: 1, maximum: 32 }
  }),
  'anonymous-regions': object({})
};

export const remoteRequestSchema = {
  oneOf: Object.entries(operations).map(([operation, params]) => object({
    requestId, targetPublicKey: publicKey, operation: { const: operation }, params
  }))
};

// This four-byte uniqueness suffix is not an authentication secret or a
// correlation tag. The Companion supplies the tag in its Sent response.
export const remoteRequestUniquenessSchema = bytes(4);
export const remoteResponseFrameSchema = object({ bytes: bytes(1, REMOTE_FRAME_MAX_BYTES) });

export const REMOTE_ERROR_REASONS = Object.freeze({
  1: 'unsupported', 2: 'not-found', 3: 'table-full',
  4: 'bad-state', 5: 'file-io', 6: 'illegal-argument'
});

const errorEnvelopes = Object.entries(REMOTE_ERROR_REASONS).map(([errorCode, reason]) => object({
  kind: { const: 'error' }, errorCode: { const: Number(errorCode) }, reason: { const: reason }
}));
errorEnvelopes.push(object({ kind: { const: 'error' },
  errorCode: { ...byte, not: { enum: Object.keys(REMOTE_ERROR_REASONS).map(Number) } },
  reason: { const: 'unknown' }
}));

export const remoteResponseEnvelopeSchema = {
  oneOf: [
    object({ kind: { const: 'sent' }, route: { enum: ['direct', 'flood'] }, tag: uint32, estimatedTimeoutMs: uint32 }),
    object({ kind: { const: 'binary-response' }, tag: uint32, body: bytes(1, REMOTE_BODY_MAX_BYTES) }),
    ...errorEnvelopes
  ]
};
