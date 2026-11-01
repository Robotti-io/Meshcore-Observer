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

export const botConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'channel', 'enabled', 'minHops', 'commands'],
  properties: {
    name: { type: 'string', minLength: 1 },
    channel: { type: 'string', minLength: 1 },
    // A string fixes every reply to one region. An array allows replies only
    // to commands scoped to one of those case-sensitive regions.
    regionScope: {
      oneOf: [
        {
          type: 'string',
          minLength: 1,
          maxLength: 30,
          pattern: '^[^\\u0000-\\u001F\\u007F]+$',
          not: { anyOf: [{ pattern: '^\\s+$' }, { pattern: '^\\*?$|^\\$' }] }
        },
        {
          type: 'array',
          minItems: 1,
          maxItems: 256,
          uniqueItems: true,
          items: configuredRegionScopesSchema.items
        }
      ]
    },
    enabled: { type: 'boolean' },
    minHops: { type: 'integer', minimum: 0 },
    maxMessageBytes: { type: 'integer', minimum: 1 },
    commands: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['trigger'],
        properties: {
          trigger: { type: 'string', minLength: 1 },
          // Opt-in only: when true, this command requires a leading
          // @[Companion name] selector matching the current radio identity.
          requiresTarget: { type: 'boolean' },
          // Opt-in only: exact commands with a sender-addressed response can
          // suppress a matching durable reply while it is still pending.
          suppressIfAnswered: { type: 'boolean' },
          // Omitted/inherit preserves bot-level and incoming-scope behavior.
          scope: commandScopeSchema,
          // Omitted fallback is none; explicit fallback stays within any
          // fixed bot scope or region allowlist.
          fallback: commandFallbackSchema,
          // Defaults to 'exact' (today's only behavior - a plain trigger
          // -> single response template). 'lookup' opts a command into
          // argument parsing (see channel-bot.js) and requires the four
          // outcome-specific templates below instead. 'stats' also opts
          // into argument parsing (a range token - see stats-range.js)
          // but only needs `response` (the success case) plus
          // `usageResponse` (missing/unrecognized range). Which fields are
          // actually required/forbidden per `kind` is enforced in
          // bots-config-loader.js, not here - AJV's strict mode (see
          // src/validation/ajv.js) can't express an if/kind-then-required
          // conditional without also duplicating every field's type
          // schema into each branch, which was worse than one plain JS
          // check.
          kind: { enum: ['exact', 'lookup', 'stats'] },
          response: { type: 'string', minLength: 1 },
          overflowResponse: { type: 'string', minLength: 1 },
          foundResponse: { type: 'string', minLength: 1 },
          notFoundResponse: { type: 'string', minLength: 1 },
          ambiguousResponse: { type: 'string', minLength: 1 },
          invalidResponse: { type: 'string', minLength: 1 },
          usageResponse: { type: 'string', minLength: 1 }
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
