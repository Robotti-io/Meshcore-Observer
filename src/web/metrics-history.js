/**
 * Bounded in-memory ring buffer of periodic ServiceHealth samples, used to
 * draw trend charts on the metrics dashboard. Deliberately not persisted -
 * AGENTS.md prohibits a database/persistence library in v1, and history is
 * only ever a convenience for the live UI, not a source of truth.
 */
export class MetricsHistory {
  #capacity;
  #samples = [];

  /**
   * @param {{historyWindowMs: number, sampleIntervalMs: number}} options
   */
  constructor({ historyWindowMs, sampleIntervalMs }) {
    this.#capacity = Math.max(1, Math.ceil(historyWindowMs / sampleIntervalMs));
  }

  /**
   * Derives a compact sample from a full ServiceHealth.snapshot() and
   * appends it, evicting the oldest sample once at capacity.
   *
   * @param {ReturnType<import('../health/service-health.js').ServiceHealth['snapshot']>} snapshot
   */
  record(snapshot) {
    const mqttStates = Object.values(snapshot.mqtt);

    this.#samples.push({
      timestamp: new Date(),
      packetsReceived: snapshot.packetsReceived,
      packetsPublished: snapshot.packetsPublished,
      packetsByType: { ...snapshot.packetsByType },
      radioConnected: snapshot.radioConnected,
      brokersConnected: mqttStates.filter((state) => state.connected).length,
      brokersTotal: mqttStates.length,
      botsReady: snapshot.bots.filter((bot) => bot.ready).length,
      botsTotal: snapshot.bots.length
    });

    if (this.#samples.length > this.#capacity) {
      this.#samples.shift();
    }
  }

  /** @returns {object[]} samples in chronological order (oldest first). */
  getSamples() {
    return [...this.#samples];
  }
}
