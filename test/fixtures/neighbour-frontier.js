import { telemetryResult, telemetryDiagnostic, TELEMETRY_OBSERVER } from './telemetry-store.js';
import { neighbourPage } from './telemetry-wire.js';

export const frontierKey = prefix => prefix + '00'.repeat(30);
export function frontierNode(f, prefix, type = 'REPEATER') {
  const key = frontierKey(prefix);
  f.store.upsertNode({ publicKeyHex: key, name: prefix, type, heardAt: 900 });
  return key;
}
export function neighbourReport(f, reporter, targets, { path = [], at = 1000, observer = TELEMETRY_OBSERVER,
  trace = 'response', status, ages = [], prefixLength = 32 } = {}) {
  const result = telemetryResult(f.run, { component: 'neighbours', target: reporter, observer,
    observedAt: at, prefixLength, count: 3, ...(status ? { status } : {}), route: 'direct',
    body: neighbourPage(targets.map((key, i) => ({ prefix: key.slice(0, prefixLength * 2), age: ages[i] ?? 0, snr: -16 })), { prefixLength }) });
  f.store.recordTelemetryResult(result);
  f.store.recordTelemetryRequestDiagnostic(telemetryDiagnostic(f.run, { requestId: result.outcome.requestId,
    observerPublicKey: observer, targetPublicKey: reporter, operation: 'neighbours', routeCandidatePath: path,
    startedAt: at - 1, dispatchedAt: at - 1, completedAt: at + 1, traceOutcome: path.length ? trace : null }));
  return result;
}
