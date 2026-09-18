import { createHash } from 'node:crypto';

// Matches the MeshCore firmware's own Packet::calculatePacketHash(): a
// protocol-level identifier (not app-specific), so it stays comparable with
// the wider MeshCore ecosystem. TRACE packets additionally hash their
// pathLen byte since two TRACE packets can otherwise share an identical
// payload while representing different physical transmissions.
const PAYLOAD_TYPE_TRACE = 0x09;

export function calculatePacketHash(payloadType, pathLen, payloadBytes) {
  const hash = createHash('sha256');
  hash.update(Buffer.from([payloadType & 0xff]));

  if (payloadType === PAYLOAD_TYPE_TRACE) {
    const pathLenBuffer = Buffer.alloc(2);
    pathLenBuffer.writeUInt16LE(pathLen & 0xffff, 0);
    hash.update(pathLenBuffer);
  }

  hash.update(Buffer.from(payloadBytes));
  return hash.digest('hex').slice(0, 16).toUpperCase();
}
