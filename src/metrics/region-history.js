import { assertRegionResult, assertRegionInput } from '../regions/region-validation.js';
import { regionObservedAnswerSchema } from '../regions/region-schemas.js';

const OUTCOME_COLUMNS = `request_id AS requestId,run_id AS runId,observer_public_key AS observerPublicKey,
  target_public_key AS targetPublicKey,started_at AS startedAt,completed_at AS completedAt,
  clock_anomaly AS clockAnomaly,status,reason,route`;
const ANSWER_COLUMNS = `id,observed_at AS observedAt,regions_json AS regionsJson,repeater_clock AS repeaterClock,
  body_bytes AS bodyBytes,csv_bytes AS csvBytes,parser_version AS parserVersion,completeness,provenance,
  observation_time_conflict AS observationTimeConflict`;
function mapAnswer(row) {
  const answer = { observedAt: row.observedAt, regions: JSON.parse(row.regionsJson), repeaterClock: row.repeaterClock,
    bodyBytes: row.bodyBytes, csvBytes: row.csvBytes, parserVersion: row.parserVersion,
    completeness: row.completeness, provenance: row.provenance };
  assertRegionInput(regionObservedAnswerSchema, answer);
  return answer;
}
// Fixed field order compares the actual saved content, not a caller's property
// order or just a fingerprint. Broker changes use T3's explicit staging seam.
function canonical({ outcome: o, answer: a }) {
  return JSON.stringify([o.requestId,o.runId,o.observerPublicKey,o.targetPublicKey,o.startedAt,o.completedAt,
    o.clockAnomaly,o.status,o.reason,o.route,a ? [a.observedAt,a.regions,a.repeaterClock,a.bodyBytes,
      a.csvBytes,a.parserVersion,a.completeness,a.provenance] : null]);
}

/** Narrow operations on MetricsStore's owned connection. No producer/outbox worker. */
export function createRegionHistory(db, requireRun) {
  const outcomeById = db.prepare(`SELECT ${OUTCOME_COLUMNS} FROM region_query_outcomes WHERE request_id=?`);
  const answerByRequest = db.prepare(`SELECT ${ANSWER_COLUMNS} FROM region_answers WHERE request_id=?`);
  const insertOutcome = db.prepare(`INSERT INTO region_query_outcomes(request_id,run_id,observer_public_key,
    target_public_key,started_at,completed_at,clock_anomaly,status,reason,route) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const conflictAtTime = db.prepare(`SELECT EXISTS(SELECT 1 FROM region_answers WHERE observer_public_key=?
    AND target_public_key=? AND observed_at=? AND (regions_json<>? OR repeater_clock IS NOT ?)) AS conflict`);
  const insertAnswer = db.prepare(`INSERT INTO region_answers(request_id,observer_public_key,target_public_key,
    observed_at,regions_json,repeater_clock,body_bytes,csv_bytes,parser_version,completeness,provenance,observation_time_conflict)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const markConflict = db.prepare(`UPDATE region_answers SET observation_time_conflict=1
    WHERE observer_public_key=? AND target_public_key=? AND observed_at=?`);
  const updateLatest = db.prepare(`INSERT INTO region_latest(observer_public_key,target_public_key,answer_id) VALUES(?,?,?)
    ON CONFLICT(observer_public_key,target_public_key) DO UPDATE SET answer_id=excluded.answer_id
    WHERE (SELECT observed_at FROM region_answers WHERE id=excluded.answer_id)>
          (SELECT observed_at FROM region_answers WHERE id=region_latest.answer_id)
      OR ((SELECT observed_at FROM region_answers WHERE id=excluded.answer_id)=
          (SELECT observed_at FROM region_answers WHERE id=region_latest.answer_id)
        AND excluded.answer_id>region_latest.answer_id)`);
  const stageInitial = db.prepare(`INSERT INTO region_publications(answer_id,broker_id,state,attempt_count,next_due_at)
    SELECT ?,?,'pending',0,? WHERE NOT EXISTS(SELECT 1 FROM region_publications p JOIN region_answers a ON a.id=p.answer_id
      WHERE p.broker_id=? AND a.observer_public_key=? AND a.target_public_key=? AND a.observed_at=?)`);

  return {
    record(input) {
      assertRegionResult(input); requireRun(input.outcome.runId);
      const o = input.outcome, a = input.answer;
      db.exec('BEGIN');
      try {
        const oldOutcome = outcomeById.get(o.requestId);
        if (oldOutcome) {
          const saved = answerByRequest.get(o.requestId);
          const old = { outcome: { ...oldOutcome, clockAnomaly: Boolean(oldOutcome.clockAnomaly) },
            ...(saved ? { answer: mapAnswer(saved) } : {}) };
          if (canonical(old) !== canonical(input)) throw new Error('Region result request identity conflict');
          db.exec('COMMIT');
          return { requestId: o.requestId, answerId: saved?.id ?? null, duplicate: true, latestUpdated: false,
            observationTimeConflict: Boolean(saved?.observationTimeConflict) };
        }
        insertOutcome.run(o.requestId,o.runId,o.observerPublicKey,o.targetPublicKey,o.startedAt,o.completedAt,
          Number(o.clockAnomaly),o.status,o.reason,o.route);
        let answerId = null, latestUpdated = false, observationTimeConflict = false;
        if (a) {
          const regionsJson = JSON.stringify(a.regions);
          observationTimeConflict = Boolean(conflictAtTime.get(o.observerPublicKey,o.targetPublicKey,
            a.observedAt,regionsJson,a.repeaterClock).conflict);
          answerId = Number(insertAnswer.run(o.requestId,o.observerPublicKey,o.targetPublicKey,a.observedAt,
            regionsJson,a.repeaterClock,a.bodyBytes,a.csvBytes,a.parserVersion,a.completeness,a.provenance,
            Number(observationTimeConflict)).lastInsertRowid);
          if (observationTimeConflict) markConflict.run(o.observerPublicKey,o.targetPublicKey,a.observedAt);
          latestUpdated = updateLatest.run(o.observerPublicKey,o.targetPublicKey,answerId).changes === 1;
          if (!observationTimeConflict) for (const brokerId of input.brokerIds ?? []) {
            stageInitial.run(answerId,brokerId,o.completedAt,brokerId,o.observerPublicKey,o.targetPublicKey,a.observedAt);
          }
        }
        db.exec('COMMIT');
        return { requestId: o.requestId, answerId, duplicate: false, latestUpdated, observationTimeConflict };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
