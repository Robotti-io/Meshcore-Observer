import { createHash, createHmac } from 'node:crypto';

/**
 * Derive MeshCore's 16-byte transport key for a case-sensitive region name.
 * Firmware's hashtag-region convention hashes `#<name>`; the leading # is
 * accepted when the name came directly from a region discovery response.
 */
export function deriveRegionTransportKey(regionName) {
  const hashtag = regionName.startsWith('#') ? regionName : `#${regionName}`;
  return createHash('sha256').update(hashtag, 'utf8').digest().subarray(0, 16);
}

export function calculateRegionTransportCode(packet, regionName) {
  const key = deriveRegionTransportKey(regionName);
  let code = createHmac('sha256', key)
    .update(Buffer.from([packet.payload_type]))
    .update(Buffer.from(packet.payload))
    .digest()
    .readUInt16LE(0);
  if (code === 0) code = 1;
  else if (code === 0xffff) code = 0xfffe;
  return code;
}

/**
 * MeshCore's short region transport code is an HMAC over payload type +
 * payload. It does not encode a region name, so names must be known locally
 * (from region discovery or bot configuration) to resolve a received scope.
 */
export function matchPacketRegionScope(packet, regionNames) {
  const hasTransportCodes = packet.route_type === 0 || packet.route_type === 3;
  const code = packet.transportCode1;
  if (!hasTransportCodes || code === null || code === 0) {
    return { status: 'unscoped', regionScope: null };
  }

  const matches = [];
  const seenKeys = new Set();
  for (const regionName of regionNames) {
    // '*' means the unscoped wildcard, while '$' regions use secret keys
    // that cannot be reconstructed from their advertised names.
    if (regionName === '*' || regionName.startsWith('$')) continue;
    const keyIdentity = deriveRegionTransportKey(regionName).toString('hex');
    if (seenKeys.has(keyIdentity)) continue;
    seenKeys.add(keyIdentity);
    const candidateCode = calculateRegionTransportCode(packet, regionName);
    if (candidateCode === code) matches.push(regionName);
  }

  if (matches.length === 1) return { status: 'matched', regionScope: matches[0] };
  return { status: matches.length === 0 ? 'unknown' : 'ambiguous', regionScope: null };
}
