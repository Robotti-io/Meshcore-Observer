// Polling startup contracts are separate from stored measurement freshness.
// No password, reference, group identifier or filesystem path is part of the
// public normalized configuration passed to ordinary application modules.
export const TELEMETRY_POLL_ENABLED_ENV_KEY = 'PACKETCAPTURE_TELEMETRY_POLL_ENABLED';
export const TELEMETRY_POLL_CONFIG_ENV_KEY = 'PACKETCAPTURE_TELEMETRY_POLL_CONFIG_FILE';
export const TELEMETRY_POLL_SECRETS_ENV_KEY = 'PACKETCAPTURE_TELEMETRY_POLL_SECRETS_FILE';
export const TELEMETRY_POLL_FILE_MAX_BYTES = 64 * 1024;
export const TELEMETRY_POLL_MAX_TARGETS = 256;
export const TELEMETRY_POLL_MAX_GROUPS = 16;
export const TELEMETRY_POLL_MAX_SECRETS = 32;

export const TELEMETRY_POLL_DEFAULTS = Object.freeze({
  enabled: false, radius: 2, evidenceWindowMs: 72 * 3600000,
  refreshIntervalMs: 24 * 3600000, startupDelayMs: 75000, tickIntervalMs: 10000,
  preflightTimeoutMs: 5000, sessionTtlMs: 10 * 60000,
  retryBaseMs: 15 * 60000, retryMaxMs: 360 * 60000, maxAttempts: 3,
  authCooldownMs: 24 * 3600000
});
export const TELEMETRY_POLL_NUMERIC_SETTINGS = Object.freeze([
  ['radius', 'RADIUS', 1, 1, 63],
  ['evidenceWindowMs', 'EVIDENCE_HOURS', 3600000, 1, 8760],
  ['refreshIntervalMs', 'INTERVAL_HOURS', 3600000, 1, 8760],
  ['startupDelayMs', 'STARTUP_DELAY_SECONDS', 1000, 1, 3600],
  ['tickIntervalMs', 'TICK_SECONDS', 1000, 1, 60],
  ['preflightTimeoutMs', 'PREFLIGHT_SECONDS', 1000, 1, 30],
  ['sessionTtlMs', 'SESSION_MINUTES', 60000, 1, 60],
  ['retryBaseMs', 'RETRY_BASE_MINUTES', 60000, 1, 10080],
  ['retryMaxMs', 'RETRY_MAX_MINUTES', 60000, 1, 10080],
  ['maxAttempts', 'MAX_ATTEMPTS', 1, 1, 10],
  ['authCooldownMs', 'AUTH_COOLDOWN_HOURS', 3600000, 1, 8760]
].map(([field, suffix, scale, min, max]) => Object.freeze({
  field, key: `PACKETCAPTURE_TELEMETRY_POLL_${suffix}`, scale, min, max
})));

const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const object = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const publicKey = { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9A-F]{64}$' };
const reference = { type: 'string', minLength: 1, maxLength: 32, pattern: '^[A-Za-z][A-Za-z0-9_-]*$' };
const path = { type: 'string', minLength: 1, maxLength: 4096, pattern: '^(?!\\s*$)[^\\u0000-\\u001F\\u007F]+$' };
const settingsProperties = { enabled: { type: 'boolean' },
  ...Object.fromEntries(TELEMETRY_POLL_NUMERIC_SETTINGS.map(({ field, scale, min, max }) =>
    [field, { ...integer(min * scale, max * scale), multipleOf: scale }])) };

export const telemetryPollEnvSchema = object({
  [TELEMETRY_POLL_ENABLED_ENV_KEY]: { type: 'string', minLength: 1, maxLength: 32,
    pattern: '^\\s*(?:[Tt][Rr][Uu][Ee]|[Ff][Aa][Ll][Ss][Ee])\\s*$' },
  [TELEMETRY_POLL_CONFIG_ENV_KEY]: path,
  [TELEMETRY_POLL_SECRETS_ENV_KEY]: path,
  ...Object.fromEntries(TELEMETRY_POLL_NUMERIC_SETTINGS.map(({ key }) =>
    [key, { type: 'string', minLength: 1, maxLength: 32, pattern: '^\\s*\\d+\\s*$' }]))
}, []);
export const telemetryPollSettingsSchema = object(settingsProperties);
export const telemetryPollLoadSchema = object({ settings: telemetryPollSettingsSchema,
  policyPath: { anyOf: [path, { type: 'null' }] }, secretsPath: { anyOf: [path, { type: 'null' }] } });

const componentProperties = Object.fromEntries(['status', 'sensors', 'neighbours'].map(name => [name, { type: 'boolean' }]));
const components = object(componentProperties);
const statusProfile = object({ layout: { enum: ['common48', 'current56'] }, evidence: { enum: ['unknown', 'established'] } });
const verifiedStatusProfile = object({ layout: { enum: ['common48', 'current56'] }, evidence: { const: 'established' } });
const neighbourProperties = { version: { const: 0 }, count: integer(1, 3), offset: integer(0, 65535),
  orderBy: { enum: [0, 1, 2, 3] }, prefixLength: { const: 32 } };

export const TELEMETRY_POLL_COMPONENT_DEFAULTS = Object.freeze({ status: true, sensors: true, neighbours: true });
export const TELEMETRY_POLL_NEIGHBOUR_DEFAULTS = Object.freeze({ version: 0, count: 3, offset: 0, orderBy: 0, prefixLength: 32 });
export const TELEMETRY_POLL_STATUS_DEFAULT = Object.freeze({ layout: 'common48', evidence: 'unknown' });

// Policy references are accepted only in this private startup input schema.
export const telemetryPollPolicySchema = object({ version: { const: 1 }, defaultCredentialRef: reference,
  components: object(componentProperties, []), neighbours: object(neighbourProperties, []),
  targets: { type: 'array', maxItems: TELEMETRY_POLL_MAX_TARGETS, items: object({ targetPublicKey: publicKey,
    credentialRef: reference, statusProfile: verifiedStatusProfile, emitterProfile: { const: 'positive-channels' }
  }, ['targetPublicKey']) },
  groups: { type: 'array', maxItems: TELEMETRY_POLL_MAX_GROUPS, items: object({ id: reference,
    credentialRef: reference, targetPublicKeys: { type: 'array', minItems: 1,
      maxItems: TELEMETRY_POLL_MAX_TARGETS, uniqueItems: true, items: publicKey }
  }) }
}, ['version', 'defaultCredentialRef']);
export const telemetryPollSecretsSchema = object({ version: { const: 1 }, secrets: {
  type: 'object', minProperties: 1, maxProperties: TELEMETRY_POLL_MAX_SECRETS,
  propertyNames: reference, patternProperties: { '^[A-Za-z][A-Za-z0-9_-]{0,31}$': {
    type: 'string', minLength: 1, maxLength: 15,
    // With AJV's Unicode regex mode this rejects lone surrogates while allowing
    // valid astral characters. UTF-8 wire byte limits are checked after AJV.
    pattern: '^[^\\u0000-\\u001F\\u007F-\\u009F\\uD800-\\uDFFF]+$', not: { pattern: '^\\s+$' }
  } }, additionalProperties: false
} });

export const telemetryPollConfigSchema = object({ ...settingsProperties,
  components, neighbourParams: object(neighbourProperties), statusProfile,
  emitterProfile: { const: 'unknown' }, permissionMask: { const: 0 },
  targetProfiles: { type: 'array', maxItems: TELEMETRY_POLL_MAX_TARGETS, items: object({
    targetPublicKey: publicKey, statusProfile, emitterProfile: { enum: ['unknown', 'positive-channels'] }
  }) }
});
export const telemetryPollTargetSchema = object({ targetPublicKey: publicKey });
