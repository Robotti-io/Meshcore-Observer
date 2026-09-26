/**
 * Aggregates internal health state from the radio, MQTT, packet, channel
 * bot, and reply-queue services into one queryable snapshot (see
 * docs/project_plan.spec.md Section 23, evolved from a single echoBot
 * object to a `bots` array to match the multi-bot architecture). This
 * module only builds the data; it stays HTTP-agnostic. The optional,
 * env-flag-gated metrics dashboard in src/web/ (see metrics-server.js) is
 * the sole current consumer of snapshot().
 *
 * Cumulative counters (reconnects, packets, per-broker last-connected time)
 * are tracked via events as they happen; point-in-time state (is the radio
 * connected right now, what state is each broker in right now) is always
 * read fresh from its source at snapshot() time, so it can never drift out
 * of sync with reality.
 */
const DEFAULT_REPLY_QUEUE_STATS = { size: 0 };

export class ServiceHealth {
  #now;
  #startedAt;
  #radioManager;
  #mqttManager;
  #bots;
  #replyQueue;

  #radioLastConnectedAt = null;
  #radioReconnectCount = 0;
  #hasConnectedOnce = false;
  #packetsReceived = 0;
  #packetsDecoded = 0;
  // Keyed by the decoded packet's `packet_type` string (the MeshCore
  // PAYLOAD_TYPE_* numeric code from @liamcottle/meshcore.js, e.g. "4" for
  // ADVERT) - human-readable labels are a display-layer concern, not this
  // module's.
  #packetsByType = new Map();
  #mqttLastConnectedAt = new Map();
  // Cumulative, per-broker outcome counts for actual publish *attempts*
  // (sent/skipped/failed) - fed externally via recordPublishResults(), not
  // inferred from the packet pipeline (see docs/Code Review - 2026-09-22.md
  // item 4: entering the pipeline is not the same as reaching a broker).
  #brokerDeliveries = new Map();

  /**
   * @param {{radioManager: object, mqttManager: object, packetPipeline: object, bots: {name: string, enabled: boolean, bot: object}[], replyQueue?: {getStats: () => object}, now?: () => Date}} options
   * `bots` is a list of every configured channel bot (see channel-bot.js),
   * each paired with whether it's enabled - a bot instance still exists but
   * is never started when disabled, so `enabled` can't be read off it.
   * `replyQueue` (see reply-queue.js) defaults to an all-zero stats stub
   * so callers that don't care about queue metrics (e.g. most tests)
   * don't need to construct a real one.
   */
  constructor({
    radioManager,
    mqttManager,
    packetPipeline,
    bots,
    replyQueue = { getStats: () => DEFAULT_REPLY_QUEUE_STATS },
    now = () => new Date()
  }) {
    this.#now = now;
    this.#startedAt = now();
    this.#radioManager = radioManager;
    this.#mqttManager = mqttManager;
    this.#bots = bots;
    this.#replyQueue = replyQueue;

    radioManager.on('radio.connected', () => {
      this.#radioLastConnectedAt = this.#now();
      if (this.#hasConnectedOnce) {
        this.#radioReconnectCount += 1;
      }
      this.#hasConnectedOnce = true;
    });
    radioManager.on('radio.packet', () => {
      this.#packetsReceived += 1;
    });
    packetPipeline.on('packet', (packet) => {
      this.#packetsDecoded += 1;
      this.#packetsByType.set(packet.packet_type, (this.#packetsByType.get(packet.packet_type) ?? 0) + 1);
    });
    mqttManager.on('broker.connected', (brokerId) => {
      this.#mqttLastConnectedAt.set(brokerId, this.#now());
    });
  }

  /**
   * Records the outcome of one actual publish attempt per configured
   * broker - called externally (see index.js) once ObserverPublisher's
   * publish call resolves, rather than inferred from the packet pipeline.
   *
   * @param {{brokerId: string, outcome: 'sent'|'skipped'|'failed'}[]} results
   */
  recordPublishResults(results) {
    for (const { brokerId, outcome } of results) {
      const counts = this.#brokerDeliveries.get(brokerId) ?? { sent: 0, skipped: 0, failed: 0 };
      counts[outcome] += 1;
      this.#brokerDeliveries.set(brokerId, counts);
    }
  }

  snapshot() {
    const mqtt = {};
    for (const [brokerId, state] of Object.entries(this.#mqttManager.getStates())) {
      mqtt[brokerId] = {
        connected: state === 'connected',
        lastConnectedAt: this.#mqttLastConnectedAt.get(brokerId) ?? null,
        // Copied, not the #brokerDeliveries Map's own object: that object is
        // mutated in place by future recordPublishResults() calls, so a
        // caller holding onto an earlier snapshot (e.g. metrics-sample.js's
        // computeSampleDelta, which diffs this tick's snapshot against the
        // previous tick's) must see this point in time, not whatever the
        // counts have grown to by the time it reads them.
        deliveries: { ...(this.#brokerDeliveries.get(brokerId) ?? { sent: 0, skipped: 0, failed: 0 }) }
      };
    }

    return {
      startedAt: this.#startedAt,
      radioConnected: this.#radioManager.isConnected(),
      radioLastConnectedAt: this.#radioLastConnectedAt,
      radioReconnectCount: this.#radioReconnectCount,
      packetsReceived: this.#packetsReceived,
      packetsDecoded: this.#packetsDecoded,
      packetsByType: Object.fromEntries(this.#packetsByType),
      mqtt,
      bots: this.#bots.map(({ name, enabled, bot }) => ({
        name,
        enabled,
        ready: bot.isReady(),
        repliesSent: bot.getRepliesSent(),
        repeatsConfirmed: bot.getRepeatsConfirmed(),
        repeatsUnconfirmed: bot.getRepeatsUnconfirmed()
      })),
      replyQueue: this.#replyQueue.getStats()
    };
  }
}
