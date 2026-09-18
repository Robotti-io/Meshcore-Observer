/**
 * Exponential backoff with a ceiling: initialDelayMs, then doubling each
 * subsequent attempt, capped at maxDelayMs. `attempt` is 1-based (the delay
 * before the first retry).
 */
export function computeBackoffDelay(attempt, initialDelayMs, maxDelayMs) {
  const exponential = initialDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, maxDelayMs);
}
