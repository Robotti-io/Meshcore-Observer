import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyQueue } from '../../src/bots/reply-queue.js';

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
  const queue = new ReplyQueue({ quietMs: QUIET_MS, ttlMs: TTL_MS, pollIntervalMs: POLL_MS, logger: silentLogger(), dispatch });

  queue.enqueue(baseItem());
  assert.equal(calls.length, 0, 'must not dispatch before any quiet window has elapsed');

  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].trigger, '!echo');
});

test('a queued item carries channel, sender, hopCount, path, and hash - not just botName/trigger', async () => {
  const { dispatch, calls } = testDispatcher();
  const queue = new ReplyQueue({ quietMs: QUIET_MS, ttlMs: TTL_MS, pollIntervalMs: POLL_MS, logger: silentLogger(), dispatch });

  queue.enqueue(baseItem({ botName: 'echo_bot', channel: '#echo', trigger: '!echo', sender: 'Jeymz', hopCount: 3, path: 'AA➡️BB', hash: 'abc123' }));
  await waitFor(() => calls.length === 1);

  assert.deepEqual(
    { botName: calls[0].botName, channel: calls[0].channel, trigger: calls[0].trigger, sender: calls[0].sender, hopCount: calls[0].hopCount, path: calls[0].path, hash: calls[0].hash },
    { botName: 'echo_bot', channel: '#echo', trigger: '!echo', sender: 'Jeymz', hopCount: 3, path: 'AA➡️BB', hash: 'abc123' }
  );
});

test('repeated activity keeps resetting the quiet clock, delaying the send', async () => {
  const { dispatch, calls } = testDispatcher();
  const queue = new ReplyQueue({ quietMs: QUIET_MS, ttlMs: TTL_MS, pollIntervalMs: POLL_MS, logger: silentLogger(), dispatch });
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
  const queue = new ReplyQueue({ quietMs: QUIET_MS, ttlMs: TTL_MS, pollIntervalMs: POLL_MS, logger: silentLogger(), dispatch });

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
  const queue = new ReplyQueue({ quietMs: QUIET_MS, ttlMs: TTL_MS, pollIntervalMs: POLL_MS, logger: silentLogger(), dispatch });

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
  const queue = new ReplyQueue({ quietMs: 500, ttlMs: 20, pollIntervalMs: POLL_MS, logger, dispatch });

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
  const queue = new ReplyQueue({ quietMs: QUIET_MS, ttlMs: TTL_MS, pollIntervalMs: POLL_MS, logger: silentLogger(), dispatch });

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
  const queue = new ReplyQueue({ quietMs: QUIET_MS, ttlMs: TTL_MS, pollIntervalMs: POLL_MS, logger, dispatch });

  queue.enqueue(baseItem({ trigger: '!broken', channel: '#echo', sender: 'Jeymz' }));
  queue.enqueue(baseItem({ trigger: '!ok' }));

  await waitFor(() => calls.some((c) => c.trigger === '!ok'), { timeoutMs: 3000 });
  const failureLog = logger.calls.warn.find((c) => c.message.includes('failed to send a queued reply'));
  assert.ok(failureLog);
  assert.equal(failureLog.meta.channel, '#echo');
  assert.equal(failureLog.meta.sender, 'Jeymz');
});

test('getStats() reports a live size plus lifetime enqueued/sent/expired/failed counters', async () => {
  const logger = silentLogger();
  const { dispatch } = testDispatcher();
  const queue = new ReplyQueue({ quietMs: QUIET_MS, ttlMs: TTL_MS, pollIntervalMs: POLL_MS, logger, dispatch });

  assert.deepEqual(queue.getStats(), { size: 0, totalEnqueued: 0, totalSent: 0, totalExpired: 0, totalFailed: 0 });

  queue.enqueue(baseItem({ trigger: '!ok' }));
  assert.equal(queue.getStats().size, 1);
  assert.equal(queue.getStats().totalEnqueued, 1);

  await waitFor(() => queue.getStats().totalSent === 1);
  assert.deepEqual(queue.getStats(), { size: 0, totalEnqueued: 1, totalSent: 1, totalExpired: 0, totalFailed: 0 });

  const { dispatch: brokenDispatch } = testDispatcher({
    '!broken': () => {
      throw new Error('nope');
    }
  });
  const failingQueue = new ReplyQueue({ quietMs: QUIET_MS, ttlMs: TTL_MS, pollIntervalMs: POLL_MS, logger, dispatch: brokenDispatch });
  failingQueue.enqueue(baseItem({ trigger: '!broken' }));
  await waitFor(() => failingQueue.getStats().totalFailed === 1);

  const expiringQueue = new ReplyQueue({ quietMs: 500, ttlMs: 20, pollIntervalMs: POLL_MS, logger, dispatch });
  expiringQueue.enqueue(baseItem({ trigger: '!expires' }));
  await waitFor(() => expiringQueue.getStats().totalExpired === 1, { timeoutMs: 2000 });
  assert.equal(expiringQueue.getStats().totalSent, 0);
});
