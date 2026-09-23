import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyQueue } from '../../src/bots/reply-queue.js';
import { MetricsStore } from '../../src/metrics/store.js';

function silentLogger() {
  const calls = { warn: [] };
  return {
    calls,
    debug() {},
    info() {},
    warn: (source, message, meta) => calls.warn.push({ source, message, meta }),
    error() {}
  };
}

// A test double for the single shared `dispatch` function a real
// ReplyQueue is given at construction (see reply-dispatcher.js) - records
// every dispatched item, and runs a per-trigger handler when one is
// registered, so individual tests can make one item succeed, fail, or
// resolve slowly without needing per-item behavior on the queue itself
// (queued items are plain data now, not callbacks).
function testDispatcher(handlersByTrigger = {}) {
  const calls = [];
  const dispatch = async (item) => {
    calls.push(item);
    const handler = handlersByTrigger[item.trigger];
    if (handler) {
      await handler(item);
    }
  };
  return { dispatch, calls };
}

function baseItem(overrides = {}) {
  return { botName: 'echo', channel: '#echo', trigger: '!echo', sender: 'Jeymz', hopCount: 1, path: 'AA', hash: 'deadbeef', ...overrides };
}

// Real (short) timings rather than fake timers, matching this repo's
// existing convention for testing timer-driven code (see radio-manager's
// backoff tests) - small enough that the suite stays fast.
const QUIET_MS = 30;
const TTL_MS = 200;
const POLL_MS = 5;

// A real MetricsStore (:memory:), not a hand-rolled fake - ReplyQueue now
// reads/writes its pending AND resolved replies through MetricsStore's
// enqueueReplyItem/countPendingReplyItems/takeExpiredReplyItems/
// peekOldestPendingReplyItem/resolveReplyItem rather than an in-memory
// array plus a separate injected recordOutcome hook (persisted state is a
// core observer capability now, independent of the dashboard, and a
// reply's whole lifecycle lives in one table - see AGENTS.md's
// "Persistence" section and the store's v5 migration doc comment), so
// exercising it against the real SQL contract is both simpler and more
// representative than a second, parallel in-memory implementation that
// could drift from it.
function newQueue(overrides = {}) {
  const store = overrides.store ?? new MetricsStore({ dbPath: ':memory:' });
  return new ReplyQueue({
    quietMs: QUIET_MS,
    ttlMs: TTL_MS,
    pollIntervalMs: POLL_MS,
    logger: silentLogger(),
    store,
    ...overrides
  });
}

function waitFor(conditionFn, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (conditionFn()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

test('does not send immediately - a queued reply waits for a quiet window', async () => {
  const { dispatch, calls } = testDispatcher();
  const queue = newQueue({ dispatch });

  queue.enqueue(baseItem());
  assert.equal(calls.length, 0, 'must not dispatch before any quiet window has elapsed');

  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].trigger, '!echo');
});

test('a queued item carries channel, sender, hopCount, path, and hash - not just botName/trigger', async () => {
  const { dispatch, calls } = testDispatcher();
  const queue = newQueue({ dispatch });

  queue.enqueue(baseItem({ botName: 'echo_bot', channel: '#echo', trigger: '!echo', sender: 'Jeymz', hopCount: 3, path: 'AA➡️BB', hash: 'abc123' }));
  await waitFor(() => calls.length === 1);

  assert.deepEqual(
    { botName: calls[0].botName, channel: calls[0].channel, trigger: calls[0].trigger, sender: calls[0].sender, hopCount: calls[0].hopCount, path: calls[0].path, hash: calls[0].hash },
    { botName: 'echo_bot', channel: '#echo', trigger: '!echo', sender: 'Jeymz', hopCount: 3, path: 'AA➡️BB', hash: 'abc123' }
  );
});

test('repeated activity keeps resetting the quiet clock, delaying the send', async () => {
  const { dispatch, calls } = testDispatcher();
  const queue = newQueue({ dispatch });
  queue.enqueue(baseItem());

  // Keep the channel "busy" for longer than quietMs by repeatedly
  // resetting activity faster than the quiet window could elapse.
  const keepBusyUntil = Date.now() + QUIET_MS * 4;
  while (Date.now() < keepBusyUntil) {
    queue.noteActivity();
    assert.equal(calls.length, 0, 'must not send while activity keeps being observed');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  await waitFor(() => calls.length === 1);
});

test('sends queued replies in FIFO order, one quiet window at a time', async () => {
  const { dispatch, calls } = testDispatcher();
  const queue = newQueue({ dispatch });

  queue.enqueue(baseItem({ trigger: '!first' }));
  queue.enqueue(baseItem({ trigger: '!second' }));

  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].trigger, '!first');
  assert.equal(queue.size, 1, 'the second item must still be waiting for its own quiet window');

  await waitFor(() => calls.length === 2);
  assert.equal(calls[1].trigger, '!second');
});

test('sending an item resets the quiet clock, so the next item still needs its own fresh quiet window', async () => {
  const sendTimestamps = [];
  const { dispatch } = testDispatcher({
    '!first': () => sendTimestamps.push(Date.now()),
    '!second': () => sendTimestamps.push(Date.now())
  });
  const queue = newQueue({ dispatch });

  queue.enqueue(baseItem({ trigger: '!first' }));
  queue.enqueue(baseItem({ trigger: '!second' }));

  await waitFor(() => sendTimestamps.length === 2, { timeoutMs: 3000 });
  const gapMs = sendTimestamps[1] - sendTimestamps[0];
  assert.ok(gapMs >= QUIET_MS, `expected at least ${QUIET_MS}ms between sends, got ${gapMs}ms`);
});

test('drops an item that expires before a quiet window is observed, and logs a warning with its channel/sender', async () => {
  const { dispatch, calls } = testDispatcher();
  const logger = silentLogger();
  // ttlMs shorter than quietMs guarantees expiry fires before eligibility.
  const queue = newQueue({ quietMs: 500, ttlMs: 20, logger, dispatch });

  queue.enqueue(baseItem({ channel: '#echo', sender: 'Jeymz' }));

  await waitFor(() => queue.size === 0, { timeoutMs: 2000 });
  assert.equal(calls.length, 0);
  assert.equal(logger.calls.warn.length, 1);
  assert.match(logger.calls.warn[0].message, /expired/);
  assert.equal(logger.calls.warn[0].meta.trigger, '!echo');
  assert.equal(logger.calls.warn[0].meta.channel, '#echo');
  assert.equal(logger.calls.warn[0].meta.sender, 'Jeymz');
});

test('a slow-resolving dispatch does not cause a concurrent send from the next poll tick', async () => {
  const events = [];
  const { dispatch } = testDispatcher({
    '!slow': async () => {
      events.push('start:!slow');
      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6)); // outlasts several poll ticks
      events.push('end:!slow');
    },
    '!second': () => events.push('end:!second')
  });
  const queue = newQueue({ dispatch });

  queue.enqueue(baseItem({ trigger: '!slow' }));
  queue.enqueue(baseItem({ trigger: '!second' }));

  await waitFor(() => events.length === 3, { timeoutMs: 3000 });
  assert.deepEqual(events, ['start:!slow', 'end:!slow', 'end:!second']);
});

test('logs a warning with channel/sender and continues when dispatching a queued item throws', async () => {
  const logger = silentLogger();
  const { dispatch, calls } = testDispatcher({
    '!broken': () => {
      throw new Error('radio busy');
    }
  });
  const queue = newQueue({ logger, dispatch });

  queue.enqueue(baseItem({ trigger: '!broken', channel: '#echo', sender: 'Jeymz' }));
  queue.enqueue(baseItem({ trigger: '!ok' }));

  await waitFor(() => calls.some((c) => c.trigger === '!ok'), { timeoutMs: 3000 });
  const failureLog = logger.calls.warn.find((c) => c.message.includes('failed to send a queued reply'));
  assert.ok(failureLog);
  assert.equal(failureLog.meta.channel, '#echo');
  assert.equal(failureLog.meta.sender, 'Jeymz');
});

test('getStats() reports only the live queue depth - lifetime counters are queried back from the store instead', async () => {
  const { dispatch } = testDispatcher();
  const queue = newQueue({ dispatch });

  assert.deepEqual(queue.getStats(), { size: 0 });

  queue.enqueue(baseItem({ trigger: '!ok' }));
  assert.deepEqual(queue.getStats(), { size: 1 });

  await waitFor(() => queue.size === 0);
  assert.deepEqual(queue.getStats(), { size: 0 });
});

test('stop() leaves pending items in the store untouched, rather than dropping them', async () => {
  const { dispatch, calls } = testDispatcher();
  // quietMs long enough that neither item would have sent on its own before
  // stop() runs.
  const queue = newQueue({ quietMs: 10000, ttlMs: 60000, dispatch });

  queue.enqueue(baseItem({ trigger: '!first' }));
  queue.enqueue(baseItem({ trigger: '!second' }));
  assert.equal(queue.size, 2);

  await queue.stop();

  assert.equal(queue.size, 2, 'a clean shutdown must not drop pending items - see the class doc comment');
  assert.equal(calls.length, 0, 'nothing should have been dispatched before stop()');
});

test('stop() prevents further enqueue() calls from being accepted', async () => {
  const { dispatch, calls } = testDispatcher();
  const queue = newQueue({ dispatch });

  await queue.stop();
  queue.enqueue(baseItem());

  assert.equal(queue.size, 0);
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS * 2));
  assert.equal(calls.length, 0);
});

test('stop() is idempotent', async () => {
  const { dispatch } = testDispatcher();
  const queue = newQueue({ dispatch });

  queue.enqueue(baseItem());
  await queue.stop();
  await assert.doesNotReject(() => queue.stop());
});

test('stop() waits for an in-flight send to finish before resolving', async () => {
  const events = [];
  const { dispatch } = testDispatcher({
    '!slow': async () => {
      events.push('start');
      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6));
      events.push('end');
    }
  });
  const queue = newQueue({ dispatch });

  queue.enqueue(baseItem({ trigger: '!slow' }));
  await waitFor(() => events.includes('start'));

  await queue.stop();
  assert.deepEqual(events, ['start', 'end']);
});

test('a reply is resolved to "sent", including sender/hash/queuedMs, once it actually sends', async () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const { dispatch, calls } = testDispatcher();
  const queue = newQueue({ store, dispatch });

  queue.enqueue(baseItem({ trigger: '!echo', sender: 'Jeymz', hash: 'deadbeef' }));
  await waitFor(() => calls.length === 1);
  const resolved = store.getReplyById(calls[0].id);

  assert.equal(resolved.botName, 'echo');
  assert.equal(resolved.trigger, '!echo');
  assert.equal(resolved.sender, 'Jeymz');
  assert.equal(resolved.hash, 'deadbeef');
  assert.equal(resolved.status, 'sent');
  assert.ok(Number.isInteger(resolved.resolvedAt));
  assert.ok(resolved.queuedMs >= 0);
  store.close();
});

test('a reply is resolved to "failed" when dispatching it throws', async () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const { dispatch, calls } = testDispatcher({
    '!broken': () => {
      throw new Error('radio busy');
    }
  });
  const queue = newQueue({ store, dispatch });

  queue.enqueue(baseItem({ trigger: '!broken' }));
  await waitFor(() => calls.length === 1);
  const resolved = store.getReplyById(calls[0].id);

  assert.equal(resolved.status, 'failed');
  assert.equal(resolved.trigger, '!broken');
  store.close();
});

test('a reply is resolved to "expired" when dropped before a quiet window is observed', async () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const { dispatch } = testDispatcher();
  const queue = newQueue({ quietMs: 500, ttlMs: 20, store, dispatch });

  queue.enqueue(baseItem({ trigger: '!echo' }));
  // Captured synchronously, right after enqueue() writes it - before the
  // poll timer's first tick has any chance to run.
  const { id } = store.peekOldestPendingReplyItem();

  await waitFor(() => store.getReplyById(id).status !== 'pending', { timeoutMs: 2000 });
  const resolved = store.getReplyById(id);

  assert.equal(resolved.status, 'expired');
  assert.ok(resolved.queuedMs >= 20);
  store.close();
});

test('a resolveReplyItem failure is caught and logged (as a possible-duplicate risk), and does not crash the tick', async () => {
  const { dispatch, calls } = testDispatcher();
  const logger = silentLogger();
  const brokenStore = {
    enqueueReplyItem: () => {},
    countPendingReplyItems: () => 1,
    takeExpiredReplyItems: () => [],
    peekOldestPendingReplyItem: () => ({ id: 1, botName: 'echo', trigger: '!echo', channel: '#echo', sender: 'Jeymz', enqueuedAt: Date.now() }),
    resolveReplyItem: () => {
      throw new Error('store unavailable');
    }
  };
  const queue = newQueue({ logger, dispatch, store: brokenStore });

  queue.enqueue(baseItem({ trigger: '!echo' }));
  await waitFor(() => calls.length === 1);
  // The broken store's resolveReplyItem() never actually resolves the
  // item, so it would otherwise be re-dispatched forever (the documented
  // duplicate-send risk) - stop() as soon as the warning is observed,
  // rather than leaving the timer running past this test.
  await waitFor(() => logger.calls.warn.some((c) => c.message.includes('failed to mark a reply resolved')));
  await queue.stop();

  assert.ok(logger.calls.warn.some((c) => c.message.includes('failed to mark a reply resolved')));
});

// --- Resume-after-restart (persisted pending items) --------------------

test('start() resumes a reply that was still pending in the store from a previous process', async () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const now = Date.now();
  // Simulates a row left behind by a previous, now-gone ReplyQueue
  // instance - written directly to the store, never through this
  // process's own enqueue().
  store.enqueueReplyItem({ ...baseItem({ trigger: '!resumed' }), enqueuedAt: now, expiresAt: now + TTL_MS });

  const { dispatch, calls } = testDispatcher();
  const queue = newQueue({ store, dispatch });

  assert.equal(calls.length, 0, 'must not dispatch before start() even notices the resumed item');
  queue.start();

  await waitFor(() => calls.length === 1, { timeoutMs: 2000 });
  assert.equal(calls[0].trigger, '!resumed');
  store.close();
});

test('start() does nothing when nothing was left pending', () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const { dispatch, calls } = testDispatcher();
  const queue = newQueue({ store, dispatch });

  assert.doesNotThrow(() => queue.start());
  assert.equal(calls.length, 0);
  store.close();
});

test('a resumed item that is already past its TTL is expired on the first tick, not dispatched', async () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const now = Date.now();
  // expiresAt already in the past - as if this process started long after
  // the item was originally queued (a crash, or extended downtime).
  store.enqueueReplyItem({ ...baseItem({ trigger: '!stale' }), enqueuedAt: now - 5000, expiresAt: now - 1000 });
  const { id } = store.peekOldestPendingReplyItem();

  const { dispatch, calls } = testDispatcher();
  const queue = newQueue({ store, dispatch });

  queue.start();
  await waitFor(() => store.getReplyById(id).status !== 'pending', { timeoutMs: 2000 });

  assert.equal(calls.length, 0, 'a resumed-but-stale item must never dispatch');
  assert.equal(store.getReplyById(id).status, 'expired');
  store.close();
});

test('start() called twice does not start a second timer (idempotent alongside enqueue())', async () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const now = Date.now();
  store.enqueueReplyItem({ ...baseItem({ trigger: '!resumed' }), enqueuedAt: now, expiresAt: now + TTL_MS });

  const { dispatch, calls } = testDispatcher();
  const queue = newQueue({ store, dispatch });

  queue.start();
  queue.start();
  await waitFor(() => calls.length === 1, { timeoutMs: 2000 });

  // A doubled timer would tend to double-dispatch or race; give it a
  // moment past the first send to confirm nothing further happens.
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS * 2));
  assert.equal(calls.length, 1);
  store.close();
});
