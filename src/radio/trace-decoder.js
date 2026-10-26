import { Constants } from '@liamcottle/meshcore.js';
import { compileSchema } from '../validation/ajv.js';
import { telemetryTraceFrameSchema } from '../telemetry/telemetry-owner-schemas.js';

const valid = compileSchema(telemetryTraceFrameSchema);

/** SDK 1.15 counts SNR bytes as path bytes, but firmware sends one per hash.
 * Adapt this connection only; raw rx still reaches the request owner's gates.
 */
export function installTraceDecoder(connection) {
  if (typeof connection.onTraceDataPush !== 'function') return;
  connection.onTraceDataPush = function (reader) {
    const frame = { bytes: [Constants.PushCodes.TraceData, ...reader.readRemainingBytes()] };
    if (!valid(frame)) return;
    const raw = Buffer.from(frame.bytes), pathLen = raw[2], flags = raw[3];
    if (raw[1] !== 0 || flags > 1 || pathLen > 64 || pathLen % (1 << flags) !== 0) return;
    const hopCount = pathLen >> flags;
    if (raw.length !== 13 + pathLen + hopCount) return;
    this.emit(Constants.PushCodes.TraceData, {
      reserved: 0, pathLen, flags, tag: raw.readUInt32LE(4), authCode: raw.readUInt32LE(8),
      pathHashes: new Uint8Array(raw.subarray(12, 12 + pathLen)),
      pathSnrs: new Uint8Array(raw.subarray(12 + pathLen, 12 + pathLen + hopCount)),
      lastSnr: raw.readInt8(raw.length - 1) / 4
    });
  };
}
