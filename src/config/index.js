import { existsSync } from 'node:fs';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { configSchema } from './schema.js';
import { loadBotsConfig } from '../bots/bots-config-loader.js';
import { loadBrokersConfig } from '../mqtt/brokers-config-loader.js';
import { REMOTE_REQUEST_DEFAULTS, REMOTE_REQUEST_ENV_KEYS, remoteRequestEnvSchema } from '../radio/remote-coordinator-schemas.js';
import { REGION_ANSWER_FRESHNESS_DEFAULT_HOURS, REGION_ANSWER_FRESHNESS_ENV_KEY, regionEnvSchema } from '../regions/region-schemas.js';
import { REGION_QUERY_DEFAULTS, REGION_QUERY_ENABLED_ENV_KEY, REGION_QUERY_NUMERIC_SETTINGS,
  regionQueryEnvSchema, regionQueryConfigSchema } from '../regions/region-query-schemas.js';
import { assertRegionQueryInput } from '../regions/region-query-validation.js';
import { TELEMETRY_FRESHNESS_DEFAULT_HOURS, TELEMETRY_FRESHNESS_ENV_KEY, telemetryEnvSchema } from '../telemetry/telemetry-schemas.js';
import { TELEMETRY_POLL_DEFAULTS, TELEMETRY_POLL_NUMERIC_SETTINGS, TELEMETRY_POLL_ENABLED_ENV_KEY,
  TELEMETRY_POLL_CONFIG_ENV_KEY, TELEMETRY_POLL_SECRETS_ENV_KEY, telemetryPollEnvSchema } from '../telemetry/polling-schemas.js';
import { loadTelemetryPolling, TelemetryPollingConfigError } from '../telemetry/polling-config.js';

const DEFAULT_BOTS_CONFIG_FILE = 'bots.config.json';
const DEFAULT_BROKERS_CONFIG_FILE = 'brokers.config.json';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const validate = compileSchema(configSchema);
const remoteEnvValid = compileSchema(remoteRequestEnvSchema);
const regionEnvValid = compileSchema(regionEnvSchema);
const regionQueryEnvValid = compileSchema(regionQueryEnvSchema);
const telemetryEnvValid = compileSchema(telemetryEnvSchema);
const telemetryPollEnvValid = compileSchema(telemetryPollEnvSchema);

function readString(env, key, fallback = null) {
  const value = env[key];
  if (value === undefined || value === '') {
    return fallback;
  }
  return value;
}

function readBoolean(env, key, fallback) {
  const value = env[key];
  if (value === undefined || value === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new ConfigError(`${key} must be "true" or "false", got "${value}"`);
}

const INTEGER_PATTERN = /^-?\d+$/;

function readInteger(env, key, fallback) {
  const value = env[key];
  if (value === undefined || value === '') {
    return fallback;
  }
  const trimmed = value.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    throw new ConfigError(`${key} must be an integer, got "${value}"`);
  }
  return Number.parseInt(trimmed, 10);
}

function readList(env, key, fallback = []) {
  const value = env[key];
  if (value === undefined || value === '') {
    return fallback;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readRadio(env) {
  const type = readString(env, 'PACKETCAPTURE_CONNECTION_TYPE', 'serial');
  return {
    type,
    serialPorts: readList(env, 'PACKETCAPTURE_SERIAL_PORTS'),
    tcpHost: readString(env, 'PACKETCAPTURE_TCP_HOST'),
    tcpPort: readInteger(env, 'PACKETCAPTURE_TCP_PORT', null),
    reconnect: {
      maxRetries: readInteger(env, 'PACKETCAPTURE_MAX_CONNECTION_RETRIES', 0),
      initialDelayMs: readInteger(env, 'PACKETCAPTURE_CONNECTION_RETRY_DELAY', 3000),
      maxDelayMs: readInteger(env, 'PACKETCAPTURE_CONNECTION_RETRY_DELAY_MAX', 15000)
    }
  };
}

function readObserver(env) {
  return {
    iata: readString(env, 'PACKETCAPTURE_IATA'),
    ownerEmail: readString(env, 'PACKETCAPTURE_OWNER_EMAIL')
  };
}

function readLogging(env) {
  return {
    level: readString(env, 'PACKETCAPTURE_LOG_LEVEL', 'info')
  };
}

// Shared by every configured bot - congestion is a shared-airtime
// concern, not a per-bot behavioral choice (see reply-queue.js). GRP_TXT
// channel replies carry no protocol ACK to retry against (see
// docs.meshcore.io/companion_protocol - only direct messages get a
// SendConfirmed push), so quietMs isn't about guaranteeing delivery: it
// lets a *triggering* message's own flood propagation settle on nearby
// repeaters before this reply adds new channel traffic. Default (5s)
// reflects field testing on a real MeshCore mesh. ttlMs bounds how long
// a reply waits for a quiet window before being dropped unsent - see
// README's "Channel bots" section for the full rationale and the
// companion repeater-side tx_delay/rx_delay recommendation.
function readBotReplyQueue(env) {
  return {
    quietMs: readInteger(env, 'PACKETCAPTURE_BOT_REPLY_QUIET_MS', 5000),
    ttlMs: readInteger(env, 'PACKETCAPTURE_BOT_REPLY_TTL_MS', 60000),
    // How long a bot waits, after sending a reply, to hear that exact
    // plaintext echoed back on the same channel (necessarily a rebroadcast
    // by another node - see channel-bot.js's #checkForRepeat) before giving
    // up and counting it unconfirmed. GRP_TXT has no protocol ACK to wait on
    // instead (same reason quietMs exists above). Zero means the entry expires
    // immediately; the next tracker sweep or operation counts it unconfirmed.
    repeatCheckTimeoutMs: readInteger(env, 'PACKETCAPTURE_BOT_REPLY_REPEAT_CHECK_MS', 10000)
  };
}

function readFloodAdvert(env) {
  return { intervalHours: readInteger(env, 'PACKETCAPTURE_FLOOD_ADVERT_INTERVAL_HOURS', 47) };
}

function readRemoteRequests(env) {
  const raw = Object.fromEntries(Object.values(REMOTE_REQUEST_ENV_KEYS)
    .filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  if (!remoteEnvValid(raw)) throw new ConfigError(`Invalid remote request environment: ${formatErrors(remoteEnvValid.errors)}`);
  return Object.fromEntries(Object.entries(REMOTE_REQUEST_ENV_KEYS).map(([field, key]) =>
    [field, raw[key] === undefined ? REMOTE_REQUEST_DEFAULTS[field] : Number.parseInt(raw[key].trim(), 10)]));
}

function readNodeObservations(env) {
  const key = 'PACKETCAPTURE_DIRECT_HEARD_WINDOW_HOURS';
  if (env[key] === '') throw new ConfigError(`${key} must be a positive whole number of hours`);
  const pruneKey = 'PACKETCAPTURE_REPEATER_FINGERPRINT_PRUNE_AFTER_DAYS';
  if (env[pruneKey] === '') throw new ConfigError(`${pruneKey} must be a whole number of days (0 disables pruning)`);
  return {
    directHeardWindowMs: readInteger(env, key, 72) * 3600000,
    repeaterFingerprintPruneAfterDays: readInteger(env, pruneKey, 0)
  };
}

function readMetricsUi(env) {
  const eventBudgetKey = 'PACKETCAPTURE_RUNTIME_EVENT_MAX_PER_MINUTE';
  if (env[eventBudgetKey] === '') throw new ConfigError(`${eventBudgetKey} must be a whole number from 1 to 600`);
  return {
    enabled: readBoolean(env, 'PACKETCAPTURE_METRICS_UI_ENABLED', false),
    host: readString(env, 'PACKETCAPTURE_METRICS_UI_HOST', '127.0.0.1'),
    port: readInteger(env, 'PACKETCAPTURE_METRICS_UI_PORT', 8090),
    sampleIntervalMs: readInteger(env, 'PACKETCAPTURE_METRICS_UI_SAMPLE_INTERVAL_MS', 10000),
    dbPath: readString(env, 'PACKETCAPTURE_METRICS_UI_DB_PATH', 'data/metrics.sqlite3'),
    // 0 = keep persisted metrics samples/bot-command events forever.
    retentionDays: readInteger(env, 'PACKETCAPTURE_METRICS_UI_RETENTION_DAYS', 0),
    maxChartBuckets: readInteger(env, 'PACKETCAPTURE_METRICS_UI_MAX_CHART_BUCKETS', 180),
    runtimeEventMaxPerMinute: readInteger(env, eventBudgetKey, 60)
  };
}

function readTopology(env) {
  const keys = ['PACKETCAPTURE_TOPOLOGY_FRESHNESS_HOURS', 'PACKETCAPTURE_TOPOLOGY_MAX_OBSERVATIONS_PER_MINUTE',
    'PACKETCAPTURE_TOPOLOGY_PRUNE_AFTER_DAYS'];
  for (const key of keys) if (env[key] === '') throw new ConfigError(`${key} must be a whole number; omit it to use the default`);
  return { freshnessWindowMs: readInteger(env, keys[0], 72) * 3600000,
    maxObservationsPerMinute: readInteger(env, keys[1], 600), pruneAfterDays: readInteger(env, keys[2], 0) };
}

function readTelemetry(env) {
  const key = TELEMETRY_FRESHNESS_ENV_KEY;
  const raw = env[key] === undefined ? {} : { [key]: env[key] };
  if (!telemetryEnvValid(raw)) throw new ConfigError(`Invalid telemetry environment: ${formatErrors(telemetryEnvValid.errors)}`);
  const hours = raw[key] === undefined ? TELEMETRY_FRESHNESS_DEFAULT_HOURS : Number(raw[key].trim());
  if (!Number.isInteger(hours) || hours < 1 || hours > 8760) {
    throw new ConfigError(`${key} must be whole hours from 1 to 8760`);
  }
  return { freshnessWindowMs: hours * 3600000 };
}

function readTelemetryPolling(env) {
  const keys = [TELEMETRY_POLL_ENABLED_ENV_KEY, TELEMETRY_POLL_CONFIG_ENV_KEY, TELEMETRY_POLL_SECRETS_ENV_KEY,
    ...TELEMETRY_POLL_NUMERIC_SETTINGS.map(setting => setting.key)];
  const raw = Object.fromEntries(keys.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  // Do not echo supplied strings, paths, reference names or AJV instance paths.
  if (!telemetryPollEnvValid(raw)) throw new ConfigError('Invalid telemetry polling environment: use true/false, whole numbers and nonempty file paths; omit optional values to use defaults');
  const settings = { ...TELEMETRY_POLL_DEFAULTS };
  if (raw[TELEMETRY_POLL_ENABLED_ENV_KEY] !== undefined) settings.enabled = raw[TELEMETRY_POLL_ENABLED_ENV_KEY].trim().toLowerCase() === 'true';
  for (const { field, key, scale } of TELEMETRY_POLL_NUMERIC_SETTINGS) {
    if (raw[key] !== undefined) settings[field] = Number(raw[key].trim()) * scale;
  }
  try {
    return loadTelemetryPolling({ settings, policyPath: raw[TELEMETRY_POLL_CONFIG_ENV_KEY] ?? null,
      secretsPath: raw[TELEMETRY_POLL_SECRETS_ENV_KEY] ?? null });
  } catch (error) {
    throw new ConfigError(error instanceof TelemetryPollingConfigError ? error.message : 'Invalid telemetry polling startup configuration');
  }
}

function readRegions(env) {
  const key = REGION_ANSWER_FRESHNESS_ENV_KEY;
  const raw = env[key] === undefined ? {} : { [key]: env[key] };
  if (!regionEnvValid(raw)) throw new ConfigError(`Invalid region environment: ${formatErrors(regionEnvValid.errors)}`);
  const queryKeys = [REGION_QUERY_ENABLED_ENV_KEY,...REGION_QUERY_NUMERIC_SETTINGS.map(setting => setting.key)];
  const queryRaw = Object.fromEntries(queryKeys.filter(key => env[key] !== undefined).map(key => [key,env[key]]));
  if (!regionQueryEnvValid(queryRaw)) throw new ConfigError(`Invalid region discovery environment: ${formatErrors(regionQueryEnvValid.errors)}`);
  const regions = { ...REGION_QUERY_DEFAULTS,
    answerFreshnessWindowMs: (raw[key] === undefined ? REGION_ANSWER_FRESHNESS_DEFAULT_HOURS
      : Number.parseInt(raw[key].trim(), 10)) * 3600000 };
  if (queryRaw[REGION_QUERY_ENABLED_ENV_KEY] !== undefined) {
    regions.discoveryEnabled = queryRaw[REGION_QUERY_ENABLED_ENV_KEY].trim().toLowerCase() === 'true';
  }
  for (const { field,key,scale } of REGION_QUERY_NUMERIC_SETTINGS) {
    if (queryRaw[key] !== undefined) regions[field] = Number.parseInt(queryRaw[key].trim(),10) * scale;
  }
  try { assertRegionQueryInput(regionQueryConfigSchema,regions); }
  catch { throw new ConfigError('Invalid region discovery configuration: check numeric bounds and ensure retry maximum is at least retry base'); }
  return regions;
}

/**
 * Brokers are configured via a JSON file (an array of independent broker
 * definitions), the same pattern as readBots() below, rather than flat env
 * vars - one broker's worth of connection settings doesn't fit one KEY=VALUE
 * pair per field any better than a bot's commands do.
 * PACKETCAPTURE_BROKERS_CONFIG_FILE points at it; if unset, the default path
 * is only optional - a missing default file just means no brokers are
 * configured, but an explicitly configured path that doesn't exist is a
 * startup error.
 *
 * The one field never stored in that file is a password-auth broker's
 * password. A broker may name its password variable with auth.passwordEnv;
 * otherwise the legacy PACKETCAPTURE_MQTT<n>_PASSWORD lookup uses its
 * 1-based position in the array. The selector itself is removed before the
 * normalized runtime configuration is returned.
 */
function readBrokers(env) {
  const configuredPath = readString(env, 'PACKETCAPTURE_BROKERS_CONFIG_FILE');
  const path = configuredPath ?? DEFAULT_BROKERS_CONFIG_FILE;

  if (configuredPath && !existsSync(path)) {
    throw new ConfigError(`PACKETCAPTURE_BROKERS_CONFIG_FILE is set to "${path}", but that file does not exist`);
  }

  let brokers;
  try {
    brokers = loadBrokersConfig(path);
  } catch (err) {
    // Unified into ConfigError so every loadConfig() caller only has one
    // error type to handle, regardless of whether a problem came from an
    // env var or the brokers config file.
    throw new ConfigError(err.message);
  }

  return brokers.map((broker, index) => {
    if (broker.auth.method !== 'password') {
      return broker;
    }
    const number = index + 1;
    const { passwordEnv, ...auth } = broker.auth;
    const passwordKey = passwordEnv ?? `PACKETCAPTURE_MQTT${number}_PASSWORD`;
    const password = readString(env, passwordKey);
    if (password === null) {
      const context = passwordEnv ? `named variable ${passwordKey}` : `position ${number} variable ${passwordKey}`;
      throw new ConfigError(`Broker "${broker.id}" uses password auth, but ${context} is not set or is empty`);
    }
    return { ...broker, auth: { ...auth, password } };
  });
}

/**
 * Channel bots are configured via a JSON file (an array of independent bot
 * definitions - name, channel, minHops, and their own trigger -> response
 * template commands) rather than flat env vars, since that shape doesn't
 * fit one bot's worth of KEY=VALUE pairs. PACKETCAPTURE_BOTS_CONFIG_FILE
 * points at it; if unset, the default path is only optional - a missing
 * default file just means no bots are configured, but an explicitly
 * configured path that doesn't exist is a startup error.
 */
function readBots(env) {
  const configuredPath = readString(env, 'PACKETCAPTURE_BOTS_CONFIG_FILE');
  const path = configuredPath ?? DEFAULT_BOTS_CONFIG_FILE;

  if (configuredPath && !existsSync(path)) {
    throw new ConfigError(`PACKETCAPTURE_BOTS_CONFIG_FILE is set to "${path}", but that file does not exist`);
  }

  try {
    return loadBotsConfig(path);
  } catch (err) {
    // Unified into ConfigError so every loadConfig() caller only has one
    // error type to handle, regardless of whether a problem came from an
    // env var or the bots config file.
    throw new ConfigError(err.message);
  }
}

/**
 * Builds and validates the application's normalized internal configuration
 * object from environment variables. This is the only module permitted to
 * read process.env; every other module receives configuration as arguments.
 *
 * @param {NodeJS.ProcessEnv} [env] defaults to process.env; overridable for tests.
 * @returns {object} the normalized, AJV-validated configuration object.
 * @throws {ConfigError} if required values are missing or malformed.
 */
export function loadConfig(env = process.env) {
  const config = {
    radio: readRadio(env),
    observer: readObserver(env),
    logging: readLogging(env),
    brokers: readBrokers(env),
    bots: readBots(env),
    metricsUi: readMetricsUi(env),
    botReplyQueue: readBotReplyQueue(env),
    floodAdvert: readFloodAdvert(env),
    nodeObservations: readNodeObservations(env),
    topology: readTopology(env),
    telemetry: readTelemetry(env),
    telemetryPolling: readTelemetryPolling(env),
    regions: readRegions(env),
    remoteRequests: readRemoteRequests(env)
  };

  if (config.radio.type === 'serial' && config.radio.serialPorts.length === 0) {
    throw new ConfigError(
      'PACKETCAPTURE_SERIAL_PORTS must list at least one port when PACKETCAPTURE_CONNECTION_TYPE=serial'
    );
  }

  if (config.radio.type === 'tcp' && (!config.radio.tcpHost || !config.radio.tcpPort)) {
    throw new ConfigError(
      'PACKETCAPTURE_TCP_HOST and PACKETCAPTURE_TCP_PORT are required when PACKETCAPTURE_CONNECTION_TYPE=tcp'
    );
  }

  if (!config.observer.iata) {
    throw new ConfigError('PACKETCAPTURE_IATA is required');
  }

  if (config.botReplyQueue.ttlMs < config.botReplyQueue.quietMs) {
    throw new ConfigError(
      'PACKETCAPTURE_BOT_REPLY_TTL_MS must be greater than or equal to PACKETCAPTURE_BOT_REPLY_QUIET_MS ' +
        '(otherwise a queued reply would always expire before a quiet window could ever be observed)'
    );
  }

  if (!validate(config)) {
    throw new ConfigError(`Invalid configuration: ${formatErrors(validate.errors)}`);
  }

  return config;
}
