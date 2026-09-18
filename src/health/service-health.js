/**
 * Aggregates internal health state from the radio, MQTT, packet, and
 * channel bot services into one queryable snapshot (see
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
export class ServiceHealth {
  #now;
  #startedAt;
  #radioManager;
  #mqttManager;
  #bots;

  #radioLastConnectedAt = null;
  #radioReconnectCount = 0;
  #hasConnectedOnce = false;
  #packetsReceived = 0;
  #packetsPublished = 0;
  // Keyed by the decoded packet's `packet_type` string (the MeshCore
  // PAYLOAD_TYPE_* numeric code from @liamcottle/meshcore.js, e.g. "4" for
  // ADVERT) - human-readable labels are a display-layer concern, not this
  // module's.
  #packetsByType = new Map();
  #mqttLastConnectedAt = new Map();

  /**
   * @param {{radioManager: object, mqttManager: object, packetPipeline: object, bots: {name: string, enabled: boolean, bot: object}[], now?: () => Date}} options
   * `bots` is a list of every configured channel bot (see channel-bot.js),
   * each paired with whether it's enabled - a bot instance still exists but
   * is never started when disabled, so `enabled` can't be read off it.
   */
  constructor({ radioManager, mqttManager, packetPipeline, bots, now = () => new Date() }) {
    this.#now = now;
    this.#startedAt = now();
    this.#radioManager = radioManager;
    this.#mqttManager = mqttManager;
    this.#bots = bots;

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
      this.#packetsPublished += 1;
      this.#packetsByType.set(packet.packet_type, (this.#packetsByType.get(packet.packet_type) ?? 0) + 1);
    });
    mqttManager.on('broker.connected', (brokerId) => {
      this.#mqttLastConnectedAt.set(brokerId, this.#now());
    });
  }

  snapshot() {
    const mqtt = {};
    for (const [brokerId, state] of Object.entries(this.#mqttManager.getStates())) {
      mqtt[brokerId] = {
        connected: state === 'connected',
        lastConnectedAt: this.#mqttLastConnectedAt.get(brokerId) ?? null
      };
    }

    return {
      startedAt: this.#startedAt,
      radioConnected: this.#radioManager.isConnected(),
      radioLastConnectedAt: this.#radioLastConnectedAt,
      radioReconnectCount: this.#radioReconnectCount,
      packetsReceived: this.#packetsReceived,
      packetsPublished: this.#packetsPublished,
      packetsByType: Object.fromEntries(this.#packetsByType),
      mqtt,
      bots: this.#bots.map(({ name, enabled, bot }) => ({
        name,
        enabled,
        ready: bot.isReady(),
        repliesSent: bot.getRepliesSent()
      }))
    };
  }
}
