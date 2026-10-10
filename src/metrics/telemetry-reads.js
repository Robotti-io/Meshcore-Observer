import { assertTelemetryInput, assertTelemetryResult, telemetryVariantKey } from '../telemetry/telemetry-validation.js';
import { telemetryLatestQuerySchema, telemetryObservationPageSchema, telemetryOutcomePageSchema, telemetryOutcomeSchema,
  TELEMETRY_READ_DEFAULT_LIMIT } from '../telemetry/telemetry-schemas.js';

const POLICY = { retainedHistoryOnly: true, historyCompleteness: 'unknown' };
const OUTCOME_COLUMNS = `o.request_id AS requestId,o.run_id AS runId,o.observer_public_key AS observerPublicKey,
  o.target_public_key AS targetPublicKey,o.variant_json AS variantJson,o.decoder_version AS decoderVersion,
  o.started_at AS startedAt,o.completed_at AS completedAt,o.received_at AS receivedAt,
  o.clock_anomaly AS clockAnomaly,o.tag,o.route,o.status,o.reason`;
const OBSERVATION_COLUMNS = `${OUTCOME_COLUMNS},a.id AS observationId,a.normalized_json AS normalizedJson,
  a.latest_eligible AS latestEligible,a.observation_time_conflict AS observationTimeConflict,
  r.wall_time_anomaly AS sourceRunClockAnomaly`;
const OBSERVATIONS = 'telemetry_observations a JOIN telemetry_query_outcomes o ON o.request_id=a.request_id';
const WITH_RUN = `${OBSERVATIONS} JOIN observer_runs r ON r.id=o.run_id`;

function saved(row, withObservation = false) {
  if (!row) return null;
  try {
    const outcome = Object.fromEntries(['requestId','runId','observerPublicKey','targetPublicKey','startedAt',
      'completedAt','receivedAt','tag','route','status','reason'].map(key => [key,row[key]]));
    outcome.clockAnomaly = Boolean(row.clockAnomaly); outcome.variant = JSON.parse(row.variantJson);
    const observation = withObservation ? JSON.parse(row.normalizedJson) : null;
    // Validate stored content/context as well as caller input. Corrupt records
    // fail safely without exposing their JSON, diagnostics or field values.
    if (withObservation) assertTelemetryResult({ decoderVersion: row.decoderVersion, outcome, observation });
    else {
      if (row.decoderVersion !== 1) throw new Error('Invalid version');
      assertTelemetryInput(telemetryOutcomeSchema,outcome);
    }
    return withObservation ? { observationId: row.observationId, requestId: outcome.requestId, runId: outcome.runId,
      observerPublicKey: outcome.observerPublicKey, targetPublicKey: outcome.targetPublicKey, ...observation,
      outcome,
      clockAnomaly: outcome.clockAnomaly, sourceRunClockAnomaly: Boolean(row.sourceRunClockAnomaly),
      latestEligible: Boolean(row.latestEligible), observationTimeConflict: Boolean(row.observationTimeConflict) }
      : { decoderVersion: row.decoderVersion, ...outcome };
  } catch { throw new Error('Invalid stored telemetry data'); }
}

// Caller text never forms SQL. Only these fixed field/column pairs are used.
function scope(query, observations) {
  const alias = observations ? 'a' : 'o', parts = [], values = [];
  for (const [field,column] of [['observerPublicKey',alias+'.observer_public_key'],
    ['targetPublicKey',alias+'.target_public_key'],['runId','o.run_id'],['component',alias+'.component'],['status','o.status']]) {
    if (query[field] !== undefined) { parts.push(column+'=?'); values.push(query[field]); }
  }
  if (query.variant) {
    parts.push(alias+'.component=?',alias+'.variant_key=?');
    values.push(query.variant.component,telemetryVariantKey(query.variant));
  }
  return { where: parts.length ? parts.join(' AND ') : '1=1', values };
}

function aged(observation, query, effectiveNow) {
  const futureDated = Boolean(observation && observation.observedAt > query.now);
  const ageMs = observation && !futureDated ? effectiveNow-observation.observedAt : null;
  const freshness = !observation ? 'unknown' : observation.observationTimeConflict ? 'ambiguous'
    : futureDated ? 'future' : observation.clockAnomaly || observation.sourceRunClockAnomaly || !observation.latestEligible
      ? 'clock-anomaly' : ageMs >= query.windowMs ? 'stale' : 'fresh';
  return { observation, freshness, fresh: freshness === 'fresh', ageMs, futureDated };
}

/** Internal bounded reads on the sole MetricsStore connection; no RF or API. */
export function createTelemetryReads(db) {
  let queryHighWater = 0;
  const durableTime = db.prepare('SELECT max(last_known_alive_at) AS value FROM observer_runs');
  const pointers = db.prepare(`SELECT observation_id AS useful,decoded_observation_id AS decoded FROM telemetry_latest
    WHERE observer_public_key=? AND target_public_key=? AND component=? AND variant_key=?`);
  const observation = db.prepare(`SELECT ${OBSERVATION_COLUMNS} FROM ${WITH_RUN} WHERE a.id=?`);
  const terminal = db.prepare(`SELECT ${OUTCOME_COLUMNS} FROM telemetry_query_outcomes o
    WHERE o.observer_public_key=? AND o.target_public_key=? AND o.component=? AND o.variant_key=?
    ORDER BY o.completed_at DESC,o.request_id DESC LIMIT 1`);
  function coverage(from, filter, timestamp) {
    return { ...db.prepare(`SELECT count(*) AS retainedRecords,min(${timestamp}) AS earliestRetainedAt,
      max(${timestamp}) AS latestRetainedAt FROM ${from} WHERE ${filter.where}`).get(...filter.values), ...POLICY };
  }
  function history(input, observations) {
    assertTelemetryInput(observations ? telemetryObservationPageSchema : telemetryOutcomePageSchema,input);
    const query = { ...input, limit: input.limit ?? TELEMETRY_READ_DEFAULT_LIMIT, offset: input.offset ?? 0 };
    const filter = scope(query,observations), timestamp = observations ? 'a.observed_at' : 'o.completed_at';
    // Most observation filters and all receipt ordering live on its header
    // index. Join outcomes before paging only when a run filter requires it.
    const from = observations ? query.runId ? OBSERVATIONS : 'telemetry_observations a' : 'telemetry_query_outcomes o';
    const where = filter.where+` AND ${timestamp}>=? AND ${timestamp}<?`, values = [...filter.values,query.start,query.end];
    const total = db.prepare(`SELECT count(*) AS total FROM ${from} WHERE ${where}`).get(...values).total;
    // Materialize only IDs before looking up any JSON. Count/coverage queries
    // never hydrate bodies; the JSON page cannot exceed the validated limit.
    const key = observations ? 'a.id' : 'o.request_id', tie = observations ? 'a.id' : 'o.request_id';
    const rows = db.prepare(`WITH page AS MATERIALIZED (SELECT ${key} AS id FROM ${from} WHERE ${where}
      ORDER BY ${timestamp} DESC,${tie} DESC LIMIT ? OFFSET ?)
      SELECT ${observations ? OBSERVATION_COLUMNS : OUTCOME_COLUMNS} FROM page
      ${observations ? `JOIN telemetry_observations a ON a.id=page.id
        JOIN telemetry_query_outcomes o ON o.request_id=a.request_id JOIN observer_runs r ON r.id=o.run_id`
        : 'JOIN telemetry_query_outcomes o ON o.request_id=page.id'}
      ORDER BY ${timestamp} DESC,${tie} DESC`).all(...values,query.limit,query.offset);
    return { total, [observations ? 'observations' : 'outcomes']: rows.map(row => saved(row,observations)),
      start: query.start, end: query.end, limit: query.limit, offset: query.offset, countScope: 'retained-range',
      coverage: coverage(from,filter,timestamp) };
  }
  return {
    latest(query) {
      assertTelemetryInput(telemetryLatestQuerySchema,query);
      const values = [query.observerPublicKey,query.targetPublicKey,query.variant.component,telemetryVariantKey(query.variant)];
      queryHighWater = Math.max(queryHighWater,query.now,durableTime.get().value ?? 0);
      const ids = pointers.get(...values);
      const useful = ids ? saved(observation.get(ids.useful),true) : null;
      const decoded = ids?.decoded ? saved(observation.get(ids.decoded),true) : null;
      return { observerPublicKey: query.observerPublicKey, targetPublicKey: query.targetPublicKey,
        variant: JSON.parse(JSON.stringify(query.variant)), ...aged(useful,query,queryHighWater),
        fullyDecoded: aged(decoded,query,queryHighWater), latestOutcome: saved(terminal.get(...values)),
        now: query.now, effectiveNow: queryHighWater, windowMs: query.windowMs, clockRollback: query.now < queryHighWater,
        coverage: coverage('telemetry_observations a',scope(query,true),'a.observed_at') };
    },
    observations(input) { return history(input,true); },
    outcomes(input) { return history(input,false); }
  };
}
