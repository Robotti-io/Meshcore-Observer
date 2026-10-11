import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TelemetryPollingScheduler } from '../../src/telemetry/polling-scheduler.js';
import { TELEMETRY_POLL_DEFAULTS, TELEMETRY_POLL_COMPONENT_DEFAULTS, TELEMETRY_POLL_NEIGHBOUR_DEFAULTS,
  TELEMETRY_POLL_STATUS_DEFAULT } from '../../src/telemetry/polling-schemas.js';
import { createTelemetryFixture, startTelemetryRun, TELEMETRY_OBSERVER as OBSERVER, TELEMETRY_TARGET as TARGET } from '../fixtures/telemetry-store.js';
import { observe, authRecord, AUTH, SENSOR } from '../fixtures/telemetry-poll.js';
import { telemetryBytes, telemetryWire } from '../fixtures/telemetry-wire.js';
import { createRunShutdown } from '../../src/metrics/run-history.js';

const HOUR = 3600000, DAY = 24 * HOUR, active = [];
function rig({ enabled = true, all = false, seed = true, ...settings } = {}) {
  vi.useFakeTimers();
  const f = createTelemetryFixture(); active.push(f);
  f.config = { ...TELEMETRY_POLL_DEFAULTS, enabled, refreshIntervalMs: HOUR, startupDelayMs: 1000, tickIntervalMs: 1000,
    ...settings, components: all ? { ...TELEMETRY_POLL_COMPONENT_DEFAULTS } : { status: false, sensors: true, neighbours: false },
    neighbourParams: { ...TELEMETRY_POLL_NEIGHBOUR_DEFAULTS }, statusProfile: { ...TELEMETRY_POLL_STATUS_DEFAULT },
    emitterProfile: 'unknown', permissionMask: 0, targetProfiles: [] };
  f.clock = { wall: 10000, monotonic: 10000 };
  f.snapshot = { ready: true, generation: 1, observerPublicKey: OBSERVER };
  f.logger = { info: vi.fn(), warn: vi.fn() }; f.calls = []; f.sent = []; f.session = false; f.timestamp = 100;
  const scope = (target, variant) => ({ observerPublicKey: f.snapshot.observerPublicKey, targetPublicKey: target, variant });
  f.due = (target = TARGET, variants = [SENSOR]) => { for (const variant of variants) f.store.deferTelemetryPoll({
    ...scope(target, variant), runId: f.run.runId, observedAt: f.clock.wall, nextDueAt: f.clock.wall,
    reason: 'rate-limited', policy: Object.fromEntries(['refreshIntervalMs', 'retryBaseMs', 'retryMaxMs', 'maxAttempts', 'authCooldownMs'].map(k => [k, f.config[k]])) }); };
  observe(f, TARGET, 900);
  if (seed) f.due();
  const invoke = async (request, config, hooks, login) => {
    f.calls.push({ ...request, login });
    const descriptor = { ...request, ...(login ? { operation: 'guest-login', params: {} } : {}) };
    const context = { ...descriptor, generation: f.snapshot.generation, observerPublicKey: f.snapshot.observerPublicKey.toUpperCase() };
    if (!hooks.isEligible(descriptor, f.snapshot)) return { status: 'deferred', reason: 'ineligible', context };
    if (!login && (!f.session || f.sessionExpires <= f.clock.monotonic)) return { status: 'deferred', reason: 'guest-session-unavailable' };
    if (f.deferral) return { status: 'deferred', reason: f.deferral, context };
    f.beforeReserve?.();
    if (!hooks.isEligible(descriptor, f.snapshot) || !hooks.reserve(context)) return { status: 'deferred', reason: 'reservation-unavailable', context };
    assert.equal(hooks.isEligible(descriptor, f.snapshot), true, 'own reservation must allow final fresh check');
    if (f.cancel) return { status: 'deferred', reason: 'foreground', context };
    const dispatchedAt = f.clock.wall; f.sent.push({ ...context, dispatchedAt });
    if (f.hold) await new Promise(resolve => { f.release = resolve; });
    if (login) {
      const reservation = { ...context, reservedAt: dispatchedAt };
      const replay = hooks.getReplayHighWater(context);
      const status = f.authReason || (replay !== null && f.timestamp <= replay) ? 'failed' : 'completed';
      const record = authRecord(reservation, { context, dispatchedAt, completedAt: f.clock.wall, status,
        reason: status === 'completed' ? null : f.authReason ?? 'auth-replay',
        ...(status === 'completed' ? { proof: { ...authRecord(reservation).proof, serverTimestamp: f.timestamp++ } } : { proof: undefined }) });
      if (record.proof === undefined) delete record.proof;
      const saved = hooks.recordAuthentication(record);
      f.session = saved && status === 'completed'; f.sessionExpires = f.clock.monotonic + config.sessionTtlMs;
      return { status: saved ? status : 'failed', ...(saved && status === 'completed' ? {} : { reason: saved ? record.reason : 'auth-persistence' }), context, dispatchedAt, tag: 42, route: 'direct' };
    }
    const component = request.operation === 'telemetry' ? 'sensors' : request.operation;
    const response = f.response ?? { status: 'completed', body: telemetryBytes(component === 'status' ? telemetryWire.status48
      : component === 'sensors' ? telemetryWire.sensors : '00000000'), receivedAt: f.clock.wall, tag: 42, route: 'direct' };
    if (response.status !== 'completed') f.session = false;
    f.beforeCompletion?.();
    return { ...response, context, dispatchedAt };
  };
  f.coordinator = { tryTelemetryRequest: (r, c, h) => invoke(r, c, h, false), tryGuestLogin: (r, c, h) => invoke(r, c, h, true) };
  f.make = () => new TelemetryPollingScheduler({ config: f.config, store: f.store, runId: f.run.runId,
    radio: { getConnectionSnapshot: () => f.snapshot }, coordinator: f.coordinator, logger: f.logger,
    wallNow: () => f.clock.wall, monotonicNow: () => f.clock.monotonic, createId: randomUUID });
  f.scheduler = f.make();
  f.tick = async (elapsed = 1000, timer = 1000) => {
    f.clock.wall += elapsed; f.clock.monotonic += elapsed; await vi.advanceTimersByTimeAsync(timer);
  };
  f.start = async () => { f.scheduler.start(); await f.tick(); };
  f.state = (variant = SENSOR, target = TARGET, observer = OBSERVER) => f.store.getTelemetryPollState({ observerPublicKey: observer, targetPublicKey: target, variant });
  f.history = () => f.store.queryTelemetryOutcomes({ start: 0, end: Number.MAX_SAFE_INTEGER });
  return f;
}
afterEach(async () => {
  for (const f of active.splice(0)) { f.scheduler.stop(); f.release?.();
    try { await f.scheduler.drain(); } catch { /* Explicitly asserted failure fixtures. */ }
    f.cleanup(); }
  assert.equal(vi.getTimerCount(), 0); vi.useRealTimers();
});

test('default-off performs no scheduling, recovery, login or query', async () => {
  const f = rig({ enabled: false }); const query = vi.spyOn(f.store, 'queryTelemetryPollCandidates');
  await f.start(); await f.tick(DAY, 10000); assert.deepEqual(f.calls, []); assert.equal(query.mock.calls.length, 0);
});
test('one incremental login then guest sensor reply persists original owned context without brokers or dashboard', async () => {
  const f = rig(); await f.start(); assert.equal(f.sent[0].operation, 'guest-login');
  assert.equal(f.store.queryTelemetryAuthenticationOutcomes({ start: 0, end: 20000 }).outcomes.length, 1);
  assert.equal(f.history().outcomes.length, 0); await f.tick(2000, 2000);
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].operation, 'telemetry');
  const outcome = f.history().outcomes[0]; assert.equal(outcome.observerPublicKey, OBSERVER);
  assert.equal(outcome.runId, f.run.runId); assert.equal(outcome.status, 'partial');
  assert.equal(outcome.startedAt, f.sent[1].dispatchedAt); assert.equal(f.state().reason, 'answered');
});
test('all components advance one physical request per tick without a three-query burst', async () => {
  const f = rig({ all: true });
  const status = { component: 'status', params: {}, profile: f.config.statusProfile };
  const neighbours = { component: 'neighbours', params: f.config.neighbourParams };
  f.due(TARGET, [status, neighbours]); await f.start(); await f.tick(6000, 6000);
  assert.deepEqual(f.sent.map(x => x.operation), ['guest-login', 'status', 'telemetry', 'neighbours']);
  assert.equal(f.history().outcomes.length, 3); assert.equal(f.history().outcomes.filter(x => x.status === 'partial').length, 2);
});
test('new component phases spread across cadence and saved deadlines do not slide on restart', async () => {
  const f = rig({ seed: false, all: true }); await f.start(); assert.equal(f.sent.length, 0);
  const variants = [{ component: 'status', params: {}, profile: f.config.statusProfile }, SENSOR,
    { component: 'neighbours', params: f.config.neighbourParams }];
  const due = variants.map(v => f.state(v).nextDueAt);
  assert.equal(new Set(due).size, 3); assert.ok(due.every(t => t > 10000 && t < 10000 + HOUR));
  f.scheduler.stop(); await f.scheduler.drain(); f.scheduler = f.make(); await f.start();
  assert.deepEqual(variants.map(v => f.state(v).nextDueAt), due); assert.equal(f.sent.length, 0);
});
for (const reason of ['foreground', 'quiet-air', 'rate-limited', 'background-turn', 'busy']) test(`${reason} defers without attempts, outcome or changing cadence`, async () => {
  const f = rig(); f.deferral = reason; await f.start(); await f.tick(10000, 10000);
  assert.equal(f.sent.length, 0); assert.equal(f.state().cycleAttempts, 0); assert.equal(f.state().nextDueAt, 10000);
  assert.equal(f.history().outcomes.length, 0);
});
for (const reason of ['contact-missing', 'inventory-too-large', 'login-prefix-collision', 'radius-exceeded', 'unknown-contact-route']) test(`${reason} uses durable deferral without RF evidence`, async () => {
  const f = rig(); f.deferral = reason; await f.start();
  assert.equal(f.sent.length, 0); assert.equal(f.state(AUTH).cycleAttempts, 0);
  assert.equal(f.state(AUTH).reason, reason); assert.ok(f.state(AUTH).nextDueAt >= f.clock.wall + f.config.retryBaseMs);
  assert.equal(f.history().outcomes.length, 0);
});
for (const reason of ['authentication-denied', 'legacy-login-proof', 'unsafe-login-permissions', 'unsupported-login-protocol', 'auth-replay']) test(`${reason} stops data through shared target cooldown`, async () => {
  const f = rig(); f.authReason = reason; await f.start(); await f.tick(HOUR);
  assert.equal(f.sent.length, 1); assert.equal(f.state(AUTH).reason, 'auth-cooldown');
  assert.equal(f.history().outcomes.length, 0); assert.equal(f.state().cycleAttempts, 0);
});
test('session expiry requires a new durable login and does not reuse old public audit authority', async () => {
  const f = rig({ refreshIntervalMs: HOUR, sessionTtlMs: 60000 }); await f.start(); await f.tick(2000, 2000);
  await f.tick(HOUR); await f.tick(4000, 4000);
  assert.deepEqual(f.sent.map(x => x.operation), ['guest-login', 'telemetry', 'guest-login', 'telemetry']);
  assert.equal(f.state(AUTH).serverTimestamp, 101);
});
test('reporter change cannot inherit evidence, due state or pending ownership', async () => {
  const f = rig(); f.beforeReserve = () => { f.snapshot = { ...f.snapshot, observerPublicKey: 'EF'.repeat(32) }; };
  await f.start(); await f.tick(3000, 3000); assert.equal(f.sent.length, 0); assert.equal(f.state().cycleAttempts, 0);
  assert.equal(f.store.getTelemetryEligibility({ observerPublicKey: f.snapshot.observerPublicKey, targetPublicKey: TARGET,
    now: f.clock.wall, windowMs: f.config.evidenceWindowMs, radius: 2 }), null);
});
test('freshness expires while waiting; no stale reservation is issued', async () => {
  const f = rig(); f.beforeReserve = () => { f.clock.wall += 73 * HOUR; f.clock.monotonic += 73 * HOUR; };
  await f.start(); assert.equal(f.sent.length, 0); assert.equal(f.state().cycleAttempts, 0);
});
test('wall or monotonic rollback pauses, then resumes only after clock agreement', async () => {
  const f = rig(); f.clock.wall = 100; f.clock.monotonic = 1000; f.scheduler.start();
  f.clock.wall = 50; await f.tick(0); assert.equal(f.sent.length, 0);
  f.clock.wall = 10000; await f.tick(); assert.equal(f.sent.length, 1);
  f.clock.monotonic -= 2000; await f.tick(0); assert.equal(f.sent.length, 1);
  assert.ok(f.logger.warn.mock.calls.some(c => c[2]?.outcome === 'clock-rollback'));
});
test('physical query failure records no invented observation, backs off and exhausts bounded attempts', async () => {
  const f = rig({ maxAttempts: 1 }); await f.start();
  f.response = { status: 'failed', reason: 'response-timeout', route: 'direct', tag: 42 }; await f.tick(2000, 2000);
  assert.equal(f.state().reason, 'exhausted'); assert.equal(f.state().cycleAttempts, 1);
  assert.equal(f.history().outcomes[0].reason, 'response-timeout');
  assert.equal(f.store.queryTelemetryObservations({ start: 0, end: Number.MAX_SAFE_INTEGER }).observations.length, 0);
  await f.tick(f.config.retryBaseMs); assert.equal(f.sent.length, 2);
});
test('unsupported binary operation waits a refresh without replacing useful readings', async () => {
  const f = rig(); await f.start(); f.response = { status: 'failed', reason: 'command-error', errorReason: 'unsupported', errorCode: 1 };
  await f.tick(2000, 2000); assert.equal(f.history().outcomes[0].status, 'unsupported');
  assert.equal(f.state().reason, 'unsupported');
});
for (const kind of ['auth', 'data']) test(`${kind} failed terminal save pauses globally, retains one result and drain retries without RF`, async () => {
  const f = rig(); const method = kind === 'auth' ? 'completeTelemetryAuthentication' : 'completeTelemetryPoll';
  const original = f.store[method].bind(f.store); let broken = true;
  f.store[method] = value => { if (broken) throw new Error('PRIVATE-SECRET'); return original(value); };
  await f.start(); if (kind === 'data') await f.tick(2000, 2000);
  const attempts = f.sent.length; await f.tick(HOUR, 10000); assert.equal(f.sent.length, attempts);
  assert.equal(f.history().outcomes.length, 0);
  f.scheduler.stop(); await assert.rejects(f.scheduler.drain(), /clean shutdown cannot be confirmed/);
  broken = false; await f.scheduler.drain(); assert.equal(f.sent.length, attempts);
  assert.doesNotMatch(JSON.stringify(f.logger.warn.mock.calls), /PRIVATE-SECRET/);
  if (kind === 'auth') { assert.equal(f.session, false); assert.equal(f.state(AUTH).reason, 'authenticated'); }
  else assert.equal(f.history().outcomes.length, 1);
});
test('reservation write fails closed before send, with no terminal data invented', async () => {
  const f = rig(); f.store.reserveTelemetryPoll = () => { throw new Error('PRIVATE-SECRET'); };
  await f.start(); await f.tick(3000, 3000); assert.equal(f.sent.length, 0); assert.equal(f.history().outcomes.length, 0);
  assert.doesNotMatch(JSON.stringify(f.logger.warn.mock.calls), /PRIVATE-SECRET/);
});
test('unused reservation stays conservative and is never called a physical failure', async () => {
  const f = rig(); f.cancel = true; await f.start(); await f.tick(3000, 3000);
  assert.equal(f.sent.length, 0); assert.equal(f.state(AUTH).reason, 'reserved'); assert.equal(f.history().outcomes.length, 0);
  f.scheduler.stop(); await f.scheduler.drain();
});
test('unknown terminal ownership pauses rather than fabricating an outcome', async () => {
  const f = rig(); await f.start(); f.coordinator.tryTelemetryRequest = async (request, config, hooks) => {
    const context = { ...request, observerPublicKey: OBSERVER, generation: 1 }; assert.equal(hooks.reserve(context), true);
    return { status: 'completed', context: { ...context, requestId: randomUUID() }, dispatchedAt: f.clock.wall };
  };
  await f.tick(2000, 2000); f.scheduler.stop(); await assert.rejects(f.scheduler.drain(), /clean shutdown/);
  assert.equal(f.history().outcomes.length, 0);
});
test('stop blocks admission while a dispatched terminal drains before storage closes', async () => {
  const f = rig(); f.hold = true; f.scheduler.start(); await f.tick(); assert.equal(f.sent.length, 1);
  f.scheduler.stop(); let drained = false; const drain = f.scheduler.drain().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false); f.release(); await drain;
  assert.equal(f.state(AUTH).reason, 'authenticated'); assert.equal(f.history().outcomes.length, 0);
});
test('bounded orphan recovery preserves old auth cooldown and data backoff on restart', async () => {
  const f = rig(); const oldRun = f.run;
  const input = { observerPublicKey: OBSERVER, targetPublicKey: TARGET, variant: AUTH, runId: oldRun.runId,
    requestId: randomUUID(), reservedAt: f.clock.wall, policy: Object.fromEntries(['refreshIntervalMs', 'retryBaseMs', 'retryMaxMs', 'maxAttempts', 'authCooldownMs'].map(k => [k, f.config[k]])),
    radius: 2, windowMs: f.config.evidenceWindowMs };
  assert.equal(f.store.reserveTelemetryPoll(input).reserved, true);
  f.store.endObserverRun({ runId: oldRun.runId, observedAt: f.clock.wall, observedDurationMs: f.clock.wall, reason: 'SIGINT' });
  f.close(); f.open(); f.run = startTelemetryRun(f.store, f.clock.wall);
  f.scheduler = f.make(); f.scheduler.start(); await f.tick();
  assert.equal(f.state(AUTH).reason, 'auth-cooldown'); assert.equal(f.sent.length, 0); assert.equal(f.history().outcomes.length, 0);
});
test('dense candidates use bounded keyset pages and an exact final eligibility read', async () => {
  const f = rig({ seed: false });
  for (let n = 1; n <= 40; n++) observe(f, n.toString(16).padStart(64, '0').toUpperCase(), 900);
  const pages = vi.spyOn(f.store, 'queryTelemetryPollCandidates'), exact = vi.spyOn(f.store, 'getTelemetryEligibility');
  await f.start(); await f.tick(4000, 4000);
  assert.equal(f.sent.length, 0); assert.ok(pages.mock.calls.every(([q]) => q.limit === 16));
  assert.ok(pages.mock.calls.some(([q]) => q.afterPublicKey)); assert.equal(exact.mock.calls.length, 0);
  await f.tick(HOUR); assert.ok(exact.mock.calls.length > 0);
});
for (const kind of ['over-radius', 'ambiguous', 'foreign-reporter']) test(`flood ${kind} evidence cannot schedule a target`, async () => {
  const f = rig();
  const key = '1234' + 'EF'.repeat(30), observer = kind === 'foreign-reporter' ? 'EF'.repeat(32) : OBSERVER;
  f.store.recordVerifiedAdvert({ publicKeyHex: key, name: null, type: 'REPEATER', receivedAt: 900, hopCount: 3, eventDigest: key.toLowerCase() });
  if (kind === 'ambiguous') f.store.recordVerifiedAdvert({ publicKeyHex: '12' + 'DA'.repeat(31), name: null,
    type: 'CHAT', receivedAt: 900, hopCount: 1, eventDigest: 'ab'.repeat(32) });
  f.store.recordTopologyObservation({ observerPublicKey: observer, runId: f.run.runId, receivedAt: 900,
    route: 1, kind: 'flood-traversed', payloadVersion: 0, hashWidth: 1,
    prefixes: kind === 'over-radius' ? ['12', 'BB', 'AA'] : ['12'], transportCodes: null, containsRepeatedPrefix: false });
  f.due(key); await f.start(); await f.tick(8000, 8000);
  assert.ok(f.calls.every(c => c.targetPublicKey !== key));
});
test('generation swap after waiting cannot grant a new reservation', async () => {
  const f = rig(); f.beforeReserve = () => { f.snapshot = { ...f.snapshot, generation: 2, ready: false }; };
  await f.start(); assert.equal(f.sent.length, 0); assert.equal(f.state().cycleAttempts, 0);
});
test('captured receipt rollback retains partial evidence as anomalous and preserves original times', async () => {
  const f = rig(); await f.start();
  f.response = { status: 'completed', body: telemetryBytes(telemetryWire.sensors), tag: 42, route: 'direct', receivedAt: 10900 };
  await f.tick(2000, 2000); const outcome = f.history().outcomes[0];
  assert.equal(outcome.clockAnomaly, true); assert.equal(outcome.receivedAt, 10900); assert.equal(outcome.status, 'partial');
  assert.equal(f.state().reason, 'retry');
});
test('store clock read failure after a binary terminal does not discard its original result', async () => {
  const f = rig(); await f.start(); f.beforeCompletion = () => { f.store.getTelemetryPollHighWater = () => { throw new Error('PRIVATE-SECRET'); }; };
  await f.tick(2000, 2000); f.scheduler.stop(); await f.scheduler.drain();
  assert.equal(f.history().outcomes.length, 1); assert.equal(f.history().outcomes[0].clockAnomaly, true);
  assert.doesNotMatch(JSON.stringify(f.logger.warn.mock.calls), /PRIVATE-SECRET/);
});
test('component profile overrides are target-scoped and never inferred from a guest proof', async () => {
  const f = rig({ all: true }); f.config.targetProfiles = [{ targetPublicKey: TARGET,
    statusProfile: { layout: 'common48', evidence: 'established' }, emitterProfile: 'positive-channels' }];
  f.scheduler = f.make();
  f.due(TARGET, [{ component: 'status', params: {}, profile: f.config.targetProfiles[0].statusProfile },
    { component: 'neighbours', params: f.config.neighbourParams }]);
  await f.start(); await f.tick(6000, 6000); assert.ok(f.history().outcomes.every(o => o.status === 'answered'));
});
test('longer restart cadence extends stored deadlines without physical permission', async () => {
  const f = rig(); await f.start(); await f.tick(2000, 2000); const due = f.state().nextDueAt;
  f.scheduler.stop(); await f.scheduler.drain(); f.config.refreshIntervalMs = 2 * HOUR; f.scheduler = f.make(); await f.start();
  await f.tick(HOUR); await f.tick(4000, 4000); assert.equal(f.sent.length, 2);
  assert.equal(f.state().nextDueAt, due, 'a read-only scheduling check does not rewrite saved deadlines');
});
test('shutdown cannot mark a run clean or close the store while a terminal save remains blocked', async () => {
  const f = rig(); f.store.completeTelemetryAuthentication = () => { throw new Error('blocked'); }; await f.start();
  const finishClean = vi.fn(), close = vi.fn(), setExitCode = vi.fn();
  const shutdown = createRunShutdown({ logger: { ...f.logger, error: vi.fn() }, runHistory: { finishClean },
    metricsStore: { close }, setExitCode, forceExit: vi.fn(), teardown: async () => { f.scheduler.stop(); await f.scheduler.drain(); } });
  await shutdown('SIGINT'); assert.equal(finishClean.mock.calls.length, 0); assert.equal(close.mock.calls.length, 0);
  assert.equal(setExitCode.mock.calls[0][0], 1); await vi.advanceTimersByTimeAsync(10000);
});
