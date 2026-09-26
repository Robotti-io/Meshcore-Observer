import { Packet } from '@liamcottle/meshcore.js';
import { normalizeRawPacketEvent } from '../packets/packet-normalizer.js';
import { calculatePacketHash } from '../packets/packet-hash.js';
import { PacketDeduplicator } from '../packets/packet-deduplicator.js';
import { RepeatCheckTracker } from './repeat-check-tracker.js';
import { channelHashForKey } from './channel-key.js';
import { decryptGroupText } from './group-text-crypto.js';
import { ensureChannel } from './channel-setup.js';
import { renderResponse, DEFAULT_MAX_MESSAGE_BYTES } from './response-template.js';

const PAYLOAD_TYPE_GRP_TXT = 0x05;
const DIRECT_ROUTES = new Set(['DIRECT', 'TRANSPORT_DIRECT']);
// Matches config/index.js's PACKETCAPTURE_BOT_REPLY_REPEAT_CHECK_MS default -
// only used when a caller (e.g. a test) constructs a bot without threading
// the configured value through.
const DEFAULT_REPEAT_CHECK_TIMEOUT_MS = 30000;

function formatRelativeAge(timestamp, now) {
  if (timestamp === undefined || timestamp === null) {
    return 'unknown';
  }

  const ageMs = Math.max(0, now - Number(timestamp));
  if (ageMs < 60 * 1000) {
    return 'just now';
  }

  const units = [
    ['y', 365 * 24 * 60 * 60 * 1000],
    ['mo', 30 * 24 * 60 * 60 * 1000],
    ['d', 24 * 60 * 60 * 1000],
    ['h', 60 * 60 * 1000],
    ['m', 60 * 1000]
  ];
  const [unit, durationMs] = units.find(([, duration]) => ageMs >= duration);
  return `${Math.floor(ageMs / durationMs)}${unit} ago`;
}

function hopCountFor(packet) {
  if (DIRECT_ROUTES.has(packet.route_type_string)) {
    return 0;
  }
  return packet.getPathHashCount();
}

function formatPath(packet) {
  return packet
    .getPathHashes()
    .map((hash) => Buffer.from(hash).toString('hex').toUpperCase())
    .join('➡️');
}

/**
 * One independently-configured channel bot: listens on its own channel,
 * matches its own set of exact trigger -> response-template commands, and
 * replies with a message rendered within a hard byte budget (see
 * response-template.js). A deployment can run any number of these, each
 * bound to a different channel/command set - see bots.config.json and
 * docs/project_plan.spec.md Section 21.
 *
 * It's an independent consumer of the same normalized radio.packet stream
 * the MQTT packet pipeline uses. It decrypts GRP_TXT messages on its own
 * channel directly from the raw captured frame (route/path/hop data isn't
 * available on meshcore.js's higher-level ChannelMsgRecv event - only a
 * plaintext string and a hop count are), so this bot never touches
 * ChannelMsgRecv and has only one event source to begin with - the raw-
 * vs-decoded-event double-reply scenario Section 21 warns about
 * structurally can't occur here. A redelivered-identical frame (observed
 * happening on real hardware) is still guarded against via its own
 * deduplicator, per Section 15's "do not maintain unrelated duplicate
 * caches" - this bot's cache and the packet pipeline's are separate
 * instances of the same reusable utility, each serving its own consumer,
 * matching the reference Python observer's own precedent (recent_rf_packets
 * vs test_replied_packets).
 *
 * Bot failure must never stop packet capture or MQTT (Section 21).
 * start()/#handleRawPacket() catch and log locally, so nothing from
 * matching/decrypting a trigger ever throws outward. sendQueuedReply()
 * is the one deliberate exception - see its own doc comment - a send
 * failure there propagates to the shared ReplyQueue's dispatcher, which
 * provides the same catch-and-continue guarantee one level up.
 */
export class ChannelBot {
  #radioManager;
  #name;
  #channelName;
  #enabled;
  #minHops;
  #maxMessageBytes;
  #commands;
  #lookupCommands;
  #nodeRegistry;
  #logger;
  #deduplicator;
  #repeatCheckTracker;
  #channelIdx = null;
  #channelSecret = null;
  #channelHash = null;
  #ready = false;
  #repliesSent = 0;
  #repeatsConfirmed = 0;
  #repeatsUnconfirmed = 0;
  #replyQueue;
  #now;
  #onRadioConnected = null;
  #onRadioPacket = null;

  /**
   * `replyQueue` (see reply-queue.js) is a single instance *shared across
   * every configured bot* - "the local frequency" is one physical radio,
   * so FIFO ordering and quiet-window detection only make sense as one
   * shared resource, not per-bot state. It defaults to an immediate
   * "queue" - dispatching straight back to this bot's own
   * sendQueuedReply(), with its own catch - so a bot built without one
   * (e.g. in tests that don't care about send timing) still replies
   * right away and a send failure still can't escape as an unhandled
   * rejection. It's also the single place reply-lifecycle metrics are
   * recorded (see reply-queue.js's recordOutcome) - this bot has no
   * enqueue timestamp of its own to report against, so it doesn't attempt
   * to record anything metrics-related itself.
   */
  constructor({
    radioManager,
    botConfig,
    logger,
    deduplicator = new PacketDeduplicator(),
    repeatCheckTimeoutMs = DEFAULT_REPEAT_CHECK_TIMEOUT_MS,
    now = () => Date.now(),
    repeatCheckTracker = new RepeatCheckTracker({ timeoutMs: repeatCheckTimeoutMs, now }),
    replyQueue,
    nodeRegistry
  }) {
    this.#radioManager = radioManager;
    this.#name = botConfig.name;
    this.#channelName = botConfig.channel;
    this.#enabled = botConfig.enabled;
    this.#minHops = botConfig.minHops;
    this.#maxMessageBytes = botConfig.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.#commands = new Map(botConfig.commands.map((command) => [command.trigger, command]));
    this.#lookupCommands = botConfig.commands.filter((command) => command.kind === 'lookup');
    this.#nodeRegistry = nodeRegistry;
    this.#now = now;
    this.#logger = logger;
    this.#deduplicator = deduplicator;
    this.#repeatCheckTracker = repeatCheckTracker;

    if (this.#lookupCommands.length > 0 && !nodeRegistry) {
      throw new Error(`bot "${this.#name}" has a lookup command but no nodeRegistry was provided`);
    }
    // sendQueuedReply() intentionally lets a send failure propagate (see
    // its own doc comment) for a real ReplyQueue to catch/count/log - this
    // default stub is the one place standing in for that catch when no
    // queue is injected, so a send failure here still can't become an
    // unhandled rejection or a silently swallowed failure.
    this.#replyQueue =
      replyQueue ??
      {
        enqueue: (item) => {
          this.sendQueuedReply(item).catch((err) => {
            this.#logger.warn('bots.channelBot', 'failed to send reply', { bot: this.#name, error: err.message });
          });
        }
      };
  }

  get name() {
    return this.#name;
  }

  start() {
    if (!this.#enabled) {
      this.#logger.info('bots.channelBot', 'bot disabled by configuration', { bot: this.#name });
      return;
    }

    this.#onRadioConnected = () => {
      this.#setup().catch((err) => {
        this.#logger.warn('bots.channelBot', 'unexpected error during channel setup', {
          bot: this.#name,
          error: err.message
        });
      });
    };
    this.#onRadioPacket = (rawPush) => {
      this.#handleRawPacket(rawPush).catch((err) => {
        this.#logger.warn('bots.channelBot', 'unexpected error handling a packet', {
          bot: this.#name,
          error: err.message
        });
      });
    };
    this.#radioManager.on('radio.connected', this.#onRadioConnected);
    this.#radioManager.on('radio.packet', this.#onRadioPacket);
  }

  /**
   * Idempotent: unsubscribes this bot from radio events and marks it not
   * ready, so a shutdown in progress (see index.js) can guarantee no new
   * packet ever reaches #handleRawPacket() again, even if the radio
   * connection itself stays open a little longer while other resources
   * finish closing. Safe to call whether or not start() ever ran (a bot
   * disabled by configuration never subscribed to begin with) and safe to
   * call more than once.
   */
  stop() {
    if (this.#onRadioConnected) {
      this.#radioManager.off('radio.connected', this.#onRadioConnected);
      this.#onRadioConnected = null;
    }
    if (this.#onRadioPacket) {
      this.#radioManager.off('radio.packet', this.#onRadioPacket);
      this.#onRadioPacket = null;
    }
    this.#ready = false;
  }

  isReady() {
    return this.#ready;
  }

  getRepliesSent() {
    return this.#repliesSent;
  }

  /** Replies confirmed rebroadcast onto the mesh (see #checkForRepeat). */
  getRepeatsConfirmed() {
    return this.#repeatsConfirmed;
  }

  /** Replies whose repeat-check window elapsed with no confirmed rebroadcast heard. */
  getRepeatsUnconfirmed() {
    return this.#repeatsUnconfirmed;
  }

  async #setup() {
    this.#ready = false;
    const result = await ensureChannel({
      runCommand: (fn) => this.#radioManager.runCommand(fn),
      channelName: this.#channelName,
      logger: this.#logger
    });

    if (!result) {
      this.#logger.warn('bots.channelBot', 'replies disabled: no channel available', {
        bot: this.#name,
        channel: this.#channelName
      });
      return;
    }

    this.#channelIdx = result.channelIdx;
    this.#channelSecret = result.secret;
    this.#channelHash = channelHashForKey(result.secret);
    this.#ready = true;
    this.#logger.info('bots.channelBot', 'bot ready', {
      bot: this.#name,
      channelIdx: result.channelIdx,
      channel: this.#channelName
    });
  }

  async #handleRawPacket(rawPush) {
    if (!this.#ready) {
      return;
    }

    let normalized;
    try {
      normalized = normalizeRawPacketEvent(rawPush);
    } catch {
      return; // already logged by the packet pipeline's own handling
    }

    let packet;
    try {
      packet = Packet.fromBytes(Buffer.from(normalized.frameHex, 'hex'));
    } catch {
      return;
    }

    if (packet.payload_type !== PAYLOAD_TYPE_GRP_TXT || packet.payload.length < 3) {
      return;
    }

    // packet.payload is a plain Uint8Array (not a Node Buffer) - wrap once
    // so .toString('hex') behaves correctly rather than Array-joining bytes
    // as decimal.
    const payload = Buffer.from(packet.payload);

    const channelHash = payload.subarray(0, 1).toString('hex');
    if (channelHash !== this.#channelHash) {
      this.#logger.debug('bots.channelBot', 'ignored GRP_TXT on a different channel', {
        bot: this.#name,
        channel: this.#channelName,
        expectedChannelHash: this.#channelHash,
        packetChannelHash: channelHash
      });
      return;
    }

    const cipherMac = payload.subarray(1, 3);
    const ciphertext = payload.subarray(3);
    const decrypted = decryptGroupText(ciphertext, cipherMac, this.#channelSecret);
    if (!decrypted) {
      // Channel hash matched (1-in-256 chance of a coincidental collision
      // with an unrelated channel) but the MAC didn't verify - never log
      // the secret/ciphertext itself, just that this happened.
      this.#logger.debug('bots.channelBot', 'GRP_TXT on this channel failed to decrypt', {
        bot: this.#name,
        channel: this.#channelName
      });
      return;
    }

    // Checked before the sender-prefix bail below: our own reply templates
    // never carry a "name: " prefix, so a rebroadcast of our own reply
    // decrypts with sender: null and would otherwise never reach any check
    // at all. Any successfully-decrypted plaintext is fair game here -
    // repeat-confirmation doesn't require a sender to attribute the message
    // to, unlike trigger-matching below.
    this.#checkForRepeat(decrypted.text, hopCountFor(packet));

    if (!decrypted.sender) {
      this.#logger.debug('bots.channelBot', 'GRP_TXT on this channel had no sender prefix', {
        bot: this.#name,
        channel: this.#channelName
      });
      return;
    }

    let command = this.#commands.get(decrypted.text);
    // Distinct name from ReplyQueue's own `outcome` ('sent'/'failed'/...
    // written onto a spread copy of the queued item once dispatch settles,
    // see reply-queue.js#safeRecordOutcome) - this is a different axis
    // entirely (which of a 'lookup' command's four response templates
    // applies), and reusing the same name would read as if one shadowed
    // the other.
    let lookupOutcome;
    let query;
    let name;
    let matchCount;
    let lastHeardAt;
    let nodePrefix;
    let repeaterCount;

    if (!command) {
      const lookupMatch = this.#matchLookupCommand(decrypted.text);
      if (lookupMatch) {
        ({ command, outcome: lookupOutcome, query, name, matchCount, lastHeardAt, nodePrefix, repeaterCount } = lookupMatch);
      }
    }

    if (!command) {
      this.#logger.debug('bots.channelBot', 'decrypted message did not match any configured trigger', {
        bot: this.#name,
        sender: decrypted.sender,
        text: decrypted.text,
        configuredTriggers: [...this.#commands.keys()]
      });
      return;
    }

    const hopCount = hopCountFor(packet);
    if (hopCount < this.#minHops) {
      this.#logger.debug('bots.channelBot', 'trigger matched but hop count is below the configured minimum', {
        bot: this.#name,
        sender: decrypted.sender,
        trigger: decrypted.text,
        hopCount,
        minHops: this.#minHops
      });
      return;
    }

    // Deduplicated here, immediately before replying, rather than at the
    // top of this method: MeshCore flood relaying leaves the encrypted
    // payload unchanged as it hops (only the path grows), so the direct
    // and relayed deliveries of the *same* logical message share the
    // identical hash (calculatePacketHash only folds in pathLen for TRACE
    // packets). Deduping earlier would let a first, too-few-hops delivery
    // permanently blackhole a later delivery of the same message that
    // *does* clear minHops - this ordering lets that later delivery still
    // win, while still guaranteeing at most one reply per accepted trigger.
    const hash = calculatePacketHash(packet.payload_type, packet.pathLen, payload);
    if (this.#deduplicator.isDuplicate(hash)) {
      this.#logger.debug('bots.channelBot', 'ignored duplicate delivery of an already-replied-to trigger', {
        bot: this.#name,
        hash
      });
      return;
    }

    // Queued rather than sent immediately: the shared ReplyQueue holds
    // this until a quiet window is observed on the physical RF channel,
    // in FIFO order across every bot (see reply-queue.js). Enqueued after
    // dedup, not before: isDuplicate() already marked this hash as seen
    // synchronously above, so a redelivery arriving while this is still
    // queued is still correctly caught as a duplicate by its own
    // #handleRawPacket call, regardless of when this one actually sends.
    // Plain data, not a closure - see reply-queue.js and reply-dispatcher.js
    // for why: it's what makes the queue directly reportable (queued per
    // bot/command/sender) and keeps the actual send in one shared,
    // auditable path instead of one closure per enqueue() call.
    this.#replyQueue.enqueue({
      botName: this.#name,
      channel: this.#channelName,
      // command.trigger, not decrypted.text: for a 'lookup' command
      // decrypted.text also carries the query argument (e.g.
      // "!lookup E85C"), but sendQueuedReply looks the command config back
      // up by its bare trigger. For an 'exact' command the two are always
      // identical, since that's what made this.#commands.get() match.
      trigger: command.trigger,
      sender: decrypted.sender,
      hopCount,
      path: formatPath(packet),
      // Lowercase: matches the packet hash format used in URLs on
      // downstream platforms this observer publishes to (e.g. an OKI Mesh
      // CoreScope packet link, https://map.okimesh.org/#/packets/{hash}),
      // which a bots.config.json response template can reference directly.
      // This is the SAME hash published in the MQTT "packets" topic
      // payload's "hash" field (there uppercase, matching the existing
      // compatibility format), just lowercased for this purpose.
      hash: hash.toLowerCase(),
      // Only populated for a 'lookup' command match (see
      // #matchLookupCommand) - undefined for 'exact' commands, which
      // sendQueuedReply ignores in favor of the single `response` template.
      query,
      lookupOutcome,
      name,
      matchCount,
      lastHeardAt,
      nodePrefix,
      repeaterCount
    });
  }

  /**
   * Checks `text` against every configured 'lookup' command's trigger,
   * resolving the argument (if any) against the node registry. Returns
   * `null` if `text` doesn't match any lookup trigger at all - as opposed
   * to matching one with a missing/invalid argument, which resolves to
   * `outcome: 'invalid'` rather than falling through to "no trigger
   * matched" (the operator gets a helpful reply either way).
   *
   * Only the first configured lookup command whose trigger matches is
   * used - two lookup commands sharing a trigger isn't a supported
   * configuration.
   */
  #matchLookupCommand(text) {
    for (const command of this.#lookupCommands) {
      const { trigger } = command;
      let query;
      if (text === trigger) {
        query = '';
      } else if (text.startsWith(`${trigger} `)) {
        query = text.slice(trigger.length + 1).trim();
      } else {
        continue;
      }

      if (query.length === 0) {
        return { command, outcome: 'invalid', query };
      }

      const result = this.#nodeRegistry.findByPrefix(query, { type: 'REPEATER' });
      return {
        command,
        outcome: result.status,
        query: result.query ?? query,
        name: result.node?.name,
        matchCount: result.matchCount,
        lastHeardAt: result.node?.lastHeardAt,
        nodePrefix:
          result.status === 'found' && query.length < 4
            ? result.node?.publicKeyHex?.slice(0, 4) ?? result.query ?? query
            : result.query ?? query,
        repeaterCount: result.status === 'not_found' ? this.#nodeRegistry.countRepeaters() : undefined
      };
    }
    return null;
  }

  /**
   * Renders and sends the reply for one queued item, then records its
   * own bookkeeping (counters, logging) - reply-lifecycle metrics
   * persistence lives in the shared ReplyQueue instead (see reply-queue.js),
   * which has the enqueue timestamp this method doesn't. Public because
   * it's invoked from outside this instance - by the shared ReplyQueue's
   * dispatcher (see reply-dispatcher.js) once a quiet window is
   * observed, not by anything reachable from over-the-air data.
   *
   * A send failure here is deliberately left to propagate to that
   * dispatcher rather than being caught locally: ReplyQueue's own
   * dispatch step (see reply-queue.js #tick()) already catches it,
   * counts it in totalFailed, and logs it with channel/sender context
   * this method would otherwise have to duplicate - catching and
   * swallowing it here too would either double-log the same failure or,
   * worse, let the queue miscount a failed send as sent. Bot failure
   * still can't stop packet capture/MQTT (Section 21): the queue's catch
   * is what provides that guarantee for this path, one level up from
   * where every other public method here still catches locally.
   *
   * @param {{trigger: string, sender: string, hopCount: number, path: string, hash: string, query?: string, lookupOutcome?: string, name?: string, matchCount?: number, lastHeardAt?: number, nodePrefix?: string, repeaterCount?: number}} item
   */
  async sendQueuedReply({ trigger, sender, hopCount, path, hash, query, lookupOutcome, name, matchCount, lastHeardAt, nodePrefix, repeaterCount }) {
    const command = this.#commands.get(trigger);
    if (!command) {
      // Not expected in the current architecture (bots.config.json is
      // immutable for the life of the process, and only a matched
      // trigger is ever enqueued) - thrown, not silently dropped, so it's
      // still counted/logged as a failed dispatch rather than miscounted
      // as sent.
      throw new Error(`no configured command matches trigger "${trigger}"`);
    }

    // A 'lookup' command has no single `response` template - which of its
    // four outcome-specific templates applies was already decided at match
    // time (see #matchLookupCommand) and travels with the queued item as
    // `lookupOutcome` (named apart from ReplyQueue's own `outcome` - see
    // #handleRawPacket - so the two never get confused for each other).
    // Only that one outcome's template is ever rendered, so an 'exact'
    // command's overflow-degradation behavior (see response-template.js)
    // is the only kind that ever gets an `overflowTemplate`.
    const template =
      command.kind === 'lookup' ? this.#lookupResponseTemplate(command, lookupOutcome) : command.response;
    const overflowTemplate = command.kind === 'lookup' ? undefined : command.overflowResponse;

    const { message, degraded } = renderResponse({
      template,
      overflowTemplate,
      values: {
        sender,
        hopCount,
        path,
        trigger,
        hash,
        query,
        name,
        matchCount,
        lastHeard: formatRelativeAge(lastHeardAt, this.#now()),
        nodePrefix: nodePrefix ?? query,
        repeaterCount:
          repeaterCount ?? (lookupOutcome === 'not_found' ? this.#nodeRegistry.countRepeaters() : undefined)
      },
      maxBytes: this.#maxMessageBytes
    });

    await this.#radioManager.runCommand((connection) => connection.sendChannelTextMessage(this.#channelIdx, message));
    this.#repliesSent += 1;
    this.#logger.info('bots.channelBot', 'sent reply', { bot: this.#name, sender, hopCount, trigger, degraded });

    // Registered after the send resolves rather than before: only a
    // reply that actually went out is worth watching for an echo. See
    // #checkForRepeat for how a later heard packet resolves this.
    const expired = this.#repeatCheckTracker.register(message, { sender, trigger, hash });
    this.#reportExpiredRepeatChecks(expired);
  }

  /**
   * Called for every successfully-decrypted GRP_TXT on this channel,
   * including ones with no sender prefix (see #handleRawPacket). MeshCore
   * flood relaying leaves a GRP_TXT's encrypted payload unchanged as it
   * hops, and this device can't hear its own outgoing transmission
   * (half-duplex), so an exact plaintext match here is necessarily a
   * rebroadcast of a reply this bot sent, not an echo of our own TX.
   */
  #checkForRepeat(text, hopCount) {
    const { confirmed, expired } = this.#repeatCheckTracker.checkAndConsume(text);
    this.#reportExpiredRepeatChecks(expired);

    if (!confirmed) {
      return;
    }

    this.#repeatsConfirmed += 1;
    this.#logger.info('bots.channelBot', 'confirmed reply was repeated on the mesh', {
      bot: this.#name,
      sender: confirmed.meta.sender,
      trigger: confirmed.meta.trigger,
      hash: confirmed.meta.hash,
      hopCount,
      elapsedMs: confirmed.elapsedMs
    });
  }

  #reportExpiredRepeatChecks(expired) {
    for (const meta of expired) {
      this.#repeatsUnconfirmed += 1;
      this.#logger.debug('bots.channelBot', 'reply repeat not confirmed within timeout', {
        bot: this.#name,
        sender: meta.sender,
        trigger: meta.trigger,
        hash: meta.hash
      });
    }
  }

  #lookupResponseTemplate(command, lookupOutcome) {
    switch (lookupOutcome) {
      case 'found':
        return command.foundResponse;
      case 'not_found':
        return command.notFoundResponse;
      case 'ambiguous':
        return command.ambiguousResponse;
      default:
        return command.invalidResponse;
    }
  }
}
