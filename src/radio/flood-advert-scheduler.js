const DEFAULT_POLL_INTERVAL_MS = 250;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Sends the Companion's own flood advert once per process start and then
 * on the configured cadence. One durable pending slot coalesces requests
 * across busy-air windows, disconnects, and process restarts.
 */
export class FloodAdvertScheduler {
  #radioManager;
  #airtimeCoordinator;
  #store;
  #logger;
  #intervalMs;
  #pollIntervalMs;
  #now;
  #timer = null;
  #running = false;
  #connected = false;
  #busy = false;
  #startupRequested = false;
  #inflight = null;
  #onConnected;
  #onDisconnected;

  /** @param {{radioManager: object, airtimeCoordinator: object, store: object, logger: object, intervalHours: number, pollIntervalMs?: number, now?: () => number}} options */
  constructor({ radioManager, airtimeCoordinator, store, logger, intervalHours, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, now = () => Date.now() }) {
    this.#radioManager = radioManager;
    this.#airtimeCoordinator = airtimeCoordinator;
    this.#store = store;
    this.#logger = logger;
    this.#intervalMs = intervalHours * HOUR_MS;
    this.#pollIntervalMs = pollIntervalMs;
    this.#now = now;
    this.#onConnected = () => {
      this.#connected = true;
      if (!this.#startupRequested) {
        this.#startupRequested = true;
        const state = this.#store.getFloodAdvertState();
        if (state.status !== 'pending') {
          this.#store.requestFloodAdvert(this.#now());
        }
        this.#logger.info('services.floodAdvert', 'startup flood advert requested');
      }
      this.#ensureTimer();
    };
    this.#onDisconnected = () => {
      this.#connected = false;
    };
  }

  /** Starts recovery and listens for radio lifecycle events. */
  start() {
    if (this.#running) return;
    this.#running = true;
    const recovered = this.#store.recoverFloodAdvertAttempt({
      intervalMs: this.#intervalMs,
      uncertainAttemptIntervalMs: Math.max(this.#intervalMs, 3 * HOUR_MS)
    });
    if (recovered) {
      this.#logger.warn('services.floodAdvert', 'recovered an interrupted flood advert attempt; retry deferred');
    }
    this.#radioManager.on('radio.connected', this.#onConnected);
    this.#radioManager.on('radio.disconnected', this.#onDisconnected);
    this.#ensureTimer();
  }

  /** Stops scheduling and waits for an already-issued Companion command. */
  async stop() {
    if (!this.#running) return;
    this.#running = false;
    this.#radioManager.off('radio.connected', this.#onConnected);
    this.#radioManager.off('radio.disconnected', this.#onDisconnected);
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#inflight;
  }

  #ensureTimer() {
    if (!this.#running || this.#timer) return;
    this.#timer = setInterval(() => this.#tick(), this.#pollIntervalMs);
    this.#timer.unref();
  }

  async #tick() {
    if (!this.#running || this.#busy) return;
    this.#busy = true;
    try {
      let state = this.#store.getFloodAdvertState();
      if (state.status === 'idle' && this.#intervalMs > 0 && state.nextDueAt !== null && this.#now() >= state.nextDueAt) {
        state = this.#store.requestFloodAdvert(this.#now());
      }
      if (!this.#connected || state.status !== 'pending' || (state.nextDueAt !== null && this.#now() < state.nextDueAt)) {
        return;
      }

      const attempt = this.#airtimeCoordinator.tryRunWhenQuiet(async () => {
        if (!this.#running || !this.#connected || !this.#store.startFloodAdvertAttempt(this.#now())) return;
        try {
          await this.#radioManager.runCommand((connection) => connection.sendFloodAdvert());
          this.#store.resolveFloodAdvertAttempt({ resolvedAt: this.#now(), intervalMs: this.#intervalMs, sent: true });
          this.#logger.info('services.floodAdvert', 'flood advert accepted by Companion');
        } catch (err) {
          this.#store.resolveFloodAdvertAttempt({ resolvedAt: this.#now(), intervalMs: this.#intervalMs, sent: false });
          this.#logger.warn('services.floodAdvert', 'flood advert command failed', { error: err.message });
        }
      });
      if (attempt) {
        this.#inflight = attempt.finally(() => {
          this.#inflight = null;
        });
        await this.#inflight;
      }
    } catch (err) {
      this.#logger.error('services.floodAdvert', 'scheduler tick failed', { error: err.message });
    } finally {
      this.#busy = false;
    }
  }
}
