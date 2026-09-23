import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration,
  formatTimestamp,
  formatBucketLabel,
  formatBucketWidthLabel,
  buildQueryString,
  resolveRangeQuery,
  parseCustomRangeInputs,
  buildHistoryChartData,
  chartNoteForBuckets,
  buildPacketTypeTotals
} from '../../../src/web/client/dashboard-logic.js';

test('formatDuration renders only as many leading units as needed', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(5000), '5s');
  assert.equal(formatDuration(65000), '1m 5s');
  assert.equal(formatDuration(3665000), '1h 1m 5s');
  assert.equal(formatDuration(90065000), '1d 1h 1m 5s');
});

test('formatDuration clamps a negative duration to 0s rather than going negative', () => {
  assert.equal(formatDuration(-5000), '0s');
});

test('formatTimestamp returns "never" for a falsy value, and a non-empty string otherwise', () => {
  assert.equal(formatTimestamp(null), 'never');
  assert.equal(formatTimestamp(undefined), 'never');
  assert.equal(formatTimestamp(0), 'never');

  const formatted = formatTimestamp('2024-01-01T00:00:00.000Z');
  assert.equal(typeof formatted, 'string');
  assert.notEqual(formatted, 'never');
  assert.ok(formatted.length > 0);
});

test('formatBucketLabel uses a time format for sub-day widths and a date format for day-or-wider widths', () => {
  const timeLabel = formatBucketLabel(Date.UTC(2024, 0, 1, 12, 30), 60 * 60 * 1000); // 1h bucket
  const dateLabel = formatBucketLabel(Date.UTC(2024, 0, 1, 12, 30), 24 * 60 * 60 * 1000); // 1d bucket

  assert.match(timeLabel, /\d/); // some kind of time rendering
  assert.match(dateLabel, /Jan/); // some kind of date rendering, month abbreviation
  assert.notEqual(timeLabel, dateLabel);
});

test('formatBucketWidthLabel picks the coarsest unit that fits', () => {
  assert.equal(formatBucketWidthLabel(45000), '45s');
  assert.equal(formatBucketWidthLabel(900000), '15m');
  assert.equal(formatBucketWidthLabel(10800000), '3h');
  assert.equal(formatBucketWidthLabel(604800000), '7d');
});

test('buildQueryString serializes params as a URL query string', () => {
  assert.equal(buildQueryString({ range: '24h' }), 'range=24h');
  const qs = buildQueryString({ start: 1000, end: 2000 });
  assert.equal(qs, 'start=1000&end=2000');
});

test('resolveRangeQuery returns {range} for a preset, and null for an unapplied custom range', () => {
  assert.deepEqual(resolveRangeQuery({ range: '24h', customStartMs: null, customEndMs: null }), { range: '24h' });
  assert.equal(resolveRangeQuery({ range: 'custom', customStartMs: null, customEndMs: null }), null);
  assert.equal(resolveRangeQuery({ range: 'custom', customStartMs: 1000, customEndMs: null }), null);
});

test('resolveRangeQuery returns {start, end} once a custom range has both bounds applied', () => {
  assert.deepEqual(resolveRangeQuery({ range: 'custom', customStartMs: 1000, customEndMs: 2000 }), { start: 1000, end: 2000 });
});

test('parseCustomRangeInputs rejects a missing start or end value', () => {
  assert.deepEqual(parseCustomRangeInputs('', '2024-01-02'), { ok: false, error: 'Pick both a start and end date.' });
  assert.deepEqual(parseCustomRangeInputs('2024-01-01', ''), { ok: false, error: 'Pick both a start and end date.' });
});

test('parseCustomRangeInputs rejects a start on or after the (end-of-day-inclusive) end', () => {
  const result = parseCustomRangeInputs('2024-01-05', '2024-01-01');
  assert.deepEqual(result, { ok: false, error: 'Start must be before end.' });
});

test('parseCustomRangeInputs accepts a valid range, treating the end date as inclusive through its end-of-day', () => {
  const result = parseCustomRangeInputs('2024-01-01', '2024-01-01');
  assert.equal(result.ok, true);
  assert.equal(result.start, Date.parse('2024-01-01'));
  assert.equal(result.end, Date.parse('2024-01-01') + 86400000 - 1);
  assert.ok(result.start < result.end);
});

const PACKET_TYPE_BUCKETS_FIXTURE = [
  { key: 'advert', label: 'Advert', varName: '--cat-1' },
  { key: 'txtMsg', label: 'Text message', varName: '--cat-2' }
];

test('buildHistoryChartData shapes buckets into labels/received/per-type series, defaulting missing counts to 0', () => {
  const buckets = [
    { bucketStart: Date.UTC(2024, 0, 1, 0, 0), bucketWidthMs: 3600000, packetsReceived: 5, countsByType: { advert: 3 } },
    { bucketStart: Date.UTC(2024, 0, 1, 1, 0), bucketWidthMs: 3600000, packetsReceived: 2, countsByType: {} }
  ];

  const { labels, receivedData, typeSeriesData } = buildHistoryChartData(buckets, PACKET_TYPE_BUCKETS_FIXTURE);

  assert.equal(labels.length, 2);
  assert.deepEqual(receivedData, [5, 2]);
  assert.deepEqual(typeSeriesData, [
    [3, 0], // advert
    [0, 0] // txtMsg, never present
  ]);
});

test('chartNoteForBuckets reports "no data" for an empty bucket list', () => {
  assert.equal(chartNoteForBuckets([]), 'No data recorded for this range yet.');
});

test('chartNoteForBuckets reports the bucket width and count for a non-empty bucket list', () => {
  const note = chartNoteForBuckets([{ bucketWidthMs: 900000 }, { bucketWidthMs: 900000 }]);
  assert.equal(note, 'Bucketed into 15m windows (2 buckets), computed on the server.');
});

test('buildPacketTypeTotals orders totals to match packetTypeBuckets, defaulting an absent bucket to 0', () => {
  const totals = [{ packetTypeBucket: 'txtMsg', total: 4 }];
  assert.deepEqual(buildPacketTypeTotals(totals, PACKET_TYPE_BUCKETS_FIXTURE), [0, 4]);
});

test('buildPacketTypeTotals returns all zeros when totals is empty', () => {
  assert.deepEqual(buildPacketTypeTotals([], PACKET_TYPE_BUCKETS_FIXTURE), [0, 0]);
});
