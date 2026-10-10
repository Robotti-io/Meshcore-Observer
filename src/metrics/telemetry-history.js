import { assertTelemetryResult, telemetryVariantKey } from '../telemetry/telemetry-validation.js';

// Closed validated DTOs contain JSON primitives/arrays/objects only. Sort object
// keys recursively for immutable comparison; preserve reading/page array order.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const json = value => JSON.stringify(canonical(value));
const OUTCOME_COLUMNS = `request_id AS requestId,run_id AS runId,observer_public_key AS observerPublicKey,
  target_public_key AS targetPublicKey,variant_json AS variantJson,decoder_version AS decoderVersion,
  started_at AS startedAt,completed_at AS completedAt,received_at AS receivedAt,
  clock_anomaly AS clockAnomaly,tag,route,status,reason`;
const newer = (at, requestId, oldAt, oldRequestId) => oldAt === null || at > oldAt || (at === oldAt && requestId > oldRequestId);

/** Narrow write/retention operations on the sole owned MetricsStore connection. */
export function createTelemetryHistory(db, requireRun) {
  const outcomeById = db.prepare(`SELECT ${OUTCOME_COLUMNS} FROM telemetry_query_outcomes WHERE request_id=?`);
  const observationByRequest = db.prepare(`SELECT id,normalized_json AS normalizedJson,
    observation_time_conflict AS conflict FROM telemetry_observations WHERE request_id=?`);
  const insertOutcome = db.prepare(`INSERT INTO telemetry_query_outcomes(request_id,run_id,observer_public_key,
    target_public_key,component,variant_key,variant_json,decoder_version,started_at,completed_at,received_at,
    clock_anomaly,tag,route,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const collision = db.prepare(`SELECT EXISTS(SELECT 1 FROM telemetry_observations WHERE observer_public_key=?
    AND target_public_key=? AND component=? AND variant_key=? AND observed_at=?) AS conflict`);
  const insertObservation = db.prepare(`INSERT INTO telemetry_observations(request_id,observer_public_key,
    target_public_key,component,variant_key,outcome_status,observed_at,quality,normalized_json,latest_eligible,observation_time_conflict)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const markCollision = db.prepare(`UPDATE telemetry_observations SET observation_time_conflict=1
    WHERE observer_public_key=? AND target_public_key=? AND component=? AND variant_key=? AND observed_at=?`);
  const latest = db.prepare(`SELECT l.observation_id AS observationId,l.decoded_observation_id AS decodedObservationId,
    u.observed_at AS usefulAt,u.request_id AS usefulRequestId,d.observed_at AS decodedAt,d.request_id AS decodedRequestId
    FROM telemetry_latest l JOIN telemetry_observations u ON u.id=l.observation_id
    LEFT JOIN telemetry_observations d ON d.id=l.decoded_observation_id
    WHERE l.observer_public_key=? AND l.target_public_key=? AND l.component=? AND l.variant_key=?`);
  const saveLatest = db.prepare(`INSERT INTO telemetry_latest(observer_public_key,target_public_key,component,variant_key,
    observation_id,decoded_observation_id) VALUES(?,?,?,?,?,?)
    ON CONFLICT(observer_public_key,target_public_key,component,variant_key)
    DO UPDATE SET observation_id=excluded.observation_id,decoded_observation_id=excluded.decoded_observation_id`);
  const pruneObservations = db.prepare(`DELETE FROM telemetry_observations WHERE observed_at<?
    AND EXISTS(SELECT 1 FROM telemetry_query_outcomes o WHERE o.request_id=telemetry_observations.request_id AND o.completed_at<?)
    AND NOT EXISTS(SELECT 1 FROM telemetry_latest l WHERE l.observation_id=telemetry_observations.id)
    AND NOT EXISTS(SELECT 1 FROM telemetry_latest l WHERE l.decoded_observation_id=telemetry_observations.id)`);
  const pruneOutcomes = db.prepare(`DELETE FROM telemetry_query_outcomes WHERE completed_at<?
    AND (received_at IS NULL OR received_at<?)
    AND NOT EXISTS(SELECT 1 FROM telemetry_observations s WHERE s.request_id=telemetry_query_outcomes.request_id)`);

  return {
    record(input) {
      assertTelemetryResult(input);
      const run = requireRun(input.outcome.runId), o = input.outcome, observation = input.observation;
      const scope = [o.observerPublicKey, o.targetPublicKey, o.variant.component, telemetryVariantKey(o.variant)];
      db.exec('BEGIN');
      try {
        const old = outcomeById.get(o.requestId);
        if (old) {
          const saved = observationByRequest.get(o.requestId);
          let prior;
          try {
            const { variantJson, decoderVersion, ...fields } = old;
            prior = { decoderVersion, outcome: { ...fields, variant: JSON.parse(variantJson), clockAnomaly: Boolean(fields.clockAnomaly) },
              ...(saved ? { observation: JSON.parse(saved.normalizedJson) } : {}) };
            assertTelemetryResult(prior);
          } catch { throw new Error('Invalid stored telemetry data'); }
          if (json(prior) !== json(input)) throw new Error('Telemetry result request identity conflict');
          db.exec('COMMIT');
          return { requestId: o.requestId, observationId: saved?.id ?? null, duplicate: true,
            latestUpdated: false, decodedLatestUpdated: false, observationTimeConflict: Boolean(saved?.conflict) };
        }
        insertOutcome.run(o.requestId,o.runId,...scope,json(o.variant),input.decoderVersion,o.startedAt,o.completedAt,
          o.receivedAt,Number(o.clockAnomaly),o.tag,o.route,o.status,o.reason);
        let observationId = null, latestUpdated = false, decodedLatestUpdated = false, observationTimeConflict = false;
        if (observation) {
          const at = observation.observedAt;
          observationTimeConflict = Boolean(collision.get(...scope,at).conflict);
          // Original anomalous evidence is saved, not rewritten. A run's known
          // clock anomaly or a request predating its source run is history-only.
          const eligible = !o.clockAnomaly && !run.wallTimeAnomaly && o.startedAt >= run.startedAt;
          observationId = Number(insertObservation.run(o.requestId,...scope,o.status,at,observation.quality,
            json(observation),Number(eligible),Number(observationTimeConflict)).lastInsertRowid);
          if (observationTimeConflict) markCollision.run(...scope,at);
          if (eligible) {
            const previous = latest.get(...scope);
            latestUpdated = newer(at,o.requestId,previous?.usefulAt ?? null,previous?.usefulRequestId ?? null);
            decodedLatestUpdated = observation.quality === 'decoded'
              && newer(at,o.requestId,previous?.decodedAt ?? null,previous?.decodedRequestId ?? null);
            if (latestUpdated || decodedLatestUpdated) saveLatest.run(...scope,
              latestUpdated ? observationId : previous.observationId,
              decodedLatestUpdated ? observationId : previous?.decodedObservationId ?? null);
          }
        }
        db.exec('COMMIT');
        return { requestId: o.requestId, observationId, duplicate: false, latestUpdated, decodedLatestUpdated, observationTimeConflict };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },

    // Internal only: MetricsStore already owns the validated, child-first shared
    // retention transaction. Referenced latest snapshots/source runs survive.
    prune(cutoffMs) { pruneObservations.run(cutoffMs,cutoffMs); pruneOutcomes.run(cutoffMs,cutoffMs); }
  };
}
