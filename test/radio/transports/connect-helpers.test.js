import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { waitForConnection } from '../../../src/radio/transports/connect-helpers.js';

test('resolves once the connection emits "connected"', async () => {
  const connection = new EventEmitter();
  const promise = waitForConnection(connection, 1000);
  connection.emit('connected');
  await assert.doesNotReject(promise);
});

test('rejects immediately if the connection emits "disconnected" before "connected"', async () => {
  const connection = new EventEmitter();
  const promise = waitForConnection(connection, 1000);
  connection.emit('disconnected');
  await assert.rejects(promise, /closed before it was ready/);
});

test('rejects after the timeout if neither event fires', async () => {
  const connection = new EventEmitter();
  await assert.rejects(waitForConnection(connection, 20), /Timed out waiting for connection after 20ms/);
});

test('does not reject on a late "disconnected" after already resolving via "connected"', async () => {
  const connection = new EventEmitter();
  const promise = waitForConnection(connection, 1000);
  connection.emit('connected');
  await promise;

  // A stray late "disconnected" must not cause an unhandled rejection or
  // otherwise affect an already-settled promise.
  assert.doesNotThrow(() => connection.emit('disconnected'));
});

test('removes both listeners once settled, leaving no leak on the connection', async () => {
  const connection = new EventEmitter();
  const promise = waitForConnection(connection, 1000);
  connection.emit('connected');
  await promise;

  assert.equal(connection.listenerCount('connected'), 0);
  assert.equal(connection.listenerCount('disconnected'), 0);
});

test('removes both listeners after a timeout too', async () => {
  const connection = new EventEmitter();
  await waitForConnection(connection, 10).catch(() => {});

  assert.equal(connection.listenerCount('connected'), 0);
  assert.equal(connection.listenerCount('disconnected'), 0);
});
