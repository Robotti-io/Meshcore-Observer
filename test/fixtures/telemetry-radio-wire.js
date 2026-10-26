import assert from 'node:assert/strict';

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

// Trusted route-provider fixture, separate from the actual coordinator and
// contact parser. Existing contact metadata is preserved for passive evidence.
export function telemetryRoute(key = telemetryRadioTarget, path = []) {
  return { status: 'available', target: { publicKeyHex: key, name: null,
    flags: 0, advertTimestamp: 0, lat: null, lon: null }, path, hashWidth: 2,
  receivedAt: 1000, receptionCount: 1, evidenceSource: 'passive-topology' };
}

// Independently enforce the firmware command layout, not the producer's offsets.
function traceCommand(command) {
  const bytes = Buffer.from(command);
  assert.equal(bytes[0], 36);
  assert.ok(bytes.length > 10 && (bytes.length - 10) % 2 === 0);
  assert.deepEqual([...bytes.subarray(5, 10)], [0, 0, 0, 0, 1]);
  return bytes;
}

export function telemetryTraceAck(command) {
  const bytes = traceCommand(command), response = Buffer.alloc(10);
  response[0] = 6;
  bytes.copy(response, 2, 1, 5);
  response.writeUInt32LE(5000, 6);
  return response;
}

// Firmware onTraceRecv: one SNR per two-byte hash, plus the final receiver.
export function telemetryTraceResponse(command) {
  const bytes = traceCommand(command), path = bytes.subarray(10);
  const response = Buffer.alloc(13 + path.length + path.length / 2);
  response[0] = 0x89; response[2] = path.length; response[3] = 1;
  bytes.copy(response, 4, 1, 9);
  path.copy(response, 12);
  return response;
}
