import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Constants } from '@liamcottle/meshcore.js';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { PacketDeduplicator } from '../packets/packet-deduplicator.js';
import { renderResponse, DEFAULT_MAX_MESSAGE_BYTES } from './response-template.js';

const contactMessageSchema = {
  $id: 'meshcore-observer/bots/direct-contact-message',
  type: 'object', additionalProperties: false,
  required: ['generation', 'pubKeyPrefixHex', 'pathLen', 'txtType', 'senderTimestamp', 'text'],
  properties: {
    generation: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    pubKeyPrefixHex: { type: 'string', pattern: '^[0-9A-F]{12}$' },
    pathLen: { type: 'integer', minimum: 0, maximum: 255 },
    txtType: { type: 'integer', minimum: 0, maximum: 255 },
    senderTimestamp: { type: 'integer', minimum: 0, maximum: 4294967295 },
    text: { type: 'string', maxLength: 256, pattern: '^[^\\u0000-\\u001F\\u007F]*$' }
  }
};

const contactRecordSchema = {
  $id: 'meshcore-observer/bots/direct-contact-record',
  type: 'object', additionalProperties: false,
  required: ['publicKeyHex', 'advertisedName'],
  properties: {
    publicKeyHex: { type: 'string', pattern: '^[0-9A-F]{64}$' },
    advertisedName: {
      anyOf: [
        { type: 'string', minLength: 1, maxLength: 32, pattern: '^[^\\u0000-\\u001F\\u007F]+$' },
        { type: 'null' }
      ]
    }
  }
};

const contactListSchema = {
  $id: 'meshcore-observer/bots/direct-contact-list',
  type: 'array', maxItems: 4096, items: contactRecordSchema
};

const contactMessageValid = compileSchema(contactMessageSchema);
const contactListValid = compileSchema(contactListSchema);
const messageHashKey = randomBytes(32);
function contactFingerprint(publicKeyHex) {
  return createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').toUpperCase();
}

function messageHash(message) {
  return createHmac('sha256', messageHashKey)
    .update(message.pubKeyPrefixHex)
    .update(String(message.senderTimestamp))
    .update(message.text)
    .digest('hex').slice(0, 16).toUpperCase();
}

function normalizePublicKey(publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== 32) return null;
  return Buffer.from(publicKey).toString('hex').toUpperCase();
}

function normalizeAnswer(answer) {
  return answer.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

/** Handles first-contact welcomes and configured private commands for known Companion contacts. */
export class DirectMessageBot {
  #radioManager;
  #botConfig;
  #logger;
  #store;
  #commandHandlers;
  #announceChannelMessage;
  #commands;
  #challenge;
  #now;
  #deduplicator;
  #contactsByPrefix = new Map();
  #contactsByAdvertisedName = new Map();
  #advertisedNamesByPublicKey = new Map();
  #contactIndexGeneration = null;
  #contactIndexPromise = null;
  #lastUnresolvedContactRefreshAt = null;
  #welcomingContacts = new Set();
  #challengingContacts = new Set();
  #ready = false;
  #repliesSent = 0;
  #onRadioConnected = null;
  #onRadioDisconnected = null;
  #onContactMessage = null;

  constructor({ radioManager, botConfig, logger, store, commandHandlers, announceChannelMessage = () => false,
    now = () => Date.now(), deduplicator = new PacketDeduplicator() }) {
    this.#radioManager = radioManager;
    this.#botConfig = botConfig;
    this.#logger = logger;
    this.#store = store;
    this.#commandHandlers = commandHandlers;
    this.#announceChannelMessage = announceChannelMessage;
    this.#commands = botConfig.commands;
    this.#challenge = botConfig.challenge ?? null;
    this.#now = now;
    this.#deduplicator = deduplicator;
  }

  get name() {
    return this.#botConfig.name;
  }

  start() {
    if (!this.#botConfig.enabled) {
      this.#logger.info('bots.directMessageBot', 'bot disabled by configuration', { bot: this.name });
      return;
    }

    this.#onRadioConnected = () => {
      const snapshot = this.#radioManager.getConnectionSnapshot();
      this.#ready = false;
      this.#contactIndexGeneration = null;
      this.#contactsByPrefix.clear();
      this.#contactsByAdvertisedName.clear();
      this.#advertisedNamesByPublicKey.clear();
      this.#lastUnresolvedContactRefreshAt = null;
      this.#loadContactIndex(snapshot.generation).catch((error) => {
        this.#logger.warn('bots.directMessageBot', 'could not load Companion contacts for private messages', {
          bot: this.name,
          error: error.message
        });
      });
    };
    this.#onRadioDisconnected = () => {
      this.#ready = false;
      this.#contactIndexGeneration = null;
      this.#contactsByPrefix.clear();
      this.#contactsByAdvertisedName.clear();
      this.#advertisedNamesByPublicKey.clear();
      this.#lastUnresolvedContactRefreshAt = null;
    };
    this.#onContactMessage = (message) => {
      this.#handleContactMessage(message).catch((error) => {
        this.#logger.warn('bots.directMessageBot', 'failed to handle a private message', {
          bot: this.name,
          error: error.message
        });
      });
    };

    this.#radioManager.on('radio.connected', this.#onRadioConnected);
    this.#radioManager.on('radio.disconnected', this.#onRadioDisconnected);
    this.#radioManager.on('radio.contactMessage', this.#onContactMessage);
  }

  stop() {
    if (this.#onRadioConnected) this.#radioManager.off('radio.connected', this.#onRadioConnected);
    if (this.#onRadioDisconnected) this.#radioManager.off('radio.disconnected', this.#onRadioDisconnected);
    if (this.#onContactMessage) this.#radioManager.off('radio.contactMessage', this.#onContactMessage);
    this.#onRadioConnected = null;
    this.#onRadioDisconnected = null;
    this.#onContactMessage = null;
    this.#ready = false;
  }

  isReady() {
    return this.#ready;
  }

  getRepliesSent() {
    return this.#repliesSent;
  }

  getRepeatsConfirmed() {
    return 0;
  }

  getRepeatsUnconfirmed() {
    return 0;
  }

  sweepRepeatChecks() {
    return 0;
  }

  async #loadContactIndex(generation, { force = false } = {}) {
    if (generation === null) return;
    if (!force && this.#contactIndexGeneration === generation) return;
    if (this.#contactIndexPromise) {
      await this.#contactIndexPromise.catch(() => {});
      if (!force && this.#contactIndexGeneration === generation) return;
    }

    this.#contactIndexPromise = this.#radioManager.runCommand(
      (connection) => connection.getContacts(),
      { generation, requireReady: true, timeoutMs: 30000 }
    ).then((contacts) => {
      const current = this.#radioManager.getConnectionSnapshot();
      if (!current.ready || current.generation !== generation) return;

      const normalizedContacts = Array.isArray(contacts)
        ? contacts.map((contact) => ({
          publicKeyHex: normalizePublicKey(contact?.publicKey),
          advertisedName: typeof contact?.advName === 'string' && contact.advName.length > 0
            ? contact.advName : null
        }))
        : contacts;
      if (!contactListValid(normalizedContacts)) {
        throw new Error(`Invalid Companion contact list: ${formatErrors(contactListValid.errors)}`);
      }

      const byPrefix = new Map();
      const byAdvertisedName = new Map();
      const namesByPublicKey = new Map();
      for (const { publicKeyHex, advertisedName } of normalizedContacts) {
        const prefix = publicKeyHex.slice(0, 12);
        const matches = byPrefix.get(prefix) ?? [];
        matches.push(publicKeyHex);
        byPrefix.set(prefix, matches);
        if (advertisedName) {
          namesByPublicKey.set(publicKeyHex, advertisedName);
          const nameMatches = byAdvertisedName.get(advertisedName) ?? [];
          nameMatches.push(publicKeyHex);
          byAdvertisedName.set(advertisedName, nameMatches);
        }
      }

      this.#contactsByPrefix = byPrefix;
      this.#contactsByAdvertisedName = byAdvertisedName;
      this.#advertisedNamesByPublicKey = namesByPublicKey;
      this.#contactIndexGeneration = generation;
      this.#ready = true;
      this.#logger.info('bots.directMessageBot', 'direct-message bot ready', {
        bot: this.name,
        knownContacts: contacts.length
      });
    }).finally(() => {
      this.#contactIndexPromise = null;
    });

    return this.#contactIndexPromise;
  }

  /** Resolves a channel sender label only when exactly one Companion advert name matches. */
  async lookupContactByAdvertisedName(name, generation) {
    await this.#loadContactIndex(generation);
    if (!this.#ready || this.#contactIndexGeneration !== generation) return { status: 'unavailable' };

    let matches = this.#contactsByAdvertisedName.get(name) ?? [];
    const now = this.#now();
    if (matches.length !== 1
      && (this.#lastUnresolvedContactRefreshAt === null || now - this.#lastUnresolvedContactRefreshAt >= 60000)) {
      this.#lastUnresolvedContactRefreshAt = now;
      await this.#loadContactIndex(generation, { force: true });
      matches = this.#contactsByAdvertisedName.get(name) ?? [];
    }
    if (matches.length === 0) return { status: 'not-found' };
    if (matches.length !== 1) return { status: 'ambiguous' };
    return { status: 'found', contactFingerprint: contactFingerprint(matches[0]) };
  }

  async #handleContactMessage(message) {
    if (!contactMessageValid(message)) {
      this.#logger.warn('bots.directMessageBot', 'ignored malformed Companion contact message', { bot: this.name });
      return;
    }
    if (message.txtType !== Constants.TxtTypes.Plain || Buffer.byteLength(message.text, 'utf8') > 512) {
      this.#logger.info('bots.directMessageBot', 'ignored unsupported private message format', { bot: this.name });
      return;
    }
    if (this.#deduplicator.isDuplicate(messageHash(message))) return;

    await this.#loadContactIndex(message.generation);
    if (!this.#ready || this.#contactIndexGeneration !== message.generation) return;

    let contactMatches = this.#contactsByPrefix.get(message.pubKeyPrefixHex) ?? [];
    const now = this.#now();
    if (contactMatches.length !== 1
      && (this.#lastUnresolvedContactRefreshAt === null || now - this.#lastUnresolvedContactRefreshAt >= 60000)) {
      this.#lastUnresolvedContactRefreshAt = now;
      await this.#loadContactIndex(message.generation, { force: true });
      contactMatches = this.#contactsByPrefix.get(message.pubKeyPrefixHex) ?? [];
    }
    if (contactMatches.length !== 1) {
      this.#logger.warn('bots.directMessageBot', 'ignored private message without a unique known contact', {
        bot: this.name,
        matchCount: contactMatches.length
      });
      return;
    }

    const publicKeyHex = contactMatches[0];
    const fingerprint = contactFingerprint(publicKeyHex);
    if (!this.#store.hasCompletedDirectWelcome(fingerprint)) {
      const advertisedName = this.#advertisedNamesByPublicKey.get(publicKeyHex) ?? 'QCC attendee';
      await this.#sendFirstContactWelcome(publicKeyHex, fingerprint, message.generation, advertisedName);
      return;
    }

    if (this.#challenge?.questions?.length > 0) {
      await this.#handleChallengeMessage(message, publicKeyHex, fingerprint);
      return;
    }

    await this.#sendConfiguredCommand(message, publicKeyHex);
  }

  async #handleChallengeMessage(message, publicKeyHex, fingerprint) {
    if (this.#challengingContacts.has(fingerprint)) return;
    this.#challengingContacts.add(fingerprint);
    try {
      const questions = this.#challenge.questions;
      const progress = this.#store.getDirectChallengeProgress(fingerprint);
      if (!progress) {
        await this.#sendPrivateText(questions[0].prompt, publicKeyHex, message.generation);
        this.#store.startDirectChallenge({ contactFingerprint: fingerprint, startedAt: this.#now() });
        return;
      }

      if (progress.questionIndex >= questions.length) {
        await this.#sendConfiguredCommand(message, publicKeyHex);
        return;
      }

      const question = questions[progress.questionIndex];
      const answer = normalizeAnswer(message.text);
      const correct = question.answers.some((accepted) => normalizeAnswer(accepted) === answer);
      if (!correct) {
        const { message: response } = renderResponse({
          template: `${this.#challenge.incorrectResponse} {prompt}`,
          overflowTemplate: '{prompt}',
          values: { prompt: question.prompt },
          maxBytes: this.#botConfig.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
        });
        await this.#sendPrivateText(response, publicKeyHex, message.generation);
        return;
      }

      const nextQuestionIndex = progress.questionIndex + 1;
      const completed = nextQuestionIndex === questions.length;
      const response = completed ? this.#challenge.completeResponse : questions[nextQuestionIndex].prompt;
      await this.#sendPrivateText(response, publicKeyHex, message.generation);
      const advanced = this.#store.advanceDirectChallengeProgress({
        contactFingerprint: fingerprint,
        expectedQuestionIndex: progress.questionIndex,
        nextQuestionIndex,
        updatedAt: this.#now(),
        completedAt: completed ? this.#now() : null
      });
      if (!advanced) {
        this.#logger.warn('bots.directMessageBot', 'challenge progress changed while handling an answer', {
          bot: this.name
        });
      } else if (completed) {
        this.#announceChannelChallengeMessage(
          "@[{sender}] has completed the tomb's trials",
          this.#advertisedNamesByPublicKey.get(publicKeyHex) ?? 'QCC attendee'
        );
      }
    } finally {
      this.#challengingContacts.delete(fingerprint);
    }
  }

  async #sendPrivateText(text, publicKeyHex, generation) {
    await this.#sendFlood(publicKeyHex, text, generation);
    this.#repliesSent += 1;
  }

  /**
   * Sends a private reply as a flood. Resetting the contact's stored outbound
   * path immediately before the send leaves the Companion with no direct route,
   * so firmware floods the message instead of trusting a possibly stale path.
   * Both commands run in one queued radio command so nothing can interleave.
   * A failed reset is not fatal: the send still goes out on the stored path.
   */
  async #sendFlood(publicKeyHex, text, generation) {
    await this.#radioManager.runCommand(
      async (connection) => {
        const recipientKey = Buffer.from(publicKeyHex, 'hex');
        // Channel replies may leave a connection-session flood scope active.
        // Private replies use the Companion's device-default routing policy.
        await connection.clearFloodScope();
        try {
          await connection.resetPath(recipientKey);
        } catch (error) {
          this.#logger.warn('bots.directMessageBot', 'could not reset contact path before private reply; sending on stored path', {
            bot: this.name,
            error: error?.message ?? 'Companion rejected the path reset'
          });
        }
        return connection.sendTextMessage(recipientKey, text, Constants.TxtTypes.Plain);
      },
      { generation, requireReady: true, timeoutMs: 10000 }
    );
  }

  async #sendFirstContactWelcome(publicKeyHex, fingerprint, generation, advertisedName) {
    if (this.#welcomingContacts.has(fingerprint)) return;
    this.#welcomingContacts.add(fingerprint);
    try {
      await this.#sendFlood(publicKeyHex, this.#botConfig.welcomeMessage, generation);

      // The welcome is considered complete only after the Companion accepts
      // the send. This follows the requested send-then-record ordering.
      this.#store.markDirectWelcomeCompleted({ contactFingerprint: fingerprint, completedAt: this.#now() });
      this.#repliesSent += 1;
      this.#logger.info('bots.directMessageBot', 'sent first-contact welcome', { bot: this.name });
      this.#announceChannelChallengeMessage(
        '@[{sender}] has discovered the secret layer of #thetomb',
        advertisedName
      );
    } catch (error) {
      this.#logger.warn('bots.directMessageBot', 'first-contact welcome was not completed', {
        bot: this.name,
        error: error.message
      });
    } finally {
      this.#welcomingContacts.delete(fingerprint);
    }
  }

  #announceChannelChallengeMessage(message, sender) {
    try {
      const queued = this.#announceChannelMessage({ message, sender });
      if (!queued) {
        this.#logger.warn('bots.directMessageBot', 'could not queue a QCC challenge announcement', {
          bot: this.name
        });
      }
    } catch (error) {
      this.#logger.warn('bots.directMessageBot', 'could not queue a QCC challenge announcement', {
        bot: this.name,
        error: error.message
      });
    }
  }

  async #sendConfiguredCommand(message, publicKeyHex) {
    let match = null;
    let matchedHandler = null;
    for (const handler of this.#commandHandlers.values()) {
      const result = handler.match({ commands: this.#commands, text: message.text });
      if (result) {
        match = result;
        matchedHandler = handler;
        break;
      }
    }

    if (!match) {
      this.#logger.info('bots.directMessageBot', 'no configured private command matched', { bot: this.name });
      return;
    }

    const data = matchedHandler.restore(match.state);
    const action = await matchedHandler.execute({ command: match.command, data, now: this.#now() });
    const { message: response, degraded } = renderResponse({
      template: action.template,
      overflowTemplate: action.overflowTemplate,
      values: {
        sender: 'QCC attendee',
        hopCount: 0,
        path: 'direct',
        trigger: match.command.trigger,
        hash: messageHash(message),
        ...action.values
      },
      maxBytes: this.#botConfig.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    });

    this.#logger.info('bots.directMessageBot', 'accepted configured private command', {
      bot: this.name,
      trigger: match.command.trigger,
      handler: matchedHandler.kind
    });

    await this.#sendFlood(publicKeyHex, response, message.generation);
    this.#repliesSent += 1;
    this.#logger.info('bots.directMessageBot', 'sent configured private reply', {
      bot: this.name,
      trigger: match.command.trigger,
      degraded
    });
  }
}
