import { compileSchema, formatErrors } from '../validation/ajv.js';
import { remoteResponseFrameSchema, remoteResponseEnvelopeSchema, REMOTE_ERROR_REASONS } from './remote-request-schemas.js';

const frameValid = compileSchema(remoteResponseFrameSchema);
const envelopeValid = compileSchema(remoteResponseEnvelopeSchema);

export function assertRemoteResponseEnvelope(envelope) {
  if (!envelopeValid(envelope)) {
    throw new Error(`Invalid remote response envelope: ${formatErrors(envelopeValid.errors)}`);
  }
}

/**
 * Accept the JSON byte arrays emitted by installed serial/TCP rx listeners.
 * Parse only owned envelope layouts; body semantics and correlation belong
 * to their separate owners. In particular, a binary push contains no key.
 */
export function parseRemoteResponseFrame(frame) {
  if (!frameValid(frame)) return { status: 'malformed' };
  const bytes = frame.bytes;
  let envelope;
  if (bytes[0] === 0x06) {
    if (bytes.length !== 10 || bytes[1] > 1) return { status: 'malformed' };
    const buffer = Buffer.from(bytes);
    envelope = { kind: 'sent', route: bytes[1] === 0 ? 'direct' : 'flood',
      tag: buffer.readUInt32LE(2), estimatedTimeoutMs: buffer.readUInt32LE(6) };
  } else if (bytes[0] === 0x01) {
    if (bytes.length !== 2) return { status: 'malformed' };
    envelope = { kind: 'error', errorCode: bytes[1], reason: REMOTE_ERROR_REASONS[bytes[1]] ?? 'unknown' };
  } else if (bytes[0] === 0x8C) {
    // Firmware emits this push only for len > 4: at least one body byte
    // follows the echoed tag. An empty region list still has its clock.
    if (bytes.length < 7 || bytes[1] !== 0) return { status: 'malformed' };
    envelope = { kind: 'binary-response', tag: Buffer.from(bytes).readUInt32LE(2), body: bytes.slice(6) };
  } else {
    return { status: 'ignored' };
  }
  assertRemoteResponseEnvelope(envelope);
  return { status: 'accepted', envelope };
}
