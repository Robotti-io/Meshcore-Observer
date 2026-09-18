import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PacketDeduplicator } from '../../src/packets/packet-deduplicator.js';

test('first sighting of an id is not a duplicate; later sightings within the TTL are', () => {
  const dedup = new PacketDeduplicator({ ttlMs: 60000 });
  assert.equal(dedup.isDuplicate('abc123'), false);
  assert.equal(dedup.isDuplicate('abc123'), true);
  assert.equal(dedup.isDuplicate('abc123'), true);
});

test('different ids are tracked independently', () => {
  const dedup = new PacketDeduplicator({ ttlMs: 60000 });
  assert.equal(dedup.isDuplicate('a'), false);
  assert.equal(dedup.isDuplicate('b'), false);
  assert.equal(dedup.isDuplicate('a'), true);
  assert.equal(dedup.isDuplicate('b'), true);
});

test('an entry becomes a fresh sighting again once its TTL expires', () => {
  let clock = 0;
  const dedup = new PacketDeduplicator({ ttlMs: 1000, now: () => clock });

  assert.equal(dedup.isDuplicate('abc123'), false);
  clock = 500;
  assert.equal(dedup.isDuplicate('abc123'), true);
  clock = 1500;
  assert.equal(dedup.isDuplicate('abc123'), false);
});

test('bounds memory by evicting the least-recently-seen entry once maxEntries is exceeded', () => {
  const dedup = new PacketDeduplicator({ maxEntries: 2, ttlMs: 60000 });

  dedup.isDuplicate('a');
  dedup.isDuplicate('b');
  dedup.isDuplicate('c');

  assert.equal(dedup.size, 2);
  // "a" was evicted to make room for "c". Checking still-tracked entries
  // first (a no-op eviction-wise, since re-touching an existing entry
  // doesn't grow the map) confirms "b" and "c" survived.
  assert.equal(dedup.isDuplicate('b'), true);
  assert.equal(dedup.isDuplicate('c'), true);
  // Only now check the evicted id - this sighting is correctly new, and
  // itself evicts "b" (the least-recently-touched of the surviving two).
  assert.equal(dedup.isDuplicate('a'), false);
});

test('re-seeing an id refreshes its recency so it is not the next eviction candidate', () => {
  const dedup = new PacketDeduplicator({ maxEntries: 2, ttlMs: 60000 });

  dedup.isDuplicate('a');
  dedup.isDuplicate('b');
  dedup.isDuplicate('a'); // touch "a" again; "b" is now the oldest
  dedup.isDuplicate('c'); // should evict "b", not "a"

  assert.equal(dedup.isDuplicate('a'), true);
  assert.equal(dedup.isDuplicate('b'), false);
});
