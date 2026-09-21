import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { Packet } from '@liamcottle/meshcore.js';
import { ChannelBot } from '../../src/bots/channel-bot.js';
import { deriveHashtagChannelKey } from '../../src/bots/channel-key.js';
import { calculatePacketHash } from '../../src/packets/packet-hash.js';
import { buildRawFrame, RouteType, PayloadType } from '../fixtures/packet-frames.js';

function silentLogger() {
  const calls = { debug: [], info: [], warn: [] };
  return {
    calls,
    debug: (source, message, meta) => calls.debug.push({ source, message, meta }),
    info: (source, message, meta) => calls.info.push({ source, message, meta }),
    warn: (source, message, meta) => calls.warn.push({ source, message, meta }),
    error: () => {}
  };
}

function encryptGroupTextPayload({ key16, timestamp = 1700000000, flags = 0, text }) {
  const header = Buffer.alloc(5);
  header.writeUInt32LE(timestamp, 0);
  header[4] = flags;
  const body = Buffer.concat([header, Buffer.from(text, 'utf8'), Buffer.from([0])]);
  const paddedLength = Math.ceil(body.length / 16) * 16;
  const plaintext = Buffer.concat([body, Buffer.alloc(paddedLength - body.length)]);

  const cipher = createCipheriv('aes-128-ecb', key16, null);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const key32 = Buffer.concat([key16, Buffer.alloc(16)]);
  const mac = createHmac('sha256', key32).update(ciphertext).digest().subarray(0, 2);

  return { ciphertext, mac };
}

function channelHashByteFor(key16) {
  return createHash('sha256').update(key16).digest().subarray(0, 1);
}

function buildGrpTxtFrame({ channelKey, hops = [], text, routeType = RouteType.FLOOD, timestamp }) {
  const { ciphertext, mac } = encryptGroupTextPayload({ key16: channelKey, text, timestamp });
  const payload = Buffer.concat([channelHashByteFor(channelKey), mac, ciphertext]);
  return buildRawFrame({
    payloadType: PayloadType.GRP_TXT,
    routeType,
    pathHashSize: 1,
    hops,
    payload
  });
}

function fakeRadioManager() {
  const emitter = new EventEmitter();
  const commandCalls = [];
  const connection = {
    getChannels: async () => [{ channelIdx: 0, name: '', secret: Buffer.alloc(16) }],
    setChannel: async () => {},
    sendChannelTextMessage: async (channelIdx, message) => {
      commandCalls.push({ channelIdx, message });
    }
  };
  return {
    commandCalls,
    connection,
    on: (event, handler) => emitter.on(event, handler),
    emitConnected: () => emitter.emit('radio.connected', {}),
    emitPacket: (frame) => emitter.emit('radio.packet', { lastSnr: 10, lastRssi: -50, raw: frame }),
    runCommand: async (fn) => fn(connection)
  };
}

function baseBotConfig(overrides = {}) {
  return {
    name: 'echo',
    channel: '#echo',
    enabled: true,
    minHops: 1,
    commands: [
      { trigger: '!echo', response: '🔁 @[{sender}]! {hopCount} hops via {path}' },
      { trigger: '!test', response: '🔁 @[{sender}]! {hopCount} hops via {path}' }
    ],
    ...overrides
  };
}

async function startAndConnect(bot, radioManager) {
  bot.start();
  radioManager.emitConnected();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('does nothing when disabled by configuration', () => {
  const radioManager = fakeRadioManager();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig({ enabled: false }), logger: silentLogger() });
  bot.start();
  assert.equal(bot.isReady(), false);
});

test('becomes ready after channel setup succeeds on radio.connected', async () => {
  const radioManager = fakeRadioManager();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig(), logger: silentLogger() });
  await startAndConnect(bot, radioManager);
  assert.equal(bot.isReady(), true);
});

test('replies to an exact trigger on the bot channel meeting the hop requirement', async () => {
  const radioManager = fakeRadioManager();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig(), logger: silentLogger() });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  const frame = buildGrpTxtFrame({ channelKey, hops: ['aa', 'bb', 'cc'], text: 'Jeymz: !echo' });
  radioManager.emitPacket(frame);
  await flush();

  assert.equal(radioManager.commandCalls.length, 1);
  assert.equal(radioManager.commandCalls[0].message, '🔁 @[Jeymz]! 3 hops via AA➡️BB➡️CC');
  assert.equal(bot.getRepliesSent(), 1);
});

test('does not reply to a non-trigger message, and logs why at debug level', async () => {
  const radioManager = fakeRadioManager();
  const logger = silentLogger();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig(), logger });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  radioManager.emitPacket(buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: hello everyone' }));
  await flush();

  assert.equal(radioManager.commandCalls.length, 0);
  const diagnostic = logger.calls.debug.find((call) => call.message.includes('did not match any configured trigger'));
  assert.ok(diagnostic, 'expected a diagnostic debug log explaining the non-match');
  assert.equal(diagnostic.meta.sender, 'Jeymz');
  assert.equal(diagnostic.meta.text, 'hello everyone');
  assert.deepEqual(diagnostic.meta.configuredTriggers, ['!echo', '!test']);
});

test('does not reply when a trigger word appears as a substring, only on an exact match', async () => {
  const radioManager = fakeRadioManager();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig(), logger: silentLogger() });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  radioManager.emitPacket(buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: !echo now' }));
  await flush();

  assert.equal(radioManager.commandCalls.length, 0);
});

test('does not reply when the hop count is below the configured minimum, and logs why', async () => {
  const radioManager = fakeRadioManager();
  const logger = silentLogger();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig({ minHops: 2 }), logger });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  radioManager.emitPacket(buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: !echo' }));
  await flush();

  assert.equal(radioManager.commandCalls.length, 0);
  const diagnostic = logger.calls.debug.find((call) => call.message.includes('below the configured minimum'));
  assert.ok(diagnostic);
  assert.equal(diagnostic.meta.hopCount, 1);
  assert.equal(diagnostic.meta.minHops, 2);
});

test('ignores a trigger message on a different channel, and logs the channel-hash mismatch', async () => {
  const radioManager = fakeRadioManager();
  const logger = silentLogger();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig(), logger });
  await startAndConnect(bot, radioManager);

  const otherChannelKey = deriveHashtagChannelKey('#somewhere-else');
  radioManager.emitPacket(buildGrpTxtFrame({ channelKey: otherChannelKey, hops: ['aa'], text: 'Jeymz: !echo' }));
  await flush();

  assert.equal(radioManager.commandCalls.length, 0);
  const diagnostic = logger.calls.debug.find((call) => call.message.includes('different channel'));
  assert.ok(diagnostic);
  assert.notEqual(diagnostic.meta.packetChannelHash, diagnostic.meta.expectedChannelHash);
});

test('logs a diagnostic when a GRP_TXT on the right channel fails to decrypt (wrong key)', async () => {
  const radioManager = fakeRadioManager();
  const logger = silentLogger();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig(), logger });
  await startAndConnect(bot, radioManager);

  // Same channel-hash byte (forced), but encrypted with a different key, so
  // the MAC check fails even though the channel-hash prefilter passes.
  const realKey = deriveHashtagChannelKey('#echo');
  const wrongKey = Buffer.alloc(16, 0x42);
  const { ciphertext, mac } = (function encrypt() {
    const header = Buffer.alloc(5);
    header.writeUInt32LE(1700000000, 0);
    const body = Buffer.concat([header, Buffer.from('Jeymz: !echo', 'utf8'), Buffer.from([0])]);
    const padded = Buffer.concat([body, Buffer.alloc(Math.ceil(body.length / 16) * 16 - body.length)]);
    const cipher = createCipheriv('aes-128-ecb', wrongKey, null);
    cipher.setAutoPadding(false);
    const ct = Buffer.concat([cipher.update(padded), cipher.final()]);
    const key32 = Buffer.concat([wrongKey, Buffer.alloc(16)]);
    const m = createHmac('sha256', key32).update(ct).digest().subarray(0, 2);
    return { ciphertext: ct, mac: m };
  })();
  const realChannelHashByte = channelHashByteFor(realKey);
  const payload = Buffer.concat([realChannelHashByte, mac, ciphertext]);
  const frame = buildRawFrame({ payloadType: PayloadType.GRP_TXT, routeType: RouteType.FLOOD, hops: ['aa'], payload });

  radioManager.emitPacket(frame);
  await flush();

  assert.equal(radioManager.commandCalls.length, 0);
  const diagnostic = logger.calls.debug.find((call) => call.message.includes('failed to decrypt'));
  assert.ok(diagnostic, 'expected a diagnostic debug log for the decrypt failure');
});

test('replies at most once for a redelivered identical frame', async () => {
  const radioManager = fakeRadioManager();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig(), logger: silentLogger() });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  const frame = buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: !echo' });
  radioManager.emitPacket(frame);
  radioManager.emitPacket(frame);
  await flush();

  assert.equal(radioManager.commandCalls.length, 1);
});

test('a later, better-routed delivery of the same message still replies after an earlier too-few-hops delivery was rejected', async () => {
  // MeshCore flood relaying leaves the encrypted payload unchanged as it
  // hops - only the path grows - so a direct (0-hop) reception and a
  // repeater-relayed (1-hop) reception of the *same* physical transmission
  // share the identical dedup hash. Real-world scenario reported live: a
  // repeater relay legitimately arrives with a satisfying hop count after
  // the direct copy was already rejected for having too few hops.
  const radioManager = fakeRadioManager();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig({ minHops: 1 }), logger: silentLogger() });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  const direct = buildGrpTxtFrame({ channelKey, hops: [], text: 'Jeymz: !echo' }); // 0 hops
  const relayed = buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: !echo' }); // same payload, 1 hop

  radioManager.emitPacket(direct);
  await flush();
  assert.equal(radioManager.commandCalls.length, 0, 'the 0-hop delivery must not reply under minHops:1');

  radioManager.emitPacket(relayed);
  await flush();
  assert.equal(radioManager.commandCalls.length, 1, 'the 1-hop relayed delivery of the same message must still reply');

  // A further identical (1-hop) redelivery must not cause a second reply.
  radioManager.emitPacket(relayed);
  await flush();
  assert.equal(radioManager.commandCalls.length, 1);
});

test('ignores packets that arrive before the channel is ready', async () => {
  const radioManager = fakeRadioManager();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig(), logger: silentLogger() });
  bot.start(); // no radio.connected yet

  const channelKey = deriveHashtagChannelKey('#echo');
  radioManager.emitPacket(buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: !echo' }));
  await flush();

  assert.equal(radioManager.commandCalls.length, 0);
});

test('logs a warning and does not throw when sending the reply fails', async () => {
  const radioManager = fakeRadioManager();
  radioManager.connection.sendChannelTextMessage = async () => {
    throw new Error('radio busy');
  };
  const logger = silentLogger();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig(), logger });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  radioManager.emitPacket(buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: !echo' }));
  await flush();

  assert.equal(bot.getRepliesSent(), 0);
  assert.ok(logger.calls.warn.some((call) => call.message.includes('failed to send reply')));
});

test('treats a DIRECT-route packet as zero hops', async () => {
  const radioManager = fakeRadioManager();
  const bot = new ChannelBot({ radioManager, botConfig: baseBotConfig({ minHops: 0 }), logger: silentLogger() });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  radioManager.emitPacket(
    buildGrpTxtFrame({ channelKey, hops: ['aa', 'bb'], text: 'Jeymz: !echo', routeType: RouteType.DIRECT })
  );
  await flush();

  assert.equal(radioManager.commandCalls[0].message, '🔁 @[Jeymz]! 0 hops via AA➡️BB');
});

test('different commands on the same bot use their own independent response templates', async () => {
  const radioManager = fakeRadioManager();
  const bot = new ChannelBot({
    radioManager,
    botConfig: baseBotConfig({
      commands: [
        { trigger: '!echo', response: '🔁 @[{sender}]! {hopCount} hops via {path}' },
        { trigger: '!ping', response: 'pong to {sender}, trigger={trigger}' }
      ]
    }),
    logger: silentLogger()
  });
  await startAndConnect(bot, radioManager);
  const channelKey = deriveHashtagChannelKey('#echo');

  radioManager.emitPacket(buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: !ping', timestamp: 1700000001 }));
  await flush();

  assert.equal(radioManager.commandCalls.length, 1);
  assert.equal(radioManager.commandCalls[0].message, 'pong to Jeymz, trigger=!ping');
});

test('exposes the packet hash (lowercase) as a {hash} template placeholder, e.g. for a map link', async () => {
  const radioManager = fakeRadioManager();
  const bot = new ChannelBot({
    radioManager,
    botConfig: baseBotConfig({
      commands: [{ trigger: '!link', response: '🔗 https://map.okimesh.org/#/packets/{hash}' }]
    }),
    logger: silentLogger()
  });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  const frame = buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: !link' });
  radioManager.emitPacket(frame);
  await flush();

  const packet = Packet.fromBytes(frame);
  const expectedHash = calculatePacketHash(packet.payload_type, packet.pathLen, Buffer.from(packet.payload)).toLowerCase();

  assert.equal(radioManager.commandCalls.length, 1);
  assert.equal(radioManager.commandCalls[0].message, `🔗 https://map.okimesh.org/#/packets/${expectedHash}`);
  assert.match(expectedHash, /^[0-9a-f]{16}$/);
});

test('records a bot-command event via the injected hook on a successful reply', async () => {
  const radioManager = fakeRadioManager();
  const recorded = [];
  const bot = new ChannelBot({
    radioManager,
    botConfig: baseBotConfig(),
    logger: silentLogger(),
    recordBotCommand: (botName, trigger, occurredAt) => recorded.push({ botName, trigger, occurredAt })
  });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  radioManager.emitPacket(buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: !echo' }));
  await flush();

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].botName, 'echo');
  assert.equal(recorded[0].trigger, '!echo');
  assert.ok(Number.isInteger(recorded[0].occurredAt));
});

test('does not record a bot-command event when the reply send fails', async () => {
  const radioManager = fakeRadioManager();
  radioManager.connection.sendChannelTextMessage = async () => {
    throw new Error('radio busy');
  };
  const recorded = [];
  const bot = new ChannelBot({
    radioManager,
    botConfig: baseBotConfig(),
    logger: silentLogger(),
    recordBotCommand: (botName, trigger, occurredAt) => recorded.push({ botName, trigger, occurredAt })
  });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  radioManager.emitPacket(buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: !echo' }));
  await flush();

  assert.equal(recorded.length, 0);
});

test('does not record a bot-command event for a deduped redelivery, matching the single sent reply', async () => {
  const radioManager = fakeRadioManager();
  const recorded = [];
  const bot = new ChannelBot({
    radioManager,
    botConfig: baseBotConfig(),
    logger: silentLogger(),
    recordBotCommand: (botName, trigger, occurredAt) => recorded.push({ botName, trigger, occurredAt })
  });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  const frame = buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: !echo' });
  radioManager.emitPacket(frame);
  radioManager.emitPacket(frame);
  await flush();

  assert.equal(recorded.length, 1);
});

test('a failure inside recordBotCommand is caught and logged, and does not affect getRepliesSent()', async () => {
  const radioManager = fakeRadioManager();
  const logger = silentLogger();
  const bot = new ChannelBot({
    radioManager,
    botConfig: baseBotConfig(),
    logger,
    recordBotCommand: () => {
      throw new Error('store unavailable');
    }
  });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  radioManager.emitPacket(buildGrpTxtFrame({ channelKey, hops: ['aa'], text: 'Jeymz: !echo' }));
  await flush();

  assert.equal(bot.getRepliesSent(), 1);
  assert.ok(logger.calls.warn.some((call) => call.message.includes('failed to record command metrics')));
});

test('two independent bots on different channels do not cross-respond', async () => {
  const radioManager = fakeRadioManager();
  const echoBot = new ChannelBot({
    radioManager,
    botConfig: baseBotConfig({ name: 'echo', channel: '#echo' }),
    logger: silentLogger()
  });
  const weatherBot = new ChannelBot({
    radioManager,
    botConfig: baseBotConfig({
      name: 'weather',
      channel: '#weather',
      commands: [{ trigger: '!weather', response: 'sunny, {sender}' }]
    }),
    logger: silentLogger()
  });

  echoBot.start();
  weatherBot.start();
  radioManager.emitConnected();
  await flush();

  const weatherKey = deriveHashtagChannelKey('#weather');

  radioManager.emitPacket(buildGrpTxtFrame({ channelKey: weatherKey, hops: ['aa'], text: 'Jeymz: !weather' }));
  await flush();

  assert.equal(radioManager.commandCalls.length, 1);
  assert.equal(radioManager.commandCalls[0].message, 'sunny, Jeymz');
  assert.equal(echoBot.getRepliesSent(), 0);
  assert.equal(weatherBot.getRepliesSent(), 1);
});

test('degrades a too-long response by dropping the path, staying within the configured byte budget', async () => {
  const radioManager = fakeRadioManager();
  const bot = new ChannelBot({
    radioManager,
    botConfig: baseBotConfig({ minHops: 0, maxMessageBytes: 40 }),
    logger: silentLogger()
  });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  const manyHops = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(2, '0'));
  radioManager.emitPacket(
    buildGrpTxtFrame({ channelKey, hops: manyHops, text: 'Jeymz: !echo', routeType: RouteType.FLOOD })
  );
  await flush();

  assert.equal(radioManager.commandCalls.length, 1);
  const { message } = radioManager.commandCalls[0];
  assert.ok(Buffer.byteLength(message, 'utf8') <= 40);
  assert.ok(!message.includes('➡️'));
});

test('degrades a too-long response to its configured overflowResponse (e.g. a hash link) instead of dropping the path', async () => {
  const radioManager = fakeRadioManager();
  const bot = new ChannelBot({
    radioManager,
    botConfig: baseBotConfig({
      minHops: 0,
      maxMessageBytes: 100,
      commands: [
        {
          trigger: '!echo',
          response: '🔁 @[{sender}]! {hopCount} hops via {path}',
          overflowResponse: '🔁 @[{sender}]! {hopCount} hops - 🔗 https://map.okimesh.org/#/packets/{hash}'
        }
      ]
    }),
    logger: silentLogger()
  });
  await startAndConnect(bot, radioManager);

  const channelKey = deriveHashtagChannelKey('#echo');
  const manyHops = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(2, '0'));
  const frame = buildGrpTxtFrame({ channelKey, hops: manyHops, text: 'Jeymz: !echo', routeType: RouteType.FLOOD });
  radioManager.emitPacket(frame);
  await flush();

  const packet = Packet.fromBytes(frame);
  const expectedHash = calculatePacketHash(packet.payload_type, packet.pathLen, Buffer.from(packet.payload)).toLowerCase();

  assert.equal(radioManager.commandCalls.length, 1);
  const { message } = radioManager.commandCalls[0];
  assert.ok(Buffer.byteLength(message, 'utf8') <= 100);
  assert.ok(!message.includes('➡️'));
  assert.equal(message, `🔁 @[Jeymz]! 20 hops - 🔗 https://map.okimesh.org/#/packets/${expectedHash}`);
});
