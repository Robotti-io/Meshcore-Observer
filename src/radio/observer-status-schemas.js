const object = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const bytes = (minItems, maxItems) => ({ type: 'array', minItems, maxItems, items: integer(0, 255) });

export const localStatusFrameSchema = object({ bytes: bytes(1, 176) });
export const deviceQueryResponseSchema = object({
  firmwareVer: integer(-128, 127), reserved: bytes(6, 6),
  firmware_build_date: { type: 'string', maxLength: 12 },
  manufacturerModel: { type: 'string', maxLength: 128, pattern: '^[^\\uFFFD]*$' }
}, []);
export const observerStatsSchema = object({ battery_mv: integer(1, 65535),
  uptime_secs: integer(0, 0xFFFFFFFF), noise_floor: integer(-200, 0) }, []);
export const observerMetadataSchema = object({
  model: { anyOf: [{ type: 'string', maxLength: 40, pattern: '^[^\\u0000-\\u001F\\u007F]*$' }, { type: 'null' }] },
  firmwareVersion: { anyOf: [{ type: 'string', minLength: 1, maxLength: 20, pattern: '^[\\x20-\\x7E]+$' }, { type: 'null' }] },
  repeat: { type: 'boolean' }
}, ['model', 'firmwareVersion']);
