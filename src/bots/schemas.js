// Validates the bots config file's parsed JSON content (an array of
// independent channel bot definitions - see bots-config-loader.js).
export const botsConfigSchema = {
  $id: 'meshcore-observer/bots/config',
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'channel', 'enabled', 'minHops', 'commands'],
    properties: {
      name: { type: 'string', minLength: 1 },
      channel: { type: 'string', minLength: 1 },
      enabled: { type: 'boolean' },
      minHops: { type: 'integer', minimum: 0 },
      maxMessageBytes: { type: 'integer', minimum: 1 },
      commands: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['trigger', 'response'],
          properties: {
            trigger: { type: 'string', minLength: 1 },
            response: { type: 'string', minLength: 1 },
            overflowResponse: { type: 'string', minLength: 1 }
          }
        }
      }
    }
  }
};
