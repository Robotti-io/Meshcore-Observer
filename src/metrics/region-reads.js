import { assertRegionInput } from '../regions/region-validation.js';
import { regionLatestQuerySchema, regionAnswerPageSchema, regionOutcomePageSchema,
  regionPublicationPageSchema, regionOutcomeSchema } from '../regions/region-schemas.js';
import { mapAnswer } from './region-history.js';

const ANSWER_COLUMNS = `a.id AS answerId,a.request_id AS requestId,o.run_id AS runId,
  a.observer_public_key AS observerPublicKey,a.target_public_key AS targetPublicKey,
  a.observed_at AS observedAt,a.regions_json AS regionsJson,a.repeater_clock AS repeaterClock,
  a.body_bytes AS bodyBytes,a.csv_bytes AS csvBytes,a.parser_version AS parserVersion,a.completeness,a.provenance,
  a.observation_time_conflict AS observationTimeConflict,o.clock_anomaly AS clockAnomaly`;
const OUTCOME_COLUMNS = `o.request_id AS requestId,o.run_id AS runId,o.observer_public_key AS observerPublicKey,
  o.target_public_key AS targetPublicKey,o.started_at AS startedAt,o.completed_at AS completedAt,
  o.clock_anomaly AS clockAnomaly,o.status,o.reason,o.route`;
const ANSWERS = 'region_answers a JOIN region_query_outcomes o ON o.request_id=a.request_id';
const POLICY = { retainedHistoryOnly: true, historyCompleteness: 'unknown' };
function savedAnswer(row) {
  return { answerId: row.answerId, requestId: row.requestId, runId: row.runId,
    observerPublicKey: row.observerPublicKey, targetPublicKey: row.targetPublicKey, ...mapAnswer(row),
    observationTimeConflict: Boolean(row.observationTimeConflict), clockAnomaly: Boolean(row.clockAnomaly) };
}
function savedOutcome(row) {
  if (!row) return null;
  const outcome = { ...row, clockAnomaly: Boolean(row.clockAnomaly) };
  assertRegionInput(regionOutcomeSchema, outcome); return outcome;
}
function page(schema, input) {
  assertRegionInput(schema, input); // Validate original shape before applying defaults.
  return { ...input, limit: input.limit === undefined ? 100 : input.limit, offset: input.offset === undefined ? 0 : input.offset };
}
// Only fixed field/column pairs can form SQL; all caller values stay bound.
function scope(query, domain = 'answer') {
  const parts = [], values = [];
  const alias = domain === 'outcome' ? 'o' : 'a';
  for (const [field,column] of [['observerPublicKey',alias + '.observer_public_key'],['targetPublicKey',alias + '.target_public_key'],
    ...(domain !== 'publication' ? [['runId','o.run_id'],['status','o.status']] : [['brokerId','p.broker_id'],['state','p.state']])]) {
    if (query[field] !== undefined) { parts.push(column + '=?'); values.push(query[field]); }
  }
  return { where: parts.length ? parts.join(' AND ') : '1=1', values };
}

/** Bounded internal read model on the same private owned SQLite connection. */
export function createRegionReads(db) {
  let queryHighWater = 0;
  const durableTime = db.prepare('SELECT max(last_known_alive_at) AS value FROM observer_runs');
  const latestAnswer = db.prepare(`SELECT ${ANSWER_COLUMNS} FROM region_latest l JOIN region_answers a ON a.id=l.answer_id
    JOIN region_query_outcomes o ON o.request_id=a.request_id WHERE l.observer_public_key=? AND l.target_public_key=?`);
  const latestOutcome = db.prepare(`SELECT ${OUTCOME_COLUMNS} FROM region_query_outcomes o
    WHERE o.observer_public_key=? AND o.target_public_key=? ORDER BY o.completed_at DESC,o.request_id DESC LIMIT 1`);
  function coverage(from, filter, timestamp) {
    return { ...db.prepare(`SELECT count(*) AS retainedRecords,min(${timestamp}) AS earliestRetainedAt,
      max(${timestamp}) AS latestRetainedAt FROM ${from} WHERE ${filter.where}`).get(...filter.values), ...POLICY };
  }
  return {
    latest(query) {
      assertRegionInput(regionLatestQuerySchema, query);
      queryHighWater = Math.max(queryHighWater, query.now, durableTime.get().value ?? 0);
      const row = latestAnswer.get(query.observerPublicKey,query.targetPublicKey), answer = row ? savedAnswer(row) : null;
      const futureDated = Boolean(answer && answer.observedAt > query.now);
      const ageMs = answer && !futureDated ? queryHighWater - answer.observedAt : null;
      const freshness = !answer ? 'unknown' : answer.observationTimeConflict ? 'ambiguous' : futureDated ? 'future'
        : answer.clockAnomaly ? 'clock-anomaly' : ageMs >= query.windowMs ? 'stale' : 'fresh';
      return { observerPublicKey: query.observerPublicKey, targetPublicKey: query.targetPublicKey, answer,
        presence: !answer ? 'unknown' : answer.regions.length ? 'non-empty' : 'empty', freshness,
        fresh: freshness === 'fresh', ageMs, futureDated, clockRollback: query.now < queryHighWater,
        now: query.now, effectiveNow: queryHighWater, windowMs: query.windowMs,
        latestOutcome: savedOutcome(latestOutcome.get(query.observerPublicKey,query.targetPublicKey)),
        coverage: coverage(ANSWERS,scope(query),'a.observed_at') };
    },
    answers(input) {
      const query = page(regionAnswerPageSchema,input), filter = scope(query);
      const ranged = filter.where + ' AND a.observed_at>=? AND a.observed_at<?', values = [...filter.values,query.start,query.end];
      return { total: db.prepare(`SELECT count(*) AS total FROM ${ANSWERS} WHERE ${ranged}`).get(...values).total,
        answers: db.prepare(`SELECT ${ANSWER_COLUMNS} FROM ${ANSWERS} WHERE ${ranged}
          ORDER BY a.observed_at DESC,a.id DESC LIMIT ? OFFSET ?`).all(...values,query.limit,query.offset).map(savedAnswer),
        start: query.start, end: query.end, limit: query.limit, offset: query.offset, countScope: 'retained-range',
        coverage: coverage(ANSWERS,filter,'a.observed_at') };
    },
    outcomes(input) {
      const query = page(regionOutcomePageSchema,input), filter = scope(query,'outcome');
      const ranged = filter.where + ' AND o.completed_at>=? AND o.completed_at<?', values = [...filter.values,query.start,query.end];
      return { total: db.prepare(`SELECT count(*) AS total FROM region_query_outcomes o WHERE ${ranged}`).get(...values).total,
        outcomes: db.prepare(`SELECT ${OUTCOME_COLUMNS} FROM region_query_outcomes o WHERE ${ranged}
          ORDER BY o.completed_at DESC,o.request_id DESC LIMIT ? OFFSET ?`).all(...values,query.limit,query.offset).map(savedOutcome),
        start: query.start, end: query.end, limit: query.limit, offset: query.offset, countScope: 'retained-range',
        coverage: coverage('region_query_outcomes o',filter,'o.completed_at') };
    },
    publications(input) {
      const query = page(regionPublicationPageSchema,input), filter = scope(query,'publication');
      const from = 'region_publications p JOIN region_answers a ON a.id=p.answer_id';
      return { total: db.prepare(`SELECT count(*) AS total FROM ${from} WHERE ${filter.where}`).get(...filter.values).total,
        publications: db.prepare(`SELECT p.answer_id AS answerId,p.broker_id AS brokerId,p.state,p.attempt_count AS attemptCount,
          p.last_attempt_at AS lastAttemptAt,p.last_result_at AS lastResultAt,p.next_due_at AS nextDueAt,p.last_error AS lastError,
          p.claim_run_id AS claimRunId,a.observer_public_key AS observerPublicKey,a.target_public_key AS targetPublicKey,
          a.observed_at AS observedAt,a.observation_time_conflict AS observationTimeConflict FROM ${from} WHERE ${filter.where}
          ORDER BY p.next_due_at,p.answer_id LIMIT ? OFFSET ?`).all(...filter.values,query.limit,query.offset)
          .map(row => ({ ...row, observationTimeConflict: Boolean(row.observationTimeConflict),
            transportAcknowledgement: row.state === 'published' ? 'recorded-success' : 'unknown', downstreamIngestion: 'unknown' })),
        limit: query.limit, offset: query.offset, countScope: 'retained-publications', coverage: coverage(from,filter,'a.observed_at') };
    },
    // Internal only, inside MetricsStore's validated shared-retention transaction.
    prune(cutoffMs) {
      db.prepare("DELETE FROM region_publications WHERE state='published' AND last_result_at<?").run(cutoffMs);
      db.prepare(`DELETE FROM region_answers WHERE observed_at<? AND EXISTS(SELECT 1 FROM region_query_outcomes o
        WHERE o.request_id=region_answers.request_id AND o.completed_at<?)
        AND NOT EXISTS(SELECT 1 FROM region_latest l WHERE l.answer_id=region_answers.id)
        AND NOT EXISTS(SELECT 1 FROM region_publications p WHERE p.answer_id=region_answers.id)`).run(cutoffMs,cutoffMs);
      db.prepare(`DELETE FROM region_query_outcomes WHERE completed_at<?
        AND NOT EXISTS(SELECT 1 FROM region_answers a WHERE a.request_id=region_query_outcomes.request_id)`).run(cutoffMs);
    }
  };
}
