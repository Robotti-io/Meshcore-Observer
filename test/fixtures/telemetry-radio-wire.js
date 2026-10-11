// Synthetic pinned MeshCore a366955 Companion frames, never captured RF.
export const telemetryRadioTarget = 'AC0102030405' + 'E1'.repeat(26);
export const telemetryRadioOther = 'BC0102030405' + 'E2'.repeat(26);
export const telemetryLoginWire = Object.freeze({
  guest: '8500AC0102030405040302010002',
  legacy: '8500AC0102030405', denied: '8600AC0102030405',
  directAck: '0600AC01020388130000', floodAck: '0601AC01020388130000'
});
export const telemetryWireBytes = hex => [...Buffer.from(hex, 'hex')];
export function telemetryContactFrame({ key = telemetryRadioTarget, type = 2, encodedPathLength = 0, path = [] } = {}) {
  const buffer = Buffer.alloc(148);
  buffer[0] = 3;
  buffer.set(Buffer.from(key, 'hex'), 1);
  buffer[33] = type;
  buffer[35] = encodedPathLength;
  buffer.set(path, 36);
  buffer.write('PRIVATE-NAME-NOT-RETURNED', 100, 'utf8');
  buffer.fill(0xFE, 132); // Raw lastmod/location/advert bytes are never retained.
  return [...buffer];
}
export function telemetryInventoryBoundary(code, value = 0) {
  const buffer = Buffer.alloc(5); buffer[0] = code; buffer.writeUInt32LE(value, 1);
  return [...buffer];
}
