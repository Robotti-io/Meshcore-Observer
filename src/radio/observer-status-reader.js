import { compileSchema } from '../validation/ajv.js';
import { localStatusFrameSchema, deviceQueryResponseSchema, observerStatsSchema, observerMetadataSchema } from './observer-status-schemas.js';

const frameValid = compileSchema(localStatusFrameSchema);
const queryValid = compileSchema(deviceQueryResponseSchema);
const statsValid = compileSchema(observerStatsSchema);
const metadataValid = compileSchema(observerMetadataSchema);

/** The SDK decodes the model and following fixed-width firmware/flags as one
 * UTF-8 string. Never keep the reserved bytes (which include the BLE PIN).
 */
export function normalizeDeviceQuery(response) {
  const input = response && { ...response,
    ...(response.reserved instanceof Uint8Array ? { reserved: Array.from(response.reserved) } : {}) };
  if (!queryValid(input)) throw new Error('Invalid device metadata');
  const packed = Buffer.from(input.manufacturerModel ?? '', 'utf8');
  const text = (start, end) => packed.subarray(start, end).toString('utf8').split('\0')[0].trim();
  const result = { model: text(0, 40) || null,
    firmwareVersion: packed.length >= 60 ? text(40, 60) || null : null };
  if (input.firmwareVer >= 9 && packed.length >= 61 && packed[60] <= 1) result.repeat = packed[60] === 1;
  if (!metadataValid(result)) throw new Error('Invalid device metadata');
  return result;
}

function decode(frame, kind) {
  const raw = Buffer.from(frame.bytes);
  if (kind === 'metadata') {
    if (raw.length < 20 || raw.length > 82) return null;
    return normalizeDeviceQuery({ firmwareVer: raw[1], manufacturerModel: raw.subarray(20).toString('utf8') });
  }
  if (kind === 'core') {
    // Core: battery u16, uptime u32, error flags u16, queue u8.
    if (raw.length !== 11) return null;
    const battery = raw.readUInt16LE(2);
    return { uptime_secs: raw.readUInt32LE(4), ...(battery > 0 ? { battery_mv: battery } : {}) };
  }
  // Radio: noise i16, RSSI i8, SNR i8, TX/RX airtime u32 each.
  if (raw.length !== 14) return null;
  return { noise_floor: raw.readInt16LE(2) };
}

const commands = {
  metadata: { command: [22, 3], code: 13 },
  core: { command: [56, 0], code: 24, subtype: 0 },
  radio: { command: [56, 1], code: 24, subtype: 1 }
};

/** One already-owned local command. Bounded raw reads avoid the SDK helpers'
 * unbounded waits and discard every listener/timer on settlement or cancellation.
 */
export function readObserverStatusPart(connection, kind, { signals = [], timeoutMs = 2000 } = {}) {
  const profile = commands[kind];
  if (!profile) throw new Error('Unknown local status query');
  return new Promise(resolve => {
    let timer, settled = false, dispatched = false;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); connection.off('rx', onFrame);
      for (const signal of signals) signal?.removeEventListener('abort', onAbort);
      resolve({ ...value, dispatched });
    };
    const onAbort = () => finish({ reason: 'aborted' });
    const onFrame = bytes => {
      const frame = { bytes: bytes instanceof Uint8Array ? Array.from(bytes) : bytes };
      if (!frameValid(frame)) return;
      if (frame.bytes[0] === 1 && frame.bytes.length === 2) {
        finish({ reason: frame.bytes[1] === 1 ? 'unsupported' : 'rejected' }); return;
      }
      if (frame.bytes[0] !== profile.code || (profile.subtype !== undefined && frame.bytes[1] !== profile.subtype)) return;
      try {
        const data = decode(frame, kind);
        finish(data && (kind === 'metadata' || statsValid(data)) ? { data } : { reason: 'invalid' });
      } catch { finish({ reason: 'invalid' }); }
    };
    if (signals.some(signal => signal?.aborted)) { resolve({ reason: 'aborted', dispatched }); return; }
    if (typeof connection.sendToRadioFrame !== 'function') { resolve({ reason: 'unsupported', dispatched }); return; }
    connection.on('rx', onFrame);
    for (const signal of signals) signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish({ reason: 'timeout' }), timeoutMs);
    try {
      dispatched = true;
      Promise.resolve(connection.sendToRadioFrame(profile.command)).catch(() => finish({ reason: 'write-error' }));
    } catch { finish({ reason: 'write-error' }); }
  });
}
