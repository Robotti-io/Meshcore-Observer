import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AirtimeCoordinator } from '../../src/radio/airtime-coordinator.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntilSent(coordinator, send, { intervalMs = 2, timeoutMs = 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const transmission = coordinator.tryRunWhenQuiet(send);
    if (transmission) {
      return { transmission };
    }
    await delay(intervalMs);
  }
  throw new Error('timed out waiting for a quiet send slot');
}

test('does not grant a send slot until the initial quiet window elapses', async () => {
  const coordinator = new AirtimeCoordinator({ quietMs: 25 });
  let sent = false;

  assert.equal(coordinator.tryRunWhenQuiet(async () => (sent = true)), null);
  const { transmission } = await pollUntilSent(coordinator, async () => (sent = true));
  await transmission;
  assert.equal(sent, true);
});

test('new RF activity restarts the quiet window for waiting callers', async () => {
  const coordinator = new AirtimeCoordinator({ quietMs: 40 });
  const startedAt = Date.now();
  let sentAt = null;

  await delay(25);
  coordinator.noteActivity();
  const { transmission } = await pollUntilSent(coordinator, async () => (sentAt = Date.now()));
  await transmission;

  assert.ok(sentAt - startedAt >= 55, `expected activity to defer send, got ${sentAt - startedAt}ms`);
});

test('only one caller can reserve a quiet window and the send resets activity', async () => {
  const coordinator = new AirtimeCoordinator({ quietMs: 20 });
  const calls = [];
  let releaseFirst;

  const { transmission: first } = await pollUntilSent(coordinator, async () => {
    calls.push('first-start');
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    calls.push('first-end');
  });
  const secondWhileSending = coordinator.tryRunWhenQuiet(async () => calls.push('second'));

  assert.equal(secondWhileSending, null);
  releaseFirst();
  await first;
  assert.equal(coordinator.tryRunWhenQuiet(async () => calls.push('second')), null);

  const { transmission: second } = await pollUntilSent(coordinator, async () => calls.push('second'));
  await second;
  assert.deepEqual(calls, ['first-start', 'first-end', 'second']);
});

test('a failed outbound operation releases the reservation', async () => {
  const coordinator = new AirtimeCoordinator({ quietMs: 0 });
  await assert.rejects(coordinator.tryRunWhenQuiet(async () => { throw new Error('send failed'); }), /send failed/);
  assert.equal(await coordinator.tryRunWhenQuiet(async () => 'sent'), 'sent');
});
