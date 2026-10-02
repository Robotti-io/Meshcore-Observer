import { test } from 'vitest';
import assert from 'node:assert/strict';
import { RepeatCheckSweeper } from '../../src/bots/repeat-check-sweeper.js';

function fakeLogger() {
  const calls = { error: [] };
  return {
    calls,
    error: (source, message, meta) => calls.error.push({ source, message, meta })
  };
}

test('uses one unreferenced one-second timer to sweep enabled bots and stops idempotently', () => {
  const callbacks = [];
  const timer = { unrefCalls: 0, unref() { this.unrefCalls += 1; } };
  const swept = [];
  const cleared = [];
  let intervalMs;
  const sweeper = new RepeatCheckSweeper({
    bots: [
      { name: 'enabled', enabled: true, bot: { sweepRepeatChecks: () => swept.push('enabled') } },
      { name: 'disabled', enabled: false, bot: { sweepRepeatChecks: () => swept.push('disabled') } }
    ],
    logger: fakeLogger(),
    setIntervalFn: (callback, interval) => {
      callbacks.push(callback);
      intervalMs = interval;
      return timer;
    },
    clearIntervalFn: (handle) => cleared.push(handle)
  });

  sweeper.start();
  sweeper.start();
  assert.equal(callbacks.length, 1);
  assert.equal(intervalMs, 1000);
  assert.equal(timer.unrefCalls, 1);

  callbacks[0]();
  assert.deepEqual(swept, ['enabled']);

  sweeper.stop();
  sweeper.stop();
  assert.deepEqual(cleared, [timer]);
});

test('does not start a timer when every bot is disabled', () => {
  let timerStarted = false;
  const sweeper = new RepeatCheckSweeper({
    bots: [{ name: 'disabled', enabled: false, bot: { sweepRepeatChecks: () => assert.fail('must not sweep') } }],
    logger: fakeLogger(),
    setIntervalFn: () => {
      timerStarted = true;
      return { unref() {} };
    },
    clearIntervalFn: () => {}
  });

  sweeper.start();
  sweeper.stop();
  assert.equal(timerStarted, false);
});

test('logs a bot sweep failure and continues sweeping other enabled bots', () => {
  const callbacks = [];
  const logger = fakeLogger();
  const swept = [];
  const sweeper = new RepeatCheckSweeper({
    bots: [
      { name: 'broken', enabled: true, bot: { sweepRepeatChecks: () => { throw new Error('failure'); } } },
      { name: 'healthy', enabled: true, bot: { sweepRepeatChecks: () => swept.push('healthy') } }
    ],
    logger,
    setIntervalFn: (callback) => {
      callbacks.push(callback);
      return { unref() {} };
    },
    clearIntervalFn: () => {}
  });

  sweeper.start();
  callbacks[0]();

  assert.deepEqual(swept, ['healthy']);
  assert.deepEqual(logger.calls.error, [
    {
      source: 'bots.repeatCheckSweeper',
      message: 'failed to sweep bot repeat checks',
      meta: { bot: 'broken', error: 'failure' }
    }
  ]);
  sweeper.stop();
});
