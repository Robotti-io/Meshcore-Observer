// The shape of one channel bot definition - shared, by direct reference,
// with src/config/schema.js's `bots` property, so the two can never drift
// out of sync the way two hand-maintained copies could (see git history
// for the drift risk this used to carry). Reusing this object (rather than
// `botsConfigSchema` as a whole) avoids any $id collision on the shared
// AJV instance: this object has no `$id` of its own, only the array
// wrapper below does, and that wrapper is compiled standalone (see
// bots-config-loader.js) - never re-embedded inside another compiled
// schema.
export const botConfigSchema = {
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
};

// Validates the bots config file's parsed JSON content (an array of
// independent channel bot definitions - see bots-config-loader.js).
export const botsConfigSchema = {
  $id: 'meshcore-observer/bots/config',
  type: 'array',
  items: botConfigSchema
};
