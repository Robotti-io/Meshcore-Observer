const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * A single FIFO queue of pending bot replies, shared across every
 * configured ChannelBot - "the local frequency" is one physical radio, so
 * quiet-window detection and ordering only make sense as one shared
 * resource, not per-bot state (see docs/plans and README's "Channel
 * bots" section for the full rationale).
 *
 * Backed by MetricsStore's `bot_replies` table (see
 * enqueueReplyItem/countPendingReplyItems/takeExpiredReplyItems/
 * peekOldestPendingReplyItem/resolveReplyItem there) rather than an
 * in-memory array - persisted state is a core observer capability now,
 * independent of the optional HTTP dashboard (see AGENTS.md's
 * "Persistence" section). A single row covers a reply's whole lifecycle,
 * from enqueue (`status: 'pending'`) through resolution
 * (`status: 'sent'|'failed'|'expired'`), so this queue's own history *is*
 * the dashboard's reply-lifecycle metrics - there's no separate event log
 * to keep in sync. This also means a pending reply survives a restart:
 * `start()` resumes ticking if anything was already pending when this
 * process started, and a resumed item whose `expiresAt` (a fixed point in
 * time set at the original enqueue) has already passed is simply expired
 * on the first tick, the same as it would have been if the process had
 * never stopped - see takeExpiredReplyItems' own doc comment.
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
 * replies out - TTL alone bounds how long a backup can grow. Unlike
 * `expiresAt`, "channel busy right now" has no meaningful value to
 * persist across a restart, so `#lastActivityAt` stays in-memory,
 * defaulting to "just active" at construction (see the constructor).
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
  #store;
  #lastActivityAt;
  #timer = null;
  #sending = false;
  #stopped = false;

  /**
   * @param {{quietMs: number, ttlMs: number, logger: object, dispatch: (item: object) => Promise<void>, store: object, pollIntervalMs?: number, now?: () => number}} options
   * `store` is required (typically the app's single MetricsStore instance -
   * see src/index.js) - it's both this queue's persistence and its
   * reply-lifecycle history now (see the class doc comment), not an
   * optional side channel.
   */
  constructor({ quietMs, ttlMs, logger, dispatch, store, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, now = () => Date.now() }) {
    this.#quietMs = quietMs;
    this.#ttlMs = ttlMs;
    this.#logger = logger;
    this.#dispatch = dispatch;
    this.#store = store;
    this.#pollIntervalMs = pollIntervalMs;
    this.#now = now;
    // Assumed just-active at construction, so the very first possible send
    // still requires observing a real quiet window from process start,
    // rather than firing immediately before any channel activity has
    // actually been observed - true whether or not resumed items exist.
    this.#lastActivityAt = now();
  }

  /**
   * Resumes polling if anything persisted from a previous process is
   * already pending - without this, a queue that starts fresh empty (the
   * common case) stays idle until the next enqueue() starts the timer,
   * exactly as before; a queue that starts with resumed work needs its
   * timer running immediately so expiry/dispatch can proceed without
   * waiting for a new trigger to arrive over the air. Safe to call even
   * when nothing is pending (a no-op) or after stop() (also a no-op).
   */
  start() {
    if (this.#stopped || this.#timer) {
      return;
    }
    if (this.#store.countPendingReplyItems() > 0) {
      this.#startTimer();
    }
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
    this.#store.enqueueReplyItem({ ...item, enqueuedAt, expiresAt: enqueuedAt + this.#ttlMs });
    this.#startTimer();
  }

  #startTimer() {
    if (!this.#timer) {
      this.#timer = setInterval(() => this.#tick(), this.#pollIntervalMs);
      this.#timer.unref();
    }
  }

  /** Number of replies currently queued (for tests/diagnostics). */
  get size() {
    return this.#store.countPendingReplyItems();
  }

  /**
   * A point-in-time snapshot of live queue depth, for the dashboard's
   * "Reply queue" section (see ServiceHealth). Lifetime sent/failed/
   * expired totals are queried back out of the same store instead (see
   * MetricsStore#queryReplyOutcomeTotals), which survives restarts the
   * way an in-memory counter can't.
   *
   * @returns {{size: number}}
   */
  getStats() {
    return { size: this.#store.countPendingReplyItems() };
  }

  /**
   * Idempotent: stops accepting new enqueue() calls and stops polling.
   * Pending items are deliberately left in the store, untouched - a
   * clean shutdown no longer drops them (see the class doc comment on
   * restart resumption); a fresh ReplyQueue's start() picks them back up
   * on the next run, and anything that's gone stale in the meantime
   * simply expires on that run's first tick instead.
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

    while (this.#sending) {
      await new Promise((resolve) => setTimeout(resolve, this.#pollIntervalMs));
    }
  }

  /**
   * Marks one dispatched item resolved. A failure here is logged as loudly
   * as possible rather than silently swallowed: unlike the old separate
   * recordOutcome hook (purely a metrics side-channel), this call is what
   * actually moves the row out of `status: 'pending'` - if it fails, the
   * item stays pending and a future tick will pick it up again, which for
   * an already-successfully-dispatched item means a real risk of a
   * duplicate send. That risk is accepted as a rare, honestly-logged edge
   * case (see MetricsStore#peekOldestPendingReplyItem's own doc comment)
   * rather than building compensating machinery for what should only ever
   * happen if the store itself is in serious trouble.
   */
  #resolve(item, status, occurredAt) {
    try {
      this.#store.resolveReplyItem(item.id, { status, resolvedAt: occurredAt, queuedMs: occurredAt - item.enqueuedAt });
    } catch (err) {
      this.#logger.warn('bots.replyQueue', 'failed to mark a reply resolved - it may be re-dispatched (and duplicated) on a future tick', {
        bot: item.botName,
        trigger: item.trigger,
        status,
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

    const now = this.#now();

    // Expiring stale items first (rather than a separate sweep) covers
    // both normal operation and a resumed item that went stale while this
    // process was down - see takeExpiredReplyItems' own doc comment.
    const expired = this.#store.takeExpiredReplyItems(now);
    for (const item of expired) {
      this.#logger.warn('bots.replyQueue', 'dropped a queued reply that expired before a quiet sending window', {
        bot: item.botName,
        channel: item.channel,
        trigger: item.trigger,
        sender: item.sender,
        queuedForMs: now - item.enqueuedAt
      });
    }

    if (this.#store.countPendingReplyItems() === 0) {
      clearInterval(this.#timer);
      this.#timer = null;
      return;
    }

    if (now - this.#lastActivityAt < this.#quietMs) {
      return; // still within a busy/recently-active window - try again next tick
    }

    const next = this.#store.peekOldestPendingReplyItem();
    if (!next) {
      return; // raced with the empty-check above (e.g. a concurrent expiry) - try again next tick
    }

    this.#sending = true;
    // Reset the clock immediately, not after the send resolves, so a
    // concurrent tick can't also treat the channel as still quiet while
    // our own transmission is in flight.
    this.noteActivity();
    try {
      await this.#dispatch(next);
      this.#resolve(next, 'sent', this.#now());
    } catch (err) {
      this.#logger.warn('bots.replyQueue', 'failed to send a queued reply', {
        bot: next.botName,
        channel: next.channel,
        trigger: next.trigger,
        sender: next.sender,
        error: err.message
      });
      this.#resolve(next, 'failed', this.#now());
    } finally {
      this.#sending = false;
      if (this.#store.countPendingReplyItems() === 0 && this.#timer) {
        clearInterval(this.#timer);
        this.#timer = null;
      }
    }
  }
}
