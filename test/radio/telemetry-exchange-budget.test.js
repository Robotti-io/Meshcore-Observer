import { test } from 'vitest';
import assert from 'node:assert/strict';
import { RemoteRequestBudget } from '../../src/radio/remote-request-budget.js';

const options = { maxRequests: 6, windowMs: 300000, stepMs: 1000, restMs: 60000 };
function fixture(limits = {}) {
  const clock = { now: 0 };
  return { clock, budget: new RemoteRequestBudget({ ...limits, now: () => clock.now }) };
}

test('target exchange borrows six paced RF turns, blocks unrelated work, and repays all turns after completion', () => {
  const { clock, budget } = fixture();
  assert.equal(budget.beginExchange(options), null);
  clock.now = 60000; const token = budget.beginExchange(options);
  assert.ok(token); assert.equal(budget.beginExchange(options), null);
  assert.equal(budget.recordAttempt(), false); assert.equal(budget.recordAttempt(Symbol('foreign')), false);
  for (let i = 0; i < 6; i++) {
    assert.equal(budget.recordAttempt(token), true);
    assert.equal(budget.recordAttempt(token), false);
    clock.now += 999; assert.equal(budget.canAttempt(token), false); clock.now++;
  }
  assert.equal(budget.hasExchangeCapacity(token), false);
  assert.equal(budget.recordAttempt(token), false);
  assert.equal(budget.endExchange(Symbol('foreign')), false);
  assert.equal(budget.endExchange(token), true); assert.equal(budget.endExchange(token), false);
  assert.equal(budget.hasExchangeCapacity(undefined), false);
  assert.equal(budget.canAttempt(token), false);
  clock.now += 359999; assert.equal(budget.canAttempt(), false);
  clock.now++; assert.equal(budget.canAttempt(), true);
  assert.equal(budget.recordAttempt(), true); assert.equal(budget.recordAttempt(), false);
});

test('failed writes count, expiry repays used credit, and an expired token cannot send or reclaim permission', () => {
  const { clock, budget } = fixture(); clock.now = 60000;
  const token = budget.beginExchange({ ...options, windowMs: 30000 });
  assert.equal(budget.recordAttempt(token), true); // caller's physical write can subsequently fail
  clock.now += 30000; assert.equal(budget.canAttempt(token), false);
  assert.equal(budget.endExchange(token), false);
  clock.now += 59999; assert.equal(budget.canAttempt(), false);
  clock.now++; assert.equal(budget.canAttempt(), true); assert.equal(budget.canAttempt(token), false);
});

test('unused exchanges spend no credit; rest floor and stricter configured spacing both apply', () => {
  const { clock, budget } = fixture({ minIntervalMs: 10000, maxPerMinute: 6 });
  clock.now = 10000; const unused = budget.beginExchange(options);
  budget.endExchange(unused); assert.equal(budget.canAttempt(), true);
  const token = budget.beginExchange(options); budget.recordAttempt(token); budget.endExchange(token);
  clock.now += 59999; assert.equal(budget.canAttempt(), false);
  clock.now++; assert.equal(budget.canAttempt(), true);
});

test('monotonic rollback cannot accelerate the step or cooldown', () => {
  const { clock, budget } = fixture(); clock.now = 60000;
  const token = budget.beginExchange(options); budget.recordAttempt(token);
  clock.now = 1; assert.equal(budget.canAttempt(token), false);
  budget.endExchange(token); clock.now = 119999; assert.equal(budget.canAttempt(), false);
  clock.now = 120000; assert.equal(budget.canAttempt(), true);
});

for (const patch of [{ maxRequests: 7 }, { maxRequests: 1 }, { stepMs: 0 }, { windowMs: 600001 },
  { restMs: 0 }, { extra: true }]) test(`invalid exchange budget rejects before granting credit: ${JSON.stringify(patch)}`, () => {
  const { clock, budget } = fixture(); clock.now = 60000;
  assert.throws(() => budget.beginExchange({ ...options, ...patch }), /Invalid remote exchange budget/);
  assert.equal(budget.canAttempt(), true);
});
