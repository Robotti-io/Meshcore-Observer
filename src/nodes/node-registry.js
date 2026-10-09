import { parseAdvertReceptionFromPacket } from './advert-parser.js';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { verifiedAdvertSchema } from './schemas.js';

const validateAdvert = compileSchema(verifiedAdvertSchema);

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
 * Verified node inventory keyed by full public key, including unnamed
 * nodes. Advert history and direct reception evidence live in the same
 * always-on MetricsStore as inventory - see
 * docs/plans/feat-bot_command_to_lookup_repeater_name.md for the original
 * design rationale. Backed directly by MetricsStore's `nodes` table (see
 * `store`'s `recordVerifiedAdvert`/`findNodesByPublicKeyPrefix`) rather than an
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
  #directHeardWindowMs;

  /**
   * @param {{logger: object, store: object, directHeardWindowMs: number, parseAdvert?: Function, now?: () => number}} options
   * `store` is required (typically the app's single MetricsStore instance -
   * see src/index.js) - persistence is no longer optional here, matching
   * every other feature MetricsStore now backs.
   */
  constructor({ logger, store, directHeardWindowMs, parseAdvert = parseAdvertReceptionFromPacket, now = () => Date.now() }) {
    this.#logger = logger;
    this.#store = store;
    this.#parseAdvert = parseAdvert;
    this.#now = now;
    this.#directHeardWindowMs = directHeardWindowMs;
  }

  /**
   * Independent packet consumer: verify authenticity, validate evidence,
   * then atomically record reception/history. Non-adverts and malformed
   * frames are ignored. Invalid signatures and persistence errors are
   * logged without interrupting capture. Store selection uses original
   * reception chronology even when verification completes out of order.
   *
   * @param {{raw: string, timestamp: string}} decodedPacket
   */
  async recordFromDecodedPacket(decodedPacket) {
    try {
      const reception = this.#parseAdvert(decodedPacket);
      if (!reception) return;
      const { advert, eventDigest, hopCount } = reception;
      // Capture Observer reception time before asynchronous verification;
      // never derive recency from the remote advert timestamp.
      const receivedAt = Date.parse(decodedPacket.timestamp);
      if (!await advert.isVerified()) {
        this.#logger.warn('services.nodeRegistry', 'dropped an advert whose signature did not verify', { type: advert.parsed.type });
        return;
      }
      const observation = { publicKeyHex: Buffer.from(advert.publicKey).toString('hex').toUpperCase(),
        name: advert.parsed.name || null, type: advert.parsed.type ?? null, eventDigest, hopCount, receivedAt };
      if (!validateAdvert(observation)) {
        this.#logger.warn('services.nodeRegistry', 'dropped invalid verified advert evidence', { error: formatErrors(validateAdvert.errors) });
        return;
      }
      this.#store.recordVerifiedAdvert(observation);
    } catch (err) {
      this.#logger.warn('services.nodeRegistry', 'failed to persist a verified advert', { error: err.message });
    }
  }

  /** Caller must recheck immediately before a future request dispatch (#31). */
  getDirectHeardEligibility(publicKeyHex) {
    return this.#store.queryDirectHeardEligibility({ publicKeyHex, now: this.#now(), windowMs: this.#directHeardWindowMs });
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
