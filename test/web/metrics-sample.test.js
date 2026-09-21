import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSampleDelta } from '../../src/web/metrics-sample.js';

function snapshot(overrides = {}) {
  return {
    radioConnected: true,
    packetsReceived: 0,
    packetsPublished: 0,
    packetsByType: {},
    mqtt: { okimesh: { connected: true, lastConnectedAt: null } },
    bots: [{ name: 'echo', enabled: true, ready: true, repliesSent: 0 }],
    ...overrides
  };
}

test('with no previous snapshot, the delta equals the cumulative totals (first tick since start)', () => {
  const sample = computeSampleDelta({
    prevSnapshot: null,
    snapshot: snapshot({ packetsReceived: 5, packetsPublished: 3, packetsByType: { 4: 3 } }),
    sampleAt: 1000,
    intervalMs: 10000
  });

  assert.equal(sample.packetsReceived, 5);
  assert.equal(sample.packetsPublished, 3);
  assert.deepEqual(sample.packetsByType, { advert: 3 });
  assert.equal(sample.sampleAt, 1000);
  assert.equal(sample.intervalMs, 10000);
});

test('with a previous snapshot, the delta is only the increase since then', () => {
  const prev = snapshot({ packetsReceived: 5, packetsPublished: 3, packetsByType: { 4: 3 } });
  const curr = snapshot({ packetsReceived: 9, packetsPublished: 5, packetsByType: { 4: 5 } });

  const sample = computeSampleDelta({ prevSnapshot: prev, snapshot: curr, sampleAt: 2000, intervalMs: 10000 });

  assert.equal(sample.packetsReceived, 4);
  assert.equal(sample.packetsPublished, 2);
  assert.deepEqual(sample.packetsByType, { advert: 2 });
});

test('re-keys raw packet_type codes into the dashboard 8-category scheme, summing codes that share a bucket', () => {
  const sample = computeSampleDelta({
    prevSnapshot: null,
    // 0 and 7 both fold into "other".
    snapshot: snapshot({ packetsByType: { 4: 1, 0: 1, 7: 2 } }),
    sampleAt: 1000,
    intervalMs: 10000
  });

  assert.deepEqual(sample.packetsByType, { advert: 1, other: 3 });
});

test('omits a packet-type code from the delta once its count stops increasing', () => {
  const prev = snapshot({ packetsByType: { 4: 3 } });
  const curr = snapshot({ packetsByType: { 4: 3 } }); // unchanged since last tick

  const sample = computeSampleDelta({ prevSnapshot: prev, snapshot: curr, sampleAt: 2000, intervalMs: 10000 });
  assert.deepEqual(sample.packetsByType, {});
});

test('carries point-in-time gauges through as-is rather than diffing them', () => {
  const prev = snapshot({ radioConnected: false, bots: [{ name: 'echo', enabled: true, ready: false, repliesSent: 0 }] });
  const curr = snapshot({
    radioConnected: true,
    mqtt: {
      okimesh: { connected: true, lastConnectedAt: null },
      letsmesh: { connected: false, lastConnectedAt: null }
    },
    bots: [
      { name: 'echo', enabled: true, ready: true, repliesSent: 1 },
      { name: 'weather', enabled: false, ready: false, repliesSent: 0 }
    ]
  });

  const sample = computeSampleDelta({ prevSnapshot: prev, snapshot: curr, sampleAt: 2000, intervalMs: 10000 });

  assert.equal(sample.radioConnected, true);
  assert.equal(sample.brokersConnected, 1);
  assert.equal(sample.brokersTotal, 2);
  assert.equal(sample.botsReady, 1);
  assert.equal(sample.botsTotal, 2);
});
