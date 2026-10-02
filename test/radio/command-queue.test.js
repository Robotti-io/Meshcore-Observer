import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CommandQueue } from '../../src/radio/command-queue.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('runs queued tasks one at a time, in order', async () => {
  const queue = new CommandQueue();
  const order = [];
  const firstStarted = deferred();
  const releaseFirst = deferred();

  const first = queue.run(async () => {
    order.push('first-start');
    firstStarted.resolve();
    await releaseFirst.promise;
    order.push('first-end');
    return 'first';
  });

  const second = queue.run(async () => {
    order.push('second-start');
    order.push('second-end');
    return 'second';
  });

  await firstStarted.promise;
  assert.deepEqual(order, ['first-start'], 'the second task must wait while the first is unresolved');
  releaseFirst.resolve();

  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('a rejected task does not block later queued tasks', async () => {
  const queue = new CommandQueue();

  const failing = queue.run(() => Promise.reject(new Error('boom')));
  const after = queue.run(() => Promise.resolve('ok'));

  await assert.rejects(failing, /boom/);
  assert.equal(await after, 'ok');
});
