import { performance } from 'node:perf_hooks';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { runtimeEventSchema, readinessSnapshotSchema, runtimeEventBudgetSchema } from './process-schemas.js';

const validateEvent = compileSchema(runtimeEventSchema);
const validateSnapshot = compileSchema(readinessSnapshotSchema);
const validateBudget = compileSchema(runtimeEventBudgetSchema);

/** Selected observed events; rejected/throttled writes never interrupt radio handling. */
export class RuntimeEvents {
  #store; #runId; #logger; #budget; #wall; #mono;
  #radio = null; #listeners = []; #radioState = null; #previous = null; #previousAt = null;
  #attempts = []; #suppressed = 0; #failed = 0; #stopped = false;

  constructor({ store, runId, logger, maxPerMinute = 60, wallNow = Date.now, monotonicNow = () => performance.now() }) {
    if (!validateBudget(maxPerMinute)) throw new Error(`Invalid runtime event budget: ${formatErrors(validateBudget.errors)}`);
    this.#store = store; this.#runId = runId; this.#logger = logger;
    this.#budget = maxPerMinute; this.#wall = wallNow; this.#mono = monotonicNow;
  }

  attachRadio(radio) {
    if (this.#radio || this.#stopped) return;
    this.#radio = radio;
    this.#radioState = radio.isConnected() ? 'connected' : 'disconnected';
    for (const state of ['connected', 'disconnected']) {
      const kind = `radio.${state}`;
      const listener = () => {
        if (this.#radioState === state) return;
        this.#radioState = state;
        this.#record({ kind, serviceId: null, state, precision: 'event', observationWindowMs: null });
      };
      radio.on(kind, listener); this.#listeners.push([kind, listener]);
    }
    // RadioManager currently emits only connection errors. Ignore the entire
    // detail payload so free-form errors/credentials cannot enter history.
    const onError = () => this.#record({ kind: 'radio.connect-error', serviceId: null,
      state: null, precision: 'event', observationWindowMs: null });
    radio.on('radio.error', onError); this.#listeners.push(['radio.error', onError]);
  }

  observeSnapshot(snapshot) {
    if (this.#stopped) return;
    // ServiceHealth is internal; project only the documented readiness seam.
    const selected = { brokers: Object.fromEntries(Object.entries(snapshot.mqtt).map(([id, item]) => [id, item.connected])),
      bots: snapshot.bots.map(({ name, enabled, ready }) => ({ name, enabled, ready })) };
    if (!validateSnapshot(selected)) throw new Error(`Invalid readiness snapshot: ${formatErrors(validateSnapshot.errors)}`);
    const at = this.#mono();
    if (this.#previous) {
      const observationWindowMs = Math.max(0, at - this.#previousAt);
      for (const [id, connected] of Object.entries(selected.brokers)) {
        if (Object.hasOwn(this.#previous.brokers, id) && this.#previous.brokers[id] !== connected) {
          this.#record({ kind: 'broker.state', serviceId: id, state: connected ? 'connected' : 'disconnected',
            precision: 'sample', observationWindowMs });
        }
      }
      const previousBots = new Map(this.#previous.bots.map((bot) => [bot.name, bot]));
      for (const bot of selected.bots) {
        const previous = previousBots.get(bot.name);
        if (bot.enabled && previous?.enabled && bot.ready !== previous.ready) {
          this.#record({ kind: 'bot.readiness', serviceId: bot.name, state: bot.ready ? 'ready' : 'not-ready',
            precision: 'sample', observationWindowMs });
        }
      }
    }
    this.#previous = selected; this.#previousAt = at;
  }

  #record(fields) {
    if (this.#stopped) return;
    try {
      const event = { runId: this.#runId, observedAt: this.#wall(), ...fields };
      if (!validateEvent(event)) throw new Error(`Invalid runtime event: ${formatErrors(validateEvent.errors)}`);
      const now = this.#mono();
      this.#attempts = this.#attempts.filter((at) => now - at < 60000);
      if (this.#attempts.length >= this.#budget) { this.#suppressed += 1; return; }
      this.#attempts.push(now);
      this.#store.recordRuntimeEvent(event);
    } catch (error) {
      this.#failed += 1;
      this.#logger.warn('services.runtimeEvents', 'failed to persist a runtime event', { kind: fields.kind, error: error.message });
    }
  }

  pendingCounts() { return { suppressedEvents: this.#suppressed, failedEvents: this.#failed }; }
  acknowledgeCounts({ suppressedEvents, failedEvents }) {
    this.#suppressed -= suppressedEvents; this.#failed -= failedEvents;
  }
  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const [event, listener] of this.#listeners) this.#radio.off(event, listener);
    this.#listeners = []; this.#radio = null;
  }
}
