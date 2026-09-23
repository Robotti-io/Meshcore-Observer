import { EventEmitter } from 'node:events';
import { computeSampleDelta } from '../web/metrics-sample.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Owns the periodic sample-persist-prune loop against MetricsStore,
 * independent of whether the HTTP dashboard (MetricsServer) is enabled -
 * persisted metrics are a core observer capability now, not a side effect
 * of serving the dashboard (see project history: this used to live inside
 * MetricsServer's own setInterval, gated on the HTTP server actually
 * starting). Emits `'sample'` with each tick's fresh ServiceHealth
 * snapshot so MetricsServer can broadcast that exact same object to its
 * SSE clients, when it's running, without a redundant second
 * `serviceHealth.snapshot()` call.
 */
export class MetricsSampler extends EventEmitter {
  #serviceHealth;
  #metricsStore;
  #sampleIntervalMs;
  #retentionDays;
  #logger;
  #timer = null;
  #lastSnapshot = null;
  #lastPrunedAt = null;

  /** @param {{serviceHealth: object, metricsStore: object, sampleIntervalMs: number, retentionDays: number, logger: object}} options */
  constructor({ serviceHealth, metricsStore, sampleIntervalMs, retentionDays, logger }) {
    super();
    this.#serviceHealth = serviceHealth;
    this.#metricsStore = metricsStore;
    this.#sampleIntervalMs = sampleIntervalMs;
    this.#retentionDays = retentionDays;
    this.#logger = logger;
  }

  /** Idempotent - a second call while already running is a no-op. */
  start() {
    if (this.#timer) {
      return;
    }
    this.#timer = setInterval(() => this.#tick(), this.#sampleIntervalMs);
    this.#timer.unref();
  }

  /** Idempotent and safe to call whether or not start() ran. */
  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #tick() {
    const snapshot = this.#serviceHealth.snapshot();
    this.#recordSample(snapshot);
    this.#maybePrune();
    this.#lastSnapshot = snapshot;
    this.emit('sample', snapshot);
  }

  #recordSample(snapshot) {
    const sample = computeSampleDelta({
      prevSnapshot: this.#lastSnapshot,
      snapshot,
      sampleAt: Date.now(),
      intervalMs: this.#sampleIntervalMs
    });

    try {
      this.#metricsStore.recordPacketSample(sample);
    } catch (err) {
      this.#logger.warn('services.metricsUi', 'failed to persist a metrics sample', { error: err.message });
    }
  }

  /** Prunes persisted metrics older than the configured retention window, at most once per day. */
  #maybePrune() {
    if (this.#retentionDays <= 0) {
      return;
    }
    const now = Date.now();
    if (this.#lastPrunedAt !== null && now - this.#lastPrunedAt < ONE_DAY_MS) {
      return;
    }
    this.#lastPrunedAt = now;
    try {
      this.#metricsStore.pruneOlderThan(now - this.#retentionDays * ONE_DAY_MS);
    } catch (err) {
      this.#logger.warn('services.metricsUi', 'failed to prune persisted metrics', { error: err.message });
    }
  }
}
