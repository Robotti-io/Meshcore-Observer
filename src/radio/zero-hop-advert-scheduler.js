const DEFAULT_POLL_INTERVAL_MS = 250;
const MINUTE_MS = 60 * 1000;
const COMMAND_TIMEOUT_MS = 5000;

/**
 * Sends one zero-hop advert after the first radio connection, then repeats
 * from each completed attempt on the configured cadence. A single pending
 * due time is retained while disconnected or waiting for quiet air.
 */
export class ZeroHopAdvertScheduler {
  #radioManager;
  #airtimeCoordinator;
  #logger;
  #intervalMs;
  #pollIntervalMs;
  #now;
  #timer = null;
  #running = false;
  #connected = false;
  #busy = false;
  #startupRequested = false;
  #nextDueAt = null;
  #inflight = null;
  #onConnected;
  #onDisconnected;

  /** @param {{radioManager: object, airtimeCoordinator: object, logger: object, intervalMinutes: number, pollIntervalMs?: number, now?: () => number}} options */
  constructor({ radioManager, airtimeCoordinator, logger, intervalMinutes, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, now = () => Date.now() }) {
    this.#radioManager = radioManager;
    this.#airtimeCoordinator = airtimeCoordinator;
    this.#logger = logger;
    this.#intervalMs = intervalMinutes * MINUTE_MS;
    this.#pollIntervalMs = pollIntervalMs;
    this.#now = now;
    this.#onConnected = () => {
      this.#connected = true;
      if (!this.#startupRequested) {
        this.#startupRequested = true;
        this.#nextDueAt = this.#now();
        this.#logger.info('services.zeroHopAdvert', 'startup zero-hop advert requested');
      }
      this.#ensureTimer();
    };
    this.#onDisconnected = () => {
      this.#connected = false;
    };
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#radioManager.on('radio.connected', this.#onConnected);
    this.#radioManager.on('radio.disconnected', this.#onDisconnected);
    this.#ensureTimer();
  }

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
    if (!this.#running || this.#busy || !this.#connected
      || this.#nextDueAt === null || this.#now() < this.#nextDueAt) return;

    this.#busy = true;
    try {
      const attempt = this.#airtimeCoordinator.tryRunWhenQuiet(async () => {
        if (!this.#running || !this.#connected) return;
        try {
          await this.#radioManager.runCommand(
            (connection) => connection.sendZeroHopAdvert(),
            { timeoutMs: COMMAND_TIMEOUT_MS }
          );
          this.#logger.info('services.zeroHopAdvert', 'zero-hop advert accepted by Companion');
        } catch (error) {
          this.#logger.warn('services.zeroHopAdvert', 'zero-hop advert command failed', { error: error.message });
        } finally {
          this.#nextDueAt = this.#intervalMs > 0 ? this.#now() + this.#intervalMs : null;
        }
      });
      if (attempt) {
        this.#inflight = attempt.finally(() => {
          this.#inflight = null;
        });
        await this.#inflight;
      }
    } catch (error) {
      this.#logger.error('services.zeroHopAdvert', 'scheduler tick failed', { error: error.message });
    } finally {
      this.#busy = false;
    }
  }
}
