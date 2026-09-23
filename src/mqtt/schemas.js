// Validates the brokers config file's parsed JSON content (an array of
// independent MQTT broker definitions - see brokers-config-loader.js).
// Each broker's position in the array (1-based) is its "number", used only
// to derive that broker's secret environment variable name (see
// src/config/index.js's readBrokers) - it is not itself a JSON field.
export const brokersConfigSchema = {
  $id: 'meshcore-observer/mqtt/brokers-config',
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'enabled', 'host', 'port', 'auth'],
    properties: {
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
        properties: {
          method: { enum: ['none', 'token', 'password'] },
          username: { type: 'string', minLength: 1 },
          audience: { type: 'string', minLength: 1 },
          tokenTtlSeconds: { type: 'integer', minimum: 1 }
        }
      }
    }
  }
};
