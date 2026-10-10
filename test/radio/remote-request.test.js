import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Connection, Constants } from '@liamcottle/meshcore.js';
import { assertRemoteRequest, prepareRemoteRequest } from '../../src/radio/remote-request.js';

const requestId = 'aabbccdd-1234-4abc-8def-0123456789ab';
const targetPublicKey = 'AC'.repeat(32);
const uniqueness = [0x12, 0x34, 0x56, 0x78];
const request = (operation = 'status', params = {}) => ({ requestId, targetPublicKey, operation, params });
const neighbours = (changes = {}) => request('neighbours', {
  version: 0, count: 10, offset: 0x1234, orderBy: 2, prefixLength: 8, ...changes
});

test('pinned read-only status, telemetry and neighbour request bytes match firmware layouts', () => {
  for (const [descriptor, hex] of [
    [request(), '010000000012345678'],
    [request('telemetry', { permissionMask: 255 }), '030000000012345678'],
    [request('telemetry', { permissionMask: 0 }), '03FF00000012345678'],
    [request('telemetry', { permissionMask: 0x55 }), '03AA00000012345678'],
    [neighbours(), '06000A3412020812345678'],
    [neighbours({ count: 255, offset: 65535, orderBy: 3, prefixLength: 32 }), '0600FFFFFF032012345678'],
    [neighbours({ count: 1, offset: 0, orderBy: 0, prefixLength: 1 }), '0600010000000112345678']
  ]) {
    const result = prepareRemoteRequest(descriptor, uniqueness);
    assert.equal(result.status, 'prepared');
    assert.equal(result.command.commandCode, 50);
    assert.equal(result.command.targetPublicKey, targetPublicKey);
    assert.equal(Buffer.from(result.command.requestBytes).toString('hex').toUpperCase(), hex);
    assert.equal(result.command.requestBytes.length, descriptor.operation === 'neighbours' ? 11 : 9);
  }
});

test('prepared arguments use the installed low-level binary method with an exact full target', async () => {
  const connection = new Connection();
  const writes = [];
  connection.sendToRadioFrame = async (frame) => writes.push([...frame]);
  for (const descriptor of [request(), request('telemetry', { permissionMask: 3 }), neighbours()]) {
    const { command } = prepareRemoteRequest(descriptor, uniqueness);
    await connection.sendCommandSendBinaryReq(Buffer.from(command.targetPublicKey, 'hex'), command.requestBytes);
    const wire = writes.at(-1);
    assert.equal(wire[0], Constants.CommandCodes.SendBinaryReq);
    assert.deepEqual(wire.slice(1, 33), [...Buffer.from(targetPublicKey, 'hex')]);
    assert.deepEqual(wire.slice(33), command.requestBytes);
  }
  assert.equal(writes.length, 3);
  assert.equal(connection.eventListenersMap.size, 0);
});

test('anonymous region preparation uses only the fixed application adapter without side effects', () => {
  const connection = new Connection();
  assert.equal(typeof connection.sendCommandSendAnonReq, 'undefined');
  assert.deepEqual(prepareRemoteRequest(request('anonymous-regions')), {
    status: 'prepared', command: { commandCode: 57, frameBytes: [0x39, ...Buffer.from(targetPublicKey, 'hex'), 1, 0] }
  });
  assert.equal(connection.eventListenersMap.size, 0);
});

test('request identity, operation allowlist and required parameters reject before preparation', () => {
  for (const value of [null, undefined, [], {}, { ...request(), requestId: undefined },
    { ...request(), params: undefined }, { ...request(), targetPublicKey: undefined }]) {
    assert.throws(() => prepareRemoteRequest(value, uniqueness), /Invalid remote request:/);
  }
  for (const changes of [
    { requestId: 'bad' }, { requestId: requestId + '\n' }, { requestId: requestId.toUpperCase() },
    { requestId: requestId.replace('-4abc-', '-1abc-') },
    { targetPublicKey: 'AC' }, { targetPublicKey: targetPublicKey.toLowerCase() },
    { targetPublicKey: targetPublicKey + '\n' }, { targetPublicKey: 'ZZ'.repeat(32) },
    { operation: 'login' }, { operation: 'acl' }, { operation: 'binary' },
    { commandCode: 26 }, { requestBytes: [2] }, { password: 'DO-NOT-ECHO' },
    { tag: 1234 }, { params: { reserved: 1 } }, { params: null }
  ]) {
    assert.throws(() => prepareRemoteRequest({ ...request(), ...changes }, uniqueness), /Invalid remote request:/);
  }
});

test('operation-specific parameter bounds reject truncation, coercion, unsupported versions and extras', () => {
  for (const permissionMask of [-1, 256, 0.5, NaN, Infinity, '255', null]) {
    assert.throws(() => assertRemoteRequest(request('telemetry', { permissionMask })), /Invalid remote request:/);
  }
  for (const params of [{}, { permissionMask: 1, password: 'DO-NOT-ECHO' }, { sensorMask: 1 }]) {
    assert.throws(() => assertRemoteRequest(request('telemetry', params)), /Invalid remote request:/);
  }
  for (const [field, values] of [
    ['version', [1, -1, '0', null]], ['count', [0, -1, 256, 1.5, '10']],
    ['offset', [-1, 65536, 0.5, Infinity, '0']], ['orderBy', [-1, 4, 0.5, '0']],
    ['prefixLength', [0, 33, -1, 1.5, '8']]
  ]) {
    for (const value of values) assert.throws(() => assertRemoteRequest(neighbours({ [field]: value })), /Invalid remote request:/);
    const descriptor = neighbours(); delete descriptor.params[field];
    assert.throws(() => assertRemoteRequest(descriptor), /Invalid remote request:/);
  }
  assert.throws(() => assertRemoteRequest(neighbours({ password: 'DO-NOT-ECHO' })), /Invalid remote request:/);
  assert.throws(() => assertRemoteRequest(request('anonymous-regions', { replyPathLength: 1 })), /Invalid remote request:/);
});

test('four-byte uniqueness suffix validates before encoding without coercing bytes or inventing tags', () => {
  for (const bytes of [undefined, null, [], [1, 2, 3], [1, 2, 3, 4, 5], [0, 0, 0, 256],
    [0, 0, 0, -1], [0, 0, 0, 1.5], [0, 0, 0, '1'], [0, 0, 0, NaN], Buffer.alloc(4)]) {
    assert.throws(() => prepareRemoteRequest(request(), bytes), /Invalid remote request uniqueness bytes:/);
  }
  const descriptor = neighbours();
  const before = JSON.stringify(descriptor);
  const suffix = [...uniqueness];
  const result = prepareRemoteRequest(descriptor, suffix);
  suffix[0] = 255; result.command.requestBytes[0] = 255;
  assert.equal(JSON.stringify(descriptor), before);
  assert.deepEqual(uniqueness, [0x12, 0x34, 0x56, 0x78]);
  assert.deepEqual(prepareRemoteRequest(descriptor, uniqueness).command.requestBytes.slice(-4), uniqueness);
});

test('validation errors never echo supplied secret values', () => {
  assert.throws(() => prepareRemoteRequest({ ...request(), password: 'DO-NOT-ECHO' }, uniqueness), (error) => {
    assert.doesNotMatch(error.message, /DO-NOT-ECHO/);
    return true;
  });
});
