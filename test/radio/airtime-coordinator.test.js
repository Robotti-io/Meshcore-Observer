import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AirtimeCoordinator } from '../../src/radio/airtime-coordinator.js';

test('does not grant a send slot until the initial quiet window elapses', async () => {
  let nowMs = 0;
  const coordinator = new AirtimeCoordinator({ quietMs: 25, now: () => nowMs });
  let sent = false;

  assert.equal(coordinator.tryRunWhenQuiet(async () => (sent = true)), null);
  nowMs = 24;
  assert.equal(coordinator.tryRunWhenQuiet(async () => (sent = true)), null);
  nowMs = 25;
  await coordinator.tryRunWhenQuiet(async () => (sent = true));
  assert.equal(sent, true);
});

test('new RF activity restarts the quiet window for waiting callers', async () => {
  let nowMs = 0;
  const coordinator = new AirtimeCoordinator({ quietMs: 40, now: () => nowMs });
  nowMs = 25;
  coordinator.noteActivity();
  nowMs = 64;
  assert.equal(coordinator.tryRunWhenQuiet(async () => {}), null);
  nowMs = 65;
  await coordinator.tryRunWhenQuiet(async () => {});
});

test('only one caller can reserve a quiet window and the send resets activity', async () => {
  let nowMs = 0;
  const coordinator = new AirtimeCoordinator({ quietMs: 20, now: () => nowMs });
  nowMs = 20;
  const calls = [];
  let releaseFirst;

  const first = coordinator.tryRunWhenQuiet(async () => {
    calls.push('first-start');
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    calls.push('first-end');
  });
  assert.ok(first);
  await Promise.resolve();
  const secondWhileSending = coordinator.tryRunWhenQuiet(async () => calls.push('second'));

  assert.equal(secondWhileSending, null);
  releaseFirst();
  await first;
  assert.equal(coordinator.tryRunWhenQuiet(async () => calls.push('second')), null);

  nowMs = 40;
  await coordinator.tryRunWhenQuiet(async () => calls.push('second'));
  assert.deepEqual(calls, ['first-start', 'first-end', 'second']);
});

test('a failed outbound operation releases the reservation', async () => {
  const coordinator = new AirtimeCoordinator({ quietMs: 0 });
  await assert.rejects(coordinator.tryRunWhenQuiet(async () => { throw new Error('send failed'); }), /send failed/);
  assert.equal(await coordinator.tryRunWhenQuiet(async () => 'sent'), 'sent');
});
