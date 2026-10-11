import { randomUUID } from 'node:crypto';
import { TELEMETRY_STATE_DEFAULT_POLICY } from '../../src/telemetry/poll-state-schemas.js';
import { TELEMETRY_OBSERVER, TELEMETRY_TARGET, telemetryResult } from './telemetry-store.js';
export const SCOPE = { observerPublicKey: TELEMETRY_OBSERVER, targetPublicKey: TELEMETRY_TARGET };
export const POLICY = TELEMETRY_STATE_DEFAULT_POLICY;
export const AUTH = { component: 'guest-login', params: {} };
export const SENSOR = { component: 'sensors', params: { permissionMask: 0 } };
export const WINDOW = 72 * 3600000;
export const evidence = (run, target = TELEMETRY_TARGET, receivedAt = 900, observer = TELEMETRY_OBSERVER) => ({
  observerPublicKey: observer, targetPublicKey: target, runId: run.runId, receivedAt,
  eventDigest: 'ab'.repeat(32), hopCount: 0, provenance: 'verified-advert' });
export function observe(f, target = TELEMETRY_TARGET, receivedAt = 900, observer = TELEMETRY_OBSERVER) {
  f.store.recordVerifiedAdvert({ publicKeyHex: target, name: null, type: 'REPEATER', receivedAt,
    hopCount: 0, eventDigest: target.toLowerCase() });
  f.store.recordTelemetryDirectEvidence(evidence(f.run, target, receivedAt, observer));
}
export const reservation = (f, reservedAt = 1000, variant = SENSOR, extra = {}) => ({ ...SCOPE,
  runId: f.run.runId, requestId: randomUUID(), variant, reservedAt, policy: { ...POLICY }, radius: 2, windowMs: WINDOW, ...extra });
export function authRecord(r, extra = {}) {
  return { context: { requestId: r.requestId, ...SCOPE, observerPublicKey: r.observerPublicKey,
    targetPublicKey: r.targetPublicKey, operation: 'guest-login', params: {}, generation: 1 },
  dispatchedAt: r.reservedAt, completedAt: r.reservedAt + 1, status: 'completed', reason: null, route: 'direct',
  proof: { status: 'guest-proof', publicKeyPrefix: r.targetPublicKey.slice(0, 12), serverTimestamp: 100,
    permissions: 0, isAdmin: false, firmwareLevel: 2, provenance: 'companion-prefix-attributed' }, ...extra };
}
export const authCompletion = (r, extra) => ({ runId: r.runId, record: authRecord(r, extra), policy: r.policy });
export const completion = (f, r, extra = {}) => ({ policy: r.policy,
  result: telemetryResult(f.run, { observer: r.observerPublicKey, target: r.targetPublicKey, requestId: r.requestId,
    component: r.variant.component, observedAt: r.reservedAt + 1, startedAt: r.reservedAt, ...extra }) });
export const snapshot = db => Object.fromEntries(['telemetry_direct_evidence', 'telemetry_auth_outcomes', 'telemetry_poll_state',
  'telemetry_query_outcomes', 'telemetry_observations', 'telemetry_latest'].map(table => [table,
  db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all().map(row => ({ ...row }))]));
