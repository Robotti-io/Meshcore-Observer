import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRangeWindow, RangeError, RANGE_ENUM } from '../../src/web/metrics-range.js';

const NOW = new Date('2026-09-21T12:00:00.000Z').getTime();

test('RANGE_ENUM lists every preset plus "all"', () => {
  assert.deepEqual(RANGE_ENUM, ['1h', '6h', '24h', '7d', '30d', '90d', '1y', 'all']);
});

test('resolves a preset range to [now - duration, now]', () => {
  const window = resolveRangeWindow({ range: '24h', now: NOW });
  assert.equal(window.end, NOW);
  assert.equal(window.start, NOW - 24 * 60 * 60 * 1000);
});

test('resolves "all" to [earliestSampleAt, now]', () => {
  const window = resolveRangeWindow({ range: 'all', now: NOW, earliestSampleAt: 1000 });
  assert.deepEqual(window, { start: 1000, end: NOW });
});

test('resolves "all" to [now, now] when no samples exist yet', () => {
  const window = resolveRangeWindow({ range: 'all', now: NOW, earliestSampleAt: null });
  assert.deepEqual(window, { start: NOW, end: NOW });
});

test('resolves an explicit start/end pair as-is when end is in the past', () => {
  const window = resolveRangeWindow({ start: 1000, end: 2000, now: NOW });
  assert.deepEqual(window, { start: 1000, end: 2000 });
});

test('clamps a future end to now', () => {
  const window = resolveRangeWindow({ start: NOW - 1000, end: NOW + 1_000_000, now: NOW });
  assert.deepEqual(window, { start: NOW - 1000, end: NOW });
});

test('rejects start >= end', () => {
  assert.throws(() => resolveRangeWindow({ start: 2000, end: 1000, now: NOW }), RangeError);
  assert.throws(() => resolveRangeWindow({ start: 1000, end: 1000, now: NOW }), RangeError);
});

test('rejects a start at or after a future end once clamped to now', () => {
  assert.throws(() => resolveRangeWindow({ start: NOW + 500, end: NOW + 1000, now: NOW }), RangeError);
});
