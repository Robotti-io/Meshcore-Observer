// Synthetic application frames from MeshCore a366955's Companion layouts;
// these are not captured RF packets or evidence of a deployed capability.
export const remoteFrames = Object.freeze({
  sentDirect: '06007856341288130000',
  sentFlood: '06017856341288130000',
  emptyRegions: '8C0078563412040302010000000000000000',
  wrongTag: '8C0079563412040302010000000000000000',
  unsupported: '0101',
  notFound: '0102',
  tableFull: '0103'
});

export function remoteFrame(hex) {
  return { bytes: [...Buffer.from(hex, 'hex')] };
}
