import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openSerialConnection } from '../../../src/radio/transports/serial-transport.js';

function silentLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function fakeConnection() {
  const connection = new EventEmitter();
  connection.connectCalls = 0;
  connection.closeCalls = 0;
  connection.connect = async () => {
    connection.connectCalls += 1;
  };
  connection.close = async () => {
    connection.closeCalls += 1;
  };
  return connection;
}

test('opens the first port that succeeds', async () => {
  const connections = { COM3: fakeConnection() };
  const created = [];

  const promise = openSerialConnection({
    serialPorts: ['COM3'],
    logger: silentLogger(),
    createConnection: (port) => {
      created.push(port);
      return connections[port];
    }
  });

  connections.COM3.emit('connected');
  const connection = await promise;

  assert.equal(connection, connections.COM3);
  assert.deepEqual(created, ['COM3']);
});

test('tries candidate ports in order, moving on after each failure', async () => {
  const connections = { COM3: fakeConnection(), COM4: fakeConnection(), COM5: fakeConnection() };
  const created = [];

  const promise = openSerialConnection({
    serialPorts: ['COM3', 'COM4', 'COM5'],
    logger: silentLogger(),
    createConnection: (port) => {
      created.push(port);
      return connections[port];
    }
  });

  // COM3 and COM4 fail fast (simulating "port not found" -> disconnected);
  // give each a moment to be attempted in turn before failing it.
  await new Promise((resolve) => setImmediate(resolve));
  connections.COM3.emit('disconnected');
  await new Promise((resolve) => setImmediate(resolve));
  connections.COM4.emit('disconnected');
  await new Promise((resolve) => setImmediate(resolve));
  connections.COM5.emit('connected');

  const connection = await promise;

  assert.equal(connection, connections.COM5);
  assert.deepEqual(created, ['COM3', 'COM4', 'COM5']);
  assert.equal(connections.COM3.closeCalls, 1);
  assert.equal(connections.COM4.closeCalls, 1);
});

test('throws the last error once every candidate port has failed', async () => {
  const connections = { COM3: fakeConnection(), COM4: fakeConnection() };

  const promise = openSerialConnection({
    serialPorts: ['COM3', 'COM4'],
    logger: silentLogger(),
    createConnection: (port) => connections[port]
  });

  await new Promise((resolve) => setImmediate(resolve));
  connections.COM3.emit('disconnected');
  await new Promise((resolve) => setImmediate(resolve));
  connections.COM4.emit('disconnected');

  await assert.rejects(promise, /closed before it was ready/);
});

test('throws immediately when no serial ports are configured', async () => {
  await assert.rejects(
    openSerialConnection({ serialPorts: [], logger: silentLogger(), createConnection: () => fakeConnection() }),
    /no serial ports configured/
  );
});
