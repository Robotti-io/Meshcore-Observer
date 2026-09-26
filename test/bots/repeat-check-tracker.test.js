import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepeatCheckTracker } from '../../src/bots/repeat-check-tracker.js';

test('a matching text within the timeout is a confirmed repeat, consumed only once', () => {
  const tracker = new RepeatCheckTracker({ timeoutMs: 1000 });

  const registerResult = tracker.register('hello', { trigger: '!echo' });
  assert.deepEqual(registerResult, []);

  const first = tracker.checkAndConsume('hello');
  assert.equal(first.confirmed.meta.trigger, '!echo');
  assert.equal(typeof first.confirmed.elapsedMs, 'number');
  assert.equal(tracker.size, 0);

  const second = tracker.checkAndConsume('hello');
  assert.equal(second.confirmed, null);
});

test('unrelated text never matches a pending registration', () => {
  const tracker = new RepeatCheckTracker({ timeoutMs: 1000 });
  tracker.register('hello', { trigger: '!echo' });

  const result = tracker.checkAndConsume('goodbye');
  assert.equal(result.confirmed, null);
  assert.equal(tracker.size, 1);
});

test('two pending registrations for the same text are matched oldest-first', () => {
  let clock = 0;
  const tracker = new RepeatCheckTracker({ timeoutMs: 1000, now: () => clock });

  tracker.register('pong', { trigger: 'first' });
  clock = 10;
  tracker.register('pong', { trigger: 'second' });

  const firstMatch = tracker.checkAndConsume('pong');
  assert.equal(firstMatch.confirmed.meta.trigger, 'first');

  const secondMatch = tracker.checkAndConsume('pong');
  assert.equal(secondMatch.confirmed.meta.trigger, 'second');
});

test('an entry past its timeout is reported as expired rather than confirmed, whether discovered via register or checkAndConsume', () => {
  let clock = 0;
  const tracker = new RepeatCheckTracker({ timeoutMs: 1000, now: () => clock });

  tracker.register('hello', { trigger: '!echo' });
  clock = 1500;

  const viaCheck = tracker.checkAndConsume('hello');
  assert.equal(viaCheck.confirmed, null);
  assert.deepEqual(viaCheck.expired, [{ trigger: '!echo' }]);
  assert.equal(tracker.size, 0);

  tracker.register('another', { trigger: '!other' });
  clock = 3000;
  const viaRegister = tracker.register('yet-another', { trigger: '!third' });
  assert.deepEqual(viaRegister, [{ trigger: '!other' }]);
});

test('bounds memory by evicting the oldest pending registration once maxEntries is exceeded', () => {
  const tracker = new RepeatCheckTracker({ timeoutMs: 60000, maxEntries: 2 });

  tracker.register('a', { id: 'a' });
  tracker.register('b', { id: 'b' });
  tracker.register('c', { id: 'c' });

  assert.equal(tracker.size, 2);
  assert.equal(tracker.checkAndConsume('a').confirmed, null);
  assert.ok(tracker.checkAndConsume('b').confirmed);
  assert.ok(tracker.checkAndConsume('c').confirmed);
});
