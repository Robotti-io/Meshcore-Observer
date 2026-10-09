import { createHash } from 'node:crypto';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { assertTopologyEvidence } from '../nodes/topology-parser.js';
import { topologyCoverageSchema, topologyPathPageSchema, topologyPathIdentitySchema, topologyDetailPageSchema,
  topologyPrefixPageSchema, topologyProximitySchema, topologyPruneSchema } from '../nodes/topology-schemas.js';

const validators = new Map([topologyCoverageSchema, topologyPathPageSchema, topologyPathIdentitySchema,
  topologyDetailPageSchema, topologyPrefixPageSchema, topologyProximitySchema, topologyPruneSchema]
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
