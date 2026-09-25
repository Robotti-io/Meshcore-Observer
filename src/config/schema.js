import { botConfigSchema } from '../bots/schemas.js';

export const configSchema = {
  $id: 'meshcore-observer/config',
  type: 'object',
  additionalProperties: false,
  required: ['radio', 'observer', 'brokers', 'bots', 'logging', 'metricsUi', 'botReplyQueue', 'floodAdvert'],
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
    botReplyQueue: {
      type: 'object',
      additionalProperties: false,
      required: ['quietMs', 'ttlMs'],
      properties: {
        quietMs: { type: 'integer', minimum: 0 },
        ttlMs: { type: 'integer', minimum: 0 }
      }
    },
    floodAdvert: {
      type: 'object',
      additionalProperties: false,
      required: ['intervalHours'],
      properties: {
        intervalHours: {
          type: 'integer',
          anyOf: [{ const: 0 }, { minimum: 3, maximum: 168 }]
        }
      }
    },
    metricsUi: {
      type: 'object',
      additionalProperties: false,
      required: [
        'enabled',
        'host',
        'port',
        'sampleIntervalMs',
        'dbPath',
        'retentionDays',
        'maxChartBuckets'
      ],
      properties: {
        enabled: { type: 'boolean' },
        host: { type: 'string', minLength: 1 },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        sampleIntervalMs: { type: 'integer', minimum: 1000 },
        dbPath: { type: 'string', minLength: 1 },
        // 0 = unlimited retention.
        retentionDays: { type: 'integer', minimum: 0 },
        maxChartBuckets: { type: 'integer', minimum: 10, maximum: 1000 }
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
    // The same object src/bots/schemas.js's botsConfigSchema.items uses -
    // not a hand-copied mirror - so the two can never drift apart. Safe to
    // share directly (rather than the whole botsConfigSchema) because this
    // object carries no `$id` of its own to collide with; only the array
    // wrapper around it does, and that wrapper is compiled standalone in
    // bots-config-loader.js, never nested inside this schema.
    bots: {
      type: 'array',
      items: botConfigSchema
    }
  }
};
