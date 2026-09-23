import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PacketPipeline } from '../../src/packets/packet-pipeline.js';
import { buildRawFrame, RouteType, PayloadType } from '../fixtures/packet-frames.js';

function silentLogger() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  return {
    calls,
    debug: (source, message, meta) => calls.debug.push({ source, message, meta }),
    info: (source, message, meta) => calls.info.push({ source, message, meta }),
    warn: (source, message, meta) => calls.warn.push({ source, message, meta }),
    error: (source, message, meta) => calls.error.push({ source, message, meta })
  };
}

function rawPushFor(frame, overrides = {}) {
  return { lastSnr: -1, lastRssi: -100, raw: frame, ...overrides };
}

test('emits a decoded packet for a valid raw push', () => {
  const logger = silentLogger();
  const pipeline = new PacketPipeline({
    logger,
    getObserverIdentity: () => ({ origin: 'Test Observer', originId: 'abc123' })
  });

  const frame = buildRawFrame({
    payloadType: PayloadType.TXT_MSG,
    routeType: RouteType.FLOOD,
    hops: [],
    payload: Buffer.from('hi')
  });

  const emitted = [];
  pipeline.on('packet', (packet) => emitted.push(packet));
  pipeline.handleRawPacket(rawPushFor(frame));

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].packet_type, '2');
  assert.equal(logger.calls.warn.length, 0);
});

test('emits every delivery of the same physical packet, including re-hearings via a different path', () => {
  const pipeline = new PacketPipeline({
    logger: silentLogger(),
    getObserverIdentity: () => ({ origin: 'Test Observer', originId: 'abc123' })
  });

  const frame = buildRawFrame({
    payloadType: PayloadType.TXT_MSG,
    routeType: RouteType.FLOOD,
    hops: [],
    payload: Buffer.from('repeat me')
  });

  const emitted = [];
  pipeline.on('packet', (packet) => emitted.push(packet));
  pipeline.handleRawPacket(rawPushFor(frame));
  pipeline.handleRawPacket(rawPushFor(frame));

  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].hash, emitted[1].hash);
});

test('drops the packet and logs a warning when device identity is not yet known', () => {
  const logger = silentLogger();
  const pipeline = new PacketPipeline({ logger, getObserverIdentity: () => null });

  const frame = buildRawFrame({
    payloadType: PayloadType.TXT_MSG,
    routeType: RouteType.FLOOD,
    hops: [],
    payload: Buffer.from('hi')
  });

  const emitted = [];
  pipeline.on('packet', (packet) => emitted.push(packet));
  pipeline.handleRawPacket(rawPushFor(frame));

  assert.equal(emitted.length, 0);
  assert.equal(logger.calls.warn.length, 1);
});

test('drops an invalid raw push without throwing', () => {
  const logger = silentLogger();
  const pipeline = new PacketPipeline({
    logger,
    getObserverIdentity: () => ({ origin: 'Test Observer', originId: 'abc123' })
  });

  const emitted = [];
  pipeline.on('packet', (packet) => emitted.push(packet));

  assert.doesNotThrow(() => pipeline.handleRawPacket({ lastSnr: 'bad', lastRssi: -100, raw: Buffer.from([1]) }));
  assert.equal(emitted.length, 0);
  assert.equal(logger.calls.warn.length, 1);
});
