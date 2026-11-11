import { configuredRegionScopesSchema } from '../regions/region-schemas.js';

// The shape of one channel bot definition - shared, by direct reference,
// with src/config/schema.js's `bots` property, so the two can never drift
// out of sync the way two hand-maintained copies could (see git history
// for the drift risk this used to carry). Reusing this object (rather than
// `botsConfigSchema` as a whole) avoids any $id collision on the shared
// AJV instance: this object has no `$id` of its own, only the array
// wrapper below does, and that wrapper is compiled standalone (see
// bots-config-loader.js) - never re-embedded inside another compiled
// schema.
// The four outcome-specific response templates a 'lookup'-kind command
// requires instead of the single `response` an 'exact' command uses - see
// docs/plans/feat-bot_command_to_lookup_repeater_name.md. Exported so
// bots-config-loader.js's post-schema check (which field combination is
// actually valid for a given `kind` - AJV strict mode can't express that
// conditional cleanly here, see the comment there) can reuse the same list
// rather than a second hand-copied one.
export const LOOKUP_RESPONSE_FIELDS = ['foundResponse', 'notFoundResponse', 'ambiguousResponse', 'invalidResponse'];

// The two templates a 'stats'-kind command requires - deliberately named
// apart from LOOKUP_RESPONSE_FIELDS's invalidResponse (a distinct name,
// not reused) so bots-config-loader.js's per-field forbid-lists for each
// kind never overlap. Exported for the same reason LOOKUP_RESPONSE_FIELDS
// is - one shared list, not a second hand-copied one.
export const STATS_RESPONSE_FIELDS = ['response', 'usageResponse'];

const semanticRegionNameSchema = configuredRegionScopesSchema.items;
const commandScopeSchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { enum: ['inherit','device-default','unscoped'] } } },
  { type: 'object', additionalProperties: false, required: ['mode','region'], properties: {
    mode: { const: 'region' }, region: semanticRegionNameSchema
  } }
] };
const commandFallbackSchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { enum: ['none','unscoped'] } } },
  { type: 'object', additionalProperties: false, required: ['mode','region'], properties: {
    mode: { const: 'region' }, region: semanticRegionNameSchema
  } }
] };

// Normalized output from decryptGroupText(). Sender may be null for a
// successfully-decrypted bot reply being checked for a mesh rebroadcast;
// ChannelBot requires a non-null sender before attempting command matching.
export const decryptedGroupTextSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['timestamp', 'flags', 'sender', 'text'],
  properties: {
    timestamp: { type: 'integer', minimum: 0, maximum: 4294967295 },
    flags: { type: 'integer', minimum: 0, maximum: 255 },
    sender: { anyOf: [{ type: 'string', minLength: 1, maxLength: 49 }, { type: 'null' }] },
    text: { type: 'string' }
  }
};

export const satisfactoryChannelResponseSchema = {
  $id: 'meshcore-observer/bots/satisfactory-channel-response',
  type: 'object',
  additionalProperties: false,
  required: ['channel', 'responseText', 'responseSender', 'observedAt', 'packetHash'],
  properties: {
    channel: { type: 'string', minLength: 1, maxLength: 128 },
    responseText: { type: 'string', maxLength: 512 },
    responseSender: { anyOf: [{ type: 'string', minLength: 1, maxLength: 49 }, { type: 'null' }] },
    observedAt: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    packetHash: { type: 'string', minLength: 1, maxLength: 128 }
  }
};

const commandProperties = {
  trigger: { type: 'string', minLength: 1 },
  requiresTarget: { type: 'boolean' },
  suppressIfAnswered: { type: 'boolean' },
  scope: commandScopeSchema,
  fallback: commandFallbackSchema,
  kind: { enum: ['exact', 'lookup', 'stats', 'discovery', 'hint'] },
  hint: { type: 'string', minLength: 1, maxLength: 160, pattern: '^[^\\u0000-\\u001F\\u007F]+$' },
  response: { type: 'string', minLength: 1 },
  overflowResponse: { type: 'string', minLength: 1 },
  foundResponse: { type: 'string', minLength: 1 },
  notFoundResponse: { type: 'string', minLength: 1 },
  ambiguousResponse: { type: 'string', minLength: 1 },
  invalidResponse: { type: 'string', minLength: 1 },
  usageResponse: { type: 'string', minLength: 1 }
};
const commandSchema = (properties) => ({
  type: 'object', additionalProperties: false, required: ['trigger'], properties
});

const channelBotConfigSchema = {
  type: 'object', additionalProperties: false,
  required: ['name', 'channel', 'enabled', 'minHops', 'commands'],
  properties: {
    name: { type: 'string', minLength: 1 },
    channel: { type: 'string', minLength: 1 },
    regionScope: {
      oneOf: [
        { type: 'string', minLength: 1, maxLength: 30,
          pattern: '^[^\\u0000-\\u001F\\u007F]+$',
          not: { anyOf: [{ pattern: '^\\s+$' }, { pattern: '^\\*?$|^\\$' }] } },
        { type: 'array', minItems: 1, maxItems: 256, uniqueItems: true, items: configuredRegionScopesSchema.items }
      ]
    },
    enabled: { type: 'boolean' },
    minHops: { type: 'integer', minimum: 0 },
    maxMessageBytes: { type: 'integer', minimum: 1 },
    type: { const: 'channel' },
    onboarding: {
      type: 'object', additionalProperties: false, required: ['advertiseMessage', 'dmMessage'],
      properties: {
        advertiseMessage: { type: 'string', minLength: 1, maxLength: 512 },
        dmMessage: { type: 'string', minLength: 1, maxLength: 512 },
        ambiguousMessage: { type: 'string', minLength: 1, maxLength: 512 }
      }
    },
    commands: { type: 'array', minItems: 1, items: commandSchema(commandProperties) }
  }
};

const directCommandProperties = Object.fromEntries(Object.entries(commandProperties)
  .filter(([name]) => !['requiresTarget', 'suppressIfAnswered', 'scope', 'fallback', 'hint'].includes(name)));
directCommandProperties.kind = { enum: ['exact', 'lookup', 'stats'] };
const directChallengeQuestionSchema = {
  type: 'object', additionalProperties: false, required: ['prompt', 'answers'],
  properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 480 },
    answers: {
      type: 'array', minItems: 1, maxItems: 8, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 80 }
    }
  }
};
const directBotConfigSchema = {
  type: 'object', additionalProperties: false,
  required: ['name', 'type', 'enabled', 'welcomeMessage', 'commands'],
  properties: {
    name: { const: 'direct' },
    type: { const: 'direct' },
    enabled: { type: 'boolean' },
    welcomeMessage: { type: 'string', minLength: 1, maxLength: 160 },
    maxMessageBytes: { type: 'integer', minimum: 1, maximum: 512 },
    challenge: {
      type: 'object', additionalProperties: false, required: ['questions', 'incorrectResponse', 'completeResponse'],
      properties: {
        questions: { type: 'array', minItems: 1, maxItems: 64, items: directChallengeQuestionSchema },
        incorrectResponse: { type: 'string', minLength: 1, maxLength: 512 },
        completeResponse: { type: 'string', minLength: 1, maxLength: 512 }
      }
    },
    commands: { type: 'array', items: commandSchema(directCommandProperties) }
  }
};

export const botConfigSchema = { oneOf: [channelBotConfigSchema, directBotConfigSchema] };

// Validates the bots config file's parsed JSON content (an array of
// independent channel bot definitions - see bots-config-loader.js).
export const botsConfigSchema = {
  $id: 'meshcore-observer/bots/config',
  type: 'array',
  items: botConfigSchema
};
