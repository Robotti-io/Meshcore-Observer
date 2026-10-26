import { compileSchema } from '../validation/ajv.js';
import { configSchema } from '../config/schema.js';

const intervalValid = compileSchema(configSchema.properties.floodAdvert);

/** Refresh local readings and retained status on the advertisement cadence.
 * Requests coalesce while busy; there is no replay queue or RF transmission.
 */
export class ObserverStatusScheduler {
  #radio; #mqtt; #publisher; #logger; #intervalMs;
  #running = false; #timer = null; #inflight = null; #controller = null;
  #generation = null; #publishing = false; #pending = false;
  #onReady;

  constructor({ radioManager, mqttManager, publisher, logger, intervalHours }) {
    if (!intervalValid({ intervalHours })) throw new Error('Invalid observer status interval');
    this.#radio = radioManager; this.#mqtt = mqttManager;
    this.#publisher = publisher; this.#logger = logger; this.#intervalMs = intervalHours * 3600000;
    this.#onReady = () => this.#refresh();
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#radio.on('radio.connected', this.#onReady);
    this.#mqtt.on('broker.connected', this.#onReady);
    if (this.#intervalMs > 0) {
      this.#timer = setInterval(this.#onReady, this.#intervalMs);
      this.#timer.unref();
    }
  }

  async stop() {
    this.#running = false;
    this.#pending = false;
    clearInterval(this.#timer); this.#timer = null;
    this.#radio.off('radio.connected', this.#onReady);
    this.#mqtt.off('broker.connected', this.#onReady);
    this.#controller?.abort();
    await this.#inflight;
  }

  #refresh() {
    if (!this.#running || !this.#mqtt.hasAnyConnected()) return;
    const snapshot = this.#radio.getConnectionSnapshot();
    if (!snapshot.ready) return;
    if (this.#inflight) {
      // A replacement radio or a broker arriving after publication began
      // still needs fresh state. Coalesce into one follow-up, never a queue.
      if (snapshot.generation !== this.#generation || this.#publishing) this.#pending = true;
      return;
    }
    this.#generation = snapshot.generation;
    const controller = new AbortController(); this.#controller = controller;
    this.#inflight = Promise.resolve().then(async () => {
      const fresh = await this.#radio.refreshObserverStatus({ signal: controller.signal });
      if (!fresh || !this.#running || controller.signal.aborted
        || this.#radio.getConnectionSnapshot().generation !== snapshot.generation) return;
      this.#publishing = true;
      const results = await this.#publisher.publishStatus(fresh, 'online');
      const failed = results.some(result => result.outcome === 'failed');
      this.#logger[failed ? 'warn' : 'info']('services.observerStatus',
        failed ? 'observer status refresh had broker failures' : 'observer status refreshed');
    }).catch(() => {
      if (this.#running) this.#logger.warn('services.observerStatus', 'observer status refresh unavailable');
    }).finally(() => {
      this.#inflight = null; this.#controller = null; this.#publishing = false;
      if (this.#pending) { this.#pending = false; this.#refresh(); }
    });
  }
}
