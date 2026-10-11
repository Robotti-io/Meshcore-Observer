import { parseTelemetryInventoryFrame, decodeTelemetryContactPath } from './telemetry-radio-adapter.js';
import { assertTelemetryRadioInput, isTelemetryRadioInput, checkedTelemetryRadioResult } from './telemetry-radio-validation.js';
import { telemetryContactInventoryOptionsSchema, telemetryContactInventoryInputSchema,
  telemetryContactInventoryClockSchema, telemetryContactInventoryResultSchema } from './telemetry-radio-schemas.js';

const immutable = value => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') immutable(child);
  return Object.freeze(value);
};

/** Bounded in-memory protocol reducer; no transport, timer, credentials or store. */
export function createTelemetryContactInventory(options) {
  assertTelemetryRadioInput(telemetryContactInventoryOptionsSchema, options);
  const { targetPublicKey, radius, startedAt, timeoutMs } = options;
  if (targetPublicKey.startsWith('00000000')) throw new Error('Unsafe telemetry login target prefix');
  const seen = new Set();
  let lastNow = startedAt, expected = null, contact = null, terminal = null;
  const checked = value => immutable(checkedTelemetryRadioResult(telemetryContactInventoryResultSchema, value));
  const fail = reason => {
    terminal = checked({ status: 'unavailable', reason });
    seen.clear(); contact = null;
    return terminal;
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
    return terminal ?? checked({ status: 'pending', contactCount: seen.size });
  }
  function accept(input) {
    if (!isTelemetryRadioInput(telemetryContactInventoryInputSchema, input)) return fail('invalid-contact-inventory-frame');
    const current = snapshot({ monotonicNow: input.monotonicNow });
    if (current.status === 'unavailable') return current;
    const parsed = parseTelemetryInventoryFrame({ bytes: input.bytes });
    if (parsed.status === 'ignored') return current;
    if (parsed.status !== 'accepted') return fail(parsed.reason);
    if (current.status === 'complete') return fail('inventory-protocol-error');
    const { envelope } = parsed;
    if (envelope.kind === 'error') return fail(envelope.errorCode === 1 ? 'preflight-unsupported' : 'preflight-failed');
    if (envelope.kind === 'start') {
      if (expected !== null) return fail('inventory-protocol-error');
      expected = envelope.count;
    } else if (envelope.kind === 'contact') {
      if (expected === null || seen.size >= expected) return fail('inventory-protocol-error');
      if (seen.has(envelope.publicKey)) return fail('duplicate-contact');
      seen.add(envelope.publicKey);
      if (envelope.publicKey !== targetPublicKey && (envelope.publicKey.startsWith(targetPublicKey.slice(0, 8))
        || envelope.publicKey.startsWith(targetPublicKey.slice(0, 12)))) return fail('login-prefix-collision');
      if (envelope.publicKey === targetPublicKey) {
        if (envelope.contactType !== 2) return fail('non-repeater-contact');
        const decoded = decodeTelemetryContactPath({ encodedPathLength: envelope.encodedPathLength,
          pathBytes: envelope.pathBytes, radius });
        if (decoded.status !== 'direct-route') return fail(decoded.reason);
        contact = { targetPublicKey, contactType: 2, route: decoded.route };
      }
    } else {
      if (expected === null || seen.size !== expected) return fail('inventory-protocol-error');
      if (contact === null) return fail('contact-missing');
      terminal = checked({ status: 'complete', contactCount: seen.size, contact,
        prefixCollisionChecked: true, provenance: 'companion-contact-inventory' });
      seen.clear(); contact = null;
      return terminal;
    }
    return checked({ status: 'pending', contactCount: seen.size });
  }
  return Object.freeze({ accept, snapshot });
}
