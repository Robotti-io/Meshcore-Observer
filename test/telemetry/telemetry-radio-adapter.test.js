import { test, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { createLogger } from '../../src/logging/logger.js';
import { loadTelemetryPolling } from '../../src/telemetry/polling-config.js';
import { TELEMETRY_POLL_DEFAULTS } from '../../src/telemetry/polling-schemas.js';
import { prepareTelemetryContactRead, prepareTelemetryContactInventory, decodeTelemetryContactPath,
  parseTelemetryContactFrame, parseTelemetryInventoryFrame, parseTelemetryGuestLogin,
  parseTelemetryLoginAck, withPreparedTelemetryGuestLogin } from '../../src/telemetry/telemetry-radio-adapter.js';
import { compileSchema } from '../../src/validation/ajv.js';
import { telemetryLoginResultSchema, telemetryContactProofSchema } from '../../src/telemetry/telemetry-radio-schemas.js';
import { telemetryRadioTarget as targetPublicKey, telemetryRadioOther, telemetryLoginWire,
  telemetryWireBytes, telemetryContactFrame, telemetryInventoryBoundary } from '../fixtures/telemetry-radio-wire.js';

const root = mkdtempSync(join(tmpdir(), 'meshcore-telemetry-radio-'));
let sequence = 0;
afterAll(() => {
  assert.ok(realpathSync(root).startsWith(realpathSync(tmpdir()) + sep));
  assert.ok(root.includes('meshcore-telemetry-radio-'));
  rmSync(root, { recursive: true, force: true });
});
function config(password = 'PRIVATE-ONLY7', enabled = true) {
  const policyPath = join(root, `policy-${sequence++}.json`), secretsPath = join(root, `secrets-${sequence++}.json`);
  writeFileSync(policyPath, JSON.stringify({ version: 1, defaultCredentialRef: 'privateRef' }));
  writeFileSync(secretsPath, JSON.stringify({ version: 1, secrets: { privateRef: password } }));
  return loadTelemetryPolling({ settings: { ...TELEMETRY_POLL_DEFAULTS, enabled }, policyPath, secretsPath });
}
const guest = bytes => parseTelemetryGuestLogin({ targetPublicKey, bytes });
const ack = bytes => parseTelemetryLoginAck({ targetPublicKey, bytes });
const contact = (bytes, radius = 2) => parseTelemetryContactFrame({ targetPublicKey, bytes, radius });

test('only full unfiltered list and exact-key contact commands can be prepared without mutation or shared arrays', () => {
  const target = { targetPublicKey };
  assert.deepEqual(prepareTelemetryContactInventory(), [4]);
  assert.deepEqual(prepareTelemetryContactRead(target), [30, ...Buffer.from(targetPublicKey, 'hex')]);
  const frame = prepareTelemetryContactRead(target); frame[1] = 0;
  assert.equal(prepareTelemetryContactRead(target)[1], 0xAC);
  assert.deepEqual(target, { targetPublicKey });
  for (const input of [{ since: 0 }, { commandCode: 4 }, { password: 'PRIVATE-ONLY7' }, null]) {
    assert.throws(() => prepareTelemetryContactInventory(input), error => error.message === 'Invalid telemetry radio data');
  }
  for (const input of [null, {}, { targetPublicKey: 'name' }, { targetPublicKey: targetPublicKey.toLowerCase() },
    { targetPublicKey, opcode: 26 }, { targetPublicKey, path: [] }, { targetPublicKey, password: 'PRIVATE-ONLY7' }]) {
    assert.throws(() => prepareTelemetryContactRead(input), error => error.message === 'Invalid telemetry radio data');
  }
  assert.throws(() => prepareTelemetryContactRead({ targetPublicKey: '00000000' + 'AC'.repeat(28) }), /Unsafe telemetry login target prefix/);
});

test('every encoded route byte is decoded by hash width/count, wire capacity and target-distance radius', () => {
  for (const radius of [1, 2, 22, 33, 63]) for (let encodedPathLength = 0; encodedPathLength <= 255; encodedPathLength++) {
    const pathBytes = Array.from({ length: 64 }, (_, i) => i), before = [...pathBytes];
    const result = decodeTelemetryContactPath({ encodedPathLength, pathBytes, radius });
    const width = (encodedPathLength >> 6) + 1, count = encodedPathLength & 63;
    const expected = encodedPathLength === 255 ? 'unknown-contact-route' : width === 4 ? 'unsupported-path-width'
      : width * count > 64 ? 'path-capacity-exceeded' : count + 1 > radius ? 'radius-exceeded' : null;
    if (expected) assert.deepEqual(result, { status: 'unavailable', reason: expected });
    else assert.deepEqual(result, { status: 'direct-route', route: { encodedPathLength, hashWidth: width,
      relayCount: count, distance: count + 1, pathBytes: before.slice(0, width * count), outboundRouteVerified: false } });
    assert.deepEqual(pathBytes, before);
  }
});

test('route padding is discarded and returned path bytes cannot mutate source or another decode', () => {
  const input = { encodedPathLength: 0x41, pathBytes: Array(64).fill(0xEF), radius: 2 };
  const first = decodeTelemetryContactPath(input); first.route.pathBytes[0] = 0;
  assert.deepEqual(decodeTelemetryContactPath(input).route.pathBytes, [0xEF, 0xEF]);
  for (const encodedPathLength of [0, 64, 128]) assert.equal(decodeTelemetryContactPath({ ...input, encodedPathLength, radius: 1 }).route.distance, 1);
});

test('invalid route DTOs and byte/radius boundaries never default to safe or disclose extra fields', () => {
  const valid = { encodedPathLength: 0, pathBytes: Array(64).fill(0), radius: 2 };
  for (const input of [null, {}, { ...valid, pathBytes: new Uint8Array(64) }, { ...valid, pathBytes: [] },
    { ...valid, pathBytes: Array(65).fill(0) }, { ...valid, privateValue: 'PRIVATE-ONLY7' },
    ...[-1, 256, 0.5, '0', null, NaN].map(encodedPathLength => ({ ...valid, encodedPathLength })),
    ...[0, 64, 1.5, '2', Infinity].map(radius => ({ ...valid, radius }))]) {
    assert.deepEqual(decodeTelemetryContactPath(input), { status: 'malformed', reason: 'invalid-contact-path' });
  }
});

test('only exact repeater contacts with bounded direct paths are eligible, without names/location/padding', () => {
  for (const [encodedPathLength, radius, expectedLength] of [[0, 1, 0], [0x41, 2, 2], [0xA0, 33, 0]]) {
    // 0xA0 has width3/count32 and overflows capacity; verify that distinction explicitly.
    const bytes = telemetryContactFrame({ encodedPathLength, path: Array(64).fill(0xEF) });
    const result = contact(bytes, radius);
    if (encodedPathLength === 0xA0) assert.equal(result.reason, 'path-capacity-exceeded');
    else {
      assert.equal(result.status, 'eligible'); assert.equal(result.contact.route.pathBytes.length, expectedLength);
      assert.equal(result.contact.targetPublicKey, targetPublicKey);
      assert.equal(result.contact.route.outboundRouteVerified, false);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE-NAME|lastmod|latitude|longitude|raw/);
    }
  }
  assert.deepEqual(contact(telemetryContactFrame({ key: telemetryRadioOther })), { status: 'ignored' });
  for (const type of [0, 1, 3, 255]) assert.deepEqual(contact(telemetryContactFrame({ type })),
    { status: 'unavailable', reason: 'non-repeater-contact' });
  assert.equal(contact(telemetryContactFrame({ encodedPathLength: 2 }), 2).reason, 'radius-exceeded');
  assert.equal(contact(telemetryContactFrame({ encodedPathLength: 255 })).reason, 'unknown-contact-route');
});

test('contact preflight errors and malformed frames produce only fixed safe outcomes', () => {
  for (const [code, reason] of [[1, 'preflight-unsupported'], [2, 'contact-missing'], [3, 'preflight-failed'], [255, 'preflight-failed']]) {
    assert.deepEqual(contact([1, code]), { status: 'unavailable', reason, errorCode: code });
  }
  for (const bytes of [[1], [1, 2, 0], [3], telemetryContactFrame().slice(0, -1), [...telemetryContactFrame(), 0]]) {
    assert.deepEqual(contact(bytes), { status: 'malformed', reason: 'invalid-contact-frame' });
  }
  for (const value of [-1, 256, 0.5, '0', null]) {
    const bytes = telemetryContactFrame(); bytes[35] = value;
    assert.equal(contact(bytes).status, 'malformed');
  }
  for (const bytes of [[2, 0], [4, 0], [6], [0x8C], [0x88]]) assert.deepEqual(contact(bytes), { status: 'ignored' });
  assert.equal(parseTelemetryContactFrame({ targetPublicKey: '00000000' + 'AC'.repeat(28), bytes: telemetryContactFrame(), radius: 2 }).reason, 'unsafe-prefix');
});

test('inventory envelope parser returns the bounded contact record needed for reconciliation', () => {
  assert.deepEqual(parseTelemetryInventoryFrame({ bytes: telemetryInventoryBoundary(2, 1024) }),
    { status: 'accepted', envelope: { kind: 'start', count: 1024 } });
  assert.deepEqual(parseTelemetryInventoryFrame({ bytes: telemetryInventoryBoundary(4, 0xFFFFFFFF) }),
    { status: 'accepted', envelope: { kind: 'end' } });
  const result = parseTelemetryInventoryFrame({ bytes: telemetryContactFrame() });
  assert.deepEqual(Object.keys(result.envelope).sort(), ['contactType', 'encodedPathLength', 'flags', 'kind', 'lastAdvert',
    'lastMod', 'lat', 'lon', 'name', 'pathBytes', 'publicKey']);
  assert.equal(result.envelope.publicKey, targetPublicKey);
  assert.equal(result.envelope.name, 'PRIVATE-NAME-NOT-RETURNED');
  for (const count of [1025, 0xFFFFFFFF]) assert.equal(parseTelemetryInventoryFrame({ bytes: telemetryInventoryBoundary(2, count) }).reason, 'inventory-too-large');
  for (const bytes of [[2], [2, 1, 0, 0], [4, 0, 0, 0, 0, 0], [3], [1], [1, 1, 0]]) {
    assert.equal(parseTelemetryInventoryFrame({ bytes }).status, 'malformed');
  }
  assert.deepEqual(parseTelemetryInventoryFrame({ bytes: [0x8A] }),
    { status: 'accepted', envelope: { kind: 'changed' } });
  assert.deepEqual(parseTelemetryInventoryFrame({ bytes: [0x88] }), { status: 'ignored' });
});

test('pinned modern login returns only prefix-attributed guest proof and original public server clock', () => {
  const bytes = telemetryWireBytes(telemetryLoginWire.guest), before = [...bytes];
  assert.deepEqual(guest(bytes), { status: 'guest-proof', publicKeyPrefix: 'AC0102030405', serverTimestamp: 0x01020304,
    permissions: 0, isAdmin: false, firmwareLevel: 2, provenance: 'companion-prefix-attributed' });
  assert.deepEqual(bytes, before);
  for (const timestamp of [0, 0xFFFFFFFF]) {
    const wire = Buffer.from(bytes); wire.writeUInt32LE(timestamp, 8);
    assert.equal(guest([...wire]).serverTimestamp, timestamp);
  }
  const samePrefixDifferentKey = targetPublicKey.slice(0, 12) + '00'.repeat(26);
  assert.equal(parseTelemetryGuestLogin({ targetPublicKey: samePrefixDifferentKey, bytes }).status, 'guest-proof');
  assert.equal('targetPublicKey' in guest(bytes), false, 'the raw reply cannot attest a full key or nonce');
});

test('every admin/permission combination rejects all privilege and unknown high bits', () => {
  for (const admin of [0, 1]) for (let permission = 0; permission <= 255; permission++) {
    const bytes = telemetryWireBytes(telemetryLoginWire.guest); bytes[1] = admin; bytes[12] = permission;
    assert.equal(guest(bytes).status, admin === 0 && permission === 0 ? 'guest-proof' : 'unavailable');
    if (admin !== 0 || permission !== 0) assert.equal(guest(bytes).reason, 'unsafe-login-permissions');
  }
  for (const firmwareLevel of [0, 1, 3, 255]) {
    const bytes = telemetryWireBytes(telemetryLoginWire.guest); bytes[13] = firmwareLevel;
    assert.deepEqual(guest(bytes), { status: 'unavailable', reason: 'unsupported-login-protocol' });
  }
});

test('legacy, denied, unrelated-prefix and malformed login replies cannot become guest authority', () => {
  assert.deepEqual(guest(telemetryWireBytes(telemetryLoginWire.legacy)), { status: 'unavailable', reason: 'legacy-login-proof' });
  assert.deepEqual(guest(telemetryWireBytes(telemetryLoginWire.denied)),
    { status: 'denied', reason: 'authentication-denied', publicKeyPrefix: 'AC0102030405' });
  for (const hex of Object.values(telemetryLoginWire).slice(0, 3)) {
    const bytes = telemetryWireBytes(hex); bytes[2] = 0xBC;
    assert.deepEqual(guest(bytes), { status: 'ignored' });
  }
  for (const length of [0, 1, 7, 9, 12, 13, 15, 177]) {
    const bytes = telemetryWireBytes(telemetryLoginWire.guest).slice(0, length);
    while (bytes.length < length) bytes.push(0);
    assert.deepEqual(guest(bytes), { status: 'malformed', reason: 'invalid-login-frame' });
  }
  const badReserved = telemetryWireBytes(telemetryLoginWire.denied); badReserved[1] = 1;
  assert.equal(guest(badReserved).status, 'malformed');
  assert.deepEqual(guest([0x8C, 0, 1]), { status: 'ignored' });
  assert.equal(parseTelemetryGuestLogin({ targetPublicKey: '00000000' + 'AC'.repeat(28), bytes: telemetryWireBytes(telemetryLoginWire.guest) }).reason, 'unsafe-prefix');
});

test('login ACK is a static first-four-byte LE prefix with direct-route proof, never a request nonce', () => {
  assert.deepEqual(ack(telemetryWireBytes(telemetryLoginWire.directAck)), { status: 'sent-proof', tag: 0x030201AC,
    route: 'direct', estimatedTimeoutMs: 5000, tagKind: 'static-public-key-prefix' });
  assert.deepEqual(ack(telemetryWireBytes(telemetryLoginWire.floodAck)), { status: 'unavailable', reason: 'route-mismatch' });
  const wrongTag = telemetryWireBytes(telemetryLoginWire.directAck); wrongTag[2] = 0xBC;
  assert.deepEqual(ack(wrongTag), { status: 'unavailable', reason: 'login-tag-mismatch' });
  const bigTimeout = Buffer.from(telemetryWireBytes(telemetryLoginWire.directAck)); bigTimeout.writeUInt32LE(0xFFFFFFFF, 6);
  assert.equal(ack([...bigTimeout]).estimatedTimeoutMs, 0xFFFFFFFF, 'T3 clamps waits using the shared ceiling');
  for (const code of [1, 2, 3, 255]) assert.deepEqual(ack([1, code]), { status: 'unavailable', reason: 'login-command-error', errorCode: code });
  for (const bytes of [[1], [6], telemetryWireBytes(telemetryLoginWire.directAck).slice(0, 9),
    [...telemetryWireBytes(telemetryLoginWire.directAck), 0]]) assert.equal(ack(bytes).status, 'malformed');
  const badRoute = telemetryWireBytes(telemetryLoginWire.directAck); badRoute[1] = 2;
  assert.equal(ack(badRoute).status, 'malformed');
  assert.deepEqual(ack(telemetryWireBytes(telemetryLoginWire.guest)), { status: 'ignored' });
  assert.equal(parseTelemetryLoginAck({ targetPublicKey: '00000000' + 'AC'.repeat(28), bytes: telemetryWireBytes(telemetryLoginWire.directAck) }).reason, 'unsafe-prefix');
});

test('all radio parsers reject secret fields, typed/nonbyte buffers and malformed scope before processing', () => {
  for (const parse of [parseTelemetryGuestLogin, parseTelemetryLoginAck]) {
    for (const input of [null, {}, { targetPublicKey, bytes: new Uint8Array(14) },
      { targetPublicKey, bytes: [0x85], password: 'PRIVATE-ONLY7' },
      { targetPublicKey: targetPublicKey.toLowerCase(), bytes: [0x85] }]) assert.equal(parse(input).status, 'malformed');
    for (const value of [-1, 256, 0.5, '0', null, NaN]) assert.equal(parse({ targetPublicKey, bytes: [0x85, value] }).status, 'malformed');
  }
  assert.equal(parseTelemetryInventoryFrame({ bytes: telemetryContactFrame(), privateValue: 'PRIVATE-ONLY7' }).status, 'malformed');
  assert.equal(parseTelemetryContactFrame({ targetPublicKey, bytes: telemetryContactFrame(), radius: 2, password: 'PRIVATE-ONLY7' }).status, 'malformed');
});

test('private command preparation uses exact UTF-8 bytes with no terminator/truncation, sends nothing and clears its buffer', async () => {
  for (const password of ['PRIVATE-ONLY7', 'éééééééx', '😀😀😀abc']) {
    const current = config(password), target = { targetPublicKey }, before = { ...target };
    let retained;
    const result = await withPreparedTelemetryGuestLogin(current, target, async frame => {
      retained = frame;
      assert.deepEqual([...frame], [0x1A, ...Buffer.from(targetPublicKey, 'hex'), ...Buffer.from(password, 'utf8')]);
      await Promise.resolve();
      assert.equal(frame.subarray(33).toString('utf8'), password);
      return { status: 'prepared-in-test' };
    });
    assert.deepEqual(result, { status: 'prepared-in-test' });
    assert.equal(retained.every(byte => byte === 0), true);
    assert.deepEqual(target, before);
    assert.equal(current.enabled, true);
  }
});

test('private preparation rejects disabled/cloned/zero-prefix/extra-command targets before invoking the consumer', async () => {
  const current = config(), consumer = vi.fn();
  for (const candidate of [config('PRIVATE-ONLY7', false), { ...current }]) {
    await assert.rejects(withPreparedTelemetryGuestLogin(candidate, { targetPublicKey }, consumer), /credential unavailable/);
  }
  for (const target of [{ targetPublicKey, password: 'PRIVATE-ONLY7' }, { targetPublicKey, opcode: 50 },
    { targetPublicKey: '00000000' + 'AC'.repeat(28) }]) {
    await assert.rejects(withPreparedTelemetryGuestLogin(current, target, consumer), /Invalid telemetry radio data|Unsafe telemetry login target prefix/);
  }
  await assert.rejects(withPreparedTelemetryGuestLogin(current, { targetPublicKey }, null), /Invalid telemetry login consumer/);
  assert.equal(consumer.mock.calls.length, 0);
});

test('fresh private preparations cannot alias earlier buffers, and sync/async failures never leak credentials', async () => {
  const current = config(); const frames = [];
  const output = [], log = vi.spyOn(console, 'log').mockImplementation(line => output.push(line));
  try {
    for (const mode of ['sync', 'async']) {
      await assert.rejects(withPreparedTelemetryGuestLogin(current, { targetPublicKey }, frame => {
        frames.push(frame);
        const error = new Error(frame.toString('hex') + ':PRIVATE-ONLY7:privateRef');
        if (mode === 'sync') throw error;
        return Promise.reject(error);
      }), error => {
        createLogger().info('services.telemetry', 'private command preparation failed safely', { reason: error.message });
        return error.message === 'Telemetry guest credential consumer failed' && !('cause' in error);
      });
    }
  } finally { log.mockRestore(); }
  assert.notEqual(frames[0], frames[1]);
  for (const frame of frames) assert.equal(frame.every(byte => byte === 0), true);
  assert.doesNotMatch(inspect(output), /PRIVATE-ONLY7|privateRef|505249564154452d4f4e4c5937/i);
});

test('sanitized protocol result schemas reject credential fields and observed full-key/nonce claims', () => {
  const loginValid = compileSchema(telemetryLoginResultSchema), proofValid = compileSchema(telemetryContactProofSchema);
  const result = guest(telemetryWireBytes(telemetryLoginWire.guest)), proof = contact(telemetryContactFrame()).contact;
  assert.equal(loginValid(result), true); assert.equal(proofValid(proof), true);
  for (const name of ['password', 'credentialRef', 'raw', 'targetPublicKey', 'nonce']) {
    assert.equal(loginValid({ ...result, [name]: 'PRIVATE-ONLY7' }), false);
  }
  assert.equal(proofValid({ ...proof, password: 'PRIVATE-ONLY7' }), false);
  const publicResults = [result, guest(telemetryWireBytes(telemetryLoginWire.legacy)),
    ack(telemetryWireBytes(telemetryLoginWire.floodAck)), contact(telemetryContactFrame()).contact];
  assert.doesNotMatch(JSON.stringify(publicResults), /PRIVATE-ONLY7|privateRef|PRIVATE-NAME|latitude|longitude/);
});
