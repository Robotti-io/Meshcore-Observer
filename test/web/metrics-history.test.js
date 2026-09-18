import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsHistory } from '../../src/web/metrics-history.js';

function snapshot(overrides = {}) {
  return {
    packetsReceived: 0,
    packetsPublished: 0,
    packetsByType: {},
    radioConnected: true,
    mqtt: { okimesh: { connected: true, lastConnectedAt: null } },
    bots: [{ name: 'echo', enabled: true, ready: true, repliesSent: 0 }],
    ...overrides
  };
}

test('derives a compact sample from a full ServiceHealth snapshot', () => {
  const history = new MetricsHistory({ historyWindowMs: 60000, sampleIntervalMs: 10000 });

  history.record(
    snapshot({
      packetsReceived: 5,
      packetsPublished: 3,
      packetsByType: { 4: 2, 5: 1 },
      radioConnected: false,
      mqtt: {
        okimesh: { connected: true, lastConnectedAt: null },
        letsmesh: { connected: false, lastConnectedAt: null }
      },
      bots: [
        { name: 'echo', enabled: true, ready: true, repliesSent: 1 },
        { name: 'weather', enabled: false, ready: false, repliesSent: 0 }
      ]
    })
  );

  const [sample] = history.getSamples();
  assert.equal(sample.packetsReceived, 5);
  assert.equal(sample.packetsPublished, 3);
  assert.equal(sample.radioConnected, false);
  assert.equal(sample.brokersConnected, 1);
  assert.equal(sample.brokersTotal, 2);
  assert.equal(sample.botsReady, 1);
  assert.equal(sample.botsTotal, 2);
  assert.deepEqual(sample.packetsByType, { 4: 2, 5: 1 });
  assert.ok(sample.timestamp instanceof Date);
});

test('copies packetsByType rather than holding a reference to the snapshot object', () => {
  const history = new MetricsHistory({ historyWindowMs: 60000, sampleIntervalMs: 10000 });
  const byType = { 4: 1 };

  history.record(snapshot({ packetsByType: byType }));
  byType[4] = 99;

  assert.deepEqual(history.getSamples()[0].packetsByType, { 4: 1 });
});

test('evicts the oldest sample once past capacity, keeping chronological order', () => {
  const history = new MetricsHistory({ historyWindowMs: 30000, sampleIntervalMs: 10000 });

  history.record(snapshot({ packetsReceived: 1 }));
  history.record(snapshot({ packetsReceived: 2 }));
  history.record(snapshot({ packetsReceived: 3 }));
  history.record(snapshot({ packetsReceived: 4 }));

  const samples = history.getSamples();
  assert.equal(samples.length, 3);
  assert.deepEqual(
    samples.map((s) => s.packetsReceived),
    [2, 3, 4]
  );
});

test('getSamples returns a copy, not the live internal array', () => {
  const history = new MetricsHistory({ historyWindowMs: 60000, sampleIntervalMs: 10000 });
  history.record(snapshot());

  const samples = history.getSamples();
  samples.push('tampered');

  assert.equal(history.getSamples().length, 1);
});
