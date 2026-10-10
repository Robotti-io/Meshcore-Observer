import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { RegionDiscoveryScheduler } from '../../src/regions/region-discovery-scheduler.js';
import { REGION_QUERY_DEFAULTS } from '../../src/regions/region-query-schemas.js';
import { createRunShutdown } from '../../src/metrics/run-history.js';
import { createPollFixture, observe, OBSERVER, TARGET, HOUR, reservation, completion } from '../fixtures/region-poll.js';

const fixtures = [];
const body = csv => [0, 0, 0, 0, ...Buffer.from(csv)];
const outcomes = store => store.queryRegionOutcomes({ start: 0, end: Number.MAX_SAFE_INTEGER });
const latest = f => f.store.getRegionLatest({ observerPublicKey: OBSERVER, targetPublicKey: TARGET,
  now: f.clock.wall, windowMs: 72 * HOUR });
async function fixture(overrides = {}) {
  vi.useFakeTimers();
  const f = createPollFixture(); fixtures.push(f);
  f.clock = { wall: 100000, monotonic: 0 };
  f.config = { ...REGION_QUERY_DEFAULTS, answerFreshnessWindowMs: 72 * HOUR,
    discoveryEnabled: true, queryStartupDelayMs: 10000, queryTickIntervalMs: 1000, ...overrides };
  f.snapshot = { generation: 1, ready: true, observerPublicKey: OBSERVER.toLowerCase() };
  f.logger = { warn: vi.fn(), info: vi.fn() }; f.calls = []; f.sent = 0;
  f.response = { status: 'completed', body: body(''), receivedAt: null };
  f.coordinator = { tryRequest: async (request, options, eligible, reserve) => {
    f.calls.push(request); f.options = options;
    if (!eligible(request, f.snapshot)) return { status: 'deferred', reason: 'ineligible' };
    if (f.deferral) return { status: 'deferred', reason: f.deferral };
    const context = { ...request, generation: f.snapshot.generation, observerPublicKey: f.snapshot.observerPublicKey.toUpperCase() };
    if (f.preflight) return { status: 'deferred', reason: f.preflight, context };
    if (f.uncertain) return { status: 'failed', reason: f.uncertain, context, recovery: 'reset' };
    f.beforeReserve?.();
    if (!eligible(request, f.snapshot) || !reserve(context)) return { status: 'deferred', reason: 'reservation-unavailable', context };
    if (f.cancelAfterReservation) return { status: 'deferred', reason: 'foreground', context };
    const dispatchedAt = f.clock.wall; f.sent++;
    if (f.hold) await new Promise(resolve => { f.release = resolve; });
    const response = { ...f.response, context, dispatchedAt, route: 'direct' };
    if (response.status === 'completed') {
      response.receivedAt ??= f.clock.wall;
      response.provenance = 'companion-tag-attributed'; response.tag = 7;
    } else delete response.receivedAt;
    f.beforeCompletion?.(response); return response;
  } };
  f.make = () => new RegionDiscoveryScheduler({ config: f.config, store: f.store, runId: f.run.runId,
    directHeardWindowMs: 72 * HOUR, radio: { getConnectionSnapshot: () => f.snapshot },
    coordinator: f.coordinator, logger: f.logger, wallNow: () => f.clock.wall,
    monotonicNow: () => f.clock.monotonic, jitter: () => f.jitter ?? 0 });
  f.scheduler = f.make();
  f.tick = async (ms = 1000) => {
    f.clock.wall += ms; f.clock.monotonic += ms; await vi.advanceTimersByTimeAsync(ms);
  };
  f.launch = async () => { f.scheduler.start(); await f.tick(10000); };
  observe(f.store, TARGET, f.clock.wall);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.scheduler.stop(); f.release?.();
    try { await f.scheduler.drain(); } catch { /* Explicitly tested unsaved faults. */ }
    f.cleanup();
  }
  assert.equal(vi.getTimerCount(), 0); vi.useRealTimers();
});

test('disabled start is inert and strict invalid constructor data fails before timers or writes', async () => {
  const f = await fixture({ discoveryEnabled: false }); await f.launch();
  f.scheduler.start(); assert.equal(vi.getTimerCount(), 0); assert.equal(f.calls.length, 0);
  assert.equal(f.store.getRegionPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET }), null);
  f.config.extra = true; assert.throws(f.make, /Invalid region query data/);
});
test('one unreferenced startup timer, idempotent start, measured empty answer and no broker staging', async () => {
  const f = await fixture(); const timers = vi.spyOn(globalThis, 'setTimeout'); f.scheduler.start(); f.scheduler.start();
  assert.equal(timers.mock.results[0].value.hasRef(), false); assert.equal(vi.getTimerCount(), 1);
  await f.tick(9999); assert.equal(f.sent, 0); await f.tick(1); assert.equal(f.sent, 1);
  assert.equal(latest(f).presence, 'empty'); assert.deepEqual(latest(f).answer.regions, []);
  assert.equal(outcomes(f.store).total, 1); assert.deepEqual(f.options, { expectedRoute: 'direct' });
  assert.equal(f.store.queryRegionPublications({ brokerId: 'unused' }).total, 0); assert.equal(vi.getTimerCount(), 1);
  f.scheduler.stop(); await f.scheduler.drain(); f.scheduler.start(); assert.equal(vi.getTimerCount(), 0);
});
test('original dispatch and binary receipt survive delayed continuation', async () => {
  const f = await fixture(); f.hold = true; await f.launch(); const dispatched = f.clock.wall;
  f.response.receivedAt = dispatched + 10; f.clock.wall += 500; f.clock.monotonic += 500;
  f.release(); await vi.advanceTimersByTimeAsync(0);
  const row = outcomes(f.store).outcomes[0];
  assert.equal(row.startedAt, dispatched); assert.equal(row.completedAt, dispatched + 500);
  assert.equal(latest(f).answer.observedAt, dispatched + 10); assert.equal(row.clockAnomaly, false);
});
test('one active operation means no timers, catch-up burst, candidate backlog or overlapping requests', async () => {
  const f = await fixture(); f.hold = true; await f.launch(); await f.tick(120000);
  assert.equal(f.calls.length, 1); assert.equal(vi.getTimerCount(), 0);
  f.release(); await vi.advanceTimersByTimeAsync(0); assert.equal(vi.getTimerCount(), 1);
});
test('bounded 100-key pages advance after selection and wrap fairly across 2001 due repeaters', async () => {
  const f = await fixture(); f.deferral = 'foreground';
  const keys = Array.from({ length: 2000 }, (_, n) => n.toString(16).padStart(64, '0').toUpperCase());
  for (const key of keys) observe(f.store, key, f.clock.wall);
  const query = vi.spyOn(f.store, 'queryRegionPollCandidates'); await f.launch();
  for (let n = 0; n < 2001; n++) await f.tick();
  assert.deepEqual(f.calls.map(x => x.targetPublicKey), [...keys, TARGET]);
  await f.tick(); assert.equal(f.calls.at(-1).targetPublicKey, keys[0]);
  assert.ok(query.mock.calls.every(([input]) => input.limit === 100));
  assert.equal(f.sent, 0); assert.equal(outcomes(f.store).total, 0); assert.equal(f.logger.warn.mock.calls.length, 0);
}, 30000);
for (const reason of ['foreground', 'quiet-air', 'rate-limited', 'busy', 'not-ready', 'disconnected', 'queue-timeout']) {
  test(`${reason} admission remains quiet and creates no scheduling/outcome writes`, async () => {
    const f = await fixture(); f.deferral = reason; await f.launch(); for (let n = 0; n < 4; n++) await f.tick();
    assert.equal(f.sent, 0); assert.equal(outcomes(f.store).total, 0);
    assert.equal(f.store.getRegionPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET }), null);
    assert.equal(f.logger.warn.mock.calls.length, 0);
  });
}
test('disconnected/not-ready/null or invalid full reporter cannot select targets', async () => {
  const f = await fixture(); f.snapshot.ready = false; await f.launch(); assert.equal(f.calls.length, 0);
  f.snapshot = { generation: null, ready: true, observerPublicKey: null }; await f.tick(); assert.equal(f.calls.length, 0);
  f.snapshot = { generation: 1, ready: true, observerPublicKey: 'bad' }; await f.tick(); await f.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.logger.warn.mock.calls.length, 1);
});
test('legacy, relayed, future, CHAT and expiry-at-equality inventory cannot qualify', async () => {
  const f = await fixture(); f.clock.wall = 100 * HOUR;
  f.store.upsertNode({ publicKeyHex: TARGET, name: 'Legacy name', type: 'REPEATER', heardAt: f.clock.wall });
  // Replace the initially valid evidence with an aged observation at dispatch.
  f.clock.wall += 72 * HOUR;
  for (const [key, at, hops, type] of [['01'.repeat(32), f.clock.wall, 1, 'REPEATER'],
    ['02'.repeat(32), f.clock.wall + HOUR, 0, 'REPEATER'], ['03'.repeat(32), f.clock.wall, 0, 'CHAT'],
    ['04'.repeat(32), f.clock.wall - 72 * HOUR + 10000, 0, 'REPEATER']]) observe(f.store, key, at, hops, type);
  f.store.upsertNode({ publicKeyHex: '05'.repeat(32), name: 'Never direct', type: 'REPEATER', heardAt: f.clock.wall });
  await f.launch(); assert.equal(f.calls.length, 0);
});
test('renamed verified repeater remains key-based, and relayed adverts cannot extend direct eligibility', async () => {
  const f = await fixture(); observe(f.store, TARGET, f.clock.wall + 1, 1);
  f.store.upsertNode({ publicKeyHex: TARGET, name: 'Renamed', type: 'REPEATER', heardAt: f.clock.wall + 1 });
  await f.launch(); assert.equal(f.sent, 1); assert.equal(outcomes(f.store).outcomes[0].targetPublicKey, TARGET);
});
for (const revoke of ['expiry', 'type', 'generation', 'reporter', 'clock', 'due']) {
  test(`final ${revoke} change prevents reservation and RF`, async () => {
    const f = await fixture();
    f.beforeReserve = () => {
      if (revoke === 'expiry') { f.clock.wall += 72 * HOUR; f.clock.monotonic += 72 * HOUR; }
      if (revoke === 'type') observe(f.store, TARGET, f.clock.wall, 0, 'CHAT');
      if (revoke === 'generation') f.snapshot.generation++;
      if (revoke === 'reporter') f.snapshot.observerPublicKey = 'CD'.repeat(32);
      if (revoke === 'clock') f.clock.wall--;
      if (revoke === 'due') f.store.reserveRegionPoll(reservation(f.run, f.clock.wall));
    };
    await f.launch(); assert.equal(f.sent, 0); assert.equal(outcomes(f.store).total, 0);
    if (revoke !== 'due') assert.equal(f.store.getRegionPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET }), null);
  });
}
for (const reason of ['contact-missing', 'unsafe-route', 'preflight-failed', 'preflight-unsupported']) {
  test(`${reason} preflight defers durably without physical counts or terminal outcomes`, async () => {
    const f = await fixture(); f.preflight = reason; await f.launch();
    const state = f.store.getRegionPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET });
    assert.equal(state.reason, reason); assert.equal(state.cycleReservations, 0);
    assert.equal(state.nextDueAt, f.clock.wall + f.config.queryRetryBaseMs);
    await f.tick(); assert.equal(f.calls.length, 1); assert.equal(f.sent, 0); assert.equal(outcomes(f.store).total, 0);
  });
}
for (const reason of ['preflight-timeout', 'write-error', 'protocol-error', 'stopped']) {
  test(`uncertain ${reason} preflight pauses only the captured generation and preserves schedule`, async () => {
    const f = await fixture(); f.uncertain = reason; await f.launch(); await f.tick(); assert.equal(f.calls.length, 1);
    assert.equal(f.store.getRegionPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET }), null);
    f.uncertain = null; f.snapshot.generation++; await f.tick(); await f.tick(); assert.equal(f.sent, 1);
  });
}
test('unsupported local read pauses all targets on that generation, and resumes only on a new ready generation', async () => {
  const f = await fixture(); observe(f.store, 'FF'.repeat(32), f.clock.wall); f.preflight = 'preflight-unsupported';
  await f.launch(); await f.tick(); assert.equal(f.calls.length, 1);
  f.preflight = null; f.snapshot.generation++; await f.tick(); assert.equal(f.sent, 1);
  assert.equal(f.calls.at(-1).targetPublicKey, 'FF'.repeat(32));
});
test('unused durable reservation preserves cooldown but creates no fictional terminal result', async () => {
  const f = await fixture(); f.cancelAfterReservation = true; await f.launch();
  assert.equal(f.sent, 0); assert.equal(outcomes(f.store).total, 0);
  assert.equal(f.store.getRegionPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET }).cycleReservations, 1);
  f.scheduler.stop(); await f.scheduler.drain();
});
test('failures preserve prior latest and exponential retry exhausts without new advert/reconnect budget reset', async () => {
  const f = await fixture(); const input = reservation(f.run, 1);
  f.store.reserveRegionPoll(input); f.store.completeRegionPoll(completion(input, { csv: 'Kept', at: 2 }));
  f.clock.wall += 25 * HOUR; observe(f.store, TARGET, f.clock.wall);
  f.response = { status: 'failed', reason: 'response-timeout' }; f.jitter = 0.1; await f.launch();
  for (let n = 1; n < 3; n++) {
    const state = f.store.getRegionPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET });
    const ms = state.nextDueAt - f.clock.wall; f.snapshot.generation++;
    f.clock.wall += ms - 1000; f.clock.monotonic += ms - 1000;
    observe(f.store, TARGET, f.clock.wall); await f.tick(); await f.tick();
    assert.equal(f.sent, n + 1);
  }
  assert.equal(latest(f).answer.regions[0], 'Kept'); assert.equal(latest(f).latestOutcome.reason, 'response-timeout');
  const exhausted = f.store.getRegionPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET });
  assert.equal(exhausted.reason, 'exhausted'); assert.equal(exhausted.cycleReservations, 3);
  assert.equal(exhausted.nextDueAt, f.clock.wall + 24 * HOUR); await f.tick(); assert.equal(f.sent, 3);
});
test('command-level unsupported has separate terminal status and refresh cooldown', async () => {
  const f = await fixture(); f.response = { status: 'failed', reason: 'command-error', errorCode: 1, errorReason: 'unsupported' };
  await f.launch(); assert.equal(outcomes(f.store).outcomes[0].status, 'unsupported');
  assert.equal(f.store.getRegionPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET }).reason, 'unsupported');
  await f.tick(); assert.equal(f.sent, 1);
});
test('malformed binary body becomes an owned failure rather than overwriting latest', async () => {
  const f = await fixture(); f.response.body = body('bad,,list'); await f.launch();
  assert.equal(outcomes(f.store).outcomes[0].reason, 'malformed-response'); assert.equal(latest(f).presence, 'unknown');
});
for (const evidence of ['recent-empty', 'recent-nonempty', 'future', 'anomalous', 'ambiguous']) {
  test(`${evidence} stored answer is consumed with truthful candidate freshness`, async () => {
    const f = await fixture();
    const at = evidence === 'future' ? f.clock.wall + HOUR : f.clock.wall - 1;
    const input = reservation(f.run, 1);
    f.store.recordRegionResult(completion(input, { csv: evidence === 'recent-empty' ? '' : 'Retained',
      at, observedAt: at, clockAnomaly: evidence === 'anomalous' }).result);
    if (evidence === 'ambiguous') f.store.recordRegionResult(completion(reservation(f.run, 1), { csv: 'Different', at, observedAt: at }).result);
    await f.launch();
    assert.equal(f.sent, evidence.startsWith('recent-') ? 0 : 1);
    assert.equal(f.store.queryRegionPublications({ brokerId: 'unused' }).total, 0);
  });
}
test('selection and non-RF deferral storage faults are bounded and never grant physical permission', async () => {
  const f = await fixture(); const query = f.store.queryRegionPollCandidates.bind(f.store);
  f.store.queryRegionPollCandidates = () => { throw Error('secret'); }; await f.launch(); await f.tick();
  assert.equal(f.sent, 0); assert.equal(f.logger.warn.mock.calls.length, 1);
  f.store.queryRegionPollCandidates = query; f.preflight = 'contact-missing';
  f.store.deferRegionPoll = () => { throw Error('secret'); }; await f.tick(); await f.tick();
  assert.equal(f.sent, 0); assert.equal(outcomes(f.store).total, 0);
  assert.doesNotMatch(JSON.stringify(f.logger.warn.mock.calls), /secret/);
});
test('clock source errors before scheduling cannot initiate a query or create state', async () => {
  const f = await fixture(); f.clock.monotonic = NaN; await f.launch(); await f.tick();
  assert.equal(f.calls.length, 0); assert.equal(outcomes(f.store).total, 0);
});
test('rollback and frozen wall pause against monotonic progression until actual clock agreement', async () => {
  const f = await fixture(); f.scheduler.start(); f.clock.monotonic += 10000;
  await vi.advanceTimersByTimeAsync(10000); assert.equal(f.calls.length, 0);
  await vi.advanceTimersByTimeAsync(1000); assert.equal(f.logger.warn.mock.calls.length, 1);
  f.clock.wall += 10000; await vi.advanceTimersByTimeAsync(1000); assert.equal(f.sent, 1);
  assert.equal(outcomes(f.store).outcomes[0].clockAnomaly, false);
});
test('rollback receipt retains original evidence with anomaly and a conservative cooldown', async () => {
  const f = await fixture(); f.hold = true; await f.launch();
  const dispatched = f.clock.wall; f.clock.wall -= 10; f.response.receivedAt = f.clock.wall;
  f.release(); await vi.advanceTimersByTimeAsync(0);
  assert.equal(outcomes(f.store).outcomes[0].clockAnomaly, true);
  assert.equal(latest(f).answer.observedAt, dispatched - 10);
  await f.tick(); assert.equal(f.sent, 1);
});
test('persistence failure holds one original result, blocks RF, retries locally and never logs payload/errors', async () => {
  const f = await fixture(); const complete = f.store.completeRegionPoll.bind(f.store);
  f.store.completeRegionPoll = () => { throw Error('private body or credentials'); }; await f.launch(); await f.tick(); await f.tick();
  assert.equal(f.sent, 1); assert.equal(outcomes(f.store).total, 0); assert.equal(f.logger.warn.mock.calls.length, 1);
  const state = f.store.getRegionPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET });
  assert.equal(state.reason, 'reserved');
  f.store.completeRegionPoll = complete; await f.tick(); assert.equal(outcomes(f.store).total, 1); assert.equal(f.sent, 1);
  assert.equal(outcomes(f.store).outcomes[0].completedAt, state.reservedAt);
  assert.doesNotMatch(JSON.stringify(f.logger.warn.mock.calls), /private body|credentials|regions/);
});
test('reservation store failure or invalid jitter grants no RF; failures remain bounded', async () => {
  const f = await fixture(); f.jitter = 0.11; await f.launch(); await f.tick();
  assert.equal(f.sent, 0); assert.equal(f.logger.warn.mock.calls.length, 1);
  f.jitter = 0; f.store.reserveRegionPoll = () => { throw Error('secret'); }; await f.tick(); await f.tick();
  assert.equal(f.sent, 0); assert.equal(outcomes(f.store).total, 0);
});
test('shutdown admission stop then cancellation and persistence drain precede clean completion/store close', async () => {
  const f = await fixture(); f.hold = true; await f.launch(); const order = [];
  const complete = f.store.completeRegionPoll.bind(f.store);
  f.store.completeRegionPoll = input => { order.push('persist'); return complete(input); };
  const finishClean = vi.fn(() => { order.push('clean'); return true; });
  const close = vi.fn(() => { order.push('close'); });
  const shutdown = createRunShutdown({ logger: { ...f.logger, error: vi.fn() },
    runHistory: { finishClean }, metricsStore: { close }, setExitCode: vi.fn(), forceExit: vi.fn(),
    teardown: async () => {
      f.scheduler.stop(); order.push('admission-stopped');
      f.response = { status: 'failed', reason: 'stopped' }; order.push('cancel'); f.release();
      await f.scheduler.drain(); order.push('radio-teardown');
    } });
  await shutdown('SIGINT'); assert.deepEqual(order, ['admission-stopped', 'cancel', 'persist', 'radio-teardown', 'clean', 'close']);
  assert.equal(outcomes(f.store).outcomes[0].reason, 'stopped');
});
test('failed final persistence prevents clean run end and store close', async () => {
  const f = await fixture(); f.store.completeRegionPoll = () => { throw Error('blocked'); }; await f.launch();
  const finishClean = vi.fn(), close = vi.fn(), setExitCode = vi.fn();
  const shutdown = createRunShutdown({ logger: { ...f.logger, error: vi.fn() }, runHistory: { finishClean },
    metricsStore: { close }, setExitCode, forceExit: vi.fn(), teardown: async () => { f.scheduler.stop(); await f.scheduler.drain(); } });
  await shutdown('SIGTERM'); assert.equal(finishClean.mock.calls.length, 0); assert.equal(close.mock.calls.length, 0);
  assert.equal(setExitCode.mock.calls[0][0], 1); await vi.advanceTimersByTimeAsync(10000);
});
test('untrusted completion fields after a reservation cannot be saved or silently declared clean', async () => {
  const f = await fixture(); f.beforeCompletion = response => { response.context.targetPublicKey = 'FF'.repeat(32); };
  await f.launch(); f.scheduler.stop(); await assert.rejects(f.scheduler.drain(), /not persisted/);
  assert.equal(outcomes(f.store).total, 0);
});
test('restart, shared pruning, discovery disabled and reporter change preserve saved cooldowns without RF replay', async () => {
  const f = await fixture(); await f.launch(); const saved = f.store.getRegionPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET });
  f.scheduler.stop(); await f.scheduler.drain(); f.store.pruneOlderThan(f.clock.wall + 1);
  f.restart(f.clock.wall); f.scheduler = f.make(); await f.launch(); assert.equal(f.sent, 1);
  assert.equal(f.store.getRegionPollState({ observerPublicKey: OBSERVER, targetPublicKey: TARGET }).nextDueAt, saved.nextDueAt);
  f.snapshot.observerPublicKey = 'CD'.repeat(32); await f.tick(); assert.equal(f.sent, 2);
  assert.equal(outcomes(f.store).outcomes[0].observerPublicKey, 'CD'.repeat(32));
  f.scheduler.stop(); await f.scheduler.drain(); f.config.discoveryEnabled = false; f.scheduler = f.make(); await f.launch(); assert.equal(f.sent, 2);
});
