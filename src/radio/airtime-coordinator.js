/**
 * Coordinates outbound radio transmissions around one observed quiet-air
 * window. Activity is inferred from radio.packet events because the
 * Companion connection does not expose channel energy detection/CAD.
 */
export class AirtimeCoordinator {
  #quietMs;
  #now;
  #lastActivityAt;
  #sending = false;

  /** @param {{quietMs: number, now?: () => number}} options */
  constructor({ quietMs, now = () => Date.now() }) {
    this.#quietMs = quietMs;
    this.#now = now;
    this.#lastActivityAt = now();
  }

  /** Marks an observed RF reception as channel activity. */
  noteActivity() {
    this.#lastActivityAt = this.#now();
  }

  /**
   * Starts one outbound operation if the shared channel has been quiet long
   * enough and no other transmission owns the reservation. Returns null
   * when a caller should retry on its next normal poll tick.
   *
   * The reservation is acquired synchronously before the operation begins,
   * so competing queues cannot both claim one quiet window. It is released
   * when the operation settles, even on failure.
   *
   * @template T
   * @param {() => Promise<T>} send
   * @returns {Promise<T>|null}
   */
  tryRunWhenQuiet(send) {
    if (this.#sending || this.#now() - this.#lastActivityAt < this.#quietMs) {
      return null;
    }

    this.#sending = true;
    this.noteActivity();
    return Promise.resolve()
      .then(send)
      .finally(() => {
        this.#sending = false;
      });
  }
}
