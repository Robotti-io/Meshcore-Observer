const DEFAULT_MAX_ENTRIES = 200;

/**
 * Tracks outbound channel-bot replies awaiting confirmation that they were
 * actually rebroadcast onto the mesh. MeshCore's GRP_TXT flood relaying
 * leaves the encrypted payload unchanged as it hops, so a later decrypted
 * plaintext identical to what we just sent is a repeat by another node - our
 * own radio can't hear its own outgoing transmission (half-duplex). Keyed by
 * exact plaintext rather than a packet hash because the device (not this
 * process) performs the AES-ECB encryption, so the ciphertext/hash of our own
 * send can't be reproduced client-side.
 *
 * Bounded by both entry count and age, matching PacketDeduplicator's
 * eviction style, since it serves the same "don't grow unbounded on a
 * long-running observer" purpose.
 */
export class RepeatCheckTracker {
  #timeoutMs;
  #maxEntries;
  #now;
  #pendingByText = new Map();
  #totalPending = 0;

  constructor({ timeoutMs, maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now() }) {
    this.#timeoutMs = timeoutMs;
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  /**
   * Registers `text` (the exact plaintext we just sent) as awaiting a
   * repeat. Returns entries that expired during the age pass separately
   * from entries removed because the pending-entry limit was reached.
   *
   * @param {string} text
   * @param {object} meta arbitrary context (sender/trigger/hash/...) carried
   * through to a later confirmation or timeout report.
   * @returns {{expired: object[], evicted: object[]}} expired entries and capacity-evicted entries' `meta`
   */
  register(text, meta) {
    const now = this.#now();
    const expired = this.#evictExpired(now);

    const entries = this.#pendingByText.get(text) ?? [];
    entries.push({ meta, expiresAt: now + this.#timeoutMs, sentAt: now });
    this.#pendingByText.set(text, entries);
    this.#totalPending += 1;

    const evicted = this.#evictOverflow();
    return { expired, evicted };
  }

  /** Removes and returns every entry whose repeat-check timeout has elapsed. */
  sweepExpired() {
    return this.#evictExpired(this.#now());
  }

  /**
   * Checks whether `text` matches a still-pending registration. On a match,
   * removes and returns the oldest matching entry's `meta` plus elapsed ms.
   * Also evicts (and returns via `expired`) any entries - matching or not -
   * that have timed out unconfirmed.
   *
   * @param {string} text
   * @returns {{confirmed: {meta: object, elapsedMs: number}|null, expired: object[]}}
   */
  checkAndConsume(text) {
    const now = this.#now();
    const expired = this.#evictExpired(now);

    const entries = this.#pendingByText.get(text);
    if (!entries || entries.length === 0) {
      return { confirmed: null, expired };
    }

    const entry = entries.shift();
    this.#totalPending -= 1;
    if (entries.length === 0) {
      this.#pendingByText.delete(text);
    }

    return { confirmed: { meta: entry.meta, elapsedMs: now - entry.sentAt }, expired };
  }

  /** Total pending registrations awaiting either a match or a timeout. */
  get size() {
    return this.#totalPending;
  }

  #evictExpired(now) {
    const expired = [];
    for (const [text, entries] of this.#pendingByText) {
      while (entries.length > 0 && entries[0].expiresAt <= now) {
        expired.push(entries.shift().meta);
        this.#totalPending -= 1;
      }
      if (entries.length === 0) {
        this.#pendingByText.delete(text);
      }
    }
    return expired;
  }

  #evictOverflow() {
    const evicted = [];
    while (this.#totalPending > this.#maxEntries) {
      const [oldestText] = this.#pendingByText.keys();
      const entries = this.#pendingByText.get(oldestText);
      evicted.push(entries.shift().meta);
      this.#totalPending -= 1;
      if (entries.length === 0) {
        this.#pendingByText.delete(oldestText);
      }
    }
    return evicted;
  }
}
