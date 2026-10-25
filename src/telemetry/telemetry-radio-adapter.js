import { parseRemoteResponseFrame } from '../radio/remote-response-parser.js';
import { withTelemetryGuestPassword } from './polling-config.js';
import { isTelemetryRadioInput, assertTelemetryRadioInput, checkedTelemetryRadioResult } from './telemetry-radio-validation.js';
import * as schemas from './telemetry-radio-schemas.js';

const safePrefix = key => !key.startsWith('00000000');
const keyOf = bytes => Buffer.from(bytes).toString('hex').toUpperCase();
const unavailable = reason => ({ status: 'unavailable', reason });
const malformed = reason => ({ status: 'malformed', reason });

function assertTarget(target) {
  assertTelemetryRadioInput(schemas.telemetryRadioTargetSchema, target);
  if (!safePrefix(target.targetPublicKey)) throw new Error('Unsafe telemetry login target prefix');
}

// Preparation only: never calls a transport or the installed unbounded helpers.
export function prepareTelemetryContactRead(target) {
  assertTarget(target);
  return [0x1E, ...Buffer.from(target.targetPublicKey, 'hex')];
}
export function prepareTelemetryContactInventory(input = {}) {
  assertTelemetryRadioInput(schemas.telemetryInventoryReadSchema, input);
  return [0x04]; // No since filter: partial listings cannot prove prefix uniqueness.
}

/** Decode saved direct-path metadata; it does not prove delivery or reverse a path. */
export function decodeTelemetryContactPath(input) {
  const result = value => checkedTelemetryRadioResult(schemas.telemetryContactPathResultSchema, value);
  if (!isTelemetryRadioInput(schemas.telemetryContactPathInputSchema, input)) return result(malformed('invalid-contact-path'));
  const { encodedPathLength, pathBytes, radius } = input;
  if (encodedPathLength === 0xFF) return result(unavailable('unknown-contact-route'));
  const hashWidth = (encodedPathLength >> 6) + 1, relayCount = encodedPathLength & 63;
  const length = hashWidth * relayCount;
  if (hashWidth === 4) return result(unavailable('unsupported-path-width'));
  if (length > schemas.TELEMETRY_CONTACT_PATH_BYTES) return result(unavailable('path-capacity-exceeded'));
  if (relayCount + 1 > radius) return result(unavailable('radius-exceeded'));
  return result({ status: 'direct-route', route: { encodedPathLength, hashWidth, relayCount,
    distance: relayCount + 1, pathBytes: pathBytes.slice(0, length), outboundRouteVerified: false } });
}

export function parseTelemetryContactFrame(input) {
  const result = value => checkedTelemetryRadioResult(schemas.telemetryContactReadResultSchema, value);
  if (!isTelemetryRadioInput(schemas.telemetryContactReadInputSchema, input)) return result(malformed('invalid-contact-frame'));
  const { targetPublicKey, bytes, radius } = input;
  if (!safePrefix(targetPublicKey)) return result(unavailable('unsafe-prefix'));
  if (bytes[0] === 1) {
    if (!isTelemetryRadioInput(schemas.telemetryContactErrorSchema, { bytes })) return result(malformed('invalid-contact-frame'));
    return result({ status: 'unavailable', reason: bytes[1] === 1 ? 'preflight-unsupported'
      : bytes[1] === 2 ? 'contact-missing' : 'preflight-failed', errorCode: bytes[1] });
  }
  if (bytes[0] !== 3) return result({ status: 'ignored' });
  if (!isTelemetryRadioInput(schemas.telemetryContactFrameSchema, { bytes })) return result(malformed('invalid-contact-frame'));
  if (keyOf(bytes.slice(1, 33)) !== targetPublicKey) return result({ status: 'ignored' });
  if (bytes[33] !== 2) return result(unavailable('non-repeater-contact'));
  const decoded = decodeTelemetryContactPath({ encodedPathLength: bytes[35], pathBytes: bytes.slice(36, 100), radius });
  if (decoded.status !== 'direct-route') return result(decoded);
  return result({ status: 'eligible', contact: { targetPublicKey, contactType: 2, route: decoded.route } });
}

/** Retains only full keys/type/path, discarding names, coordinates and raw frames. */
export function parseTelemetryInventoryFrame(input) {
  const result = value => checkedTelemetryRadioResult(schemas.telemetryInventoryFrameResultSchema, value);
  if (!isTelemetryRadioInput(schemas.telemetryRadioFrameSchema, input)) return result(malformed('invalid-contact-inventory-frame'));
  const { bytes } = input;
  let envelope;
  if (bytes[0] === 0x8A) {
    envelope = { kind: 'changed' }; // PUSH_CODE_NEW_ADVERT may interleave with a contact-list read.
  } else if (bytes[0] === 2) {
    if (!isTelemetryRadioInput(schemas.telemetryContactListStartSchema, input)) return result(malformed('invalid-contact-inventory-frame'));
    const count = Buffer.from(bytes).readUInt32LE(1);
    if (count > schemas.TELEMETRY_CONTACT_INVENTORY_MAX) return result(unavailable('inventory-too-large'));
    envelope = { kind: 'start', count };
  } else if (bytes[0] === 4) {
    if (!isTelemetryRadioInput(schemas.telemetryContactListEndSchema, input)) return result(malformed('invalid-contact-inventory-frame'));
    envelope = { kind: 'end' }; // Lastmod is not a local time or a count.
  } else if (bytes[0] === 3) {
    if (!isTelemetryRadioInput(schemas.telemetryContactFrameSchema, input)) return result(malformed('invalid-contact-inventory-frame'));
    const nameBytes = Buffer.from(bytes.slice(100, 132));
    const nameEnd = nameBytes.indexOf(0);
    envelope = { kind: 'contact', publicKey: keyOf(bytes.slice(1, 33)), contactType: bytes[33], flags: bytes[34],
      encodedPathLength: bytes[35], pathBytes: bytes.slice(36, 100),
      name: nameBytes.subarray(0, nameEnd < 0 ? nameBytes.length : nameEnd).toString('utf8'),
      lastAdvert: Buffer.from(bytes).readUInt32LE(132), lat: Buffer.from(bytes).readInt32LE(136),
      lon: Buffer.from(bytes).readInt32LE(140), lastMod: Buffer.from(bytes).readUInt32LE(144) };
  } else if (bytes[0] === 1) {
    if (!isTelemetryRadioInput(schemas.telemetryContactErrorSchema, input)) return result(malformed('invalid-contact-inventory-frame'));
    envelope = { kind: 'error', errorCode: bytes[1] };
  } else return result({ status: 'ignored' });
  return result({ status: 'accepted', envelope });
}

/** Guest proof only. T3 must still enforce owner/generation/replay/session gates. */
export function parseTelemetryGuestLogin(input) {
  const result = value => checkedTelemetryRadioResult(schemas.telemetryLoginResultSchema, value);
  if (!isTelemetryRadioInput(schemas.telemetryLoginFrameInputSchema, input)) return result(malformed('invalid-login-frame'));
  const { bytes, targetPublicKey } = input;
  if (!safePrefix(targetPublicKey)) return result(unavailable('unsafe-prefix'));
  if (![0x85, 0x86].includes(bytes[0])) return result({ status: 'ignored' });
  const modern = isTelemetryRadioInput(schemas.telemetryLoginSuccessSchema, { bytes });
  const legacy = isTelemetryRadioInput(schemas.telemetryLoginLegacySchema, { bytes });
  const denied = isTelemetryRadioInput(schemas.telemetryLoginFailureSchema, { bytes });
  if (!modern && !legacy && !denied) return result(malformed('invalid-login-frame'));
  const publicKeyPrefix = keyOf(bytes.slice(2, 8));
  if (publicKeyPrefix !== targetPublicKey.slice(0, 12)) return result({ status: 'ignored' });
  if (denied) return result({ status: 'denied', reason: 'authentication-denied', publicKeyPrefix });
  if (legacy) return result(unavailable('legacy-login-proof'));
  // Pinned repeater guest login returns exactly zero permissions. Reject high
  // capability bits too; unknown grants must not be treated as guest authority.
  if (bytes[1] !== 0 || bytes[12] !== 0) return result(unavailable('unsafe-login-permissions'));
  if (bytes[13] !== schemas.TELEMETRY_LOGIN_FIRMWARE_LEVEL) return result(unavailable('unsupported-login-protocol'));
  return result({ status: 'guest-proof', publicKeyPrefix, serverTimestamp: Buffer.from(bytes).readUInt32LE(8),
    permissions: 0, isAdmin: false, firmwareLevel: bytes[13], provenance: 'companion-prefix-attributed' });
}

export function parseTelemetryLoginAck(input) {
  const result = value => checkedTelemetryRadioResult(schemas.telemetryLoginAckResultSchema, value);
  if (!isTelemetryRadioInput(schemas.telemetryLoginFrameInputSchema, input)) return result(malformed('invalid-login-ack'));
  if (!safePrefix(input.targetPublicKey)) return result(unavailable('unsafe-prefix'));
  if (![1, 6].includes(input.bytes[0])) return result({ status: 'ignored' });
  const parsed = parseRemoteResponseFrame({ bytes: input.bytes });
  if (parsed.status !== 'accepted') return result(malformed('invalid-login-ack'));
  const { envelope } = parsed;
  if (envelope.kind === 'error') return result({ status: 'unavailable', reason: 'login-command-error', errorCode: envelope.errorCode });
  if (envelope.tag !== Buffer.from(input.targetPublicKey, 'hex').readUInt32LE(0)) return result(unavailable('login-tag-mismatch'));
  if (envelope.route !== 'direct') return result(unavailable('route-mismatch'));
  return result({ status: 'sent-proof', tag: envelope.tag, route: 'direct', estimatedTimeoutMs: envelope.estimatedTimeoutMs,
    tagKind: 'static-public-key-prefix' });
}

/** Private temporary wire buffer, consumed locally and zeroed after completion. */
export async function withPreparedTelemetryGuestLogin(config, target, consumeFrame) {
  assertTarget(target);
  if (typeof consumeFrame !== 'function') throw new Error('Invalid telemetry login consumer');
  return withTelemetryGuestPassword(config, target, async password => {
    const frame = Buffer.alloc(33 + Buffer.byteLength(password, 'utf8'));
    frame[0] = 0x1A;
    frame.set(Buffer.from(target.targetPublicKey, 'hex'), 1);
    frame.write(password, 33, 'utf8');
    try { return await consumeFrame(frame); }
    finally { frame.fill(0); }
  });
}
