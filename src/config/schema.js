export const configSchema = {
  $id: 'meshcore-observer/config',
  type: 'object',
  additionalProperties: false,
  required: ['radio', 'observer', 'brokers', 'bots', 'logging', 'metricsUi'],
  properties: {
    radio: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'serialPorts', 'tcpHost', 'tcpPort', 'reconnect'],
      properties: {
        type: { enum: ['serial', 'tcp'] },
        serialPorts: {
          type: 'array',
          items: { type: 'string', minLength: 1 }
        },
        tcpHost: { type: ['string', 'null'], minLength: 1 },
        tcpPort: { type: ['integer', 'null'], minimum: 1, maximum: 65535 },
        reconnect: {
          type: 'object',
          additionalProperties: false,
          required: ['maxRetries', 'initialDelayMs', 'maxDelayMs'],
          properties: {
            maxRetries: { type: 'integer', minimum: 0 },
            initialDelayMs: { type: 'integer', minimum: 0 },
            maxDelayMs: { type: 'integer', minimum: 0 }
          }
        }
      }
    },
    observer: {
      type: 'object',
      additionalProperties: false,
      required: ['iata', 'ownerEmail'],
      properties: {
        iata: { type: 'string', minLength: 1 },
        ownerEmail: { type: ['string', 'null'] }
      }
    },
    logging: {
      type: 'object',
      additionalProperties: false,
      required: ['level'],
      properties: {
        level: { enum: ['debug', 'info', 'warn', 'error'] }
      }
    },
    metricsUi: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'host', 'port', 'sampleIntervalMs', 'historyWindowMs'],
      properties: {
        enabled: { type: 'boolean' },
        host: { type: 'string', minLength: 1 },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        sampleIntervalMs: { type: 'integer', minimum: 1000 },
        historyWindowMs: { type: 'integer', minimum: 1000 }
      }
    },
    brokers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'enabled',
          'host',
          'port',
          'transport',
          'tls',
          'websocketPath',
          'keepalive',
          'qos',
          'retain',
          'clientIdPrefix',
          'auth'
        ],
        properties: {
          id: { type: 'string', minLength: 1 },
          enabled: { type: 'boolean' },
          host: { type: 'string', minLength: 1 },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          transport: { enum: ['tcp', 'wss'] },
          tls: { type: 'boolean' },
          websocketPath: { type: ['string', 'null'] },
          keepalive: { type: 'integer', minimum: 0 },
          qos: { enum: [0, 1, 2] },
          retain: { type: 'boolean' },
          clientIdPrefix: { type: 'string', minLength: 1 },
          auth: {
            type: 'object',
            additionalProperties: false,
            required: ['method', 'username', 'password', 'audience', 'tokenTtlSeconds'],
            properties: {
              method: { enum: ['none', 'token', 'password'] },
              username: { type: ['string', 'null'] },
              password: { type: ['string', 'null'] },
              audience: { type: ['string', 'null'] },
              tokenTtlSeconds: { type: ['integer', 'null'], minimum: 1 }
            }
          }
        }
      }
    },
    // Shape mirrors src/bots/schemas.js's botsConfigSchema (kept as a
    // separate inline definition rather than an imported/shared schema
    // object, since both get compiled on the same shared AJV instance and
    // a shared object carrying the same $id twice would collide).
    bots: {
      type: 'array',
      items: {
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
                response: { type: 'string', minLength: 1 }
              }
            }
          }
        }
      }
    }
  }
};
