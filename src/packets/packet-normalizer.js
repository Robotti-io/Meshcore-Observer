import { compileSchema, formatErrors } from '../validation/ajv.js';
import { rawPacketEventSchema } from './schemas.js';

const validate = compileSchema(rawPacketEventSchema);

export class InvalidRawPacketEventError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRawPacketEventError';
  }
}

/**
 * Normalizes a meshcore.js LogRxData push ({lastSnr, lastRssi, raw}) into
 * the schema-validated shape the rest of the packet pipeline consumes, and
 * validates it with AJV before any decoding happens. This is the only place
 * raw, unvalidated radio data is allowed to exist.
 */
export function normalizeRawPacketEvent(rawPush, { now = () => Date.now() } = {}) {
  const event = {
    receivedAt: new Date(now()).toISOString(),
    snr: rawPush.lastSnr,
    rssi: rawPush.lastRssi,
    frameHex: Buffer.from(rawPush.raw).toString('hex').toUpperCase()
  };

  if (!validate(event)) {
    throw new InvalidRawPacketEventError(`Invalid raw packet event: ${formatErrors(validate.errors)}`);
  }

  return event;
}
