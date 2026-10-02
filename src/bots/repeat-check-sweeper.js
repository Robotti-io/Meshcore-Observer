const DEFAULT_SWEEP_INTERVAL_MS = 1000;

/**
 * Periodically asks every enabled channel bot to expire timed-out repeat
 * checks. One shared, unreferenced timer avoids per-reply timer growth and
 * lets timeout accounting progress on otherwise quiet channels.
 */
export class RepeatCheckSweeper {
  #bots;
  #logger;
  #intervalMs;
  #setInterval;
  #clearInterval;
  #timer = null;

  /**
   * @param {{bots: {name: string, enabled: boolean, bot: {sweepRepeatChecks: () => number}}[], logger: object, intervalMs?: number, setIntervalFn?: typeof setInterval, clearIntervalFn?: typeof clearInterval}} options
   */
  constructor({
    bots,
    logger,
    intervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  }) {
    this.#bots = bots;
    this.#logger = logger;
    this.#intervalMs = intervalMs;
    this.#setInterval = setIntervalFn;
    this.#clearInterval = clearIntervalFn;
  }

  /** Idempotently starts one timer when at least one bot is enabled. */
  start() {
    if (this.#timer || !this.#bots.some(({ enabled }) => enabled)) {
      return;
    }
    this.#timer = this.#setInterval(() => this.#sweep(), this.#intervalMs);
    this.#timer.unref();
  }

  /** Idempotently stops the shared timer. */
  stop() {
    if (!this.#timer) {
      return;
    }
    this.#clearInterval(this.#timer);
    this.#timer = null;
  }

  #sweep() {
    for (const { name, enabled, bot } of this.#bots) {
      if (!enabled) {
        continue;
      }
      try {
        bot.sweepRepeatChecks();
      } catch (err) {
        this.#logger.error('bots.repeatCheckSweeper', 'failed to sweep bot repeat checks', {
          bot: name,
          error: err.message
        });
      }
    }
  }
}
