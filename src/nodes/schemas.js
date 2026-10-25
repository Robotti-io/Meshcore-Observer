const epochMs = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const publicKey = { type: 'string', pattern: '^[0-9A-F]{64}$' };
const digest = { type: 'string', pattern: '^[0-9a-f]{64}$' };

export const fingerprintPruneSchema = {
  $id: 'meshcore-observer/nodes/fingerprint-prune',
  type: 'object', additionalProperties: false, required: ['cutoffMs'],
  properties: { cutoffMs: epochMs }
};

// A local frame view only; MQTT's existing compatibility DTO is unchanged.
export const advertFrameSchema = {
  $id: 'meshcore-observer/nodes/advert-frame',
  type: 'object', additionalProperties: false, required: ['raw'],
  properties: {
    raw: { type: 'string', pattern: '^([0-9A-Fa-f]{2})+$' },
    packet_type: { type: 'string' }
  }
};

// Built only after signature verification. Schema validity is not proof of
// authenticity; the producer must verify the payload before this store seam.
export const verifiedAdvertSchema = {
  $id: 'meshcore-observer/nodes/verified-advert',
  type: 'object', additionalProperties: false,
  required: ['publicKeyHex', 'eventDigest', 'name', 'type', 'receivedAt', 'hopCount'],
  properties: {
    publicKeyHex: publicKey, eventDigest: digest,
    name: { type: ['string', 'null'] },
    type: { enum: ['NONE', 'CHAT', 'REPEATER', 'ROOM', 'SENSOR', null] },
    receivedAt: epochMs, hopCount: { type: 'integer', minimum: 0, maximum: 63 },
    routeEvidence: {
      type: 'object', additionalProperties: false,
      required: ['hashWidth', 'pathHashesHex', 'flags', 'advertTimestamp', 'lat', 'lon'],
      properties: {
        hashWidth: { type: 'integer', minimum: 1, maximum: 3 },
        pathHashesHex: { type: 'array', maxItems: 63, items: { type: 'string', pattern: '^(?:[0-9A-F]{2}){1,3}$' } },
        flags: { type: 'integer', minimum: 0, maximum: 255 },
        advertTimestamp: { type: 'integer', minimum: 0, maximum: 0xFFFFFFFF },
        lat: { type: ['integer', 'null'], minimum: -2147483648, maximum: 2147483647 },
        lon: { type: ['integer', 'null'], minimum: -2147483648, maximum: 2147483647 }
      }
    }
  }
};

export const advertRangeSchema = {
  $id: 'meshcore-observer/nodes/advert-range',
  type: 'object', additionalProperties: false, required: ['start', 'end'],
  properties: { start: epochMs, end: epochMs, type: { enum: ['CHAT', 'REPEATER'] } }
};

export const advertPageSchema = {
  $id: 'meshcore-observer/nodes/advert-page',
  type: 'object', additionalProperties: false, required: ['start', 'end', 'limit', 'offset'],
  properties: {
    ...advertRangeSchema.properties,
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
  }
};

export const directHeardQuerySchema = {
  $id: 'meshcore-observer/nodes/direct-heard-query',
  type: 'object', additionalProperties: false, required: ['publicKeyHex', 'now', 'windowMs'],
  properties: {
    publicKeyHex: publicKey, now: epochMs,
    windowMs: { type: 'integer', minimum: 3600000, maximum: 8760 * 3600000, multipleOf: 3600000 }
  }
};

export const verifiedAdvertRouteQuerySchema = {
  $id: 'meshcore-observer/nodes/verified-advert-route-query',
  type: 'object', additionalProperties: false, required: ['publicKeyHex', 'now', 'windowMs', 'radius'],
  properties: {
    publicKeyHex: publicKey, observerPublicKey: publicKey, now: epochMs,
    windowMs: { type: 'integer', minimum: 1, maximum: 8760 * 3600_000 },
    radius: { type: 'integer', minimum: 1, maximum: 63 }
  }
};
