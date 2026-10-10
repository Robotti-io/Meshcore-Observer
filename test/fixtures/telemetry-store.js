import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { MetricsStore } from '../../src/metrics/store.js';
import { parseStatusResponseBody } from '../../src/telemetry/status-parser.js';
import { parseSensorResponseBody } from '../../src/telemetry/sensor-parser.js';
import { parseNeighbourResponseBody } from '../../src/telemetry/neighbour-parser.js';
import { telemetryWire, telemetryBytes, telemetryInput } from './telemetry-wire.js';

export const TELEMETRY_OBSERVER = 'AB'.repeat(32), TELEMETRY_TARGET = 'CD'.repeat(32);
const parsers = { status: parseStatusResponseBody, sensors: parseSensorResponseBody, neighbours: parseNeighbourResponseBody };
const bodies = { status: telemetryWire.status48, sensors: telemetryWire.sensors, neighbours: telemetryWire.neighbours };
export function startTelemetryRun(store, at = 0) {
  return store.beginObserverRun({ runId: randomUUID(), startedAt: at, observedAt: at, observedDurationMs: 0,
    appVersion: '2.4.0', nodeVersion: process.version, platform: process.platform, architecture: process.arch });
}
export function createTelemetryFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-store-')), path = join(dir, 'metrics.sqlite3');
  const f = { path, store: new MetricsStore({ dbPath: path }) };
  f.close = () => { f.store?.close(); f.store = null; };
  f.open = () => { f.store = new MetricsStore({ dbPath: path }); return f.store; };
  f.start = at => { f.run = startTelemetryRun(f.store, at); return f.run; };
  f.inspect = work => { if (f.store) throw new Error('Close owned fixture before inspection');
    const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
    try { return work(db); } finally { db.close(); } };
  f.cleanup = () => { f.close(); rmSync(dir, { recursive: true, force: true }); };
  f.start(); return f;
}
export function telemetryResult(run, options = {}) {
  const component = options.component ?? 'sensors', at = options.observedAt ?? 1000;
  const body = options.body ?? telemetryBytes(bodies[component]);
  const input = telemetryInput(component, body, { ...options, observedAt: at });
  const observation = parsers[component](input).observation;
  const status = options.status ?? (observation.quality === 'decoded' ? 'answered' : 'partial');
  const accepted = ['answered', 'partial'].includes(status);
  return { decoderVersion: 1, outcome: {
    requestId: options.requestId ?? randomUUID(), runId: run.runId,
    observerPublicKey: options.observer ?? TELEMETRY_OBSERVER, targetPublicKey: options.target ?? TELEMETRY_TARGET,
    variant: input.response.variant, startedAt: options.startedAt ?? Math.max(0, at - 1), completedAt: options.completedAt ?? at + 1,
    receivedAt: accepted ? at : options.receivedAt ?? null, clockAnomaly: options.clockAnomaly ?? false,
    tag: options.tag ?? 0x12345678, route: options.route ?? 'direct', status,
    reason: options.reason ?? (accepted ? null : status === 'failed' ? 'response-timeout' : 'unsupported')
  }, ...(accepted ? { observation } : {}) };
}
export function telemetrySnapshot(db) {
  return Object.fromEntries(['telemetry_query_outcomes', 'telemetry_observations', 'telemetry_latest']
    .map(table => [table, db.prepare('SELECT * FROM '+table).all().map(row => ({ ...row }))]));
}

// Synthetic lifecycle corpus spanning each supported interpretation and
// failure/partial/empty scope. No producer or deployed-radio fixture implied.
export function telemetryLifecycleResults(run, at) {
  return [
    telemetryResult(run,{component:'status',observedAt:at}),
    telemetryResult(run,{component:'status',layout:'current56',body:telemetryBytes(telemetryWire.status56),observedAt:at+1}),
    telemetryResult(run,{component:'status',evidence:'unknown',observedAt:at+2}),
    telemetryResult(run,{observedAt:at+3}),
    telemetryResult(run,{body:[...telemetryBytes(telemetryWire.sensors),5,250],observedAt:at+4}),
    telemetryResult(run,{status:'failed',observedAt:at+5}),
    telemetryResult(run,{status:'unsupported',observedAt:at+6}),
    telemetryResult(run,{component:'neighbours',observedAt:at+7}),
    telemetryResult(run,{component:'neighbours',body:[0,0,0,0],observedAt:at+8}),
    telemetryResult(run,{component:'neighbours',offset:1,body:[1,0,0,0],observedAt:at+9})
  ];
}
