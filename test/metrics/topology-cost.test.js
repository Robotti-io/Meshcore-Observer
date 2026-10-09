import { test } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { MetricsStore } from '../../src/metrics/store.js';
import { topologyCanonical } from '../../src/metrics/topology-history.js';

const OBSERVER = 'CD'.repeat(32); const HOUR = 3600000;
function start(store) {
  return store.beginObserverRun({ runId: randomUUID(), startedAt: 0, observedAt: 0, observedDurationMs: 0,
    appVersion: '2.4.0', nodeVersion: process.version, platform: process.platform, architecture: process.arch });
}
function evidence(runId, index) {
  return { runId, observerPublicKey: OBSERVER, receivedAt: 1000, route: 1, kind: 'flood-traversed', payloadVersion: 0,
    hashWidth: 3, prefixes: [index.toString(16).padStart(6, '0').toUpperCase(), 'FE0100', 'FE0200'],
    transportCodes: null, containsRepeatedPrefix: false };
}
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];

test('20k paths/100k receptions/4k identities meet local write/read targets with indexed bounded queries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'topology-cost-')); const path = join(dir, 'metrics.sqlite3');
  let store;
  try {
    store = new MetricsStore({ dbPath: path }); const first = start(store); store.close(); store = null;
    // Only fixture preparation is batched. The measurements below use normal
    // owned-store transactions and synchronous commit durability on this host.
    const db = new DatabaseSync(path);
    let pageBefore;
    try {
      db.exec('PRAGMA foreign_keys=ON; BEGIN');
      const insert = db.prepare(`INSERT INTO topology_paths(digest,canonical,observer_public_key,route,kind,hash_width,
        transport_code_1,transport_code_2,path_hex,repeated_prefix,reception_count,first_received_at,last_received_at)
        VALUES(?,?,?,1,'flood-traversed',3,NULL,NULL,?,0,5,1000,1000)`);
      const hop = db.prepare('INSERT INTO topology_path_hops VALUES(?,?,3,?,?)');
      const observation = db.prepare('INSERT INTO topology_observations(path_id,run_id,received_at) VALUES(?,?,1000)');
      for (let i = 0; i < 20000; i++) {
        const item = evidence(first.runId, i); const canonical = topologyCanonical(item);
        const id = Number(insert.run(createHash('sha256').update(canonical).digest('hex'), canonical, OBSERVER, item.prefixes.join('')).lastInsertRowid);
        item.prefixes.forEach((prefix, position) => hop.run(id, position, prefix, 3 - position));
        for (let n = 0; n < 5; n++) observation.run(id, first.runId);
      }
      const node = db.prepare('INSERT INTO nodes(public_key_hex,name,type,first_heard_at,last_heard_at) VALUES(?,?,?,0,0)');
      for (let i = 0; i < 3998; i++) node.run(i.toString(16).padStart(6, '0').padEnd(64, 'A'), `Relay ${i}`, 'REPEATER');
      node.run('FE0100'.padEnd(64, 'A'), null, 'REPEATER'); node.run('FE0100'.padEnd(64, 'B'), null, 'CHAT');
      db.exec('COMMIT'); pageBefore = db.prepare('PRAGMA page_count').get().page_count;
      for (const [sql, args, index] of [
        ['SELECT count(*) FROM topology_observations WHERE received_at>=? AND received_at<?', [1000, 1001], 'idx_topology_observations_at'],
        ['SELECT count(*) FROM topology_observations WHERE path_id=? AND received_at>=? AND received_at<?', [1, 1000, 1001], 'idx_topology_observations_path_at'],
        ...[1, 2, 3].map((width) => [`SELECT count(*) FROM nodes WHERE upper(substr(public_key_hex,1,${width * 2}))=?`, ['00'.repeat(width)], `idx_nodes_prefix_${width}`])
      ]) assert.match(JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)), new RegExp(index));
    } finally { db.close(); }
    store = new MetricsStore({ dbPath: path }); const run = start(store);
    const writeTimes = []; const firstMaxTimes = [];
    for (let i = 0; i < 200; i++) {
      const before = performance.now(); store.recordTopologyObservation(evidence(run.runId, i)); writeTimes.push(performance.now() - before);
    }
    for (const [width, count] of [[1, 63], [2, 32], [3, 21]]) for (let n = 0; n < 20; n++) {
      const item = { ...evidence(run.runId, 0), hashWidth: width,
        prefixes: Array.from({ length: count }, (_, i) => ((i + n * count) % (256 ** width)).toString(16).padStart(width * 2, '0').toUpperCase()) };
      const before = performance.now(); store.recordTopologyObservation(item); firstMaxTimes.push(performance.now() - before);
    }
    const readCosts = {};
    for (const [name, read] of [
      ['paths', () => store.queryTopologyPaths({ limit: 200 })],
      ['observations', () => store.queryTopologyObservations({ start: 0, end: 2000, limit: 200 })],
      ['rangeCounts', () => store.queryTopologyRouteCounts({ start: 0, end: 2000, limit: 200 })],
      ['prefixes', () => store.queryTopologyPrefixIdentities({ hashWidth: 3, prefix: 'FE0100', limit: 200 })],
      ['positions', () => store.getTopologyPath({ pathId: 1 })],
      ['proximity', () => store.queryObservedProximity({ observerPublicKey: OBSERVER, now: 2000, windowMs: 72 * HOUR, radius: 3, limit: 200 })]
    ]) {
      const times = []; for (let i = 0; i < 20; i++) { const before = performance.now(); const result = read(); times.push(performance.now() - before);
        if (name === 'proximity') { assert.equal(result.candidates.length, 200); assert.ok(result.candidates.every((row) => row.alternatePaths.length <= 3));
          assert.ok(result.candidates.every((row) => !row.publicKeyHex.startsWith('FE0100'))); }
      }
      readCosts[name] = Number(p95(times).toFixed(3));
    }
    store.close(); store = null;
    const inspect = new DatabaseSync(path);
    const pageAfter = inspect.prepare('PRAGMA page_count').get().page_count;
    const pageSize = inspect.prepare('PRAGMA page_size').get().page_size;
    assert.deepEqual(inspect.prepare('PRAGMA foreign_key_check').all(), []); inspect.close();
    console.info('Topology cost fixture:', { paths: 20000, receptions: 100000, inventory: 4000,
      writeP95Ms: Number(p95(writeTimes).toFixed(3)), firstMaximumPathP95Ms: Number(p95(firstMaxTimes).toFixed(3)),
      readP95Ms: readCosts, fixtureBytes: pageBefore * pageSize, measuredGrowthBytes: (pageAfter - pageBefore) * pageSize,
      platform: process.platform, node: process.version, targets: { writeP95Ms: 10, readP95Ms: 100 } });
    assert.ok(p95(writeTimes) < 10, 'local normal write p95 target');
    assert.ok(p95(firstMaxTimes) < 10, 'local first maximum-path write p95 target');
    for (const [name, cost] of Object.entries(readCosts)) assert.ok(cost < 100, `${name} local read p95 target`);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30000);
