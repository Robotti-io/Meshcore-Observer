import { Packet } from '@liamcottle/meshcore.js';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { topologyFrameSchema, topologyEvidenceSchema } from './topology-schemas.js';

const frameValid = compileSchema(topologyFrameSchema);
const evidenceValid = compileSchema(topologyEvidenceSchema);

export function assertTopologyEvidence(evidence) {
  if (!evidenceValid(evidence)) throw new Error(`Invalid topology evidence: ${formatErrors(evidenceValid.errors)}`);
  if (evidence.containsRepeatedPrefix !== (new Set(evidence.prefixes).size !== evidence.prefixes.length)) {
    throw new Error('Invalid topology evidence: repeated-prefix flag disagrees with path');
  }
}

/** Header-only local view. Never examines encrypted contents or changes the MQTT DTO. */
export function parseTopologyFrame(frame) {
  if (!frameValid(frame)) return { status: 'malformed' };
  const bytes = Buffer.from(frame.raw, 'hex');
  const header = bytes[0];
  const route = header & 3;
  const version = header >> 6;
  const type = (header >> 2) & 15;
  if (version !== 0 || type === 9 || (type >= 12 && type <= 14)) return { status: 'unsupported' };
  const offset = route === 0 || route === 3 ? 5 : 1;
  if (bytes.length <= offset) return { status: 'malformed' };
  const width = (bytes[offset] >> 6) + 1;
  const count = bytes[offset] & 63;
  if (width === 4) return { status: 'unsupported' };
  const pathBytes = width * count;
  // BufferReader can silently return short slices; reject before invoking it.
  if (pathBytes > 64 || bytes.length < offset + 1 + pathBytes || bytes.length - offset - 1 - pathBytes > 184) {
    return { status: 'malformed' };
  }
  const packet = Packet.fromBytes(bytes);
  if (count === 0) return { status: 'noRelay' };
  const prefixes = packet.getPathHashes().map((hash) => Buffer.from(hash).toString('hex').toUpperCase());
  const evidence = {
    runId: frame.runId, observerPublicKey: frame.observerPublicKey, receivedAt: frame.receivedAt,
    route, kind: route <= 1 ? 'flood-traversed' : 'direct-remaining', payloadVersion: 0,
    hashWidth: width, prefixes,
    transportCodes: offset === 5 ? [packet.transportCode1, packet.transportCode2] : null,
    containsRepeatedPrefix: new Set(prefixes).size !== prefixes.length
  };
  assertTopologyEvidence(evidence);
  return { status: 'accepted', evidence };
}
