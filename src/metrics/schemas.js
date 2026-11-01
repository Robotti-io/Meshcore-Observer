const epochMs = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

const scopePolicySchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'device-default' } } },
  { type: 'object', additionalProperties: false, required: ['mode','region'], properties: {
    mode: { const: 'region' }, region: { type: 'string', minLength: 1, maxLength: 31, pattern: '^[^\\u0000-\\u001F\\u007F]+$' }
  } },
  { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'unscoped' } } }
] };
const fallbackPolicySchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'none' } } },
  { type: 'object', additionalProperties: false, required: ['mode','region'], properties: {
    mode: { const: 'region' }, region: { type: 'string', minLength: 1, maxLength: 31, pattern: '^[^\\u0000-\\u001F\\u007F]+$' }
  } },
  { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'unscoped' } } }
] };

export const botReplyDeliveryPolicySchema = {
  $id: 'meshcore-observer/metrics/bot-reply-delivery-policy',
  type: 'object', additionalProperties: false,
  required: ['version','transport','scope','fallback','maxAttempts'],
  properties: {
    version: { const: 1 }, transport: { enum: ['channel','private'] }, scope: scopePolicySchema,
    fallback: fallbackPolicySchema, maxAttempts: { enum: [1,2] }
  }
};

export const botReplyAcknowledgementSchema = {
  $id: 'meshcore-observer/metrics/bot-reply-acknowledgement',
  type: 'object', additionalProperties: false, required: ['id','status','occurredAt'],
  properties: { id: { type: 'integer', minimum: 1 }, status: { enum: ['acknowledged','timed-out'] }, occurredAt: epochMs }
};

export const botReplyResolutionSchema = {
  $id: 'meshcore-observer/metrics/bot-reply-resolution',
  type: 'object', additionalProperties: false, required: ['id','status','resolvedAt','queuedMs'],
  properties: {
    id: { type: 'integer', minimum: 1 }, status: { enum: ['sent','failed','expired','cancelled','suppressed','delivery-unknown'] },
    resolvedAt: epochMs, queuedMs: epochMs,
    reason: { enum: ['send-failed','expired-before-dispatch','satisfactory-response','process-restart','recipient-unavailable','scope-unavailable','unsupported-policy'] }
  }
};

export const botReplyDispatchClaimSchema = {
  $id: 'meshcore-observer/metrics/bot-reply-dispatch-claim',
  type: 'object', additionalProperties: false, required: ['id','dispatchStartedAt'],
  properties: { id: { type: 'integer', minimum: 1 }, dispatchStartedAt: epochMs }
};

export const botReplyRecoverySchema = {
  $id: 'meshcore-observer/metrics/bot-reply-recovery',
  type: 'object', additionalProperties: false, required: ['recoveredAt'],
  properties: { recoveredAt: epochMs }
};

export const botReplySuppressionCandidatesSchema = {
  $id: 'meshcore-observer/metrics/bot-reply-suppression-candidates',
  type: 'object', additionalProperties: false, required: ['channel','observedAt'],
  properties: { channel: { type: 'string', minLength: 1 }, observedAt: epochMs }
};

export const botReplySuppressionSchema = {
  $id: 'meshcore-observer/metrics/bot-reply-suppression',
  type: 'object', additionalProperties: false, required: ['id','resolvedAt'],
  properties: { id: { type: 'integer', minimum: 1 }, resolvedAt: epochMs }
};

export const botReplyLifecycleRangeSchema = {
  $id: 'meshcore-observer/metrics/bot-reply-lifecycle-range',
  type: 'object', additionalProperties: false, required: ['start','end'],
  properties: { start: epochMs, end: epochMs }
};

const filterProperties = {
  botName: { type: 'string', minLength: 1 },
  channel: { type: 'string', minLength: 1 },
  trigger: { type: 'string', minLength: 1 },
  sender: { type: 'string', minLength: 1 }
};

export const botUsageFiltersSchema = {
  $id: 'meshcore-observer/metrics/bot-usage-filters',
  type: 'object',
  additionalProperties: false,
  properties: filterProperties
};

export const botUsageRangeSchema = {
  $id: 'meshcore-observer/metrics/bot-usage-range',
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end'],
  properties: { ...filterProperties, start: epochMs, end: epochMs }
};

export const botUsagePageSchema = {
  $id: 'meshcore-observer/metrics/bot-usage-page',
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end', 'limit', 'offset'],
  properties: {
    ...filterProperties,
    start: epochMs,
    end: epochMs,
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
  }
};

// Evidence is either wholly absent or supplied by a producer that can
// establish reliable attribution. A valid DTO does not itself prove identity;
// today's channel-message producer has no such evidence and leaves it null.
export const botInteractionSchema = {
  $id: 'meshcore-observer/metrics/bot-interaction',
  type: 'object',
  additionalProperties: false,
  required: [
    'botName', 'channel', 'trigger', 'sender', 'hopCount', 'path', 'hash',
    'regionScope', 'handlerStateJson', 'enqueuedAt', 'expiresAt',
    'senderIdentifier', 'senderIdentifierKind', 'senderIdentifierSource','deliveryPolicy','recipientPublicKey'
  ],
  properties: {
    botName: { type: 'string', minLength: 1 },
    channel: { type: ['string', 'null'] },
    trigger: { type: 'string', minLength: 1 },
    sender: { type: ['string', 'null'] },
    hopCount: { type: 'integer', minimum: 0, maximum: 63 },
    path: { type: 'string' },
    hash: { type: 'string', minLength: 1 },
    regionScope: { type: ['string', 'null'], minLength: 1, maxLength: 31 },
    handlerStateJson: { type: 'string', minLength: 1 },
    enqueuedAt: epochMs,
    expiresAt: epochMs,
    senderIdentifier: { type: ['string', 'null'], minLength: 1, maxLength: 512 },
    senderIdentifierKind: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
    senderIdentifierSource: { type: ['string', 'null'], minLength: 1, maxLength: 128 },
    deliveryPolicy: botReplyDeliveryPolicySchema,
    recipientPublicKey: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[0-9A-F]{64}$' }] }
  },
  anyOf: [
    {
      type: 'object',
      properties: {
        senderIdentifier: { type: 'null' },
        senderIdentifierKind: { type: 'null' },
        senderIdentifierSource: { type: 'null' }
      }
    },
    {
      type: 'object',
      properties: {
        senderIdentifier: { type: 'string' },
        senderIdentifierKind: { type: 'string' },
        senderIdentifierSource: { type: 'string' }
      }
    }
  ]
};
