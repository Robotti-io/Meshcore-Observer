import { test } from 'vitest';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { createTelemetryFixture } from '../fixtures/telemetry-store.js';
import { SCOPE, SENSOR, POLICY, WINDOW, reservation, completion } from '../fixtures/telemetry-poll.js';
import { TELEMETRY_CANDIDATE_SQL, TELEMETRY_ELIGIBILITY_SQL } from '../../src/metrics/telemetry-poll-state.js';
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const ms = number => Number(number.toFixed(3));

test('20k scoped direct markers plus 10k flood paths preserve indexed keyset/exact reads and atomic write cost', () => {
  const f = createTelemetryFixture(), key = i => i.toString(16).toUpperCase().padStart(64, '0');
  try {
    f.close(); f.inspect(db => {
      db.exec('BEGIN');
      const node = db.prepare("INSERT INTO nodes(public_key_hex,name,type,first_heard_at,last_heard_at) VALUES(?,NULL,'REPEATER',900,900)");
      const direct = db.prepare("INSERT INTO telemetry_direct_evidence VALUES(?,?,?,900,?,'verified-advert',1)");
      for (let i = 1; i <= 20000; i++) { node.run(key(i)); direct.run(SCOPE.observerPublicKey, key(i), f.run.runId, 'ab'.repeat(32)); }
      const path = db.prepare(`INSERT INTO topology_paths(digest,canonical,observer_public_key,route,kind,hash_width,
        path_hex,repeated_prefix,reception_count,first_received_at,last_received_at) VALUES(?,?,?,1,'flood-traversed',3,'000000',0,1,900,900)`);
      const hop = db.prepare('INSERT INTO topology_path_hops VALUES(?,0,3,?,1)');
      const receipt = db.prepare('INSERT INTO topology_observations(path_id,run_id,received_at) VALUES(?,?,900)');
      // Deliberately dense ambiguous prefixes exercise rejection without hydrating history.
      for (let i = 0; i < 10000; i++) { const id = Number(path.run(randomUUID(), 'synthetic', SCOPE.observerPublicKey).lastInsertRowid);
        hop.run(id, '000000'); receipt.run(id, f.run.runId); }
      db.exec('COMMIT');
      const args = { observer: SCOPE.observerPublicKey, now: 1000, cutoff: 1000 - WINDOW, radius: 2, after: '', limit: 200 };
      const plan = db.prepare('EXPLAIN QUERY PLAN '+TELEMETRY_CANDIDATE_SQL).all(args).map(row => row.detail).join('\n');
      assert.match(plan, /idx_telemetry_direct_fresh/); assert.match(plan, /idx_topology_paths_observer_kind_at/);
      for (const width of [1, 2, 3]) assert.match(plan, new RegExp('idx_nodes_prefix_'+width));
      const exactPlan = db.prepare('EXPLAIN QUERY PLAN '+TELEMETRY_ELIGIBILITY_SQL).all({ observer: SCOPE.observerPublicKey,
        target: key(1), now: 1000, cutoff: 1000 - WINDOW, radius: 2 }).map(row => row.detail).join('\n');
      assert.match(exactPlan, /idx_topology_hops_prefix/);
      for (const width of [1, 2, 3]) assert.match(exactPlan, new RegExp('SEARCH nodes USING COVERING INDEX idx_nodes_prefix_'+width));
      assert.doesNotMatch(TELEMETRY_CANDIDATE_SQL, /normalized_json|record_json|COUNT\(\*\).*telemetry_auth/is);
    });
    f.open(); f.start();
    const candidateCosts = [], exactCosts = [], stateCosts = [], reserveCosts = [], completeCosts = [];
    const query = { observerPublicKey: SCOPE.observerPublicKey, now: 1000, windowMs: WINDOW, radius: 2, limit: 200 };
    for (let i = 0; i < 20; i++) {
      let before = performance.now(); const page = f.store.queryTelemetryPollCandidates(query); candidateCosts.push(performance.now() - before);
      assert.equal(page.candidates.length, 200);
      before = performance.now(); assert.ok(f.store.getTelemetryEligibility({ observerPublicKey: SCOPE.observerPublicKey,
        now: 1000, windowMs: WINDOW, radius: 2, targetPublicKey: key(i + 1) }));
      exactCosts.push(performance.now() - before);
    }
    for (let i = 1; i <= 200; i++) {
      const r = reservation(f, 1000 + i * 10, SENSOR, { targetPublicKey: key(i) });
      let before = performance.now(); assert.equal(f.store.reserveTelemetryPoll(r).reserved, true); reserveCosts.push(performance.now() - before);
      before = performance.now(); assert.equal(f.store.completeTelemetryPoll(completion(f, r)).completed, true); completeCosts.push(performance.now() - before);
      before = performance.now(); assert.ok(f.store.getTelemetryPollState({ observerPublicKey: SCOPE.observerPublicKey, targetPublicKey: key(i), variant: SENSOR }));
      stateCosts.push(performance.now() - before);
    }
    const costs = { candidateReadP95Ms: ms(p95(candidateCosts)), exactReadP95Ms: ms(p95(exactCosts)),
      stateReadP95Ms: ms(p95(stateCosts)), reservationWriteP95Ms: ms(p95(reserveCosts)), atomicTerminalWriteP95Ms: ms(p95(completeCosts)) };
    console.info('Telemetry polling cost fixture:', { markers: 20000, floodPaths: 10000, costs,
      policy: POLICY, node: process.version, platform: process.platform, targets: { writeP95Ms: 10, ordinaryReadP95Ms: 100 } });
    for (const value of [p95(candidateCosts), p95(exactCosts), p95(stateCosts)]) assert.ok(value < 100, `bounded read ${value}ms exceeds 100ms`);
    for (const value of [p95(reserveCosts), p95(completeCosts)]) assert.ok(value < 10, `durable write ${value}ms exceeds 10ms`);
  } finally { f.cleanup(); }
}, 30000);
