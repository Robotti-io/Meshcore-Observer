// Validates the brokers config file's parsed JSON content (an array of
// independent MQTT broker definitions - see brokers-config-loader.js).
// Each broker may name its password secret variable in auth.passwordEnv.
// The 1-based array position remains the legacy fallback used by
// src/config/index.js's readBrokers; it is not itself a JSON field.
import { regionPublicationFileSchema } from './region-publication-schemas.js';
export const brokersConfigSchema = {
  $id: 'meshcore-observer/mqtt/brokers-config',
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'enabled', 'host', 'port', 'auth'],
    properties: {
      regionPublication: regionPublicationFileSchema,
      id: { type: 'string', minLength: 1 },
      enabled: { type: 'boolean' },
      host: { type: 'string', minLength: 1 },
      port: { type: 'integer', minimum: 1, maximum: 65535 },
      transport: { enum: ['tcp', 'wss'] },
      tls: { type: 'boolean' },
      websocketPath: { type: 'string', minLength: 1 },
      keepalive: { type: 'integer', minimum: 0 },
      qos: { enum: [0, 1, 2] },
      retain: { type: 'boolean' },
      clientIdPrefix: { type: 'string', minLength: 1 },
      auth: {
        type: 'object',
        additionalProperties: false,
        required: ['method'],
        allOf: [
          {
            if: {
              type: 'object',
              properties: { passwordEnv: { type: 'string' } },
              required: ['passwordEnv']
            },
            then: { properties: { method: { const: 'password' } } }
          }
        ],
        properties: {
          method: { enum: ['none', 'token', 'password'] },
          username: { type: 'string', minLength: 1 },
          audience: { type: 'string', minLength: 1 },
          tokenTtlSeconds: { type: 'integer', minimum: 1 },
          passwordEnv: { type: 'string', minLength: 1, pattern: '^[A-Z_][A-Z0-9_]*$' }
        }
      }
    }
  }
};
