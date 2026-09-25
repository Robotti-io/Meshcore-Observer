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
 * A general "contact list" of every node this observer has heard advertise
 * a name, keyed by its full public key - see
 * docs/plans/feat-bot_command_to_lookup_repeater_name.md for the original
 * design rationale. Backed directly by MetricsStore's `nodes` table (see
 * `store`'s `upsertNode`/`findNodesByPublicKeyPrefix`) rather than an
 * in-memory Map: persisted metrics/state are now a core observer
 * capability independent of whether the optional HTTP dashboard is
 * enabled, so `!lookup`'s data survives a restart the same way every other
 * feature backed by MetricsStore does. `store`'s reads are synchronous
 * (node:sqlite's DatabaseSync), so this stays exactly as fast/simple a
 * dependency for ChannelBot's hot path as the old in-memory Map was.
 */
export class NodeRegistry {
  #logger;
  #parseAdvert;
  #now;
  #store;

  /**
   * @param {{logger: object, store: {upsertNode: Function, findNodesByPublicKeyPrefix: Function, countNodesByType: Function}, parseAdvert?: Function, now?: () => number}} options
   * `store` is required (typically the app's single MetricsStore instance -
   * see src/index.js) - persistence is no longer optional here, matching
   * every other feature MetricsStore now backs.
   */
  constructor({ logger, store, parseAdvert = parseAdvertFromPacket, now = () => Date.now() }) {
    this.#logger = logger;
    this.#store = store;
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
   * Repeated adverts upsert the same row, so both `name` and `lastHeardAt`
   * always reflect the most recently verified advert heard (see
   * MetricsStore#upsertNode - `firstHeardAt` is set once and never moves).
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
    try {
      this.#store.upsertNode({ publicKeyHex, name: advert.parsed.name, type: advert.parsed.type, heardAt: this.#now() });
    } catch (err) {
      this.#logger.warn('services.nodeRegistry', 'failed to persist a verified advert', { error: err.message });
    }
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
   *   (MetricsStore#findNodesByPublicKeyPrefix already returns them sorted
   *   by `lastHeardAt` descending), so a caller can surface a best-guess
   *   name alongside the count.
   */
  findByPrefix(rawQuery, { type } = {}) {
    const query = normalizeQuery(rawQuery);
    if (!query) {
      return { status: 'invalid' };
    }

    const matches = this.#store.findNodesByPublicKeyPrefix(query, { type });

    if (matches.length === 0) {
      return { status: 'not_found', query };
    }
    if (matches.length === 1) {
      return { status: 'found', query, node: matches[0] };
    }
    return { status: 'ambiguous', query, matchCount: matches.length, node: matches[0] };
  }

  /** Total number of repeaters currently stored, with no age/TTL filter. */
  countRepeaters() {
    return this.#store.countNodesByType('REPEATER');
  }
}
