import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandQueue } from '../../src/radio/command-queue.js';

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test('runs queued tasks one at a time, in order', async () => {
  const queue = new CommandQueue();
  const order = [];

  const first = queue.run(async () => {
    order.push('first-start');
    await delay(20);
    order.push('first-end');
    return 'first';
  });

  const second = queue.run(async () => {
    order.push('second-start');
    await delay(1);
    order.push('second-end');
    return 'second';
  });

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
