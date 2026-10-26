import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createTelemetryFixture, TELEMETRY_OBSERVER as OBSERVER } from '../fixtures/telemetry-store.js';
import { WINDOW, reservation, SENSOR } from '../fixtures/telemetry-poll.js';
import { frontierKey, frontierNode, neighbourReport } from '../fixtures/neighbour-frontier.js';

const active = [];
function fixture() { const f = createTelemetryFixture(); active.push(f); return f; }
afterEach(() => { for (const f of active.splice(0)) f.cleanup(); });
const query = (extra = {}) => ({ observerPublicKey: OBSERVER, now: 2000, windowMs: WINDOW, radius: 3, ...extra });
const eligible = (f, target, extra) => f.store.getTelemetryEligibility({ ...query(extra), targetPublicKey: target });
const route = (f, target, extra) => f.store.getTopologyOutboundRoute({ ...query(extra), targetPublicKey: target });

test('a successful direct neighbour report enables the next known layer without a passive receipt', () => {
  const f = fixture(), anchor = frontierNode(f, 'E85C'), target = frontierNode(f, '1100');
  assert.equal(eligible(f, target), null);
  neighbourReport(f, anchor, [target]);
  assert.deepEqual(f.store.queryTelemetryPollCandidates(query()).candidates.map(r => [r.targetPublicKey, r.distance]), [[target, 2]]);
  assert.equal(eligible(f, target).outboundRouteVerified, false);
  assert.deepEqual(route(f, target).path, ['E85C']);
  const r = reservation(f, 2000, SENSOR, { targetPublicKey: target, radius: 2 });
  assert.equal(f.store.reserveTelemetryPoll(r).reserved, true, 'the same evidence must pass the atomic final eligibility check');
  f.close(); f.open(); f.start(2001);
  assert.equal(eligible(f, target, { now: 2002 }).distance, 2, 'original-time evidence survives restart without granting a session');
});

test('expansion waits for the next reporter exchange and includes the destination in the radius', () => {
  const f = fixture(), anchor = frontierNode(f, 'E85C'), relay = frontierNode(f, '2200'), target = frontierNode(f, '1100');
  neighbourReport(f, anchor, [relay]);
  assert.equal(eligible(f, target), null);
  neighbourReport(f, relay, [target], { path: ['E85C'], at: 1100 });
  assert.equal(eligible(f, target).distance, 3);
  assert.deepEqual(route(f, target).path, ['E85C', '2200']);
  assert.equal(eligible(f, target, { radius: 2 }), null);
  assert.equal(route(f, target, { radius: 2 }).status, 'unavailable');
  assert.equal(f.store.reserveTelemetryPoll(reservation(f, 2000, SENSOR, { targetPublicKey: target, radius: 2 })).reason, 'ineligible');
});

test('distance/key cursor visits inner layers first and deduplicates reports against passive evidence', () => {
  const f = fixture(), anchor = frontierNode(f, 'E85C'), near = frontierNode(f, 'FF00'), far = frontierNode(f, '1100');
  neighbourReport(f, anchor, [near, far]);
  f.store.recordTopologyObservation({ runId: f.run.runId, observerPublicKey: OBSERVER, receivedAt: 900,
    route: 1, kind: 'flood-traversed', payloadVersion: 0, hashWidth: 2, prefixes: ['FF00'],
    transportCodes: null, containsRepeatedPrefix: false });
  const first = f.store.queryTelemetryPollCandidates(query({ limit: 1 }));
  assert.deepEqual(first.candidates.map(r => [r.targetPublicKey, r.distance]), [[near, 1]]);
  const second = f.store.queryTelemetryPollCandidates(query({ limit: 1, afterPublicKey: first.nextCursor, afterDistance: first.nextDistance }));
  assert.deepEqual(second.candidates.map(r => [r.targetPublicKey, r.distance]), [[far, 2]]);
  const end = f.store.queryTelemetryPollCandidates(query({ afterPublicKey: second.nextCursor, afterDistance: second.nextDistance }));
  assert.deepEqual(end.candidates, []); assert.equal(end.exhausted, true);
  assert.throws(() => f.store.queryTelemetryPollCandidates(query({ afterDistance: 1 })), /Invalid telemetry polling data/);
});

for (const scenario of ['other-observer', 'future', 'stale', 'aged-at-cutoff', 'partial', 'unknown', 'chat',
  'colliding-target', 'colliding-reporter', 'self', 'loop', 'unanchored', 'untraced', 'anomalous-run']) {
  test(`neighbour frontier rejects ${scenario} evidence at discovery and reservation`, () => {
    const f = fixture(), anchor = frontierNode(f, 'E85C'), target = frontierNode(f, '1100');
    const options = {};
    if (scenario === 'other-observer') options.observer = 'EE'.repeat(32);
    if (scenario === 'future') options.at = 2100;
    if (scenario === 'stale') options.at = 1000;
    if (scenario === 'aged-at-cutoff') options.ages = [WINDOW / 1000 - 1];
    if (scenario === 'partial') options.status = 'partial';
    if (scenario === 'unknown') { neighbourReport(f, anchor, [frontierKey('3300')]); }
    else if (scenario === 'self') neighbourReport(f, anchor, [OBSERVER]);
    else if (scenario === 'loop') neighbourReport(f, anchor, [anchor]);
    else if (scenario === 'unanchored' || scenario === 'untraced') {
      const relay = frontierNode(f, '2200');
      if (scenario === 'untraced') neighbourReport(f, anchor, []);
      neighbourReport(f, relay, [target], { path: ['E85C'], trace: scenario === 'untraced' ? 'trace-timeout' : 'response' });
    } else if (scenario === 'partial') assert.throws(() => neighbourReport(f, anchor, [target], options), /Invalid telemetry data/);
    else neighbourReport(f, anchor, [target], options);
    if (scenario === 'chat') frontierNode(f, '1100', 'CHAT');
    if (scenario.startsWith('colliding')) f.store.upsertNode({ publicKeyHex: (scenario === 'colliding-target' ? '1100' : 'E85C') + '01'.repeat(30),
      name: null, type: 'CHAT', heardAt: 900 });
    if (scenario === 'anomalous-run') f.store.checkpointObserverRun({ runId: f.run.runId, observedAt: 2000, observedDurationMs: 5000 });
    const now = scenario === 'stale' ? WINDOW + 1000 : 2000;
    assert.equal(eligible(f, target, { now }), null);
    assert.deepEqual(f.store.queryTelemetryPollCandidates(query({ now })).candidates, []);
    assert.equal(f.store.reserveTelemetryPoll(reservation(f, now, SENSOR, { targetPublicKey: target, radius: 3 })).reserved, false);
  });
}

test('alternate anchored neighbour paths survive exclusion of a failed preferred path', () => {
  const f = fixture(), a = frontierNode(f, 'E85C'), b = frontierNode(f, '2200'), target = frontierNode(f, '1100');
  neighbourReport(f, a, [target]); neighbourReport(f, a, [target], { at: 1200 }); neighbourReport(f, b, [target]);
  assert.deepEqual(route(f, target).path, ['E85C']);
  assert.deepEqual(route(f, target, { excludedPaths: [['E85C']] }).path, ['2200']);
});

test('short retained neighbour prefixes use bounded indexed resolution and only the newest 512 pages expand', () => {
  const f = fixture(), anchor = frontierNode(f, 'E85C'), old = frontierNode(f, '1100'), target = frontierNode(f, '2200');
  f.close(); f.inspect(db => {
    db.exec('BEGIN');
    const node = db.prepare("INSERT INTO nodes(public_key_hex,name,type,first_heard_at,last_heard_at) VALUES(?,NULL,'REPEATER',900,900)");
    for (let i = 1; i <= 20000; i++) node.run(i.toString(16).toUpperCase().padStart(64, '0'));
    db.exec('COMMIT');
  }); f.open(); f.start();
  neighbourReport(f, anchor, [old], { prefixLength: 8 });
  for (let i = 1; i <= 512; i++) neighbourReport(f, anchor, [target], { at: 1000 + i, prefixLength: 8 });
  const costs = [];
  for (let i = 0; i < 5; i++) {
    const before = performance.now(), page = f.store.queryTelemetryPollCandidates(query());
    costs.push(performance.now() - before);
    assert.deepEqual(page.candidates.map(r => r.targetPublicKey), [target]);
  }
  console.info('Neighbour frontier cost fixture:', { nodes: 20003, savedPages: 513, sourcePageLimit: 512,
    maxReadMs: Number(Math.max(...costs).toFixed(3)) });
  assert.ok(Math.max(...costs) < 100, 'bounded indexed neighbour expansion exceeds the ordinary 100ms read budget');
  assert.equal(eligible(f, old), null);
  assert.equal(eligible(f, target).distance, 2);
}, 30000);
