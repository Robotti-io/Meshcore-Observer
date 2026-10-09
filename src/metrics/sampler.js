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
  #repeaterFingerprintPruneAfterDays;
  #runHistory;
  #processMeasurements;
  #runtimeEvents;
  #logger;
  #timer = null;
  #lastSnapshot = null;
  #lastPrunedAt = null;

  /** @param {{serviceHealth: object, metricsStore: object, sampleIntervalMs: number, retentionDays: number, repeaterFingerprintPruneAfterDays?: number, runHistory?: object, processMeasurements?: object, runtimeEvents?: object, logger: object}} options */
  constructor({ serviceHealth, metricsStore, sampleIntervalMs, retentionDays, repeaterFingerprintPruneAfterDays = 0,
    runHistory = null, processMeasurements = null, runtimeEvents = null, logger }) {
    super();
    this.#serviceHealth = serviceHealth;
    this.#metricsStore = metricsStore;
    this.#sampleIntervalMs = sampleIntervalMs;
    this.#retentionDays = retentionDays;
    this.#repeaterFingerprintPruneAfterDays = repeaterFingerprintPruneAfterDays;
    this.#runHistory = runHistory;
    this.#processMeasurements = processMeasurements;
    this.#runtimeEvents = runtimeEvents;
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
    try { this.#runtimeEvents?.observeSnapshot(snapshot); }
    catch (error) { this.#logger.warn('services.runtimeEvents', 'failed to observe sampled readiness', { error: error.message }); }
    this.flushProcessSample();
    this.#recordSample(snapshot);
    this.#maybePrune();
    this.#lastSnapshot = snapshot;
    this.emit('sample', snapshot);
  }

  /** Also called once after event listeners stop, before orderly service teardown. */
  flushProcessSample() {
    if (this.#processMeasurements && this.#runHistory) {
      try {
        const { measurements, unavailable } = this.#processMeasurements.collect();
        if (unavailable.length) this.#logger.warn('services.processMetrics', 'process measurements unavailable', { measurements: unavailable });
        const counts = this.#runtimeEvents?.pendingCounts() ?? { suppressedEvents: 0, failedEvents: 0 };
        const checkpoint = this.#runHistory.checkpointEvidence();
        this.#metricsStore.recordProcessSample({ runId: checkpoint.runId, sampleAt: checkpoint.observedAt,
          ...measurements, ...counts }, checkpoint);
        this.#runtimeEvents?.acknowledgeCounts(counts);
        return;
      } catch (error) {
        this.#logger.warn('services.processMetrics', 'failed to persist process measurements', { error: error.message });
      }
    }
    try {
      this.#runHistory?.checkpoint();
    } catch (error) {
      this.#logger.warn('services.runHistory', 'failed to persist run checkpoint', { error: error.message });
    }
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

  /** Independent opt-in local history/fingerprint cleanup, at most once per day. */
  #maybePrune() {
    if (this.#retentionDays <= 0 && this.#repeaterFingerprintPruneAfterDays <= 0) {
      return;
    }
    const now = Date.now();
    if (this.#lastPrunedAt !== null && now - this.#lastPrunedAt < ONE_DAY_MS) {
      return;
    }
    this.#lastPrunedAt = now;
    if (this.#retentionDays > 0) {
      try {
        this.#metricsStore.pruneOlderThan(now - this.#retentionDays * ONE_DAY_MS);
      } catch (err) {
        this.#logger.warn('services.metricsUi', 'failed to prune persisted metrics', { error: err.message });
      }
    }
    const fingerprintCutoff = now - this.#repeaterFingerprintPruneAfterDays * ONE_DAY_MS;
    if (this.#repeaterFingerprintPruneAfterDays > 0 && fingerprintCutoff >= 0) {
      try {
        const removed = this.#metricsStore.pruneInactiveRepeaterFingerprints({ cutoffMs: fingerprintCutoff });
        if (removed > 0) this.#logger.info('services.nodeRegistry', 'pruned inactive repeater fingerprints', { removed });
      } catch (err) {
        this.#logger.warn('services.nodeRegistry', 'failed to prune inactive repeater fingerprints', { error: err.message });
      }
    }
  }
}
