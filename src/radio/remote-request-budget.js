import { performance } from 'node:perf_hooks';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { remoteRequestBudgetSchema, remoteExchangeBudgetSchema, REMOTE_REQUEST_DEFAULTS } from './remote-coordinator-schemas.js';

const valid = compileSchema(remoteRequestBudgetSchema);
const validExchange = compileSchema(remoteExchangeBudgetSchema);

/** Bounded process-local attempt budget; reconnect never constructs a new one. */
export class RemoteRequestBudget {
  #minIntervalMs;
  #maxPerMinute;
  #now;
  #lastTime = -Infinity;
  #nextAttemptAt;
  #attempts = [];
  #exchange = null;

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

  canAttempt(token) {
    const now = this.#time();
    if (this.#exchange && now >= this.#exchange.expiresAt) this.endExchange(this.#exchange.token);
    if (this.#exchange) return token === this.#exchange.token && now >= this.#exchange.nextAt
      && this.#exchange.count < this.#exchange.maxRequests;
    if (token !== undefined) return false;
    this.#attempts = this.#attempts.filter(at => now - at < 60000);
    return now >= this.#nextAttemptAt && this.#attempts.length < this.#maxPerMinute;
  }

  /** Call immediately before the physical write, including attempts that fail. */
  recordAttempt(token) {
    if (!this.canAttempt(token)) return false;
    const now = this.#time();
    if (this.#exchange) {
      this.#exchange.count++;
      this.#exchange.nextAt = now + this.#exchange.stepMs;
      return true;
    }
    this.#attempts.push(now); // At most six entries, even under error storms.
    this.#nextAttemptAt = now + this.#minIntervalMs;
    return true;
  }

  beginExchange(options) {
    if (!validExchange(options)) throw new Error('Invalid remote exchange budget');
    if (!this.canAttempt()) return null;
    const token = Symbol('telemetry-exchange');
    this.#exchange = { ...options, token, count: 0, nextAt: this.#time(), expiresAt: this.#time() + options.windowMs };
    return token;
  }

  hasExchangeCapacity(token) {
    if (this.#exchange && this.#time() >= this.#exchange.expiresAt) this.endExchange(this.#exchange.token);
    return Boolean(this.#exchange && this.#exchange.token === token && this.#exchange.count < this.#exchange.maxRequests);
  }

  endExchange(token) {
    if (!this.#exchange || this.#exchange.token !== token) return false;
    const exchange = this.#exchange;
    this.#exchange = null;
    if (exchange.count) {
      // Repay every borrowed RF turn AFTER the exchange, including failed
      // writes and traces. No catch-up credit survives a long idle period.
      const perRequest = Math.max(this.#minIntervalMs, Math.ceil(60000 / this.#maxPerMinute));
      this.#nextAttemptAt = Math.max(this.#nextAttemptAt,
        this.#time() + Math.max(exchange.restMs, exchange.count * perRequest));
    }
    return true;
  }
}
