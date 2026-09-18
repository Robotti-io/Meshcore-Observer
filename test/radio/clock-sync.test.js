import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncDeviceClock } from '../../src/radio/clock-sync.js';

function fakeLogger() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  return {
    calls,
    debug: (source, message, meta) => calls.debug.push({ source, message, meta }),
    info: (source, message, meta) => calls.info.push({ source, message, meta }),
    warn: (source, message, meta) => calls.warn.push({ source, message, meta }),
    error: (source, message, meta) => calls.error.push({ source, message, meta })
  };
}

const passthroughQueue = { run: (task) => task() };

test('advances the device clock when it is behind system time', async () => {
  const setCalls = [];
  const connection = {
    getDeviceTime: async () => ({ epochSecs: 1000 }),
    setDeviceTime: async (epochSecs) => setCalls.push(epochSecs)
  };
  const logger = fakeLogger();

  await syncDeviceClock({ connection, commandQueue: passthroughQueue, logger, now: () => 5000 * 1000 });

  assert.deepEqual(setCalls, [5000]);
  assert.equal(logger.calls.info.length, 1);
  assert.equal(logger.calls.warn.length, 0);
});

test('does not move the device clock backward when it is equal or ahead', async () => {
  const setCalls = [];
  const connection = {
    getDeviceTime: async () => ({ epochSecs: 9000 }),
    setDeviceTime: async (epochSecs) => setCalls.push(epochSecs)
  };
  const logger = fakeLogger();

  await syncDeviceClock({ connection, commandQueue: passthroughQueue, logger, now: () => 5000 * 1000 });

  assert.deepEqual(setCalls, []);
  assert.equal(logger.calls.debug.length, 1);
});

test('warns but does not throw when the device rejects the read', async () => {
  const connection = {
    getDeviceTime: async () => {
      throw new Error('no response');
    },
    setDeviceTime: async () => {
      throw new Error('should not be called');
    }
  };
  const logger = fakeLogger();

  await assert.doesNotReject(() =>
    syncDeviceClock({ connection, commandQueue: passthroughQueue, logger })
  );
  assert.equal(logger.calls.warn.length, 1);
  assert.match(logger.calls.warn[0].message, /clock sync failed/);
});
