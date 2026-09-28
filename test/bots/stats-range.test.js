import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatsRange, STATS_RANGE_TOKENS } from '../../src/bots/stats-range.js';

const NOW = 1_700_000_000_000;

test('resolves each fixed-duration token to a window ending at now', () => {
  assert.deepEqual(resolveStatsRange('1h', { now: NOW, earliestSampleAt: 0 }), {
    start: NOW - 60 * 60 * 1000,
    end: NOW
  });
  assert.deepEqual(resolveStatsRange('6h', { now: NOW, earliestSampleAt: 0 }), {
    start: NOW - 6 * 60 * 60 * 1000,
    end: NOW
  });
  assert.deepEqual(resolveStatsRange('1d', { now: NOW, earliestSampleAt: 0 }), {
    start: NOW - 24 * 60 * 60 * 1000,
    end: NOW
  });
  assert.deepEqual(resolveStatsRange('3d', { now: NOW, earliestSampleAt: 0 }), {
    start: NOW - 3 * 24 * 60 * 60 * 1000,
    end: NOW
  });
});

test('"all" starts at earliestSampleAt, not a fixed duration back from now', () => {
  const earliestSampleAt = NOW - 30 * 24 * 60 * 60 * 1000;
  assert.deepEqual(resolveStatsRange('all', { now: NOW, earliestSampleAt }), { start: earliestSampleAt, end: NOW });
});

test('"all" falls back to an empty window at now when nothing has been sampled yet', () => {
  assert.deepEqual(resolveStatsRange('all', { now: NOW, earliestSampleAt: null }), { start: NOW, end: NOW });
});

test('is case-insensitive', () => {
  assert.deepEqual(resolveStatsRange('1H', { now: NOW, earliestSampleAt: 0 }), resolveStatsRange('1h', { now: NOW, earliestSampleAt: 0 }));
  assert.deepEqual(resolveStatsRange('ALL', { now: NOW, earliestSampleAt: 0 }), resolveStatsRange('all', { now: NOW, earliestSampleAt: 0 }));
});

test('returns null for an unrecognized, empty, or missing token', () => {
  assert.equal(resolveStatsRange('5h', { now: NOW, earliestSampleAt: 0 }), null);
  assert.equal(resolveStatsRange('', { now: NOW, earliestSampleAt: 0 }), null);
  assert.equal(resolveStatsRange(undefined, { now: NOW, earliestSampleAt: 0 }), null);
});

test('exports the recognized token list for config/docs to reference', () => {
  assert.deepEqual(STATS_RANGE_TOKENS, ['1h', '6h', '1d', '3d', 'all']);
});
