import { parseTelemetryInventoryFrame, decodeTelemetryContactPath } from './telemetry-radio-adapter.js';
import { assertTelemetryRadioInput, isTelemetryRadioInput, checkedTelemetryRadioResult } from './telemetry-radio-validation.js';
import { telemetryContactInventoryOptionsSchema, telemetryContactInventoryInputSchema,
  telemetryContactInventoryClockSchema, telemetryContactInventoryResultSchema,
  TELEMETRY_CONTACT_INVENTORY_MAX } from './telemetry-radio-schemas.js';

const immutable = value => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') immutable(child);
  return Object.freeze(value);
};

/** Bounded in-memory protocol reducer; no transport, timer, credentials or store. */
export function createTelemetryContactInventory(options) {
  assertTelemetryRadioInput(telemetryContactInventoryOptionsSchema, options);
  const { targetPublicKey, radius, startedAt, timeoutMs } = options;
  if (targetPublicKey.startsWith('00000000')) throw new Error('Unsafe telemetry login target prefix');
  const seen = new Set(); let contacts = [];
  let lastNow = startedAt, expected = null, contact = null, contactFailure = null;
  let terminal = null, changed = false, contactFrames = 0;
  const checked = value => immutable(checkedTelemetryRadioResult(telemetryContactInventoryResultSchema, value));
  const fail = reason => {
    terminal = checked({ status: 'unavailable', reason });
    seen.clear(); contacts = []; contact = null; contactFailure = null;
    return terminal;
  };
  const defer = reason => {
    terminal = checked({ status: 'deferred', reason, contactCount: Math.min(contactFrames, TELEMETRY_CONTACT_INVENTORY_MAX) });
    seen.clear(); contacts = []; contact = null; contactFailure = null;
    return terminal;
  };
  const rememberContactFailure = reason => {
    // Prefix ambiguity takes precedence over route/type failures because a
    // login response cannot be attributed safely when either prefix collides.
    if (contactFailure === null || reason === 'login-prefix-collision') contactFailure = reason;
  };
  function observeClock(monotonicNow) {
    if (monotonicNow < lastNow) return fail('clock-anomaly');
    lastNow = monotonicNow;
    if (monotonicNow - startedAt >= timeoutMs) return fail('preflight-timeout');
  }
  function snapshot(input) {
    if (!isTelemetryRadioInput(telemetryContactInventoryClockSchema, input)) return fail('clock-anomaly');
    if (terminal?.status === 'unavailable') return terminal;
    const expired = observeClock(input.monotonicNow);
    if (expired) return expired;
    return terminal ?? checked({ status: 'pending', contactCount: Math.min(contactFrames, TELEMETRY_CONTACT_INVENTORY_MAX) });
  }
  function accept(input) {
    if (!isTelemetryRadioInput(telemetryContactInventoryInputSchema, input)) return fail('invalid-contact-inventory-frame');
    const current = snapshot({ monotonicNow: input.monotonicNow });
    if (current.status === 'unavailable') return current;
    if (current.status === 'deferred') return current;
    const parsed = parseTelemetryInventoryFrame({ bytes: input.bytes });
    if (parsed.status === 'ignored') return current;
    if (parsed.status !== 'accepted') return fail(parsed.reason);
    const { envelope } = parsed;
    if (envelope.kind === 'changed') {
      if (current.status === 'complete') return defer('contacts-changed');
      changed = true;
      return checked({ status: 'pending', contactCount: Math.min(contactFrames, TELEMETRY_CONTACT_INVENTORY_MAX) });
    }
    if (current.status === 'complete') return fail('inventory-protocol-error');
    if (envelope.kind === 'error') {
      if (expected !== null) return fail('inventory-protocol-error');
      return defer(envelope.errorCode === 1 ? 'preflight-unsupported' : 'preflight-failed');
    }
    if (envelope.kind === 'start') {
      if (expected !== null) return fail('inventory-protocol-error');
      expected = envelope.count;
    } else if (envelope.kind === 'contact') {
      if (expected === null) return fail('inventory-protocol-error');
      contactFrames++;
      if (contactFrames > TELEMETRY_CONTACT_INVENTORY_MAX) return fail('inventory-too-large');
      if (!changed && contactFrames > expected) return fail('inventory-protocol-error');
      // Once PUSH_CODE_NEW_ADVERT arrives the snapshot is no longer evidence.
      // Continue validating and draining frames to the explicit end marker,
      // without retaining or interpreting any more contact details.
      if (changed) return checked({ status: 'pending', contactCount: contactFrames });
      if (seen.has(envelope.publicKey)) return fail('duplicate-contact');
      seen.add(envelope.publicKey);
      contacts.push({ publicKey: envelope.publicKey, contactType: envelope.contactType, flags: envelope.flags,
        encodedPathLength: envelope.encodedPathLength, pathBytes: envelope.pathBytes,
        name: envelope.name, lastAdvert: envelope.lastAdvert, lat: envelope.lat, lon: envelope.lon, lastMod: envelope.lastMod });
      if (envelope.publicKey !== targetPublicKey && (envelope.publicKey.startsWith(targetPublicKey.slice(0, 8))
        || envelope.publicKey.startsWith(targetPublicKey.slice(0, 12)))) rememberContactFailure('login-prefix-collision');
      if (envelope.publicKey === targetPublicKey) {
        if (envelope.contactType !== 2) rememberContactFailure('non-repeater-contact');
        else {
          const decoded = decodeTelemetryContactPath({ encodedPathLength: envelope.encodedPathLength,
            pathBytes: envelope.pathBytes, radius });
          if (decoded.status !== 'direct-route') rememberContactFailure(decoded.reason);
          else contact = { targetPublicKey, contactType: 2, route: decoded.route };
        }
      }
    } else {
      if (expected === null) return fail('inventory-protocol-error');
      if (changed) return defer('contacts-changed');
      if (seen.size !== expected) return fail('inventory-protocol-error');
      if (contactFailure === 'login-prefix-collision') return defer(contactFailure);
      terminal = checked({ status: 'complete', contactCount: seen.size, contact,
        contacts, ...(contactFailure ? { contactIssue: contactFailure } : {}),
        prefixCollisionChecked: true, provenance: 'companion-contact-inventory' });
      seen.clear(); contact = null;
      return terminal;
    }
    return checked({ status: 'pending', contactCount: seen.size });
  }
  return Object.freeze({ accept, snapshot });
}
