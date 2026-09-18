const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Centralized duplicate detection for one canonical packet identifier.
 * Bounded by both entry count and age so memory cannot grow unbounded on a
 * long-running observer. A single instance must be shared by every consumer
 * (MQTT publisher, echo bot, ...) so the same physical packet arriving
 * through different event paths is only ever treated as "new" once.
 */
export class PacketDeduplicator {
  #maxEntries;
  #ttlMs;
  #now;
  #seenAt = new Map();

  constructor({ maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /**
   * Returns true if `id` was already seen within the TTL window (a
   * duplicate), false if it's new. Either way, `id` is recorded as seen.
   */
  isDuplicate(id) {
    const now = this.#now();
    this.#evictExpired(now);

    const previouslySeenAt = this.#seenAt.get(id);
    const isDuplicate = previouslySeenAt !== undefined && now - previouslySeenAt < this.#ttlMs;

    // Re-inserting moves the key to the end of Map's iteration order, which
    // #evictOverflow relies on to evict the least-recently-seen entries.
    this.#seenAt.delete(id);
    this.#seenAt.set(id, now);
    this.#evictOverflow();

    return isDuplicate;
  }

  get size() {
    return this.#seenAt.size;
  }

  #evictExpired(now) {
    for (const [id, seenAt] of this.#seenAt) {
      if (now - seenAt >= this.#ttlMs) {
        this.#seenAt.delete(id);
      } else {
        // Map iterates in insertion order, so once we hit a non-expired
        // entry every later one is also non-expired.
        break;
      }
    }
  }

  #evictOverflow() {
    while (this.#seenAt.size > this.#maxEntries) {
      const oldestKey = this.#seenAt.keys().next().value;
      this.#seenAt.delete(oldestKey);
    }
  }
}
