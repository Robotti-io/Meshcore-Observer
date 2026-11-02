import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ensureChannel } from '../../src/bots/channel-setup.js';
import { deriveHashtagChannelKey } from '../../src/bots/channel-key.js';
import { CommandQueue } from '../../src/radio/command-queue.js';

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

test('channel enumeration completing after generation cancellation cannot create a slot', async () => {
  const controller = new AbortController();
  let finishEnumeration;
  let writes = 0;
  const connection = {
    getChannels: () => new Promise(resolve => { finishEnumeration = resolve; }),
    setChannel: async () => { writes += 1; }
  };
  const pending = ensureChannel({ channelName: '#cancelled', logger: silentLogger(),
    runCommand: operation => operation(connection, { signal: controller.signal }) });
  controller.abort(new Error('generation retired'));
  finishEnumeration([{ channelIdx: 0, name: '', secret: Buffer.alloc(16) }]);
  assert.equal(await pending, null);
  assert.equal(writes, 0);
});

function sharedChannelDevice({ rejectChannel = null } = {}) {
  const slots = [0, 1].map(channelIdx => ({ channelIdx, name: '', secret: Buffer.alloc(16) }));
  const writes = [];
  const queue = new CommandQueue();
  const connection = {
    getChannels: async () => slots.map(slot => ({ ...slot })),
    setChannel: async (channelIdx, name, secret) => {
      if (name === rejectChannel) throw new Error('device rejected channel creation');
      writes.push({ channelIdx, name });
      slots[channelIdx] = { channelIdx, name, secret: Buffer.from(secret) };
    }
  };
  return { slots, writes, runCommand: fn => queue.run(() => fn(connection)) };
}

test('concurrent missing channels allocate distinct slots on the shared command queue', async () => {
  const device = sharedChannelDevice();
  const logger = silentLogger();
  const [first, second] = await Promise.all([
    ensureChannel({ runCommand: device.runCommand, channelName: '#one', logger }),
    ensureChannel({ runCommand: device.runCommand, channelName: '#two', logger })
  ]);

  assert.equal(first.channelIdx, 0);
  assert.equal(second.channelIdx, 1);
  assert.deepEqual(device.slots.map(slot => slot.name), ['#one', '#two']);
  assert.deepEqual(first.secret, device.slots[0].secret);
  assert.deepEqual(second.secret, device.slots[1].secret);
});

test('concurrent setup of the same channel reuses the first created slot', async () => {
  const device = sharedChannelDevice();
  const logger = silentLogger();
  const [first, second] = await Promise.all([
    ensureChannel({ runCommand: device.runCommand, channelName: '#echo', logger }),
    ensureChannel({ runCommand: device.runCommand, channelName: '#ECHO', logger })
  ]);

  assert.deepEqual(second, first);
  assert.deepEqual(device.writes, [{ channelIdx: 0, name: '#echo' }]);
});

test('failed channel creation does not block another bot or consume its slot', async () => {
  const device = sharedChannelDevice({ rejectChannel: '#one' });
  const logger = silentLogger();
  const [first, second] = await Promise.all([
    ensureChannel({ runCommand: device.runCommand, channelName: '#one', logger }),
    ensureChannel({ runCommand: device.runCommand, channelName: '#two', logger })
  ]);

  assert.equal(first, null);
  assert.equal(second.channelIdx, 0);
  assert.equal(device.slots[0].name, '#two');
  assert.equal(logger.calls.warn[0].message, 'failed to create channel');
});

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
