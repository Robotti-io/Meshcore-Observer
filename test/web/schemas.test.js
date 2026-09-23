import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRangeQuery, validateRangeOnlyQuery, validateMetricsHistoryQuery } from '../../src/web/schemas.js';

test('parseRangeQuery converts known numeric fields, and carries an unrecognized key through as a string', () => {
  const query = parseRangeQuery(new URLSearchParams('range=24h&typo=1'));
  assert.deepEqual(query, { range: '24h', typo: '1' });
});

test('parseRangeQuery converts start/end/maxBuckets to numbers', () => {
  const query = parseRangeQuery(new URLSearchParams('start=1000&end=2000&maxBuckets=50'));
  assert.deepEqual(query, { start: 1000, end: 2000, maxBuckets: 50 });
});

test('parseRangeQuery keeps only the first value of a repeated key, matching URLSearchParams#get()', () => {
  const searchParams = new URLSearchParams('range=24h&range=1h');
  assert.equal(searchParams.get('range'), '24h'); // the convention being matched
  assert.deepEqual(parseRangeQuery(searchParams), { range: '24h' });
});

test('validateRangeOnlyQuery rejects a query with an unrecognized parameter, thanks to parseRangeQuery preserving it', () => {
  const query = parseRangeQuery(new URLSearchParams('range=24h&typo=1'));
  assert.equal(validateRangeOnlyQuery(query), false);
  assert.ok(validateRangeOnlyQuery.errors.some((e) => e.message.includes('additional properties')));
});

test('validateRangeOnlyQuery accepts a query with only recognized parameters', () => {
  const query = parseRangeQuery(new URLSearchParams('range=24h'));
  assert.equal(validateRangeOnlyQuery(query), true);
});

test('validateMetricsHistoryQuery rejects an unrecognized parameter alongside a valid maxBuckets', () => {
  const query = parseRangeQuery(new URLSearchParams('range=24h&maxBuckets=50&typo=1'));
  assert.equal(validateMetricsHistoryQuery(query), false);
});

test('an unparseable numeric value becomes NaN, which the integer type keyword rejects', () => {
  const query = parseRangeQuery(new URLSearchParams('start=oops&end=2000'));
  assert.ok(Number.isNaN(query.start));
  assert.equal(validateRangeOnlyQuery(query), false);
});
