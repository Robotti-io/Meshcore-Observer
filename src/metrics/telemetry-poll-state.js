import { assertTelemetryState, telemetryStatePolicySchema,
  telemetryStateScopeSchema, telemetryStateQuerySchema, telemetryEvidenceQuerySchema, telemetryCandidateQuerySchema,
  telemetryDirectEvidenceSchema, telemetryReservationSchema, telemetryPollCompletionSchema, telemetryAuthCompletionSchema,
  telemetryDeferralSchema, telemetryRecoverySchema, telemetryAuthPageSchema } from '../telemetry/poll-state-schemas.js';
import { assertTelemetryResult, telemetryVariantKey } from '../telemetry/telemetry-validation.js';
import { telemetryAuthenticationRecordSchema } from '../telemetry/telemetry-owner-schemas.js';

const MAX_TIME = Number.MAX_SAFE_INTEGER;
const at = (time, delay) => Math.min(MAX_TIME, time + delay);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const variantKey = variant => variant.component === 'guest-login' ? 'guest-login' : telemetryVariantKey(variant);
const scope = input => [input.observerPublicKey, input.targetPublicKey];
const stateScope = input => [...scope(input), input.variant.component, variantKey(input.variant)];
const retry = (policy, attempts) => Math.min(policy.retryMaxMs, policy.retryBaseMs * 2 ** Math.max(0, attempts - 1));
const AUTH_VARIANT = Object.freeze({ component: 'guest-login', params: {} });
const columns = `observer_public_key AS observerPublicKey,target_public_key AS targetPublicKey,
  variant_json AS variantJson,next_due_at AS nextDueAt,cycle_started_at AS cycleStartedAt,cycle_attempts AS cycleAttempts,
  last_policy_at AS lastPolicyAt,last_completed_at AS lastCompletedAt,request_id AS requestId,reserved_at AS reservedAt,run_id AS runId,
  reason,policy_json AS policyJson,server_timestamp AS serverTimestamp,replay_run_id AS replayRunId,replay_request_id AS replayRequestId`;
const policyReasons = ['answered', 'partial', 'unsupported', 'exhausted'];
const unsafeAuthentication = new Set(['authentication-denied', 'unsafe-login-permissions',
  'legacy-login-proof', 'unsupported-login-protocol', 'auth-replay']);
const validPath = `p.kind='flood-traversed' AND p.repeated_prefix=0 AND p.last_received_at>:cutoff
  AND p.last_received_at<=:now AND h.distance BETWEEN 1 AND :radius
  AND EXISTS(SELECT 1 FROM topology_observations o JOIN observer_runs r ON r.id=o.run_id
    WHERE o.path_id=p.id AND o.received_at=p.last_received_at AND r.wall_time_anomaly=0 AND o.received_at>=r.started_at)`;
// Prefix association counts ALL node types, using the existing expression indexes.
// It is passive positional evidence, never an assertion of an outbound route.
const flood = width => `SELECT :target AS targetPublicKey,h.distance,p.last_received_at AS receivedAt
  FROM topology_path_hops h INDEXED BY idx_topology_hops_prefix CROSS JOIN topology_paths p ON p.id=h.path_id
  WHERE h.hash_width=${width} AND h.prefix=substr(:target,1,${width * 2})
    AND p.observer_public_key=:observer AND ${validPath} AND :target!=:observer
    AND EXISTS(SELECT 1 FROM nodes WHERE public_key_hex=:target AND type='REPEATER')
    AND (SELECT count(*) FROM nodes WHERE upper(substr(public_key_hex,1,${width * 2}))=substr(:target,1,${width * 2}))=1`;
const direct = exact => `SELECT d.target_public_key AS targetPublicKey,1 AS distance,d.received_at AS receivedAt
  FROM telemetry_direct_evidence d ${exact ? '' : 'INDEXED BY idx_telemetry_direct_fresh'} JOIN nodes n ON n.public_key_hex=d.target_public_key
  JOIN observer_runs r ON r.id=d.run_id WHERE d.observer_public_key=:observer AND d.eligible=1
    AND r.wall_time_anomaly=0 AND n.type='REPEATER' AND d.target_public_key!=:observer
    AND d.received_at>:cutoff AND d.received_at<=:now
    AND ${exact ? 'd.target_public_key=:target' : 'd.target_public_key>:after'}`;
const candidateFlood = width => `SELECT n.public_key_hex AS targetPublicKey,h.distance,h.receivedAt
  FROM resolved h CROSS JOIN nodes n ON upper(substr(n.public_key_hex,1,${width * 2}))=+h.prefix
  WHERE h.hashWidth=${width} AND n.type='REPEATER' AND n.public_key_hex!=:observer AND n.public_key_hex>:after
    AND length(n.public_key_hex)=64 AND n.public_key_hex NOT GLOB '*[^0-9A-F]*'`;
export const TELEMETRY_CANDIDATE_SQL = `WITH hops AS MATERIALIZED (
  SELECT h.hash_width AS hashWidth,h.prefix,min(h.distance) AS distance,max(p.last_received_at) AS receivedAt
  FROM topology_paths p INDEXED BY idx_topology_paths_observer_kind_at JOIN topology_path_hops h ON h.path_id=p.id
  WHERE p.observer_public_key=:observer AND ${validPath} GROUP BY h.hash_width,h.prefix
), resolved AS MATERIALIZED (SELECT * FROM hops h WHERE CASE h.hashWidth
  ${[1, 2, 3].map(w => `WHEN ${w} THEN (SELECT count(*) FROM nodes WHERE upper(substr(public_key_hex,1,${w * 2}))=+h.prefix)`).join(' ')} END=1)
  SELECT targetPublicKey,min(distance) AS distance,max(receivedAt) AS receivedAt
  FROM (${[direct(false), ...[1, 2, 3].map(candidateFlood)].join(' UNION ALL ')})
  GROUP BY targetPublicKey ORDER BY targetPublicKey LIMIT :limit`;
export const TELEMETRY_ELIGIBILITY_SQL = `SELECT targetPublicKey,min(distance) AS distance,max(receivedAt) AS receivedAt
  FROM (${[direct(true), ...[1, 2, 3].map(flood)].join(' UNION ALL ')}) GROUP BY targetPublicKey`;

/** Durable metadata on the one owned connection. No live grant, timer or RF queue. */
export function createTelemetryPollState(db, requireRun, recordWithinTransaction) {
  let highWater = 0;
  const durableClock = db.prepare(`SELECT max(coalesce((SELECT max(last_known_alive_at) FROM observer_runs),0),
    coalesce((SELECT max(last_policy_at) FROM telemetry_poll_state),0)) AS value`);
  const byScope = db.prepare(`SELECT ${columns} FROM telemetry_poll_state
    WHERE observer_public_key=? AND target_public_key=? AND component=? AND variant_key=?`);
  const knownRequest = db.prepare(`SELECT request_id FROM telemetry_poll_state WHERE request_id=?
    UNION ALL SELECT request_id FROM telemetry_auth_outcomes WHERE request_id=?
    UNION ALL SELECT request_id FROM telemetry_query_outcomes WHERE request_id=? LIMIT 1`);
  const save = db.prepare(`INSERT INTO telemetry_poll_state(observer_public_key,target_public_key,component,variant_key,
    variant_json,next_due_at,cycle_started_at,cycle_attempts,last_policy_at,last_completed_at,request_id,reserved_at,run_id,reason,policy_json,server_timestamp,replay_run_id,replay_request_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(observer_public_key,target_public_key,component,variant_key) DO UPDATE SET
    next_due_at=excluded.next_due_at,cycle_started_at=excluded.cycle_started_at,cycle_attempts=excluded.cycle_attempts,
    last_policy_at=excluded.last_policy_at,last_completed_at=excluded.last_completed_at,request_id=excluded.request_id,reserved_at=excluded.reserved_at,
    run_id=excluded.run_id,reason=excluded.reason,policy_json=excluded.policy_json,server_timestamp=excluded.server_timestamp,
    replay_run_id=excluded.replay_run_id,replay_request_id=excluded.replay_request_id`);
  const evidence = db.prepare(TELEMETRY_ELIGIBILITY_SQL), candidates = db.prepare(TELEMETRY_CANDIDATE_SQL);
  const saveDirect = db.prepare(`INSERT INTO telemetry_direct_evidence(observer_public_key,target_public_key,run_id,
    received_at,event_digest,provenance,eligible) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(observer_public_key,target_public_key) DO UPDATE SET run_id=excluded.run_id,received_at=excluded.received_at,
    event_digest=excluded.event_digest,eligible=excluded.eligible WHERE excluded.received_at>telemetry_direct_evidence.received_at`);
  const authById = db.prepare('SELECT run_id AS runId,record_json AS recordJson FROM telemetry_auth_outcomes WHERE request_id=?');
  const insertAuth = db.prepare(`INSERT INTO telemetry_auth_outcomes(request_id,run_id,observer_public_key,target_public_key,
    dispatched_at,completed_at,generation,status,reason,route,clock_anomaly,record_json,server_timestamp)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const seeded = db.prepare(`SELECT o.received_at AS receivedAt,o.completed_at AS completedAt,o.status,o.clock_anomaly AS clockAnomaly,
    s.observation_time_conflict AS conflict,r.wall_time_anomaly AS runAnomaly FROM telemetry_query_outcomes o
    JOIN observer_runs r ON r.id=o.run_id LEFT JOIN telemetry_observations s ON s.request_id=o.request_id
    WHERE o.observer_public_key=? AND o.target_public_key=? AND o.component=? AND o.variant_key=?
    ORDER BY o.completed_at DESC,o.request_id DESC LIMIT 1`);
  function transaction(work) {
    db.exec('BEGIN');
    try { const value = work(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function clock(now) {
    highWater = Math.max(highWater, durableClock.get().value);
    const rollback = now < highWater; highWater = Math.max(highWater, now); return rollback;
  }
  function map(row) {
    if (!row) return null;
    const { variantJson, policyJson, ...fields } = row;
    try {
      const variant = JSON.parse(variantJson), policy = JSON.parse(policyJson);
      assertTelemetryState(telemetryStateQuerySchema, { ...Object.fromEntries(['observerPublicKey', 'targetPublicKey'].map(k => [k, fields[k]])), variant });
      assertTelemetryState(telemetryStatePolicySchema, policy);
      return { ...fields, variant, policy };
    } catch { throw new Error('Invalid stored telemetry polling data'); }
  }
  function write(state) {
    save.run(...stateScope(state), json(state.variant), state.nextDueAt, state.cycleStartedAt, state.cycleAttempts,
      state.lastPolicyAt, state.lastCompletedAt, state.requestId, state.reservedAt, state.runId, state.reason, json(state.policy),
      state.serverTimestamp, state.replayRunId, state.replayRequestId);
  }
  function conservative(saved, policy) {
    return Object.fromEntries(Object.keys(policy).map(k => [k, k === 'maxAttempts'
      ? Math.min(saved[k], policy[k]) : Math.max(saved[k], policy[k])]));
  }
  function due(state, policy) {
    const p = conservative(state.policy, policy);
    const delay = state.reason === 'auth-cooldown' ? p.authCooldownMs : policyReasons.includes(state.reason)
      || state.cycleAttempts >= p.maxAttempts ? p.refreshIntervalMs : retry(p, state.cycleAttempts);
    return Math.max(state.nextDueAt, state.requestId ? at(state.lastCompletedAt ?? state.reservedAt, delay) : 0);
  }
  function initialize(input, now, policy) {
    const old = input.variant.component === 'guest-login' ? null : seeded.get(...stateScope(input));
    const valid = old && !old.clockAnomaly && !old.runAnomaly && !old.conflict && old.completedAt <= now;
    const nextDueAt = valid ? at(old.receivedAt ?? old.completedAt,
      ['answered', 'partial', 'unsupported'].includes(old.status) ? policy.refreshIntervalMs : policy.retryBaseMs) : 0;
    return { ...Object.fromEntries(['observerPublicKey', 'targetPublicKey', 'variant'].map(k => [k, input[k]])),
      nextDueAt, cycleStartedAt: now, cycleAttempts: 0, lastPolicyAt: now,
      requestId: null, reservedAt: null, lastCompletedAt: null, runId: null, reason: 'ready', policy: { ...policy },
      serverTimestamp: null, replayRunId: null, replayRequestId: null };
  }
  function eligible(input) {
    return evidence.get({ observer: input.observerPublicKey, target: input.targetPublicKey,
      now: input.now, cutoff: input.now - input.windowMs, radius: input.radius });
  }
  function finish(state, end, policy, successful, unsupported = false, authFailure = false) {
    state.policy = conservative(state.policy, policy);
    state.lastPolicyAt = Math.max(state.lastPolicyAt, end);
    state.lastCompletedAt = state.lastPolicyAt;
    if (successful || unsupported) {
      state.cycleAttempts = 0; state.cycleStartedAt = state.lastPolicyAt;
      state.reason = state.variant.component === 'guest-login' ? 'authenticated' : unsupported ? 'unsupported' : 'answered';
    } else state.reason = authFailure ? 'auth-cooldown' : state.cycleAttempts >= state.policy.maxAttempts ? 'exhausted' : 'retry';
    const delay = authFailure ? state.policy.authCooldownMs : successful && state.variant.component === 'guest-login'
      ? state.policy.retryBaseMs : successful || unsupported || state.reason === 'exhausted' ? state.policy.refreshIntervalMs
        : retry(state.policy, state.cycleAttempts);
    state.nextDueAt = Math.max(state.nextDueAt, at(state.lastPolicyAt, delay)); write(state);
    highWater = Math.max(highWater, state.lastPolicyAt);
  }
  return {
    highWater() { highWater = Math.max(highWater, durableClock.get().value); return highWater; },
    state(input) { assertTelemetryState(telemetryStateQuerySchema, input); return map(byScope.get(...stateScope(input))); },
    replay(input) {
      assertTelemetryState(telemetryStateScopeSchema, input);
      return { serverTimestamp: map(byScope.get(...stateScope({ ...input, variant: AUTH_VARIANT })))?.serverTimestamp ?? null };
    },
    direct(input) {
      assertTelemetryState(telemetryDirectEvidenceSchema, input); const run = requireRun(input.runId);
      // Captured verified receipt only; old unscoped nodes cannot manufacture this marker.
      return { updated: saveDirect.run(...scope(input), input.runId, input.receivedAt, input.eventDigest,
        input.provenance, Number(!run.wallTimeAnomaly && input.receivedAt >= run.startedAt)).changes > 0 };
    },
    eligible(input) {
      assertTelemetryState(telemetryEvidenceQuerySchema, input);
      const row = clock(input.now) ? null : eligible(input);
      return row ? { ...row, outboundRouteVerified: false } : null;
    },
    candidates(input) {
      assertTelemetryState(telemetryCandidateQuerySchema, input);
      const limit = input.limit ?? 100, rollback = clock(input.now);
      const rows = rollback ? [] : candidates.all({ observer: input.observerPublicKey, now: input.now,
        cutoff: input.now - input.windowMs, radius: input.radius, after: input.afterPublicKey ?? '', limit });
      return { candidates: rows.map(row => ({ ...row, outboundRouteVerified: false })), limit,
        nextCursor: rows.at(-1)?.targetPublicKey ?? null, exhausted: rows.length < limit, clockRollback: rollback, effectiveNow: highWater };
    },
    reserve(input) {
      assertTelemetryState(telemetryReservationSchema, input); const run = requireRun(input.runId);
      if (clock(input.reservedAt) || run.wallTimeAnomaly || input.reservedAt < run.startedAt) return { reserved: false, reason: 'clock-anomaly' };
      return transaction(() => {
        if (knownRequest.get(input.requestId, input.requestId, input.requestId)) return { reserved: false, reason: 'duplicate-reservation' };
        if (!eligible({ ...input, now: input.reservedAt })) return { reserved: false, reason: 'ineligible' };
        const auth = map(byScope.get(...stateScope({ ...input, variant: AUTH_VARIANT })));
        if (auth?.reason === 'auth-cooldown' && input.reservedAt < due(auth, input.policy)) return { reserved: false, reason: 'auth-cooldown' };
        const saved = map(byScope.get(...stateScope(input))), state = saved ?? initialize(input, input.reservedAt, input.policy);
        if (saved?.reason === 'reserved') return { reserved: false, reason: 'pending-reservation' };
        state.policy = conservative(state.policy, input.policy);
        state.nextDueAt = Math.max(due(state, state.policy), initialize(input, input.reservedAt, state.policy).nextDueAt);
        if (input.reservedAt < state.nextDueAt) { state.lastPolicyAt = input.reservedAt; write(state); return { reserved: false, reason: 'not-due', state }; }
        if (state.cycleAttempts === 0 || state.cycleAttempts >= state.policy.maxAttempts || policyReasons.includes(state.reason)
          || input.reservedAt >= at(state.cycleStartedAt, state.policy.refreshIntervalMs)) {
          // Honor a new cycle's configuration only after the prior durable deadline.
          state.cycleAttempts = 0; state.cycleStartedAt = input.reservedAt; state.policy = { ...input.policy };
        }
        state.cycleAttempts++;
        const delay = state.cycleAttempts >= state.policy.maxAttempts ? state.policy.refreshIntervalMs : retry(state.policy, state.cycleAttempts);
        if (input.reservedAt > MAX_TIME - delay) return { reserved: false, reason: 'clock-range' };
        Object.assign(state, { requestId: input.requestId, reservedAt: input.reservedAt, runId: input.runId,
          lastPolicyAt: input.reservedAt, lastCompletedAt: null, nextDueAt: at(input.reservedAt, delay), reason: 'reserved' });
        write(state); return { reserved: true, state };
      });
    },
    defer(input) {
      assertTelemetryState(telemetryDeferralSchema, input); const run = requireRun(input.runId);
      if (input.nextDueAt < input.observedAt) throw new Error('Invalid telemetry polling data');
      if (clock(input.observedAt) || run.wallTimeAnomaly) return { deferred: false, reason: 'clock-anomaly' };
      return transaction(() => {
        const state = map(byScope.get(...stateScope(input))) ?? initialize(input, input.observedAt, input.policy);
        if (state.reason === 'reserved') return { deferred: false, reason: 'pending-reservation' };
        state.nextDueAt = Math.max(due(state, input.policy), input.nextDueAt); state.lastPolicyAt = input.observedAt;
        state.policy = conservative(state.policy, input.policy);
        // Keep the auth cooldown classification while extending its deadline.
        if (state.reason !== 'auth-cooldown') state.reason = input.reason;
        write(state); return { deferred: true, state };
      });
    },
    complete(input) {
      assertTelemetryState(telemetryPollCompletionSchema, input); assertTelemetryResult(input.result);
      const o = input.result.outcome, run = requireRun(o.runId);
      assertTelemetryState(telemetryStateQuerySchema, { observerPublicKey: o.observerPublicKey, targetPublicKey: o.targetPublicKey, variant: o.variant });
      if (['answered', 'partial'].includes(o.status) && o.route !== 'direct') throw new Error('Invalid telemetry polling data');
      return transaction(() => {
        const state = map(byScope.get(...stateScope(o)));
        if (!state || state.requestId !== o.requestId || state.runId !== o.runId) return { completed: false, reason: 'stale-reservation' };
        if (state.reason !== 'reserved') {
          const recorded = recordWithinTransaction(input.result); return { completed: false, reason: 'already-completed', recorded };
        }
        if (!o.clockAnomaly && o.startedAt < state.reservedAt) throw new Error('Invalid telemetry polling data');
        const recorded = recordWithinTransaction(input.result);
        const end = Math.max(o.startedAt, o.completedAt, o.receivedAt ?? 0);
        const successful = ['answered', 'partial'].includes(o.status) && !o.clockAnomaly && !run.wallTimeAnomaly && !recorded.observationTimeConflict;
        finish(state, end, input.policy, successful, o.status === 'unsupported');
        return { completed: true, recorded, state };
      });
    },
    authenticate(input) {
      assertTelemetryState(telemetryAuthCompletionSchema, input); const run = requireRun(input.runId);
      const r = input.record, c = r.context;
      if (c.operation !== 'guest-login' || Object.keys(c.params).length !== 0 || Buffer.byteLength(json(r)) > 4096
        || (r.proof?.publicKeyPrefix && r.proof.publicKeyPrefix !== c.targetPublicKey.slice(0, 12))) throw new Error('Invalid telemetry polling data');
      const success = r.status === 'completed';
      const anomaly = run.wallTimeAnomaly || r.dispatchedAt < run.startedAt || r.completedAt < r.dispatchedAt;
      if (success && (anomaly || r.reason !== null || r.route !== 'direct' || r.proof?.status !== 'guest-proof')
        || !success && r.reason === null) throw new Error('Invalid telemetry polling data');
      return transaction(() => {
        const old = authById.get(c.requestId);
        if (old) {
          if (old.runId !== input.runId || old.recordJson !== json(r)) throw new Error('Telemetry authentication request identity conflict');
          return { completed: false, reason: 'already-completed', duplicate: true };
        }
        const state = map(byScope.get(...stateScope({ ...c, variant: AUTH_VARIANT })));
        if (!state || state.requestId !== c.requestId || state.runId !== input.runId || state.reason !== 'reserved') return { completed: false, reason: 'stale-reservation' };
        if (!anomaly && r.dispatchedAt < state.reservedAt) throw new Error('Invalid telemetry polling data');
        if (success && state.serverTimestamp !== null && r.proof.serverTimestamp <= state.serverTimestamp) throw new Error('Telemetry authentication replay rejected');
        insertAuth.run(c.requestId, input.runId, ...scope(c), r.dispatchedAt, r.completedAt, c.generation, r.status,
          r.reason, r.route, Number(anomaly), json(r), r.proof?.status === 'guest-proof' ? r.proof.serverTimestamp : null);
        if (success) Object.assign(state, { serverTimestamp: r.proof.serverTimestamp, replayRunId: input.runId, replayRequestId: c.requestId });
        finish(state, Math.max(r.dispatchedAt, r.completedAt), input.policy, success, false,
          !success && (anomaly || unsafeAuthentication.has(r.reason)));
        return { completed: true, duplicate: false, state };
      });
    },
    recover(input) {
      assertTelemetryState(telemetryRecoverySchema, input); requireRun(input.runId);
      if (clock(input.observedAt)) return { recovered: 0, clockRollback: true, nextCursor: null, exhausted: true };
      return transaction(() => {
        const limit = input.limit ?? 100;
        const rows = db.prepare(`SELECT ${columns} FROM telemetry_poll_state WHERE request_id>? AND reason='reserved'
          AND run_id!=? ORDER BY request_id LIMIT ?`).all(input.afterRequestId ?? '', input.runId, limit);
        for (const row of rows) { const state = map(row); finish(state, input.observedAt, input.policy, false, false,
          state.variant.component === 'guest-login'); state.reason = state.variant.component === 'guest-login' ? 'auth-cooldown' : 'orphaned'; write(state); }
        return { recovered: rows.length, clockRollback: false, nextCursor: rows.at(-1)?.requestId ?? null, exhausted: rows.length < limit };
      });
    },
    authenticationHistory(input) {
      assertTelemetryState(telemetryAuthPageSchema, input); const limit = input.limit ?? 100;
      const rows = db.prepare(`SELECT request_id AS requestId,run_id AS runId,record_json AS recordJson,
        clock_anomaly AS clockAnomaly FROM telemetry_auth_outcomes WHERE completed_at>=? AND completed_at<?
        AND (? IS NULL OR observer_public_key=?) AND (? IS NULL OR target_public_key=?) AND request_id>?
        ORDER BY request_id LIMIT ?`).all(input.start, input.end, input.observerPublicKey ?? null, input.observerPublicKey ?? null,
        input.targetPublicKey ?? null, input.targetPublicKey ?? null, input.afterRequestId ?? '', limit);
      return { outcomes: rows.map(({ recordJson, clockAnomaly, ...r }) => {
        try { const record = JSON.parse(recordJson); assertTelemetryState(telemetryAuthenticationRecordSchema, record);
          return { ...r, record, clockAnomaly: Boolean(clockAnomaly) };
        } catch { throw new Error('Invalid stored telemetry authentication data'); }
      }),
        limit, nextCursor: rows.at(-1)?.requestId ?? null, exhausted: rows.length < limit };
    },
    // Protected replay/direct/latest scheduling state intentionally stays. Source-run
    // FKs participate in MetricsStore's existing child-first shared pruning guards.
    prune(cutoff) { db.prepare('DELETE FROM telemetry_auth_outcomes WHERE completed_at<? AND dispatched_at<?').run(cutoff, cutoff); }
  };
}
