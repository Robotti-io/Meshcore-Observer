import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createTelemetryContactInventory } from '../../src/telemetry/telemetry-contact-inventory.js';
import { telemetryRadioTarget as targetPublicKey, telemetryRadioOther,
  telemetryContactFrame, telemetryInventoryBoundary } from '../fixtures/telemetry-radio-wire.js';

const create = overrides => createTelemetryContactInventory({ targetPublicKey, radius: 2, startedAt: 100,
  timeoutMs: 5000, ...overrides });
const accept = (inventory, bytes, monotonicNow = 101) => inventory.accept({ bytes, monotonicNow });
const start = count => telemetryInventoryBoundary(2, count), end = () => telemetryInventoryBoundary(4, 123456);

test('target alone does not prove unique login prefix: exact full listing and end marker are required', () => {
  const inventory = create();
  assert.deepEqual(inventory.snapshot({ monotonicNow: 100 }), { status: 'pending', contactCount: 0 });
  assert.equal(accept(inventory, start(2)).status, 'pending');
  const bytes = telemetryContactFrame({ encodedPathLength: 0x41, path: [0xAB, 0xCD] }), before = [...bytes];
  assert.deepEqual(accept(inventory, bytes), { status: 'pending', contactCount: 1 });
  assert.deepEqual(bytes, before);
  assert.equal(accept(inventory, telemetryContactFrame({ key: telemetryRadioOther, type: 3 })).status, 'pending');
  const complete = accept(inventory, end());
  assert.equal(complete.status, 'complete'); assert.equal(complete.contactCount, 2);
  assert.deepEqual(complete.contact, { targetPublicKey, contactType: 2, route: { encodedPathLength: 0x41, hashWidth: 2, relayCount: 1,
    distance: 2, pathBytes: [0xAB, 0xCD], outboundRouteVerified: false } });
  assert.equal(complete.contacts.length, 2); assert.equal(complete.contacts[0].publicKey, targetPublicKey);
  assert.equal(complete.contacts[0].contactType, 2); assert.equal(complete.prefixCollisionChecked, true);
  assert.equal(complete.provenance, 'companion-contact-inventory');
  assert.throws(() => { complete.contact.route.pathBytes[0] = 0; }, TypeError);
  assert.deepEqual(inventory.snapshot({ monotonicNow: 102 }), complete);
  assert.doesNotMatch(JSON.stringify(complete), /password/);
});

test('all contact types participate in first-four/six-byte collision checks in either row order', () => {
  const fourCollision = targetPublicKey.slice(0, 8) + 'FFFF' + '00'.repeat(26);
  const sixCollision = targetPublicKey.slice(0, 12) + '00'.repeat(26);
  for (const key of [fourCollision, sixCollision]) for (const type of [0, 1, 2, 3, 255]) for (const targetFirst of [false, true]) {
    const inventory = create(); accept(inventory, start(2));
    const rows = [telemetryContactFrame(), telemetryContactFrame({ key, type })];
    if (!targetFirst) rows.reverse();
    const results = rows.map(bytes => accept(inventory, bytes));
    assert.deepEqual(results.at(-1), { status: 'pending', contactCount: 2 });
    assert.deepEqual(accept(inventory, end()), { status: 'deferred', reason: 'login-prefix-collision', contactCount: 2 });
  }
});

test('duplicate keys, extra rows, repeated start, premature end and missing starts cannot prove complete coverage', () => {
  const streams = [
    [telemetryContactFrame()], [end()], [start(1), start(1)],
    [start(2), telemetryContactFrame(), end()],
    [start(2), telemetryContactFrame(), telemetryContactFrame()],
    [start(1), telemetryContactFrame(), telemetryContactFrame({ key: telemetryRadioOther })]
  ];
  for (const stream of streams) {
    const inventory = create(); const results = stream.map(bytes => accept(inventory, bytes));
    assert.equal(results.at(-1).status, 'unavailable');
    assert.ok(['inventory-protocol-error', 'duplicate-contact'].includes(results.at(-1).reason));
  }
});

test('complete empty/non-target lists and non-repeater/unsafe/out-of-radius targets remain repairable', () => {
  for (const rows of [[], [telemetryContactFrame({ key: telemetryRadioOther })]]) {
    const inventory = create(); accept(inventory, start(rows.length)); rows.forEach(bytes => accept(inventory, bytes));
    const completed = accept(inventory, end());
    assert.equal(completed.status, 'complete'); assert.equal(completed.contact, null);
    assert.equal(completed.contactCount, rows.length);
  }
  for (const [options, reason] of [[{ type: 3 }, 'non-repeater-contact'], [{ encodedPathLength: 255 }, 'unknown-contact-route'],
    [{ encodedPathLength: 192 }, 'unsupported-path-width'], [{ encodedPathLength: 0x61 }, 'path-capacity-exceeded'],
    [{ encodedPathLength: 2 }, 'radius-exceeded']]) {
    const inventory = create(); accept(inventory, start(2));
    assert.deepEqual(accept(inventory, telemetryContactFrame(options)), { status: 'pending', contactCount: 1 });
    assert.deepEqual(accept(inventory, telemetryContactFrame({ key: telemetryRadioOther })), { status: 'pending', contactCount: 2 });
    const completed = accept(inventory, end());
    assert.equal(completed.status, 'complete'); assert.equal(completed.contact, null);
      assert.equal(completed.contactIssue, reason); assert.equal(completed.contacts.length, 2);
  }
});

test('bounded inventory accepts 1024 unique contacts and rejects excess before retaining a partial proof', () => {
  const inventory = create(); accept(inventory, start(1024)); accept(inventory, telemetryContactFrame());
  for (let i = 0; i < 1023; i++) {
    const key = 'BC010203' + i.toString(16).padStart(56, '0').toUpperCase();
    assert.equal(accept(inventory, telemetryContactFrame({ key, type: 1 }), 101).status, 'pending');
  }
  assert.equal(accept(inventory, end()).contactCount, 1024);
  for (const count of [1025, 0xFFFFFFFF]) {
    const oversized = create(); assert.deepEqual(accept(oversized, start(count)), { status: 'unavailable', reason: 'inventory-too-large' });
    assert.equal(accept(oversized, telemetryContactFrame()).reason, 'inventory-too-large');
  }
});

test('monotonic deadline is inclusive, applies to silence/ignored frames and expires completed proofs too', () => {
  const inventory = create(); accept(inventory, start(1)); accept(inventory, telemetryContactFrame());
  assert.equal(inventory.snapshot({ monotonicNow: 5099.999 }).status, 'pending');
  assert.deepEqual(accept(inventory, end(), 5100), { status: 'unavailable', reason: 'preflight-timeout' });
  const silent = create(); assert.equal(silent.snapshot({ monotonicNow: 5100 }).reason, 'preflight-timeout');
  const unrelated = create(); assert.equal(accept(unrelated, [0x88], 5100).reason, 'preflight-timeout');
  const completed = create(); accept(completed, start(1)); accept(completed, telemetryContactFrame()); accept(completed, end());
  assert.equal(completed.snapshot({ monotonicNow: 5100 }).reason, 'preflight-timeout');
});

test('rollback and invalid clock input fail closed without a timer or fabricated local time', () => {
  for (const now of [99, 100.5]) {
    const inventory = create(); accept(inventory, start(1), 101);
    assert.equal(inventory.snapshot({ monotonicNow: now }).reason, 'clock-anomaly');
  }
  for (const input of [{ monotonicNow: Infinity }, { monotonicNow: -1 }, { monotonicNow: '100' },
    { monotonicNow: 100, secret: 'PRIVATE-ONLY7' }, {}, null]) {
    assert.deepEqual(create().snapshot(input), { status: 'unavailable', reason: 'clock-anomaly' });
  }
});

test('known mutation drains to the end marker; malformed frames retire inventory and complete local errors defer', () => {
  for (const [bytes, reason] of [[[3], 'invalid-contact-inventory-frame'], [[2, 0], 'invalid-contact-inventory-frame']]) {
    const inventory = create(); accept(inventory, start(1));
    assert.deepEqual(accept(inventory, bytes), { status: 'unavailable', reason });
    assert.equal(accept(inventory, telemetryContactFrame()).reason, reason);
  }
  const changed = create(); accept(changed, start(1));
  assert.deepEqual(accept(changed, [0x8A]), { status: 'pending', contactCount: 0 });
  assert.equal(accept(changed, telemetryContactFrame()).status, 'pending');
  assert.deepEqual(accept(changed, end()), { status: 'deferred', reason: 'contacts-changed', contactCount: 1 });
  for (const [bytes, reason] of [[[1, 1], 'preflight-unsupported'], [[1, 4], 'preflight-failed']]) {
    const inventory = create();
    assert.deepEqual(accept(inventory, bytes), { status: 'deferred', reason, contactCount: 0 });
    assert.equal(accept(inventory, telemetryContactFrame()).reason, reason);
  }
  const midStreamError = create(); accept(midStreamError, start(1));
  assert.deepEqual(accept(midStreamError, [1, 2]), { status: 'unavailable', reason: 'inventory-protocol-error' });
  const inventory = create(); accept(inventory, start(1));
  assert.deepEqual(accept(inventory, [0x88]), { status: 'pending', contactCount: 0 });
  assert.deepEqual(inventory.accept({ bytes: telemetryContactFrame(), monotonicNow: 101, password: 'PRIVATE-ONLY7' }),
    { status: 'unavailable', reason: 'invalid-contact-inventory-frame' });
});

test('completed proof defers on a later known mutation and rejects an extra owned inventory row', () => {
  for (const bytes of [[0x8A], telemetryContactFrame({ key: telemetryRadioOther })]) {
    const inventory = create(); accept(inventory, start(1)); accept(inventory, telemetryContactFrame());
    assert.equal(accept(inventory, end()).status, 'complete');
    assert.equal(accept(inventory, [0x88]).status, 'complete');
    assert.equal(accept(inventory, bytes).reason, bytes[0] === 0x8A ? 'contacts-changed' : 'inventory-protocol-error');
    assert.equal(inventory.snapshot({ monotonicNow: 102 }).status, bytes[0] === 0x8A ? 'deferred' : 'unavailable');
  }
});

test('invalid options, zero target prefix and deadline bounds are rejected before reducer creation', () => {
  for (const options of [{ radius: 0 }, { radius: 64 }, { timeoutMs: 999 }, { timeoutMs: 30001 },
    { timeoutMs: 1500 }, { startedAt: NaN }, { startedAt: -1 }, { targetPublicKey: targetPublicKey.toLowerCase() },
    { password: 'PRIVATE-ONLY7' }]) assert.throws(() => create(options), error => error.message === 'Invalid telemetry radio data');
  assert.throws(() => create({ targetPublicKey: '00000000' + 'AC'.repeat(28) }), /Unsafe telemetry login target prefix/);
  for (const timeoutMs of [1000, 30000]) assert.equal(create({ timeoutMs }).snapshot({ monotonicNow: 100 }).status, 'pending');
});
