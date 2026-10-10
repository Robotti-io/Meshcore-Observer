import { compileSchema } from '../validation/ajv.js';
import { assertRegionQueryInput } from './region-query-validation.js';
import { regionQueryTargetSchema, regionContactInputSchema, regionContactFrameSchema,
  regionPreflightErrorFrameSchema } from './region-query-schemas.js';

const inputValid = compileSchema(regionContactInputSchema);
const contactValid = compileSchema(regionContactFrameSchema);
const errorValid = compileSchema(regionPreflightErrorFrameSchema);
const malformed = () => ({ status: 'malformed', reason: 'invalid-contact-frame' });

// Preparation only. T2 owns calling the existing serial/TCP transport inside
// the coordinator's generation-bound command transaction; no I/O here.
export function prepareRegionContactRead(target) {
  assertRegionQueryInput(regionQueryTargetSchema,target);
  return [0x1E,...Buffer.from(target.targetPublicKey,'hex')];
}
export function prepareRegionAnonymousRequest(target) {
  assertRegionQueryInput(regionQueryTargetSchema,target);
  return [0x39,...Buffer.from(target.targetPublicKey,'hex'),0x01,0x00];
}

/** Read only the fixed full-key/path-length evidence, never names or paths. */
export function parseRegionContactFrame(input) {
  if (!inputValid(input)) return malformed();
  const { bytes,targetPublicKey } = input;
  if (bytes[0] === 0x01) {
    if (!errorValid({ bytes })) return malformed();
    return { status: 'unavailable', reason: bytes[1] === 1 ? 'preflight-unsupported'
      : bytes[1] === 2 ? 'contact-missing' : 'preflight-failed', errorCode: bytes[1] };
  }
  if (bytes[0] !== 0x03) return { status: 'ignored' };
  if (!contactValid({ bytes })) return malformed();
  if (Buffer.from(bytes.slice(1,33)).toString('hex').toUpperCase() !== targetPublicKey) return { status: 'ignored' };
  if (bytes[35] !== 0) return { status: 'unavailable', reason: 'unsafe-route' };
  return { status: 'eligible', targetPublicKey, outPathLen: 0 };
}
