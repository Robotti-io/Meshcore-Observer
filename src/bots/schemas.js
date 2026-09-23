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
        required: ['trigger'],
        properties: {
          trigger: { type: 'string', minLength: 1 },
          // Defaults to 'exact' (today's only behavior - a plain trigger
          // -> single response template). 'lookup' opts a command into
          // argument parsing (see channel-bot.js) and requires the four
          // outcome-specific templates below instead. Which fields are
          // actually required/forbidden per `kind` is enforced in
          // bots-config-loader.js, not here - AJV's strict mode (see
          // src/validation/ajv.js) can't express an if/kind-then-required
          // conditional without also duplicating every field's type
          // schema into each branch, which was worse than one plain JS
          // check.
          kind: { enum: ['exact', 'lookup'] },
          response: { type: 'string', minLength: 1 },
          overflowResponse: { type: 'string', minLength: 1 },
          foundResponse: { type: 'string', minLength: 1 },
          notFoundResponse: { type: 'string', minLength: 1 },
          ambiguousResponse: { type: 'string', minLength: 1 },
          invalidResponse: { type: 'string', minLength: 1 }
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
