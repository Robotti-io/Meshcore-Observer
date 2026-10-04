import { existsSync, readFileSync } from 'node:fs';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { brokersConfigSchema } from './schemas.js';

const validate = compileSchema(brokersConfigSchema);

export class BrokersConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrokersConfigError';
  }
}

function normalizeBroker(broker) {
  return {
    id: broker.id,
    enabled: broker.enabled,
    host: broker.host,
    port: broker.port,
    transport: broker.transport ?? 'tcp',
    tls: broker.tls ?? false,
    websocketPath: broker.websocketPath ?? null,
    keepalive: broker.keepalive ?? 60,
    qos: broker.qos ?? 0,
    retain: broker.retain ?? true,
    clientIdPrefix: broker.clientIdPrefix ?? 'meshcore-observer',
    auth: {
      method: broker.auth.method,
      username: broker.auth.username ?? null,
      // Never sourced from the JSON file - see readBrokers() in
      // src/config/index.js, which fills this in from passwordEnv or the
      // legacy PACKETCAPTURE_MQTT<number>_PASSWORD variable.
      password: null,
      ...(broker.auth.passwordEnv ? { passwordEnv: broker.auth.passwordEnv } : {}),
      audience: broker.auth.audience ?? null,
      tokenTtlSeconds: broker.auth.tokenTtlSeconds ?? null
    }
  };
}

/**
 * Loads, parses, and validates the MQTT brokers config file: a JSON array
 * of independent broker definitions. Returns an empty array (not an error)
 * if the file simply doesn't exist - callers that require the file to exist
 * (an explicitly configured path) should check that themselves before
 * calling this.
 *
 * A password-auth broker may name its secret environment variable with
 * auth.passwordEnv. If it does not, its 1-based array position is used by
 * src/config/index.js's readBrokers for the legacy variable name.
 *
 * File shape:
 * [
 *   {
 *     "id": "okimesh",
 *     "enabled": true,
 *     "host": "mqtt1.okimesh.org",
 *     "port": 1883,
 *     "auth": { "method": "none" }
 *   }
 * ]
 *
 * @throws {BrokersConfigError} if the file can't be read/parsed, fails
 * schema validation, has a duplicate broker id, or is missing a field
 * required by its auth method (a username for "password", an audience for
 * "token").
 */
export function loadBrokersConfig(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new BrokersConfigError(`Failed to read brokers config file "${filePath}": ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BrokersConfigError(`Brokers config file "${filePath}" is not valid JSON: ${err.message}`);
  }

  if (!validate(parsed)) {
    throw new BrokersConfigError(`Invalid brokers config file "${filePath}": ${formatErrors(validate.errors)}`);
  }

  const ids = new Set();
  for (const broker of parsed) {
    if (ids.has(broker.id)) {
      throw new BrokersConfigError(`Duplicate broker id "${broker.id}" in brokers config file "${filePath}"`);
    }
    ids.add(broker.id);

    if (broker.auth.method === 'password' && !broker.auth.username) {
      throw new BrokersConfigError(`Broker "${broker.id}" uses password auth but has no username configured`);
    }
    if (broker.auth.method === 'token' && !broker.auth.audience) {
      throw new BrokersConfigError(`Broker "${broker.id}" uses token auth but has no audience configured`);
    }
  }

  return parsed.map(normalizeBroker);
}
