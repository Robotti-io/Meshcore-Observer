import { assertRegionQueryInput } from '../regions/region-query-validation.js';
import { REGION_QUERY_DEFAULTS, regionQueryPolicySchema, regionPollCandidateQuerySchema,
  regionPollStateQuerySchema, regionPollDeferralSchema, regionPollReservationSchema,
  regionPollCompletionSchema } from '../regions/region-query-schemas.js';

const DEFAULT_POLICY = Object.freeze(Object.fromEntries(Object.keys(regionQueryPolicySchema.properties)
  .map(key => [key, REGION_QUERY_DEFAULTS[key]])));
const MAX_TIME = Number.MAX_SAFE_INTEGER;
const at = (time, delay) => Math.min(MAX_TIME, time + delay);
const retryDelay = (policy, count, jitter = 0) => Math.min(policy.queryRetryMaxMs,
  Math.ceil(policy.queryRetryBaseMs * 2 ** Math.max(0, count - 1) * (1 + jitter)));
const STATE_COLUMNS = `observer_public_key AS observerPublicKey,target_public_key AS targetPublicKey,
  next_due_at AS nextDueAt,cycle_started_at AS cycleStartedAt,cycle_reservations AS cycleReservations,
  last_policy_at AS lastPolicyAt,last_reservation_id AS requestId,last_reservation_at AS reservedAt,
  reservation_run_id AS runId,last_reason AS reason`;
const scope = input => [input.observerPublicKey, input.targetPublicKey];

// Fixed SQL only; named values are bound after strict centralized validation.
// Scheduled pairs use the due index; uninitialized inventory uses keyset
// access and indexed latest/outcome headers, never body JSON/history counts.
// CROSS JOIN keeps the due range outside node lookups, avoiding a repeated
// range scan per node on unanalyzed databases. See SQLite's documented seam:
// https://www.sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join
const seededDue = `max(0,
  CASE WHEN a.observed_at<=:now AND a.observation_time_conflict=0 AND ao.clock_anomaly=0
    THEN min(9007199254740991,a.observed_at+:refresh) ELSE 0 END,
  CASE WHEN last.completed_at<=:now AND last.clock_anomaly=0 AND last.status IN ('failed','unsupported')
    THEN min(9007199254740991,last.completed_at+CASE WHEN last.status='unsupported' THEN :refresh ELSE :base END)
    ELSE 0 END)`;
const savedDue = `max(s.next_due_at,CASE WHEN s.cycle_reservations>0
  THEN min(9007199254740991,s.last_reservation_at+CASE WHEN s.cycle_reservations>=:attempts
    THEN :refresh ELSE min(:cap,:base*(1 << max(0,s.cycle_reservations-1))) END) ELSE 0 END,
  CASE WHEN s.cycle_reservations=0 THEN ${seededDue} ELSE 0 END)`;
const eligible = `n.type='REPEATER' AND n.last_direct_heard_at>:cutoff AND n.last_direct_heard_at<=:now
  AND n.public_key_hex>:after`;
export const REGION_POLL_CANDIDATE_SQL = `
  SELECT * FROM (
    SELECT n.public_key_hex AS targetPublicKey,n.last_direct_heard_at AS lastDirectHeardAt,
      ${savedDue} AS nextDueAt,s.cycle_reservations AS cycleReservations,s.last_policy_at AS lastPolicyAt,
      s.last_reason AS reason,1 AS initialized
    FROM region_poll_state s INDEXED BY idx_region_poll_due CROSS JOIN nodes n ON n.public_key_hex=s.target_public_key
    LEFT JOIN region_latest l ON l.observer_public_key=:observer AND l.target_public_key=n.public_key_hex
      AND s.cycle_reservations=0
    LEFT JOIN region_answers a ON a.id=l.answer_id
    LEFT JOIN region_query_outcomes ao ON ao.request_id=a.request_id
    LEFT JOIN region_query_outcomes last ON last.request_id=(
      SELECT request_id FROM region_query_outcomes WHERE observer_public_key=:observer
        AND target_public_key=n.public_key_hex AND s.cycle_reservations=0
        ORDER BY completed_at DESC,request_id DESC LIMIT 1)
    WHERE s.observer_public_key=:observer AND s.next_due_at<=:now AND s.last_policy_at<=:now
      AND ${eligible} AND ${savedDue}<=:now
    UNION ALL
    SELECT n.public_key_hex,n.last_direct_heard_at,${seededDue},0,0,'ready',0
    FROM nodes n INDEXED BY idx_nodes_type_key
    LEFT JOIN region_latest l ON l.observer_public_key=:observer AND l.target_public_key=n.public_key_hex
    LEFT JOIN region_answers a ON a.id=l.answer_id
    LEFT JOIN region_query_outcomes ao ON ao.request_id=a.request_id
    LEFT JOIN region_query_outcomes last ON last.request_id=(
      SELECT request_id FROM region_query_outcomes WHERE observer_public_key=:observer
        AND target_public_key=n.public_key_hex ORDER BY completed_at DESC,request_id DESC LIMIT 1)
    WHERE ${eligible} AND NOT EXISTS(SELECT 1 FROM region_poll_state
      WHERE observer_public_key=:observer AND target_public_key=n.public_key_hex) AND ${seededDue}<=:now
  ) ORDER BY targetPublicKey LIMIT :limit`;

/** Scheduling metadata on MetricsStore's owned connection. No timers or RF. */
export function createRegionPollState(db, requireRun, recordWithinTransaction) {
  let highWater = 0;
  const durableTime = db.prepare(`SELECT max(
    coalesce((SELECT max(last_known_alive_at) FROM observer_runs),0),
    coalesce((SELECT max(last_policy_at) FROM region_poll_state),0)) AS value`);
  const stateByKey = db.prepare(`SELECT ${STATE_COLUMNS} FROM region_poll_state
    WHERE observer_public_key=? AND target_public_key=?`);
  const latest = db.prepare(`SELECT a.observed_at AS observedAt,a.observation_time_conflict AS conflict,
    o.clock_anomaly AS clockAnomaly FROM region_latest l JOIN region_answers a ON a.id=l.answer_id
    JOIN region_query_outcomes o ON o.request_id=a.request_id WHERE l.observer_public_key=? AND l.target_public_key=?`);
  const terminal = db.prepare(`SELECT completed_at AS completedAt,status,clock_anomaly AS clockAnomaly
    FROM region_query_outcomes WHERE observer_public_key=? AND target_public_key=?
    ORDER BY completed_at DESC,request_id DESC LIMIT 1`);
  const outcomeExists = db.prepare('SELECT 1 FROM region_query_outcomes WHERE request_id=?');
  const candidates = db.prepare(REGION_POLL_CANDIDATE_SQL);
  const save = db.prepare(`INSERT INTO region_poll_state(observer_public_key,target_public_key,next_due_at,
    cycle_started_at,cycle_reservations,last_policy_at,last_reservation_id,last_reservation_at,reservation_run_id,last_reason)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(observer_public_key,target_public_key) DO UPDATE SET
    next_due_at=excluded.next_due_at,cycle_started_at=excluded.cycle_started_at,cycle_reservations=excluded.cycle_reservations,
    last_policy_at=excluded.last_policy_at,last_reservation_id=excluded.last_reservation_id,
    last_reservation_at=excluded.last_reservation_at,reservation_run_id=excluded.reservation_run_id,last_reason=excluded.last_reason`);
  function write(state) {
    save.run(...scope(state),state.nextDueAt,state.cycleStartedAt,state.cycleReservations,state.lastPolicyAt,
      state.requestId,state.reservedAt,state.runId,state.reason);
  }
  function transaction(work) {
    db.exec('BEGIN');
    try { const value = work(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function clock(now) {
    highWater = Math.max(highWater,durableTime.get().value);
    const rollback = now < highWater;
    highWater = Math.max(highWater,now);
    return rollback;
  }
  function initialize(input, now, policy) {
    const answer = latest.get(...scope(input)), outcome = terminal.get(...scope(input));
    const answerDue = answer && answer.observedAt<=now && !answer.conflict && !answer.clockAnomaly
      ? at(answer.observedAt,policy.queryRefreshIntervalMs) : 0;
    const failureDue = outcome && outcome.completedAt<=now && !outcome.clockAnomaly && outcome.status!=='answered'
      ? at(outcome.completedAt,outcome.status==='unsupported' ? policy.queryRefreshIntervalMs : policy.queryRetryBaseMs) : 0;
    return { ...Object.fromEntries(['observerPublicKey','targetPublicKey'].map(key => [key,input[key]])),
      nextDueAt: Math.max(answerDue,failureDue),cycleStartedAt: now,cycleReservations: 0,lastPolicyAt: now,
      requestId: null,reservedAt: null,runId: null,
      reason: failureDue>answerDue ? 'seeded-failure' : answerDue>0 ? 'seeded-success' : 'ready' };
  }
  function due(state, policy) {
    if (state.cycleReservations===0) return state.nextDueAt;
    return Math.max(state.nextDueAt,at(state.reservedAt,state.cycleReservations>=policy.queryMaxAttempts
      ? policy.queryRefreshIntervalMs : retryDelay(policy,state.cycleReservations)));
  }
  return {
    highWater() { highWater = Math.max(highWater,durableTime.get().value); return highWater; },
    state(input) {
      assertRegionQueryInput(regionPollStateQuerySchema,input);
      const row = stateByKey.get(...scope(input)); return row ? { ...row } : null;
    },
    candidates(query, policy = DEFAULT_POLICY) {
      assertRegionQueryInput(regionPollCandidateQuerySchema,query);
      assertRegionQueryInput(regionQueryPolicySchema,policy);
      const limit = query.limit ?? 100, clockRollback = clock(query.now);
      const rows = clockRollback ? [] : candidates.all({ observer: query.observerPublicKey,now: query.now,
        cutoff: query.now-query.windowMs,after: query.afterPublicKey ?? '',limit,
        refresh: policy.queryRefreshIntervalMs,base: policy.queryRetryBaseMs,cap: policy.queryRetryMaxMs,
        attempts: policy.queryMaxAttempts });
      return { candidates: rows.map(row => ({ ...row,initialized: Boolean(row.initialized) })),
        limit,nextCursor: rows.at(-1)?.targetPublicKey ?? null,exhausted: rows.length<limit,
        clockRollback,effectiveNow: highWater };
    },
    defer(input, policy = DEFAULT_POLICY) {
      assertRegionQueryInput(regionPollDeferralSchema,input);
      assertRegionQueryInput(regionQueryPolicySchema,policy); requireRun(input.runId);
      if (clock(input.observedAt)) return { deferred: false,reason: 'clock-rollback' };
      return transaction(() => {
        const state = stateByKey.get(...scope(input));
        if (state && input.observedAt<due(state,policy)) return { deferred: false,reason: 'not-due' };
        const next = state ? { ...state } : initialize(input,input.observedAt,policy);
        const transitioned = next.reason!==input.reason;
        next.nextDueAt = Math.max(next.nextDueAt,input.nextDueAt);
        next.lastPolicyAt = input.observedAt; next.reason = input.reason; write(next);
        return { deferred: true,transitioned,state: next };
      });
    },
    reserve(input) {
      assertRegionQueryInput(regionPollReservationSchema,input); requireRun(input.runId);
      if (clock(input.reservedAt)) return { reserved: false,reason: 'clock-rollback' };
      return transaction(() => {
        const saved = stateByKey.get(...scope(input)), state = saved ? { ...saved } : initialize(input,input.reservedAt,input.policy);
        if (state.requestId===input.requestId || outcomeExists.get(input.requestId)) {
          return { reserved: false,reason: 'duplicate-reservation' };
        }
        if (saved && state.cycleReservations===0) {
          // Current cadence can lengthen an idle receipt-based baseline,
          // but never shorten a deadline already saved under earlier policy.
          state.nextDueAt=Math.max(state.nextDueAt,initialize(input,input.reservedAt,input.policy).nextDueAt);
        }
        const nextDueAt = due(state,input.policy);
        if (input.reservedAt<nextDueAt) {
          if (!saved || nextDueAt>saved.nextDueAt) { state.nextDueAt=nextDueAt; state.lastPolicyAt=input.reservedAt; write(state); }
          return { reserved: false,reason: 'not-due',state };
        }
        if (state.cycleReservations===0 || state.cycleReservations>=input.policy.queryMaxAttempts
          || ['exhausted','unsupported'].includes(state.reason)
          || input.reservedAt>=at(state.cycleStartedAt,input.policy.queryRefreshIntervalMs)) {
          state.cycleReservations=0; state.cycleStartedAt=input.reservedAt;
        }
        state.cycleReservations++;
        const delay = state.cycleReservations>=input.policy.queryMaxAttempts ? input.policy.queryRefreshIntervalMs
          : retryDelay(input.policy,state.cycleReservations,input.jitterRatio);
        if (input.reservedAt>MAX_TIME-delay) return { reserved: false,reason: 'clock-range' };
        Object.assign(state,{ nextDueAt: input.reservedAt+delay,lastPolicyAt: input.reservedAt,
          requestId: input.requestId,reservedAt: input.reservedAt,runId: input.runId,reason: 'reserved' });
        write(state);
        return { reserved: true,state };
      });
    },
    complete(input) {
      assertRegionQueryInput(regionPollCompletionSchema,input); requireRun(input.runId);
      return transaction(() => {
        const state = stateByKey.get(...scope(input));
        if (!state || state.requestId!==input.requestId || state.runId!==input.runId) {
          return { completed: false,reason: 'stale-reservation' };
        }
        if (state.reason!=='reserved') return { completed: false,reason: 'already-completed' };
        const { outcome,answer } = input.result;
        if (!outcome.clockAnomaly && outcome.startedAt<state.reservedAt) throw new Error('Invalid region query data');
        const recorded = recordWithinTransaction(input.result);
        const end = Math.max(state.lastPolicyAt,outcome.startedAt,outcome.completedAt,answer?.observedAt ?? 0);
        state.lastPolicyAt=end;
        if (outcome.status==='answered' && !outcome.clockAnomaly && !recorded.observationTimeConflict) {
          state.cycleReservations=0; state.cycleStartedAt=end; state.reason='answered';
          state.nextDueAt=Math.max(state.nextDueAt,at(answer.observedAt,input.policy.queryRefreshIntervalMs));
        } else if (outcome.status==='unsupported') {
          state.cycleReservations=0; state.cycleStartedAt=end; state.reason='unsupported';
          state.nextDueAt=Math.max(state.nextDueAt,at(end,input.policy.queryRefreshIntervalMs));
        } else {
          const exhausted=state.cycleReservations>=input.policy.queryMaxAttempts;
          state.reason=outcome.clockAnomaly ? 'clock-anomaly' : exhausted ? 'exhausted' : 'retry';
          state.nextDueAt=Math.max(state.nextDueAt,at(end,exhausted ? input.policy.queryRefreshIntervalMs
            : retryDelay(input.policy,state.cycleReservations,input.jitterRatio)));
        }
        write(state); highWater=Math.max(highWater,end);
        return { completed: true,recorded,state: { ...state } };
      });
    }
  };
}
