import { parseAdvertFromPacket } from './advert-parser.js';

const HEX_PATTERN = /^[0-9A-Fa-f]+$/;
const MIN_QUERY_HEX_LENGTH = 2; // 1 byte, per docs/plans/feat-bot_command_to_lookup_repeater_name.md
const MAX_QUERY_HEX_LENGTH = 64; // a full 32-byte public key

function normalizeQuery(rawQuery) {
  const trimmed = rawQuery.trim();
  if (trimmed.length < MIN_QUERY_HEX_LENGTH || trimmed.length > MAX_QUERY_HEX_LENGTH || !HEX_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.toUpperCase();
}

/**
 * A general, in-memory "contact list" of every node this observer has heard
 * advertise a name, keyed by its full public key - see
 * docs/plans/feat-bot_command_to_lookup_repeater_name.md for the full
 * design rationale. No persistence (v1 constraint per AGENTS.md): it
 * rebuilds from scratch as adverts are re-heard after every restart, which
 * is also what keeps stored names honest rather than stale.
 */
export class NodeRegistry {
  #nodesByPublicKey = new Map();
  #logger;
  #parseAdvert;
  #now;

  constructor({ logger, parseAdvert = parseAdvertFromPacket, now = () => new Date().toISOString() }) {
    this.#logger = logger;
    this.#parseAdvert = parseAdvert;
    this.#now = now;
  }

  /**
   * The one method callers feed every decoded packet through. A no-op for
   * anything that isn't a verified, named advert:
   *  - not an ADVERT packet, or a malformed one -> `parseAdvert` returns
   *    `null`, silently ignored.
   *  - an advert with no name set -> silently ignored (only names we've
   *    actually heard are ever stored).
   *  - an advert whose signature doesn't verify against its own claimed
   *    public key -> dropped and logged. This integrity check is never
   *    skipped: a name is only trusted once
   *    `await advert.isVerified()` confirms it.
   *
   * Repeated adverts overwrite the previous record for that public key, so
   * both `name` and `lastHeardAt` always reflect the most recently
   * verified advert heard.
   *
   * @param {{raw: string}} decodedPacket
   */
  async recordFromDecodedPacket(decodedPacket) {
    const advert = this.#parseAdvert(decodedPacket);
    if (!advert || !advert.parsed?.name) {
      return;
    }

    const verified = await advert.isVerified();
    if (!verified) {
      this.#logger.warn('services.nodeRegistry', 'dropped an advert with a name whose signature did not verify', {
        type: advert.parsed.type
      });
      return;
    }

    const publicKeyHex = Buffer.from(advert.publicKey).toString('hex').toUpperCase();
    this.#nodesByPublicKey.set(publicKeyHex, {
      publicKeyHex,
      name: advert.parsed.name,
      type: advert.parsed.type,
      lastHeardAt: this.#now()
    });
  }

  /**
   * Resolves a hex public-key prefix against every stored node, optionally
   * narrowed to one `type` (e.g. `'REPEATER'`) *before* deciding the
   * outcome, so a matching node of a filtered-out type never counts toward
   * `found`/`ambiguous`.
   *
   * @param {string} rawQuery
   * @param {{type?: string}} [options]
   * @returns
   *   {{status: 'invalid'}} |
   *   {{status: 'not_found', query: string}} |
   *   {{status: 'found', query: string, node: object}} |
   *   {{status: 'ambiguous', query: string, matchCount: number, node: object}}
   *   For 'ambiguous', `node` is the most-recently-heard of the matches
   *   (matches are sorted by `lastHeardAt` descending), so a caller can
   *   surface a best-guess name alongside the count.
   */
  findByPrefix(rawQuery, { type } = {}) {
    const query = normalizeQuery(rawQuery);
    if (!query) {
      return { status: 'invalid' };
    }

    const matches = [...this.#nodesByPublicKey.values()]
      .filter((node) => node.publicKeyHex.startsWith(query))
      .filter((node) => !type || node.type === type)
      .sort((a, b) => (a.lastHeardAt < b.lastHeardAt ? 1 : a.lastHeardAt > b.lastHeardAt ? -1 : 0));

    if (matches.length === 0) {
      return { status: 'not_found', query };
    }
    if (matches.length === 1) {
      return { status: 'found', query, node: matches[0] };
    }
    return { status: 'ambiguous', query, matchCount: matches.length, node: matches[0] };
  }

  /** Every stored node, any type - for diagnostics/tests. */
  entries() {
    return [...this.#nodesByPublicKey.values()];
  }

  size() {
    return this.#nodesByPublicKey.size;
  }
}
