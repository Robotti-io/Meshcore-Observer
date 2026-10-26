import { compileSchema } from '../validation/ajv.js';
import { topologyNeighbourQuerySchema } from '../nodes/topology-schemas.js';
import { assertTelemetryInput } from '../telemetry/telemetry-validation.js';
import { telemetryObservationSchema, telemetryRequestDiagnosticSchema } from '../telemetry/telemetry-schemas.js';

const validQuery = compileSchema(topologyNeighbourQuerySchema);

/** Read-only frontier on the owned connection. Shared by discovery, reservation
 * rechecks and route selection so a report never bypasses the routing guards. */
export function createTelemetryNeighbourFrontier(db) {
  const direct = db.prepare(`SELECT o.target_public_key AS publicKeyHex,count(*) AS anchorSuccessCount
    FROM telemetry_query_outcomes o JOIN observer_runs r ON r.id=o.run_id
    JOIN telemetry_request_diagnostics d ON d.request_id=o.request_id
    JOIN nodes n ON n.public_key_hex=o.target_public_key
    WHERE o.observer_public_key=? AND o.status IN ('answered','partial') AND o.route='direct'
      AND o.clock_anomaly=0 AND o.received_at>? AND o.received_at<=?
      AND d.observer_public_key=o.observer_public_key AND d.target_public_key=o.target_public_key
      AND d.run_id=o.run_id AND d.status='completed' AND d.clock_anomaly=0
      AND d.operation IN ('status','telemetry','neighbours')
      AND json_array_length(json_extract(d.diagnostic_json,'$.routeCandidatePath'))=0
      AND r.wall_time_anomaly=0 AND o.received_at>=r.started_at AND n.type='REPEATER'
    GROUP BY o.target_public_key ORDER BY o.target_public_key`);
  const rows = db.prepare(`SELECT upper(o.target_public_key) AS reporterPublicKey,
      a.normalized_json AS normalizedJson,d.diagnostic_json AS diagnosticJson
    FROM telemetry_observations a JOIN telemetry_query_outcomes o ON o.request_id=a.request_id
    JOIN telemetry_request_diagnostics d ON d.request_id=o.request_id
    JOIN observer_runs r ON r.id=o.run_id
    WHERE a.observer_public_key=? AND a.component='neighbours'
      AND a.outcome_status='answered' AND o.status='answered' AND o.clock_anomaly=0
      AND a.quality='decoded' AND a.latest_eligible=1 AND a.observation_time_conflict=0
      AND a.observed_at>? AND a.observed_at<=? AND a.observed_at>=r.started_at AND r.wall_time_anomaly=0
      AND d.run_id=o.run_id AND d.observer_public_key=o.observer_public_key AND d.target_public_key=o.target_public_key
      AND d.operation='neighbours' AND d.status='completed' AND d.clock_anomaly=0
      AND d.completed_at>? AND d.completed_at<=?
    ORDER BY a.observed_at DESC,o.request_id DESC LIMIT 512`);
  const exact = db.prepare('SELECT public_key_hex AS publicKeyHex,type FROM nodes WHERE public_key_hex=?');
  // Canonical uppercase fixed-length keys permit an indexed lexical range for
  // every supported prefix width, including retained shorter neighbour pages.
  const prefixRange = db.prepare(`SELECT public_key_hex AS publicKeyHex,type FROM nodes
    WHERE public_key_hex>=? AND public_key_hex<=? ORDER BY public_key_hex LIMIT 2`);
  const resolve = prefix => prefix.length === 64 ? exact.all(prefix)
    : prefixRange.all(prefix.padEnd(64, '0'), prefix.padEnd(64, 'F'));
  function anchors(query) {
    if (!validQuery(query)) throw new Error('Invalid telemetry neighbour query');
    return new Map(direct.all(query.observerPublicKey, query.now - query.windowMs, query.now)
      .map(row => [row.publicKeyHex, row.anchorSuccessCount]));
  }
  function frontier(query, adjacent) {
    if (!validQuery(query)) throw new Error('Invalid telemetry neighbour query');
    adjacent ??= anchors(query);
    const routes = [];
    let rejected = false;
    if (!adjacent.size || query.radius < 2) return { routes, rejected };
    const cutoff = query.now - query.windowMs;
    for (const row of rows.all(query.observerPublicKey, cutoff, query.now, cutoff, query.now)) {
      let observation, diagnostic;
      try {
        observation = JSON.parse(row.normalizedJson); diagnostic = JSON.parse(row.diagnosticJson);
        assertTelemetryInput(telemetryObservationSchema, observation);
        assertTelemetryInput(telemetryRequestDiagnosticSchema, diagnostic);
      } catch { continue; }
      if (observation.variant.component !== 'neighbours' || observation.quality !== 'decoded'
        || diagnostic.operation !== 'neighbours' || diagnostic.status !== 'completed' || diagnostic.clockAnomaly
        || diagnostic.observerPublicKey !== query.observerPublicKey || diagnostic.targetPublicKey !== row.reporterPublicKey
        || !Array.isArray(diagnostic.routeCandidatePath)) continue;
      const basePath = diagnostic.routeCandidatePath;
      // Include the reporting relay AND the destination in the radius.
      if (basePath.length + 2 > query.radius || basePath.length + 1 > 31
        || (basePath.length && diagnostic.traceOutcome !== 'response')) continue;
      const path = [...basePath, row.reporterPublicKey.slice(0, 4)], keys = [];
      let safe = true;
      for (const token of path) {
        const matches = resolve(token);
        if (matches.length !== 1 || matches[0].type !== 'REPEATER'
          || matches[0].publicKeyHex === query.observerPublicKey || keys.includes(matches[0].publicKeyHex)) { safe = false; break; }
        keys.push(matches[0].publicKeyHex);
      }
      if (!safe || keys.at(-1) !== row.reporterPublicKey || !adjacent.has(keys[0])) { rejected = true; continue; }
      const ageMs = query.now - observation.observedAt;
      if (ageMs < 0 || ageMs >= query.windowMs) continue;
      for (const entry of observation.data.entries) {
        if (entry.prefix.length < 4 || entry.heardSecondsAgo * 1000 >= query.windowMs - ageMs) continue;
        const matches = resolve(entry.prefix);
        if (matches.length !== 1 || matches[0].type !== 'REPEATER') continue;
        const targetPublicKey = matches[0].publicKeyHex;
        if (targetPublicKey === query.observerPublicKey || keys.includes(targetPublicKey)) continue;
        // Even a full-key neighbour must be unambiguous in the two-byte
        // contact/trace path before it can extend the next outward layer.
        const routeMatches = resolve(targetPublicKey.slice(0, 4));
        if (routeMatches.length !== 1 || routeMatches[0].publicKeyHex !== targetPublicKey) continue;
        routes.push({ targetPublicKey, path, distance: path.length + 1, receivedAt: observation.observedAt });
      }
    }
    return { routes, rejected };
  }
  return { anchors, frontier };
}
