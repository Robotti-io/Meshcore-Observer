const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * A single FIFO queue of pending bot replies, shared across every
 * configured ChannelBot - "the local frequency" is one physical radio, so
 * quiet-window detection and ordering only make sense as one shared
 * resource, not per-bot state (see docs/plans and README's "Channel
 * bots" section for the full rationale).
 *
 * There is no channel-energy/CAD reading exposed to this companion app,
 * only "have we heard any RF packet recently" - so "quiet" is inferred
 * from the time since the last observed activity. `noteActivity()` must
 * be called for every heard `radio.packet` (regardless of which logical
 * MeshCore channel it's on - the physical RF channel is shared across
 * all of them) AND is called internally whenever this queue sends
 * something itself, since our own transmission occupies the same shared
 * channel and the next queued item must wait its own fresh quiet window
 * afterward. That self-reset is what makes an unbounded queue safe
 * without a size cap: the drain rate is inherently bounded to roughly
 * one reply per quiet period no matter how many are queued, so a burst
 * of triggers can only make the queue back up, never make it burst
 * replies out - TTL alone bounds how long a backup can grow.
 *
 * Queued items are plain data (see enqueue()), never callbacks - this
 * keeps the queue directly inspectable/reportable (queued-per-bot,
 * per-command, per-sender, etc.) and keeps "how a reply actually gets
 * sent" in exactly one shared, auditable place: the `dispatch` function
 * given at construction, rather than a different closure created at
 * every enqueue() call site.
 */
export class ReplyQueue {
  #quietMs;
  #ttlMs;
  #pollIntervalMs;
  #logger;
  #dispatch;
  #now;
  #items = [];
  #lastActivityAt;
  #timer = null;
  #sending = false;
  #totalEnqueued = 0;
  #totalSent = 0;
  #totalExpired = 0;
  #totalFailed = 0;

  /**
   * @param {{quietMs: number, ttlMs: number, logger: object, dispatch: (item: object) => Promise<void>, pollIntervalMs?: number, now?: () => number}} options
   */
  constructor({ quietMs, ttlMs, logger, dispatch, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, now = () => Date.now() }) {
    this.#quietMs = quietMs;
    this.#ttlMs = ttlMs;
    this.#logger = logger;
    this.#dispatch = dispatch;
    this.#pollIntervalMs = pollIntervalMs;
    this.#now = now;
    // Assumed just-active at construction, so the very first possible send
    // still requires observing a real quiet window from process start,
    // rather than firing immediately before any channel activity has
    // actually been observed.
    this.#lastActivityAt = now();
  }

  /** Marks the shared channel as busy right now - call for every heard RF packet. */
  noteActivity() {
    this.#lastActivityAt = this.#now();
  }

  /**
   * Queues a reply for later sending once a quiet window is observed.
   * `item` is plain data describing the reply - this queue and its
   * `dispatch` function are the only things that know how to turn it
   * into an actual transmission; nothing here executes caller-supplied
   * code per item.
   *
   * @param {{botName: string, channel: string, trigger: string, sender: string, hopCount: number, path: string, hash: string}} item
   */
  enqueue(item) {
    const enqueuedAt = this.#now();
    this.#items.push({ ...item, enqueuedAt, expiresAt: enqueuedAt + this.#ttlMs });
    this.#totalEnqueued += 1;

    if (!this.#timer) {
      this.#timer = setInterval(() => this.#tick(), this.#pollIntervalMs);
      this.#timer.unref();
    }
  }

  /** Number of replies currently queued (for tests/diagnostics). */
  get size() {
    return this.#items.length;
  }

  /**
   * A point-in-time snapshot of queue depth and lifetime counters, for
   * the dashboard's "Reply queue" section (see ServiceHealth).
   *
   * @returns {{size: number, totalEnqueued: number, totalSent: number, totalExpired: number, totalFailed: number}}
   */
  getStats() {
    return {
      size: this.#items.length,
      totalEnqueued: this.#totalEnqueued,
      totalSent: this.#totalSent,
      totalExpired: this.#totalExpired,
      totalFailed: this.#totalFailed
    };
  }

  async #tick() {
    // A previous tick's send may still be in flight - setInterval doesn't
    // wait for an async callback to resolve before firing again, so this
    // guard prevents two ticks from both deciding the channel is quiet
    // and sending concurrently.
    if (this.#sending) {
      return;
    }

    // FIFO means the oldest item is always at the front, so lazily
    // dropping expired entries here (rather than a separate sweep) is
    // sufficient and keeps this the only place queue state changes.
    while (this.#items.length > 0 && this.#now() >= this.#items[0].expiresAt) {
      const expired = this.#items.shift();
      this.#totalExpired += 1;
      this.#logger.warn('bots.replyQueue', 'dropped a queued reply that expired before a quiet sending window', {
        bot: expired.botName,
        channel: expired.channel,
        trigger: expired.trigger,
        sender: expired.sender,
        queuedForMs: this.#now() - expired.enqueuedAt
      });
    }

    if (this.#items.length === 0) {
      clearInterval(this.#timer);
      this.#timer = null;
      return;
    }

    if (this.#now() - this.#lastActivityAt < this.#quietMs) {
      return; // still within a busy/recently-active window - try again next tick
    }

    const next = this.#items.shift();
    this.#sending = true;
    // Reset the clock immediately, not after the send resolves, so a
    // concurrent tick can't also treat the channel as still quiet while
    // our own transmission is in flight.
    this.noteActivity();
    try {
      await this.#dispatch(next);
      this.#totalSent += 1;
    } catch (err) {
      this.#totalFailed += 1;
      this.#logger.warn('bots.replyQueue', 'failed to send a queued reply', {
        bot: next.botName,
        channel: next.channel,
        trigger: next.trigger,
        sender: next.sender,
        error: err.message
      });
    } finally {
      this.#sending = false;
      if (this.#items.length === 0 && this.#timer) {
        clearInterval(this.#timer);
        this.#timer = null;
      }
    }
  }
}
