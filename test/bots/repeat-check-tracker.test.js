import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepeatCheckTracker } from '../../src/bots/repeat-check-tracker.js';

test('a matching text within the timeout is a confirmed repeat, consumed only once', () => {
  const tracker = new RepeatCheckTracker({ timeoutMs: 1000 });

  const registerResult = tracker.register('hello', { trigger: '!echo' });
  assert.deepEqual(registerResult, { expired: [], evicted: [] });

  const first = tracker.checkAndConsume('hello');
  assert.equal(first.confirmed.meta.trigger, '!echo');
  assert.equal(typeof first.confirmed.elapsedMs, 'number');
  assert.equal(tracker.size, 0);

  const second = tracker.checkAndConsume('hello');
  assert.equal(second.confirmed, null);
});

test('a zero timeout expires on the next sweep and cannot be confirmed', () => {
  const tracker = new RepeatCheckTracker({ timeoutMs: 0, now: () => 100 });
  tracker.register('hello', { trigger: '!echo' });

  assert.deepEqual(tracker.sweepExpired(), [{ trigger: '!echo' }]);
  assert.equal(tracker.size, 0);
  assert.equal(tracker.checkAndConsume('hello').confirmed, null);
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
  assert.deepEqual(viaRegister, { expired: [{ trigger: '!other' }], evicted: [] });
});

test('sweeps timed-out entries without requiring another tracker operation', () => {
  let clock = 0;
  const tracker = new RepeatCheckTracker({ timeoutMs: 1000, now: () => clock });
  tracker.register('hello', { trigger: '!echo' });

  clock = 999;
  assert.deepEqual(tracker.sweepExpired(), []);
  assert.equal(tracker.size, 1);

  clock = 1000;
  assert.deepEqual(tracker.sweepExpired(), [{ trigger: '!echo' }]);
  assert.equal(tracker.size, 0);
  assert.deepEqual(tracker.sweepExpired(), []);
});

test('sweeps duplicate text registrations independently and preserves oldest-first confirmation', () => {
  let clock = 0;
  const tracker = new RepeatCheckTracker({ timeoutMs: 100, now: () => clock });
  tracker.register('same', { id: 'first' });
  clock = 50;
  tracker.register('same', { id: 'second' });

  clock = 100;
  assert.deepEqual(tracker.sweepExpired(), [{ id: 'first' }]);
  assert.equal(tracker.size, 1);
  assert.equal(tracker.checkAndConsume('same').confirmed.meta.id, 'second');

  clock = 200;
  assert.deepEqual(tracker.sweepExpired(), []);
  assert.equal(tracker.size, 0);
});

test('bounds memory and reports capacity evictions separately from timeouts', () => {
  const tracker = new RepeatCheckTracker({ timeoutMs: 60000, maxEntries: 2 });

  tracker.register('a', { id: 'a' });
  tracker.register('b', { id: 'b' });
  assert.deepEqual(tracker.register('c', { id: 'c' }), { expired: [], evicted: [{ id: 'a' }] });

  assert.equal(tracker.size, 2);
  assert.equal(tracker.checkAndConsume('a').confirmed, null);
  assert.ok(tracker.checkAndConsume('b').confirmed);
  assert.ok(tracker.checkAndConsume('c').confirmed);
});
