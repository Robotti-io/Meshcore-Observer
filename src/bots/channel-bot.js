import { Packet } from '@liamcottle/meshcore.js';
import { normalizeRawPacketEvent } from '../packets/packet-normalizer.js';
import { calculatePacketHash } from '../packets/packet-hash.js';
import { PacketDeduplicator } from '../packets/packet-deduplicator.js';
import { channelHashForKey } from './channel-key.js';
import { decryptGroupText } from './group-text-crypto.js';
import { ensureChannel } from './channel-setup.js';
import { renderResponse, DEFAULT_MAX_MESSAGE_BYTES } from './response-template.js';

const PAYLOAD_TYPE_GRP_TXT = 0x05;
const DIRECT_ROUTES = new Set(['DIRECT', 'TRANSPORT_DIRECT']);

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
  #logger;
  #deduplicator;
  #channelIdx = null;
  #channelSecret = null;
  #channelHash = null;
  #ready = false;
  #repliesSent = 0;
  #replyQueue;
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
    replyQueue
  }) {
    this.#radioManager = radioManager;
    this.#name = botConfig.name;
    this.#channelName = botConfig.channel;
    this.#enabled = botConfig.enabled;
    this.#minHops = botConfig.minHops;
    this.#maxMessageBytes = botConfig.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.#commands = new Map(botConfig.commands.map((command) => [command.trigger, command]));
    this.#logger = logger;
    this.#deduplicator = deduplicator;
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
    if (!decrypted || !decrypted.sender) {
      // Channel hash matched (1-in-256 chance of a coincidental collision
      // with an unrelated channel) but the MAC didn't verify, or the
      // plaintext had no "sender: " prefix to parse - never log the
      // secret/ciphertext itself, just that this happened.
      this.#logger.debug('bots.channelBot', 'GRP_TXT on this channel failed to decrypt or had no sender prefix', {
        bot: this.#name,
        channel: this.#channelName
      });
      return;
    }

    const command = this.#commands.get(decrypted.text);
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
      trigger: decrypted.text,
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
      hash: hash.toLowerCase()
    });
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
   * @param {{trigger: string, sender: string, hopCount: number, path: string, hash: string}} item
   */
  async sendQueuedReply({ trigger, sender, hopCount, path, hash }) {
    const command = this.#commands.get(trigger);
    if (!command) {
      // Not expected in the current architecture (bots.config.json is
      // immutable for the life of the process, and only a matched
      // trigger is ever enqueued) - thrown, not silently dropped, so it's
      // still counted/logged as a failed dispatch rather than miscounted
      // as sent.
      throw new Error(`no configured command matches trigger "${trigger}"`);
    }

    const { message, degraded } = renderResponse({
      template: command.response,
      overflowTemplate: command.overflowResponse,
      values: { sender, hopCount, path, trigger, hash },
      maxBytes: this.#maxMessageBytes
    });

    await this.#radioManager.runCommand((connection) => connection.sendChannelTextMessage(this.#channelIdx, message));
    this.#repliesSent += 1;
    this.#logger.info('bots.channelBot', 'sent reply', { bot: this.#name, sender, hopCount, trigger, degraded });
  }
}
