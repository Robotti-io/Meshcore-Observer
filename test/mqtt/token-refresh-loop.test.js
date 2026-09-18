import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTokenRefreshLoop } from '../../src/mqtt/token-refresh-loop.js';

function silentLogger() {
  const calls = { info: [], warn: [] };
  return {
    calls,
    debug: () => {},
    info: (source, message, meta) => calls.info.push({ source, message, meta }),
    warn: (source, message, meta) => calls.warn.push({ source, message, meta }),
    error: () => {}
  };
}

function fakeBroker() {
  const calls = { close: 0, connect: [] };
  return {
    calls,
    close: async () => {
      calls.close += 1;
    },
    connect: (will) => calls.connect.push(will)
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('does nothing while the current token is far from the renewal threshold', async () => {
  const nowSeconds = 1000;
  const auth = { getExpiration: () => nowSeconds + 10000, refreshIfNeeded: async () => 'token' };
  const broker = fakeBroker();

  const stop = startTokenRefreshLoop({
    auth,
    broker,
    will: null,
    logger: silentLogger(),
    checkIntervalMs: 5,
    thresholdSeconds: 300,
    now: () => nowSeconds * 1000
  });

  await wait(30);
  stop();

  assert.equal(broker.calls.close, 0);
  assert.equal(broker.calls.connect.length, 0);
});

test('does nothing while no token has been created yet', async () => {
  const auth = { getExpiration: () => null, refreshIfNeeded: async () => 'token' };
  const broker = fakeBroker();

  const stop = startTokenRefreshLoop({ auth, broker, will: null, logger: silentLogger(), checkIntervalMs: 5 });
  await wait(30);
  stop();

  assert.equal(broker.calls.close, 0);
});

test('refreshes and reconnects the broker once within the renewal threshold', async () => {
  const nowSeconds = 1000;
  let refreshCalls = 0;
  const auth = {
    getExpiration: () => nowSeconds + 100, // within the 300s threshold
    refreshIfNeeded: async () => {
      refreshCalls += 1;
      return 'fresh-token';
    }
  };
  const broker = fakeBroker();
  const will = { topic: 't', payload: 'p' };
  const logger = silentLogger();

  const stop = startTokenRefreshLoop({
    auth,
    broker,
    will,
    logger,
    checkIntervalMs: 5,
    thresholdSeconds: 300,
    now: () => nowSeconds * 1000
  });

  await wait(30);
  stop();

  assert.ok(refreshCalls >= 1);
  assert.ok(broker.calls.close >= 1);
  assert.deepEqual(broker.calls.connect[0], will);
});

test('logs a warning and keeps running when refresh fails', async () => {
  const nowSeconds = 1000;
  const auth = {
    getExpiration: () => nowSeconds + 100,
    refreshIfNeeded: async () => {
      throw new Error('device unavailable');
    }
  };
  const broker = fakeBroker();
  const logger = silentLogger();

  const stop = startTokenRefreshLoop({
    auth,
    broker,
    will: null,
    logger,
    checkIntervalMs: 5,
    thresholdSeconds: 300,
    now: () => nowSeconds * 1000
  });

  await wait(30);
  stop();

  assert.ok(logger.calls.warn.length >= 1);
  assert.match(logger.calls.warn[0].meta.error, /device unavailable/);
  assert.equal(broker.calls.close, 0);
});

test('stop() prevents any further checks', async () => {
  const nowSeconds = 1000;
  let checks = 0;
  const auth = {
    getExpiration: () => {
      checks += 1;
      return nowSeconds + 10000;
    },
    refreshIfNeeded: async () => 'token'
  };
  const broker = fakeBroker();

  const stop = startTokenRefreshLoop({
    auth,
    broker,
    will: null,
    logger: silentLogger(),
    checkIntervalMs: 5,
    now: () => nowSeconds * 1000
  });

  await wait(20);
  stop();
  const checksAtStop = checks;
  await wait(30);

  assert.equal(checks, checksAtStop);
});
