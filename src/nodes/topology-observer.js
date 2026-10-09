import { performance } from 'node:perf_hooks';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { topologyConfigSchema, topologyCounters } from './topology-schemas.js';
import { parseTopologyFrame } from './topology-parser.js';

const validateConfig = compileSchema(topologyConfigSchema);
const emptyCounts = () => Object.fromEntries(Object.keys(topologyCounters).map((key) => [key, 0]));

/** Independent synchronous consumer, no raw frame queue, RF calls, or timer. */
export class TopologyObserver {
  #store; #runId; #deviceInfo; #logger; #max; #monotonic; #now;
  #attempts = []; #counts = new Map(); #pipeline = null;
  #listener = (packet) => this.observe(packet);

  constructor({ store, runId, getDeviceInfo, logger, config, monotonicNow = () => performance.now(), now = () => Date.now() }) {
    if (!validateConfig(config)) throw new Error(`Invalid topology configuration: ${formatErrors(validateConfig.errors)}`);
    this.#store = store; this.#runId = runId; this.#deviceInfo = getDeviceInfo; this.#logger = logger;
    this.#max = config.maxObservationsPerMinute; this.#monotonic = monotonicNow; this.#now = now;
  }
  attach(pipeline) { this.stop(); this.#pipeline = pipeline; pipeline.on('packet', this.#listener); }
  stop() { this.#pipeline?.off('packet', this.#listener); this.#pipeline = null; }

  observe(packet) {
    try { return this.#observe(packet); }
    catch { return { status: 'failed' }; }
  }

  #observe(packet) {
    // Only take the header view needed by the strict schema. Never pass a
    // packet or radio error object to storage or logging.
    const observerPublicKey = packet?.origin_id;
    const currentKey = this.#deviceInfo()?.publicKey;
    if (!/^[0-9A-F]{64}$/.test(observerPublicKey ?? '') || observerPublicKey !== currentKey?.toUpperCase()) {
      return { status: 'malformed' }; // Unknown radio context cannot own coverage either.
    }
    if (!this.#counts.has(observerPublicKey)) this.#counts.set(observerPublicKey, emptyCounts());
    const counts = this.#counts.get(observerPublicKey);
    try {
      const receivedAt = Date.parse(packet.timestamp);
      const parsed = parseTopologyFrame({ raw: packet.raw, runId: this.#runId, observerPublicKey, receivedAt });
      if (parsed.status !== 'accepted') { counts[parsed.status]++; return parsed; }
      const now = this.#monotonic();
      // Conservative on a broken injected clock; the real performance clock is monotonic.
      while (this.#attempts.length && now - this.#attempts[0] >= 60000) this.#attempts.shift();
      if (this.#attempts.length >= this.#max) { counts.suppressed++; return { status: 'suppressed' }; }
      this.#attempts.push(now);
      this.#store.recordTopologyObservation(parsed.evidence);
      counts.accepted++;
      return { status: 'accepted' };
    } catch {
      counts.failed++;
      // Per-reception failures are summarized on cadence rather than emitting
      // unbounded logs (which could contain database trigger/error content).
      return { status: 'failed' };
    }
  }

  flushCoverage() {
    const currentKey = this.#deviceInfo()?.publicKey?.toUpperCase();
    if (/^[0-9A-F]{64}$/.test(currentKey ?? '') && !this.#counts.has(currentKey)) this.#counts.set(currentKey, emptyCounts());
    for (const [observerPublicKey, counts] of this.#counts) {
      const captured = { ...counts };
      try {
        this.#store.recordTopologyCoverage({ runId: this.#runId, observerPublicKey, sampleAt: this.#now(), ...captured });
        for (const key of Object.keys(captured)) counts[key] -= captured[key];
        if (Object.values(counts).every((value) => value === 0)) this.#counts.delete(observerPublicKey);
      } catch {
        this.#logger.warn('services.topology', 'failed to persist topology coverage; pending counts will be retried');
      }
    }
  }
}
