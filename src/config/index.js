import { existsSync } from 'node:fs';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { configSchema } from './schema.js';
import { loadBotsConfig } from '../bots/bots-config-loader.js';

const MAX_BROKER_SLOTS = 9;
const DEFAULT_BOTS_CONFIG_FILE = 'bots.config.json';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const validate = compileSchema(configSchema);

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
  return value.trim().toLowerCase() === 'true';
}

function readInteger(env, key, fallback) {
  const value = env[key];
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new ConfigError(`${key} must be an integer, got "${value}"`);
  }
  return parsed;
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
    ttlMs: readInteger(env, 'PACKETCAPTURE_BOT_REPLY_TTL_MS', 60000)
  };
}

function readMetricsUi(env) {
  return {
    enabled: readBoolean(env, 'PACKETCAPTURE_METRICS_UI_ENABLED', false),
    host: readString(env, 'PACKETCAPTURE_METRICS_UI_HOST', '127.0.0.1'),
    port: readInteger(env, 'PACKETCAPTURE_METRICS_UI_PORT', 8090),
    sampleIntervalMs: readInteger(env, 'PACKETCAPTURE_METRICS_UI_SAMPLE_INTERVAL_MS', 10000),
    dbPath: readString(env, 'PACKETCAPTURE_METRICS_UI_DB_PATH', 'data/metrics.sqlite3'),
    // 0 = keep persisted metrics samples/bot-command events forever.
    retentionDays: readInteger(env, 'PACKETCAPTURE_METRICS_UI_RETENTION_DAYS', 0),
    maxChartBuckets: readInteger(env, 'PACKETCAPTURE_METRICS_UI_MAX_CHART_BUCKETS', 180)
  };
}

function isBrokerSlotConfigured(env, slot) {
  const prefix = `PACKETCAPTURE_MQTT${slot}_`;
  return Object.keys(env).some((key) => key.startsWith(prefix));
}

function readBrokerSlot(env, slot) {
  const prefix = `PACKETCAPTURE_MQTT${slot}_`;
  const key = (suffix) => `${prefix}${suffix}`;
  const method = readString(env, key('AUTH_METHOD'), 'none').toLowerCase();

  return {
    id: readString(env, key('ID'), `mqtt${slot}`),
    enabled: readBoolean(env, key('ENABLED'), false),
    host: readString(env, key('HOST')),
    port: readInteger(env, key('PORT'), null),
    transport: readString(env, key('TRANSPORT'), 'tcp'),
    tls: readBoolean(env, key('TLS'), false),
    websocketPath: readString(env, key('WEBSOCKET_PATH')),
    keepalive: readInteger(env, key('KEEPALIVE'), 60),
    qos: readInteger(env, key('QOS'), 0),
    retain: readBoolean(env, key('RETAIN'), true),
    clientIdPrefix: readString(env, key('CLIENT_ID_PREFIX'), 'meshcore-observer'),
    auth: {
      method,
      username: readString(env, key('USERNAME')),
      password: readString(env, key('PASSWORD')),
      audience: readString(env, key('TOKEN_AUDIENCE')),
      tokenTtlSeconds: readInteger(env, key('TOKEN_TTL'), null)
    }
  };
}

function readBrokers(env) {
  const brokers = [];
  for (let slot = 1; slot <= MAX_BROKER_SLOTS; slot += 1) {
    if (isBrokerSlotConfigured(env, slot)) {
      brokers.push(readBrokerSlot(env, slot));
    }
  }
  return brokers;
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
    botReplyQueue: readBotReplyQueue(env)
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

  for (const broker of config.brokers) {
    if (broker.enabled && !broker.host) {
      throw new ConfigError(`Broker "${broker.id}" is enabled but has no host configured`);
    }
    if (broker.enabled && !broker.port) {
      throw new ConfigError(`Broker "${broker.id}" is enabled but has no port configured`);
    }
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
