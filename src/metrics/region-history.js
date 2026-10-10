import { randomUUID } from 'node:crypto';
import { assertRegionResult, assertRegionInput } from '../regions/region-validation.js';
import { regionObservedAnswerSchema, regionStagePublicationsSchema, regionClaimPublicationSchema,
  regionResolvePublicationSchema } from '../regions/region-schemas.js';

const OUTCOME_COLUMNS = `request_id AS requestId,run_id AS runId,observer_public_key AS observerPublicKey,
  target_public_key AS targetPublicKey,started_at AS startedAt,completed_at AS completedAt,
  clock_anomaly AS clockAnomaly,status,reason,route`;
const ANSWER_COLUMNS = `id,observed_at AS observedAt,regions_json AS regionsJson,repeater_clock AS repeaterClock,
  body_bytes AS bodyBytes,csv_bytes AS csvBytes,parser_version AS parserVersion,completeness,provenance,
  observation_time_conflict AS observationTimeConflict`;
export function mapAnswer(row) {
  const answer = { observedAt: row.observedAt, regions: JSON.parse(row.regionsJson), repeaterClock: row.repeaterClock,
    bodyBytes: row.bodyBytes, csvBytes: row.csvBytes, parserVersion: row.parserVersion,
    completeness: row.completeness, provenance: row.provenance };
  assertRegionInput(regionObservedAnswerSchema, answer);
  return answer;
}
// Fixed field order compares the actual saved content, not a caller's property
// order or just a fingerprint. Broker changes use the separate staging seam.
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
  const answerById = db.prepare(`SELECT ${ANSWER_COLUMNS},observer_public_key AS observerPublicKey,
    target_public_key AS targetPublicKey,(SELECT completed_at FROM region_query_outcomes WHERE request_id=a.request_id) AS completedAt
    FROM region_answers a WHERE id=?`);
  const duePublication = db.prepare(`SELECT p.answer_id AS answerId,a.request_id AS requestId,
    o.run_id AS sourceRunId,a.observer_public_key AS observerPublicKey,a.target_public_key AS targetPublicKey,
    a.observed_at AS observedAt,a.regions_json AS regionsJson,a.repeater_clock AS repeaterClock,
    a.body_bytes AS bodyBytes,a.csv_bytes AS csvBytes,a.parser_version AS parserVersion,a.completeness,a.provenance,
    o.clock_anomaly AS clockAnomaly,p.attempt_count AS attemptCount
    FROM region_publications p JOIN region_answers a ON a.id=p.answer_id
    JOIN region_query_outcomes o ON o.request_id=a.request_id
    WHERE p.broker_id=? AND p.state='pending' AND p.next_due_at<=? AND a.observation_time_conflict=0
    ORDER BY p.next_due_at,p.answer_id LIMIT 1`);
  const claimPublication = db.prepare(`UPDATE region_publications SET state='publishing',attempt_count=attempt_count+1,
    last_attempt_at=?,claim_run_id=?,claim_token=? WHERE answer_id=? AND broker_id=? AND state='pending'`);
  const resolvePublication = db.prepare(`UPDATE region_publications SET state=?,last_result_at=?,next_due_at=?,last_error=?,
    claim_run_id=NULL,claim_token=NULL WHERE answer_id=? AND broker_id=? AND state='publishing' AND claim_run_id=? AND claim_token=?
    AND EXISTS(SELECT 1 FROM region_answers a WHERE a.id=answer_id AND a.observation_time_conflict=0)`);
  const recoverPublications = db.prepare(`UPDATE region_publications SET state='pending',claim_run_id=NULL,claim_token=NULL
    WHERE state='publishing'`);

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
    },

    stage(input) {
      assertRegionInput(regionStagePublicationsSchema, input); requireRun();
      db.exec('BEGIN');
      try {
        const row = answerById.get(input.answerId);
        if (!row) throw new Error('Region answer not found');
        mapAnswer(row); // Validate saved immutable content before staging any destination.
        let staged = 0;
        if (!row.observationTimeConflict) for (const brokerId of input.brokerIds) {
          staged += stageInitial.run(row.id,brokerId,row.completedAt,brokerId,
            row.observerPublicKey,row.targetPublicKey,row.observedAt).changes;
        }
        db.exec('COMMIT');
        return { answerId: row.id, staged, observationTimeConflict: Boolean(row.observationTimeConflict) };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },

    claim(input) {
      assertRegionInput(regionClaimPublicationSchema, input); requireRun(input.runId);
      db.exec('BEGIN');
      try {
        const row = duePublication.get(input.brokerId,input.now);
        let claim = null;
        if (row) {
          const answer = mapAnswer(row), claimToken = randomUUID();
          if (claimPublication.run(input.now,input.runId,claimToken,row.answerId,input.brokerId).changes !== 1) {
            throw new Error('Region publication claim conflict');
          }
          claim = { answerId: row.answerId, brokerId: input.brokerId, runId: input.runId, claimToken,
            attemptCount: row.attemptCount + 1, lastAttemptAt: input.now, requestId: row.requestId,
            sourceRunId: row.sourceRunId, observerPublicKey: row.observerPublicKey, targetPublicKey: row.targetPublicKey,
            clockAnomaly: Boolean(row.clockAnomaly), answer };
        }
        db.exec('COMMIT'); return claim;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },

    resolve(input) {
      assertRegionInput(regionResolvePublicationSchema, input); requireRun(input.runId);
      // One conditional statement guards broker, answer, run, token and ambiguity.
      // A stale/collided claim cannot certify success or schedule another retry.
      return resolvePublication.run(input.status,input.resolvedAt,
        input.status === 'pending' ? input.nextDueAt : input.resolvedAt,
        input.status === 'pending' ? input.reason : null,input.answerId,input.brokerId,input.runId,input.claimToken).changes === 1;
    },

    // Internal only: caller already owns the DB, inside its new-run transaction.
    // Preserve original times, attempts and prior results; the interrupted
    // attempt's acknowledgement remains unknown, with no fabricated result.
    recoverPublications() { return recoverPublications.run().changes; }
  };
}
