const epochMs = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

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
    'handlerStateJson', 'enqueuedAt', 'expiresAt',
    'senderIdentifier', 'senderIdentifierKind', 'senderIdentifierSource'
  ],
  properties: {
    botName: { type: 'string', minLength: 1 },
    channel: { type: ['string', 'null'] },
    trigger: { type: 'string', minLength: 1 },
    sender: { type: ['string', 'null'] },
    hopCount: { type: 'integer', minimum: 0, maximum: 63 },
    path: { type: 'string' },
    hash: { type: 'string', minLength: 1 },
    handlerStateJson: { type: 'string', minLength: 1 },
    enqueuedAt: epochMs,
    expiresAt: epochMs,
    senderIdentifier: { type: ['string', 'null'], minLength: 1, maxLength: 512 },
    senderIdentifierKind: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
    senderIdentifierSource: { type: ['string', 'null'], minLength: 1, maxLength: 128 }
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
