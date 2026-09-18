import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoffDelay } from '../../src/radio/backoff.js';

test('first retry uses the initial delay', () => {
  assert.equal(computeBackoffDelay(1, 3000, 15000), 3000);
});

test('delay doubles with each subsequent attempt', () => {
  assert.equal(computeBackoffDelay(2, 3000, 15000), 6000);
  assert.equal(computeBackoffDelay(3, 3000, 15000), 12000);
});

test('delay is capped at maxDelayMs', () => {
  assert.equal(computeBackoffDelay(4, 3000, 15000), 15000);
  assert.equal(computeBackoffDelay(10, 3000, 15000), 15000);
});
