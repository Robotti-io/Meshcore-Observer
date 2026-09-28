/**
 * Thin read-only wrapper around MetricsStore for the !stats bot command,
 * mirroring how NodeRegistry sits between ChannelBot and the store for
 * !lookup - ChannelBot never queries MetricsStore directly.
 */
export class StatsReporter {
  #store;

  constructor({ store }) {
    this.#store = store;
  }

  /**
   * @param {{start: number, end: number}} range
   * @returns {{packetsReceived: number, packetsDecoded: number, repliesSent: number, repeatersHeard: number}}
   */
  summarize({ start, end }) {
    const { received, decoded } = this.#store.queryPacketTotals({ start, end });
    const { sent } = this.#store.queryReplyOutcomeTotals({ start, end });
    const repeatersHeard = this.#store.countActiveNodesInRange({ start, end, type: 'REPEATER' });

    return { packetsReceived: received, packetsDecoded: decoded, repliesSent: sent, repeatersHeard };
  }

  /** Earliest timestamp still in the store, or null if nothing's been sampled yet - see resolveStatsRange's "all". */
  earliestSampleAt() {
    return this.#store.getEarliestSampleAt();
  }
}
