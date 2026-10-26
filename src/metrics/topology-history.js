import { createHash } from 'node:crypto';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { assertTopologyEvidence } from '../nodes/topology-parser.js';
import { createTelemetryNeighbourFrontier } from './telemetry-neighbour-frontier.js';
import { topologyCoverageSchema, topologyPathPageSchema, topologyPathIdentitySchema, topologyDetailPageSchema,
  topologyPrefixPageSchema, topologyProximitySchema, topologyOutboundRouteQuerySchema, topologyPruneSchema } from '../nodes/topology-schemas.js';

const validators = new Map([topologyCoverageSchema, topologyPathPageSchema, topologyPathIdentitySchema,
  topologyDetailPageSchema, topologyPrefixPageSchema, topologyProximitySchema, topologyOutboundRouteQuerySchema, topologyPruneSchema]
  .map((schema) => [schema, compileSchema(schema)]));
function validate(schema, value) {
  const check = validators.get(schema);
  if (!check(value)) throw new Error(`Invalid topology input: ${formatErrors(check.errors)}`);
  if (value.start !== undefined && value.start > value.end) throw new Error('Invalid topology input: inverted range');
  if (value.prefix !== undefined && value.prefix.length !== value.hashWidth * 2) throw new Error('Invalid topology input: prefix width');
}
const page = (query) => ({ limit: 100, offset: 0, ...query });
const POLICY = { frequencyBasis: 'persisted-receptions', outboundRouteVerified: false,
  coverageIsLowerBound: true, detailMayBePruned: true, identityIsPrefixAssociation: true };
const PATH_COLUMNS = `id AS pathId,observer_public_key AS observerPublicKey,route,kind,hash_width AS hashWidth,
  transport_code_1 AS transportCode1,transport_code_2 AS transportCode2,path_hex AS pathHex,
  repeated_prefix AS containsRepeatedPrefix,reception_count AS receptionCount,
  first_received_at AS firstReceivedAt,last_received_at AS lastReceivedAt`;
function mapPath(row) {
  return row ? { ...row, containsRepeatedPrefix: Boolean(row.containsRepeatedPrefix),
    loopOrCollision: Boolean(row.containsRepeatedPrefix), ...POLICY, countScope: 'cumulative' } : null;
}
// Three fixed SQL shapes: no caller-controlled SQL and each expression matches its index.
const PREFIX_EXPRESSIONS = { 1: 'upper(substr(public_key_hex,1,2))',
  2: 'upper(substr(public_key_hex,1,4))', 3: 'upper(substr(public_key_hex,1,6))' };
const validKey = (value) => /^[0-9a-f]{64}$/i.test(value);
const validRouteQuery = validators.get(topologyOutboundRouteQuerySchema);

export function topologyCanonical(evidence) {
  return JSON.stringify(['topology-v1', evidence.observerPublicKey, evidence.route, evidence.kind,
    evidence.payloadVersion, evidence.hashWidth, evidence.transportCodes, evidence.prefixes]);
}

/** Narrow operations on MetricsStore's owned connection, not a second store/registry. */
export function createTopologyHistory(db, requireRun) {
  const byDigest = db.prepare('SELECT * FROM topology_paths WHERE digest=?');
  const insertPath = db.prepare(`INSERT INTO topology_paths(digest,canonical,observer_public_key,route,kind,hash_width,
    transport_code_1,transport_code_2,path_hex,repeated_prefix,reception_count,first_received_at,last_received_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`);
  const updatePath = db.prepare(`UPDATE topology_paths SET reception_count=reception_count+1,
    first_received_at=min(first_received_at,?),last_received_at=max(last_received_at,?) WHERE id=?`);
  const insertHop = db.prepare('INSERT INTO topology_path_hops(path_id,position,hash_width,prefix,distance) VALUES(?,?,?,?,?)');
  const insertObservation = db.prepare('INSERT INTO topology_observations(path_id,run_id,received_at) VALUES(?,?,?)');
  const insertCoverage = db.prepare(`INSERT INTO topology_capture_samples(run_id,observer_public_key,sample_at,
    accepted,suppressed,failed,malformed,unsupported,no_relay) VALUES(?,?,?,?,?,?,?,?,?)`);
  const prefixStatements = Object.fromEntries([1, 2, 3].map((width) => [width, {
    count: db.prepare(`SELECT count(*) AS total FROM nodes WHERE ${PREFIX_EXPRESSIONS[width]}=?`),
    list: db.prepare(`SELECT public_key_hex AS publicKeyHex,name,type FROM nodes WHERE ${PREFIX_EXPRESSIONS[width]}=?
      ORDER BY public_key_hex LIMIT ? OFFSET ?`)
  }]));
  const resolvePrefix = db.prepare(`SELECT public_key_hex AS publicKeyHex,name,type FROM nodes
    WHERE upper(substr(public_key_hex,1,?))=? ORDER BY public_key_hex LIMIT 2`);
  const targetMetadata = db.prepare(`SELECT upper(n.public_key_hex) AS publicKeyHex,n.name,
      advert.flags,advert.advert_timestamp AS advertTimestamp,advert.advert_lat AS lat,advert.advert_lon AS lon
    FROM nodes n LEFT JOIN verified_advert_paths advert ON advert.id=(
      SELECT id FROM verified_advert_paths WHERE public_key_hex=n.public_key_hex ORDER BY received_at DESC,id DESC LIMIT 1)
    WHERE n.public_key_hex=? AND n.type='REPEATER'`);
  const neighbours = createTelemetryNeighbourFrontier(db);
  // Attribute trace success to the exact requested contact-path token and
  // position. TraceData hashes are retained for display, but are not treated
  // as normal repeater identities or resolved against advert prefixes.
  const tracedHops = db.prepare(`SELECT CAST(hop.key AS INTEGER) AS position,upper(hop.value) AS repeaterId,
      count(*) AS traceSuccessCount
    FROM telemetry_request_diagnostics d,json_each(d.diagnostic_json,'$.routeCandidatePath') hop
    WHERE d.observer_public_key=? AND d.completed_at>? AND d.completed_at<=? AND d.clock_anomaly=0
      AND json_extract(d.diagnostic_json,'$.traceOutcome')='response'
    GROUP BY CAST(hop.key AS INTEGER),upper(hop.value)`);
  const outboundRows = Object.fromEntries([1, 2, 3].map((width) => [width, db.prepare(`SELECT p.path_hex AS pathHex,
      h.position,count(*) AS receptionCount,max(o.received_at) AS receivedAt
    FROM topology_path_hops h INDEXED BY idx_topology_hops_prefix
    JOIN topology_paths p ON p.id=h.path_id
    JOIN topology_observations o ON o.path_id=p.id
    JOIN observer_runs r ON r.id=o.run_id
    WHERE h.hash_width=? AND h.prefix=? AND p.observer_public_key=? AND p.kind='flood-traversed'
      AND p.repeated_prefix=0 AND o.received_at>? AND o.received_at<=?
      AND r.wall_time_anomaly=0 AND o.received_at>=r.started_at
    GROUP BY p.id,h.position`)]));
  const topologyHighWater = db.prepare(`SELECT max(value) AS value FROM (
    SELECT max(last_known_alive_at) AS value FROM observer_runs UNION ALL
    SELECT max(sample_at) FROM topology_capture_samples)`);
  // Read-time rollback guard plus durable run/sample high water across restarts.
  let queryHighWater = 0;
  function transaction(work) {
    db.exec('BEGIN');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function prefixResolution(hashWidth, prefix) {
    const statements = prefixStatements[hashWidth];
    const total = statements.count.get(prefix).total;
    const identity = total === 1 ? statements.list.get(prefix, 1, 0) : null;
    const usable = identity && validKey(identity.publicKeyHex);
    return { resolution: total === 0 ? 'unresolved' : usable ? 'unique' : 'ambiguous', matchCount: total,
      identity: usable ? { ...identity, publicKeyHex: identity.publicKeyHex.toUpperCase() } : null };
  }
  // Distinct eligible prefixes bound inventory work to indexed prefix lookups;
  // count ALL identities first, including mixed types and invalid legacy rows.
  const proximityCte = `WITH eligible AS MATERIALIZED (
    SELECT id,last_received_at,reception_count FROM topology_paths
    WHERE observer_public_key=? AND kind='flood-traversed' AND repeated_prefix=0
      AND last_received_at>? AND last_received_at<=?
  ), prefixes AS MATERIALIZED (
    SELECT DISTINCT h.hash_width,h.prefix FROM topology_path_hops h JOIN eligible e ON e.id=h.path_id
    WHERE h.distance<=?
  ), associations AS MATERIALIZED (
    ${[1, 2, 3].map((width) => `SELECT ${width} AS hash_width,p.prefix,count(*) AS matches,
      min(n.public_key_hex) AS public_key_hex,min(n.name) AS name,min(n.type) AS type
      FROM prefixes p JOIN nodes n ON ${PREFIX_EXPRESSIONS[width].replaceAll('public_key_hex', 'n.public_key_hex')}=p.prefix
      WHERE p.hash_width=${width} GROUP BY p.prefix`).join(' UNION ALL ')}
  ), evidence AS MATERIALIZED (
    SELECT upper(a.public_key_hex) AS publicKeyHex,a.name,a.type,h.path_id AS pathId,h.position,h.distance,
      e.last_received_at AS lastReceivedAt,e.reception_count AS receptionCount
    FROM eligible e JOIN topology_path_hops h ON h.path_id=e.id JOIN associations a ON a.hash_width=h.hash_width AND a.prefix=h.prefix
    WHERE h.distance<=? AND a.matches=1 AND a.type='REPEATER' AND length(a.public_key_hex)=64
      AND a.public_key_hex NOT GLOB '*[^0-9a-fA-F]*' AND upper(a.public_key_hex)<>?
  ), ranked AS (
    SELECT *,row_number() OVER(PARTITION BY publicKeyHex ORDER BY distance,lastReceivedAt DESC,receptionCount DESC,pathId,position) AS rank
    FROM evidence
  )`;

  return {
    record(evidence) {
      assertTopologyEvidence(evidence); requireRun(evidence.runId);
      const canonical = topologyCanonical(evidence);
      const digest = createHash('sha256').update(canonical).digest('hex');
      return transaction(() => {
        const old = byDigest.get(digest);
        if (old) {
          const storedCanonical = topologyCanonical({ observerPublicKey: old.observer_public_key, route: old.route,
            kind: old.kind, payloadVersion: 0, hashWidth: old.hash_width,
            transportCodes: old.transport_code_1 === null ? null : [old.transport_code_1, old.transport_code_2],
            prefixes: old.path_hex.match(new RegExp(`.{${old.hash_width * 2}}`, 'g')) ?? [] });
          if (old.canonical !== canonical || storedCanonical !== canonical || Boolean(old.repeated_prefix) !== evidence.containsRepeatedPrefix) {
            throw new Error('Topology digest collision: canonical context differs');
          }
        }
        let pathId = old?.id;
        if (old) updatePath.run(evidence.receivedAt, evidence.receivedAt, pathId);
        else {
          pathId = Number(insertPath.run(digest, canonical, evidence.observerPublicKey, evidence.route, evidence.kind,
            evidence.hashWidth, evidence.transportCodes?.[0] ?? null, evidence.transportCodes?.[1] ?? null,
            evidence.prefixes.join(''), Number(evidence.containsRepeatedPrefix), evidence.receivedAt, evidence.receivedAt).lastInsertRowid);
          evidence.prefixes.forEach((prefix, position) => insertHop.run(pathId, position, evidence.hashWidth, prefix,
            evidence.kind === 'flood-traversed' ? evidence.prefixes.length - position : null));
        }
        const observationId = Number(insertObservation.run(pathId, evidence.runId, evidence.receivedAt).lastInsertRowid);
        return { pathId, observationId };
      });
    },
    recordCoverage(sample) {
      validate(topologyCoverageSchema, sample); requireRun(sample.runId);
      return Number(insertCoverage.run(sample.runId, sample.observerPublicKey, sample.sampleAt,
        sample.accepted, sample.suppressed, sample.failed, sample.malformed, sample.unsupported, sample.noRelay).lastInsertRowid);
    },
    paths(query = {}) {
      query = page(query); validate(topologyPathPageSchema, query);
      const filter = 'WHERE (? IS NULL OR observer_public_key=?) AND (? IS NULL OR kind=?)';
      const values = [query.observerPublicKey ?? null, query.observerPublicKey ?? null, query.kind ?? null, query.kind ?? null];
      const total = db.prepare(`SELECT count(*) AS total FROM topology_paths ${filter}`).get(...values).total;
      const rows = db.prepare(`SELECT ${PATH_COLUMNS} FROM topology_paths ${filter} ORDER BY id LIMIT ? OFFSET ?`)
        .all(...values, query.limit, query.offset);
      return { total, paths: rows.map(mapPath), ...POLICY };
    },
    path(query) {
      validate(topologyPathIdentitySchema, query);
      const path = mapPath(db.prepare(`SELECT ${PATH_COLUMNS} FROM topology_paths WHERE id=?`).get(query.pathId));
      if (!path) return null;
      const hops = db.prepare(`SELECT position,hash_width AS hashWidth,prefix,distance FROM topology_path_hops WHERE path_id=? ORDER BY position LIMIT 63`)
        .all(query.pathId);
      const resolutions = new Map();
      path.hops = hops.map((hop) => {
        if (!resolutions.has(hop.prefix)) resolutions.set(hop.prefix, prefixResolution(hop.hashWidth, hop.prefix));
        return { ...hop, ...resolutions.get(hop.prefix) };
      });
      return path;
    },
    identities(query) {
      query = page(query); validate(topologyPrefixPageSchema, query);
      const statements = prefixStatements[query.hashWidth];
      return { ...prefixResolution(query.hashWidth, query.prefix),
        identities: statements.list.all(query.prefix, query.limit, query.offset).map((row) => ({ ...row, validPublicKey: validKey(row.publicKeyHex) })),
        ...POLICY };
    },
    observations(query) {
      query = page(query); validate(topologyDetailPageSchema, query);
      const filter = 'WHERE received_at>=? AND received_at<? AND (? IS NULL OR path_id=?) AND (? IS NULL OR run_id=?)';
      const values = [query.start, query.end, query.pathId ?? null, query.pathId ?? null, query.runId ?? null, query.runId ?? null];
      const total = db.prepare(`SELECT count(*) AS total FROM topology_observations ${filter}`).get(...values).total;
      return { total, observations: db.prepare(`SELECT id,path_id AS pathId,run_id AS runId,received_at AS receivedAt
        FROM topology_observations ${filter} ORDER BY received_at DESC,id DESC LIMIT ? OFFSET ?`).all(...values, query.limit, query.offset),
      ...POLICY, countScope: 'retained-range', start: query.start, end: query.end };
    },
    counts(query) {
      query = page(query); validate(topologyDetailPageSchema, query);
      const filter = 'WHERE received_at>=? AND received_at<? AND (? IS NULL OR path_id=?) AND (? IS NULL OR run_id=?)';
      const values = [query.start, query.end, query.pathId ?? null, query.pathId ?? null, query.runId ?? null, query.runId ?? null];
      const total = db.prepare(`SELECT count(DISTINCT path_id) AS total FROM topology_observations ${filter}`).get(...values).total;
      return { total, paths: db.prepare(`SELECT path_id AS pathId,count(*) AS receptionCount FROM topology_observations ${filter}
        GROUP BY path_id ORDER BY path_id LIMIT ? OFFSET ?`).all(...values, query.limit, query.offset),
      ...POLICY, countScope: 'retained-range', start: query.start, end: query.end };
    },
    coverage(query) {
      query = page(query); validate(topologyDetailPageSchema, query);
      if (query.pathId !== undefined) throw new Error('Invalid topology input: coverage has no path scope');
      const filter = 'WHERE sample_at>=? AND sample_at<? AND (? IS NULL OR run_id=?)';
      const values = [query.start, query.end, query.runId ?? null, query.runId ?? null];
      const total = db.prepare(`SELECT count(*) AS total FROM topology_capture_samples ${filter}`).get(...values).total;
      return { total, samples: db.prepare(`SELECT id,run_id AS runId,observer_public_key AS observerPublicKey,sample_at AS sampleAt,
        accepted,suppressed,failed,malformed,unsupported,no_relay AS noRelay FROM topology_capture_samples ${filter}
        ORDER BY sample_at DESC,id DESC LIMIT ? OFFSET ?`).all(...values, query.limit, query.offset), ...POLICY };
    },
    proximity(query) {
      query = page(query); validate(topologyProximitySchema, query);
      const durableNow = db.prepare(`SELECT max(value) AS value FROM (
        SELECT max(last_known_alive_at) AS value FROM observer_runs UNION ALL SELECT max(sample_at) FROM topology_capture_samples)`)
        .get().value ?? 0;
      queryHighWater = Math.max(queryHighWater, durableNow, query.now);
      const clockRollback = query.now < queryHighWater;
      // A rollback never renews expired evidence; future evidence remains ineligible.
      const values = [query.observerPublicKey, queryHighWater - query.windowMs, query.now, query.radius, query.radius, query.observerPublicKey];
      const rows = db.prepare(`${proximityCte}, selected AS (
        SELECT *,count(*) OVER() AS total FROM ranked WHERE rank=1
        ORDER BY distance,lastReceivedAt DESC,receptionCount DESC,pathId,publicKeyHex LIMIT ? OFFSET ?
      ) SELECT r.*,s.total FROM ranked r JOIN selected s ON s.publicKeyHex=r.publicKeyHex WHERE r.rank<=4
        ORDER BY s.distance,s.lastReceivedAt DESC,s.receptionCount DESC,s.pathId,s.publicKeyHex,r.rank`)
        .all(...values, query.limit, query.offset);
      // Reuse the same materialized evidence for totals and rows. A page beyond
      // the end needs a separate count, but ordinary pages avoid a second scan.
      const total = rows[0]?.total ?? db.prepare(`${proximityCte} SELECT count(*) AS total FROM ranked WHERE rank=1`).get(...values).total;
      const candidates = [];
      for (const row of rows) {
        const reference = { pathId: row.pathId, position: row.position, distance: row.distance,
          lastReceivedAt: row.lastReceivedAt, receptionCount: row.receptionCount };
        if (row.rank === 1) candidates.push({ publicKeyHex: row.publicKeyHex, name: row.name, ...reference,
          alternatePaths: [], observedProximityCandidate: true, fresh: true, resolution: 'unique', ...POLICY });
        else candidates.at(-1).alternatePaths.push(reference);
      }
      return { total, candidates, now: query.now, effectiveNow: queryHighWater, windowMs: query.windowMs,
        radius: query.radius, clockRollback, ...POLICY };
    },
    neighbourCandidates(query) { return neighbours.frontier(query).routes; },
    outboundRoute(query) {
      if (!validRouteQuery(query)) throw new Error('Invalid topology outbound-route query');
      const durableNow = topologyHighWater.get().value ?? 0;
      const effectiveNow = Math.max(queryHighWater, durableNow, query.now);
      if (query.now < effectiveNow) return { status: 'unavailable', reason: 'clock-rollback' };
      queryHighWater = effectiveNow;
      if (query.targetPublicKey === query.observerPublicKey) return { status: 'unavailable', reason: 'target-is-observer' };
      const target = targetMetadata.get(query.targetPublicKey);
      if (!target) return { status: 'unavailable', reason: 'target-not-known-repeater' };
      const cutoff = effectiveNow - query.windowMs;
      const neighbourQuery = { observerPublicKey: query.observerPublicKey, now: effectiveNow,
        windowMs: query.windowMs, radius: query.radius };
      const anchors = neighbours.anchors(neighbourQuery);
      const adjacent = new Set(anchors.keys());
      if (!adjacent.size) return { status: 'unavailable', reason: 'no-fresh-direct-relay' };
      const traceSupport = new Map(tracedHops.all(query.observerPublicKey, cutoff, effectiveNow)
        .map(row => [`${row.position}:${row.repeaterId}`, row.traceSuccessCount]));
      const byRoute = new Map();
      let rejectedNonAdjacent = false;
      const routeFor = (path) => {
        const routeKey = JSON.stringify(path);
        let candidate = byRoute.get(routeKey);
        if (!candidate) {
          const firstKey = resolvePrefix.get(4, path[0]);
          const firstPublicKey = firstKey?.publicKeyHex?.toUpperCase();
          candidate = { path, receptionCount: 0, passiveReceptionCount: 0, neighbourSupportCount: 0,
            receivedAt: 0, anchorSuccessCount: anchors.get(firstPublicKey) ?? 0 };
          byRoute.set(routeKey, candidate);
        }
        return candidate;
      };
      for (const width of [1, 2, 3]) {
        const targetPrefix = query.targetPublicKey.slice(0, width * 2);
        const targetMatches = resolvePrefix.all(width * 2, targetPrefix);
        if (targetMatches.length !== 1 || targetMatches[0].publicKeyHex.toUpperCase() !== query.targetPublicKey
          || targetMatches[0].type !== 'REPEATER') continue;
        const rows = outboundRows[width].all(width, targetPrefix, query.observerPublicKey, cutoff, effectiveNow);
        for (const row of rows) {
          const tokenWidth = width * 2;
          if (typeof row.pathHex !== 'string' || row.pathHex.length === 0 || row.pathHex.length % tokenWidth !== 0) continue;
          const prefixes = row.pathHex.match(new RegExp(`.{${tokenWidth}}`, 'g'));
          if (!prefixes || row.position < 0 || row.position >= prefixes.length || prefixes[row.position] !== targetPrefix) continue;
          const relayKeys = [];
          let safe = true;
          for (const prefix of prefixes.slice(row.position + 1).reverse()) {
            const matches = resolvePrefix.all(tokenWidth, prefix);
            if (matches.length !== 1 || matches[0].type !== 'REPEATER') { safe = false; break; }
            const relayKey = matches[0].publicKeyHex.toUpperCase();
            if (relayKey === query.targetPublicKey || relayKey === query.observerPublicKey || relayKeys.includes(relayKey)) {
              safe = false; break;
            }
            const routePrefix = relayKey.slice(0, 4);
            const routeMatches = resolvePrefix.all(4, routePrefix);
            if (routeMatches.length !== 1 || routeMatches[0].publicKeyHex.toUpperCase() !== relayKey) { safe = false; break; }
            relayKeys.push(relayKey);
          }
          if (!safe || relayKeys.length > 31 || relayKeys.length + 1 > query.radius) continue;
          const path = relayKeys.map(key => key.slice(0, 4));
          // The first MeshCore path token is the next hop from the observer.
          // Never promote a relay seen deeper in a flood path to a local
          // neighbor based on reception count alone.
          if (!relayKeys.length || !adjacent.has(relayKeys[0])) {
            rejectedNonAdjacent = true;
            continue;
          }
          const candidate = routeFor(path);
          candidate.passiveReceptionCount += row.receptionCount;
          candidate.receptionCount = candidate.passiveReceptionCount;
          candidate.receivedAt = Math.max(candidate.receivedAt, row.receivedAt);
        }
      }
      const frontier = neighbours.frontier(neighbourQuery, anchors);
      const rejectedNeighbourEvidence = frontier.rejected;
      for (const route of frontier.routes) {
        if (route.targetPublicKey !== query.targetPublicKey) continue;
        const candidate = routeFor(route.path);
        candidate.neighbourSupportCount++;
        candidate.receivedAt = Math.max(candidate.receivedAt, route.receivedAt);
        if (candidate.passiveReceptionCount === 0) candidate.receptionCount = candidate.neighbourSupportCount;
      }
      const candidates = [...byRoute.values()];
      const positionSupport = new Map();
      const neighbourPositionSupport = new Map();
      for (const candidate of candidates) candidate.path.forEach((relayId, position) => {
        if (!positionSupport.has(position)) positionSupport.set(position, new Map());
        const weights = positionSupport.get(position);
        weights.set(relayId, (weights.get(relayId) ?? 0) + candidate.passiveReceptionCount);
        if (position === candidate.path.length - 1 && candidate.neighbourSupportCount) {
          if (!neighbourPositionSupport.has(position)) neighbourPositionSupport.set(position, new Map());
          const neighbourWeights = neighbourPositionSupport.get(position);
          neighbourWeights.set(relayId, (neighbourWeights.get(relayId) ?? 0) + candidate.neighbourSupportCount);
        }
      });
      for (const candidate of candidates) {
        candidate.hopWeights = candidate.path.map((repeaterId, position) => ({ position: position + 1,
          repeaterId, anchorSuccessCount: position === 0 ? candidate.anchorSuccessCount : 0,
          traceSuccessCount: traceSupport.get(`${position}:${repeaterId}`) ?? 0,
          ...(neighbourPositionSupport.get(position)?.get(repeaterId)
            ? { neighbourSupportCount: neighbourPositionSupport.get(position).get(repeaterId) } : {}),
          pathReceptionCount: positionSupport.get(position)?.get(repeaterId) ?? 0 }));
      }
      const maxHopCount = candidates.reduce((max, candidate) => Math.max(max, candidate.path.length), 0);
      const compareSupport = (a, b) => {
        if (a.anchorSuccessCount !== b.anchorSuccessCount) return b.anchorSuccessCount - a.anchorSuccessCount;
        for (let position = 0; position < maxHopCount; position++) {
          const aTrace = a.hopWeights[position]?.traceSuccessCount ?? 0;
          const bTrace = b.hopWeights[position]?.traceSuccessCount ?? 0;
          if (aTrace !== bTrace) return bTrace - aTrace;
          const aNeighbours = a.hopWeights[position]?.neighbourSupportCount ?? 0;
          const bNeighbours = b.hopWeights[position]?.neighbourSupportCount ?? 0;
          if (aNeighbours !== bNeighbours) return bNeighbours - aNeighbours;
          const aWeight = a.hopWeights[position]?.pathReceptionCount ?? 0;
          const bWeight = b.hopWeights[position]?.pathReceptionCount ?? 0;
          if (aWeight !== bWeight) return bWeight - aWeight;
        }
        return b.receptionCount - a.receptionCount;
      };
      candidates.sort((a, b) => compareSupport(a, b)
        || b.receivedAt - a.receivedAt || a.path.length - b.path.length
        || JSON.stringify(a.path).localeCompare(JSON.stringify(b.path)));
      const excluded = new Set((query.excludedPaths ?? []).map(path => JSON.stringify(path)));
      const available = candidates.filter(candidate => !excluded.has(JSON.stringify(candidate.path)));
      if (!available.length) return { status: 'unavailable', reason: candidates.length && excluded.size
        ? 'candidate-routes-suppressed' : rejectedNonAdjacent
        ? 'no-observer-adjacent-route' : rejectedNeighbourEvidence
          ? 'neighbour-route-not-anchored' : 'no-fresh-passive-route' };
      if (available.length > 1 && compareSupport(available[0], available[1]) === 0) {
        return { status: 'unavailable', reason: 'passive-route-support-tied' };
      }
      const best = available[0];
      return { status: 'available', target: { publicKeyHex: target.publicKeyHex, name: target.name,
        flags: target.flags ?? 0, advertTimestamp: target.advertTimestamp ?? 0, lat: target.lat, lon: target.lon },
      path: best.path, hashWidth: 2, receivedAt: best.receivedAt, receptionCount: best.receptionCount,
      evidenceSource: best.passiveReceptionCount > 0 ? 'passive-topology' : 'telemetry-neighbours',
      hopWeights: best.hopWeights };
    },
    prune(query) {
      validate(topologyPruneSchema, query);
      return transaction(() => {
        const predicate = `last_received_at<=? AND NOT EXISTS(SELECT 1 FROM topology_observations o WHERE o.path_id=topology_paths.id)`;
        db.prepare(`DELETE FROM topology_path_hops WHERE path_id IN(SELECT id FROM topology_paths WHERE ${predicate})`).run(query.cutoffMs);
        return db.prepare(`DELETE FROM topology_paths WHERE ${predicate}`).run(query.cutoffMs).changes;
      });
    }
  };
}
