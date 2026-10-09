import { performance } from 'node:perf_hooks';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { remoteRequestBudgetSchema, REMOTE_REQUEST_DEFAULTS } from './remote-coordinator-schemas.js';

const valid = compileSchema(remoteRequestBudgetSchema);

/** Bounded process-local attempt budget; reconnect never constructs a new one. */
export class RemoteRequestBudget {
  #minIntervalMs;
  #maxPerMinute;
  #now;
  #lastTime = -Infinity;
  #nextAttemptAt;
  #attempts = [];

  constructor({ minIntervalMs = REMOTE_REQUEST_DEFAULTS.minIntervalMs,
    maxPerMinute = REMOTE_REQUEST_DEFAULTS.maxPerMinute, now = () => performance.now() } = {}) {
    if (!valid({ minIntervalMs, maxPerMinute })) throw new Error(`Invalid remote request budget: ${formatErrors(valid.errors)}`);
    this.#minIntervalMs = minIntervalMs;
    this.#maxPerMinute = maxPerMinute;
    this.#now = now;
    this.#nextAttemptAt = this.#time() + minIntervalMs;
  }

  #time() {
    this.#lastTime = Math.max(this.#lastTime, this.#now());
    return this.#lastTime;
  }

  canAttempt() {
    const now = this.#time();
    this.#attempts = this.#attempts.filter(at => now - at < 60000);
    return now >= this.#nextAttemptAt && this.#attempts.length < this.#maxPerMinute;
  }

  /** Call immediately before the physical write, including attempts that fail. */
  recordAttempt() {
    if (!this.canAttempt()) return false;
    const now = this.#time();
    this.#attempts.push(now); // At most six entries, even under error storms.
    this.#nextAttemptAt = now + this.#minIntervalMs;
    return true;
  }
}
