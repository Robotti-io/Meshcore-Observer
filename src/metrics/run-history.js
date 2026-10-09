import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** One database-backed run; wall clocks label evidence, monotonic clocks measure elapsed time. */
export class RunHistory {
  #store;
  #wallNow;
  #monotonicNow;
  #baseline;
  #run;

  constructor({ store, metadata, startedAt, monotonicStartedAt, wallNow = Date.now,
    monotonicNow = () => performance.now(), createId = randomUUID }) {
    this.#store = store;
    this.#wallNow = wallNow;
    this.#monotonicNow = monotonicNow;
    this.#baseline = monotonicStartedAt ?? monotonicNow();
    this.#run = store.beginObserverRun({ ...metadata, runId: createId(),
      startedAt: startedAt ?? wallNow(), ...this.#evidence() });
  }

  get runId() { return this.#run.runId; }
  get instanceId() { return this.#run.instanceId; }

  #evidence() {
    return { observedAt: this.#wallNow(), observedDurationMs: Math.floor(this.#monotonicNow() - this.#baseline) };
  }
  checkpoint() {
    return this.#store.checkpointObserverRun(this.checkpointEvidence());
  }
  checkpointEvidence() { return { runId: this.runId, ...this.#evidence() }; }
  finishClean(reason) {
    return this.#store.endObserverRun({ runId: this.runId, ...this.#evidence(), reason });
  }
}

/** Purpose-built bounded run shutdown. Failure leaves storage available to
 * outstanding writers and the run unclosed; restart recovers it conservatively. */
export function createRunShutdown({ logger, runHistory, metricsStore, teardown, timeoutMs = 10000,
  forceExit = (code) => process.exit(code), setExitCode = (code) => { process.exitCode = code; } }) {
  let pending;
  return (signal) => {
    if (pending) return pending;
    // Defer until pending is assigned, including teardown callbacks that may signal again.
    pending = Promise.resolve().then(async () => {
      logger.info('app.bootstrap', 'shutdown signal received', { signal });
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        logger.warn('app.bootstrap', 'shutdown exceeded bounded duration, forcing exit');
        forceExit(1);
      }, timeoutMs);
      timeout.unref();
      try {
        await teardown();
        if (timedOut) return;
        if (!runHistory.finishClean(signal)) throw new Error('Clean run end was not persisted');
        metricsStore.close();
        clearTimeout(timeout);
        logger.info('app.bootstrap', 'meshcore-observer stopped');
        setExitCode(0);
      } catch (error) {
        logger.error('app.bootstrap', 'shutdown failed; run end remains unconfirmed', { error: error.message });
        setExitCode(1);
        // Keep the bound armed: a failed service may still hold live handles.
      }
    });
    return pending;
  };
}
