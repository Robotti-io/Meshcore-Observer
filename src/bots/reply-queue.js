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
  #stopped = false;
  #recordOutcome;

  /**
   * @param {{quietMs: number, ttlMs: number, logger: object, dispatch: (item: object) => Promise<void>, pollIntervalMs?: number, now?: () => number, recordOutcome?: (event: object) => void}} options
   * `recordOutcome`, when given, is called once per item for every way it
   * can be resolved - 'sent', 'failed', 'expired', or 'cancelled' (see
   * #tick()/stop()) - so a persistence layer (see src/metrics/store.js's
   * recordBotReplyEvent) can build a full reply-lifecycle history, not just
   * a count of successes. This queue is the only component that knows both
   * an item's enqueue time and its eventual outcome, so it - not ChannelBot -
   * is the single place that records this.
   */
  constructor({
    quietMs,
    ttlMs,
    logger,
    dispatch,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = () => Date.now(),
    recordOutcome = () => {}
  }) {
    this.#quietMs = quietMs;
    this.#ttlMs = ttlMs;
    this.#logger = logger;
    this.#dispatch = dispatch;
    this.#pollIntervalMs = pollIntervalMs;
    this.#now = now;
    this.#recordOutcome = recordOutcome;
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
    if (this.#stopped) {
      this.#logger.debug('bots.replyQueue', 'ignored an enqueue after the reply queue was stopped', {
        bot: item.botName,
        trigger: item.trigger
      });
      return;
    }

    const enqueuedAt = this.#now();
    this.#items.push({ ...item, enqueuedAt, expiresAt: enqueuedAt + this.#ttlMs });

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
   * A point-in-time snapshot of live queue depth, for the dashboard's
   * "Reply queue" section (see ServiceHealth). Lifetime sent/failed/
   * expired/cancelled counters used to live here too, but as plain
   * in-memory counters they reset on every restart - that history is now
   * persisted instead via recordOutcome (see src/metrics/store.js's
   * getReplyOutcomeTotals), which survives restarts and is what the
   * dashboard actually reads for those tiles.
   *
   * @returns {{size: number}}
   */
  getStats() {
    return { size: this.#items.length };
  }

  /**
   * Idempotent: stops accepting new enqueue() calls and drops every reply
   * still waiting for a quiet window, without attempting to send them.
   *
   * Policy: cancel outright rather than drain or force an immediate send.
   * This queue exists to let a *triggering* message's own flood propagation
   * settle before adding new channel traffic (see the class doc comment);
   * during shutdown, the radio connection and MQTT brokers are also about
   * to close (see index.js's shutdown()), so there is no guarantee a queued
   * item could finish waiting for a quiet window - or even finish sending -
   * before those close underneath it. That matches this queue's existing
   * "unsent beats stale" philosophy for TTL expiry, just recorded as its
   * own 'cancelled' outcome (see recordOutcome) rather than folded into
   * 'expired'.
   *
   * Waits for a send already in flight (started by a previous #tick()) to
   * finish first, so shutdown doesn't race that send against radioManager/
   * mqttManager closing underneath it.
   */
  async stop() {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;

    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    const cancelled = this.#items.splice(0);
    const occurredAt = this.#now();
    for (const item of cancelled) {
      this.#logger.warn('bots.replyQueue', 'dropped a queued reply on shutdown before it could be sent', {
        bot: item.botName,
        channel: item.channel,
        trigger: item.trigger,
        sender: item.sender
      });
      this.#safeRecordOutcome({ ...item, outcome: 'cancelled', occurredAt, queuedMs: occurredAt - item.enqueuedAt });
    }

    while (this.#sending) {
      await new Promise((resolve) => setTimeout(resolve, this.#pollIntervalMs));
    }
  }

  /**
   * Wraps the injected recordOutcome hook so a metrics-persistence failure
   * can never propagate out of #tick()/stop() and disrupt actually sending,
   * expiring, or cancelling a reply - mirrors the same guarantee
   * channel-bot.js's recordBotCommand call used to make on its own behalf
   * before this responsibility moved here.
   */
  #safeRecordOutcome({ botName, trigger, sender, hash, outcome, occurredAt, queuedMs }) {
    try {
      this.#recordOutcome({ botName, trigger, sender, hash, outcome, occurredAt, queuedMs });
    } catch (err) {
      this.#logger.warn('bots.replyQueue', 'failed to record a reply outcome for metrics', {
        bot: botName,
        trigger,
        outcome,
        error: err.message
      });
    }
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
      const occurredAt = this.#now();
      this.#logger.warn('bots.replyQueue', 'dropped a queued reply that expired before a quiet sending window', {
        bot: expired.botName,
        channel: expired.channel,
        trigger: expired.trigger,
        sender: expired.sender,
        queuedForMs: occurredAt - expired.enqueuedAt
      });
      this.#safeRecordOutcome({ ...expired, outcome: 'expired', occurredAt, queuedMs: occurredAt - expired.enqueuedAt });
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
    // Captured before the send attempt: queuedMs measures time waiting in
    // the queue, not how long the send itself took.
    const dispatchStartedAt = this.#now();
    try {
      await this.#dispatch(next);
      this.#safeRecordOutcome({ ...next, outcome: 'sent', occurredAt: this.#now(), queuedMs: dispatchStartedAt - next.enqueuedAt });
    } catch (err) {
      this.#logger.warn('bots.replyQueue', 'failed to send a queued reply', {
        bot: next.botName,
        channel: next.channel,
        trigger: next.trigger,
        sender: next.sender,
        error: err.message
      });
      this.#safeRecordOutcome({ ...next, outcome: 'failed', occurredAt: this.#now(), queuedMs: dispatchStartedAt - next.enqueuedAt });
    } finally {
      this.#sending = false;
      if (this.#items.length === 0 && this.#timer) {
        clearInterval(this.#timer);
        this.#timer = null;
      }
    }
  }
}
