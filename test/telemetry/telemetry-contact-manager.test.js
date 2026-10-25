import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Constants } from '@liamcottle/meshcore.js';
import { reconcileTelemetryContact } from '../../src/telemetry/telemetry-contact-manager.js';

const target = 'DD'.repeat(32), older = 'AA'.repeat(32), favourite = 'BB'.repeat(32);
const record = (publicKey, overrides = {}) => ({ publicKey, contactType: 2, flags: 0, encodedPathLength: 0,
  pathBytes: Array(64).fill(0), name: 'Contact', lastAdvert: 100, lat: 0, lon: 0, lastMod: 100, ...overrides });
const route = { status: 'available', target: { publicKeyHex: target, name: 'Target', flags: 0x82,
  advertTimestamp: 200, lat: 1, lon: 2 }, path: ['BB12', 'CC34'], hashWidth: 2, receivedAt: 1000, receptionCount: 1 };

function connection({ full = false } = {}) {
  const emitter = new EventEmitter(); const calls = { adds: [], removes: [] };
  emitter.addOrUpdateContact = async (...args) => {
    calls.adds.push(args);
    if (full && calls.adds.length === 1) { emitter.emit(Constants.ResponseCodes.Err, { errCode: 3 }); throw new Error('rejected'); }
    emitter.emit(Constants.ResponseCodes.Ok, {});
  };
  emitter.removeContact = async key => { calls.removes.push(Buffer.from(key).toString('hex').toUpperCase()); emitter.emit(Constants.ResponseCodes.Ok, {}); };
  return { emitter, calls };
}

test('missing target is added from fresh verified route using packed two-byte path length', async () => {
  const radio = connection();
  assert.deepEqual(await reconcileTelemetryContact({ connection: radio.emitter, targetPublicKey: target, contacts: [], route }),
    { status: 'added', hopCount: 2, evicted: false });
  const [key, type, flags, pathLength, path, name, timestamp, lat, lon] = radio.calls.adds[0];
  assert.equal(Buffer.from(key).toString('hex').toUpperCase(), target); assert.equal(type, 2); assert.equal(flags, 0x82);
  assert.equal(pathLength, 0x42); assert.deepEqual(Array.from(path.slice(0, 4)), [0xBB, 0x12, 0xCC, 0x34]);
  assert.equal(name, 'Target'); assert.deepEqual([timestamp, lat, lon], [200, 1, 2]);
});

test('only an explicit full-table response evicts the oldest non-favourite other contact and retries once', async () => {
  const radio = connection({ full: true });
  const contacts = [record(older, { lastMod: 2 }), record(favourite, { flags: 1, lastMod: 1 })];
  const result = await reconcileTelemetryContact({ connection: radio.emitter, targetPublicKey: target, contacts, route });
  assert.deepEqual(result, { status: 'added', hopCount: 2, evicted: true });
  assert.deepEqual(radio.calls.removes, [older]); assert.equal(radio.calls.adds.length, 2);
});

test('no verified route or full table with only favourites never mutates other contacts', async () => {
  const radio = connection();
  assert.deepEqual(await reconcileTelemetryContact({ connection: radio.emitter, targetPublicKey: target, contacts: [], route: null }),
    { status: 'deferred', reason: 'route-unavailable' });
  assert.equal(radio.calls.adds.length, 0);
  const full = connection({ full: true });
  await assert.rejects(reconcileTelemetryContact({ connection: full.emitter, targetPublicKey: target,
    contacts: [record(favourite, { flags: 1 })], route }), error => error.meshcoreErrorCode === 3);
  assert.deepEqual(full.calls.removes, []);
});
