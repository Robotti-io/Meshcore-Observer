import { test } from 'vitest';
import assert from 'node:assert/strict';
import { StatsReporter } from '../../src/metrics/stats-reporter.js';

function fakeStore({ received = 0, decoded = 0, sent = 0, repeatersHeard = 0, earliestSampleAt = null } = {}) {
  const calls = [];
  return {
    calls,
    queryPacketTotals: (range) => {
      calls.push({ method: 'queryPacketTotals', range });
      return { received, decoded };
    },
    queryReplyOutcomeTotals: (range) => {
      calls.push({ method: 'queryReplyOutcomeTotals', range });
      return { sent, failed: 0, expired: 0, cancelled: 0 };
    },
    countActiveNodesInRange: (range) => {
      calls.push({ method: 'countActiveNodesInRange', range });
      return repeatersHeard;
    },
    getEarliestSampleAt: () => earliestSampleAt
  };
}

test('summarize() combines packet totals, sent replies, and active repeaters over the given range', () => {
  const store = fakeStore({ received: 142, decoded: 98, sent: 3, repeatersHeard: 2 });
  const reporter = new StatsReporter({ store });

  const summary = reporter.summarize({ start: 1000, end: 2000 });

  assert.deepEqual(summary, { packetsReceived: 142, packetsDecoded: 98, repliesSent: 3, repeatersHeard: 2 });
  assert.deepEqual(
    store.calls.map((c) => c.method).sort(),
    ['countActiveNodesInRange', 'queryPacketTotals', 'queryReplyOutcomeTotals']
  );
  for (const call of store.calls) {
    assert.equal(call.range.start, 1000);
    assert.equal(call.range.end, 2000);
  }
});

test('scopes the repeaters-heard query to type REPEATER', () => {
  let capturedType;
  const store = fakeStore();
  store.countActiveNodesInRange = ({ type }) => {
    capturedType = type;
    return 0;
  };
  new StatsReporter({ store }).summarize({ start: 0, end: 1 });
  assert.equal(capturedType, 'REPEATER');
});

test('earliestSampleAt() passes through the store value', () => {
  const store = fakeStore({ earliestSampleAt: 12345 });
  assert.equal(new StatsReporter({ store }).earliestSampleAt(), 12345);
});
