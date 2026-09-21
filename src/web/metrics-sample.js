import { bucketPacketsByType } from './packet-type-buckets.js';

/**
 * Diffs a tick's cumulative ServiceHealth snapshot against the previous
 * tick's to get this interval's deltas - the store persists per-interval
 * activity, not running totals, so range queries can sum sample rows
 * meaningfully (see docs/plans/feat-improved_metrics_reporting.md). Raw
 * packet-type deltas are re-keyed into the dashboard's fixed 8-category
 * scheme. Point-in-time gauges (radioConnected, broker/bot counts) are
 * carried through as-is, not diffed.
 *
 * With no prior snapshot (the first tick since process start), the deltas
 * equal the cumulative totals themselves, since every ServiceHealth
 * counter started at zero.
 *
 * Pulled out of MetricsServer as a pure function so its delta arithmetic
 * can be unit tested directly, without depending on real timer intervals.
 *
 * @param {{prevSnapshot: object|null, snapshot: object, sampleAt: number, intervalMs: number}} options
 * @returns {object} shaped for MetricsStore#recordPacketSample.
 */
export function computeSampleDelta({ prevSnapshot, snapshot, sampleAt, intervalMs }) {
  const packetsReceived = snapshot.packetsReceived - (prevSnapshot?.packetsReceived ?? 0);
  const packetsPublished = snapshot.packetsPublished - (prevSnapshot?.packetsPublished ?? 0);

  const packetsByTypeDelta = {};
  for (const [code, count] of Object.entries(snapshot.packetsByType)) {
    const delta = count - (prevSnapshot?.packetsByType?.[code] ?? 0);
    if (delta > 0) {
      packetsByTypeDelta[code] = delta;
    }
  }

  const mqttStates = Object.values(snapshot.mqtt);

  return {
    sampleAt,
    intervalMs,
    packetsReceived,
    packetsPublished,
    radioConnected: snapshot.radioConnected,
    brokersConnected: mqttStates.filter((state) => state.connected).length,
    brokersTotal: mqttStates.length,
    botsReady: snapshot.bots.filter((bot) => bot.ready).length,
    botsTotal: snapshot.bots.length,
    packetsByType: bucketPacketsByType(packetsByTypeDelta)
  };
}
