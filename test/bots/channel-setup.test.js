import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureChannel } from '../../src/bots/channel-setup.js';
import { deriveHashtagChannelKey } from '../../src/bots/channel-key.js';

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

function runCommandOver(connection) {
  return (fn) => fn(connection);
}

test('finds an existing channel by case-insensitive name match and reuses its index/secret', async () => {
  const existingSecret = Buffer.alloc(16, 0x11);
  const connection = {
    getChannels: async () => [
      { channelIdx: 0, name: 'Public', secret: Buffer.alloc(16) },
      { channelIdx: 1, name: '#ECHO', secret: existingSecret }
    ],
    setChannel: async () => {
      throw new Error('must not create a channel that already exists');
    }
  };
  const logger = silentLogger();

  const result = await ensureChannel({ runCommand: runCommandOver(connection), channelName: '#echo', logger });

  assert.deepEqual(result, { channelIdx: 1, secret: existingSecret });
});

test('creates the channel in the first empty slot when not found, using the derived key', async () => {
  const setChannelCalls = [];
  const connection = {
    getChannels: async () => [
      { channelIdx: 0, name: 'Public', secret: Buffer.alloc(16) },
      { channelIdx: 1, name: '', secret: Buffer.alloc(16) },
      { channelIdx: 2, name: '', secret: Buffer.alloc(16) }
    ],
    setChannel: async (channelIdx, name, secret) => {
      setChannelCalls.push({ channelIdx, name, secret });
    }
  };
  const logger = silentLogger();

  const result = await ensureChannel({ runCommand: runCommandOver(connection), channelName: '#echo', logger });

  assert.equal(setChannelCalls.length, 1);
  assert.equal(setChannelCalls[0].channelIdx, 1);
  assert.equal(setChannelCalls[0].name, '#echo');
  assert.deepEqual(setChannelCalls[0].secret, deriveHashtagChannelKey('#echo'));
  assert.deepEqual(result, { channelIdx: 1, secret: deriveHashtagChannelKey('#echo') });
});

test('never logs the derived channel secret', async () => {
  const connection = {
    getChannels: async () => [{ channelIdx: 0, name: '', secret: Buffer.alloc(16) }],
    setChannel: async () => {}
  };
  const logger = silentLogger();

  await ensureChannel({ runCommand: runCommandOver(connection), channelName: '#echo', logger });

  const secretHex = deriveHashtagChannelKey('#echo').toString('hex');
  const serialized = JSON.stringify([...logger.calls.info, ...logger.calls.warn]);
  assert.ok(!serialized.includes(secretHex));
});

test('returns null and warns when no empty slot is available', async () => {
  const connection = {
    getChannels: async () => [{ channelIdx: 0, name: 'Public', secret: Buffer.alloc(16) }],
    setChannel: async () => {
      throw new Error('must not be called');
    }
  };
  const logger = silentLogger();

  const result = await ensureChannel({ runCommand: runCommandOver(connection), channelName: '#echo', logger });

  assert.equal(result, null);
  assert.equal(logger.calls.warn.length, 1);
});

test('returns null and warns when listing channels fails', async () => {
  const connection = {
    getChannels: async () => {
      throw new Error('device not responding');
    }
  };
  const logger = silentLogger();

  const result = await ensureChannel({ runCommand: runCommandOver(connection), channelName: '#echo', logger });

  assert.equal(result, null);
  assert.equal(logger.calls.warn.length, 1);
});

test('returns null and warns when creating the channel fails', async () => {
  const connection = {
    getChannels: async () => [{ channelIdx: 0, name: '', secret: Buffer.alloc(16) }],
    setChannel: async () => {
      throw new Error('device rejected channel creation');
    }
  };
  const logger = silentLogger();

  const result = await ensureChannel({ runCommand: runCommandOver(connection), channelName: '#echo', logger });

  assert.equal(result, null);
  assert.equal(logger.calls.warn.length, 1);
});
