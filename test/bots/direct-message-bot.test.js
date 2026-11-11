import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { DirectMessageBot } from '../../src/bots/direct-message-bot.js';
import { MetricsStore } from '../../src/metrics/store.js';

const publicKey = new Uint8Array(32).fill(0x42);
const publicKeyHex = Buffer.from(publicKey).toString('hex').toUpperCase();
const contactFingerprint = createHash('sha256').update(publicKey).digest('hex').toUpperCase();

function createRadioManager(contacts = [{ publicKey, advName: 'QCC-Player' }]) {
  const events = new EventEmitter();
  const sentMessages = [];
  const connection = {
    getContacts: async () => contacts,
    sendTextMessage: async (recipientKey, text) => {
      sentMessages.push({ recipientKey: Buffer.from(recipientKey).toString('hex').toUpperCase(), text });
      return { accepted: true };
    }
  };
  return {
    events,
    sentMessages,
    on: (...args) => events.on(...args),
    off: (...args) => events.off(...args),
    getConnectionSnapshot: () => ({ ready: true, generation: 1 }),
    runCommand: async (action) => action(connection)
  };
}

function createBot({ radioManager, store }) {
  return new DirectMessageBot({
    radioManager,
    store,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    botConfig: {
      name: 'direct',
      type: 'direct',
      enabled: true,
      welcomeMessage: 'Welcome to QCC 0x4.',
      maxMessageBytes: 512,
      challenge: {
        questions: [
          { prompt: 'What year does the QCC origin story begin?', answers: ['2019'] },
          { prompt: 'Which organization puts on Queen City Con?', answers: ['Cannon Fodder Security', 'CFS'] }
        ],
        incorrectResponse: 'Not quite. Try again:',
        completeResponse: 'Challenge complete.'
      },
      commands: [{ trigger: '!help', response: 'Try !commands.' }]
    },
    commandHandlers: new Map()
  });
}

async function sendContactMessage(radioManager, senderTimestamp, text) {
  radioManager.events.emit('radio.contactMessage', {
    generation: 1,
    pubKeyPrefixHex: publicKeyHex.slice(0, 12),
    pathLen: 0,
    txtType: 0,
    senderTimestamp,
    text
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('welcomes once, starts the private Q&A on the next DM, and advances only on correct answers', async () => {
  const radioManager = createRadioManager();
  const store = new MetricsStore({ dbPath: ':memory:' });
  const bot = createBot({ radioManager, store });
  bot.start();
  radioManager.events.emit('radio.connected');

  assert.deepEqual(await bot.lookupContactByAdvertisedName('QCC-Player', 1), {
    status: 'found', contactFingerprint
  });

  await sendContactMessage(radioManager, 1, 'hello');
  assert.equal(radioManager.sentMessages[0].text, 'Welcome to QCC 0x4.');
  assert.equal(store.hasCompletedDirectWelcome(contactFingerprint), true);

  await sendContactMessage(radioManager, 2, 'start');
  assert.equal(radioManager.sentMessages[1].text, 'What year does the QCC origin story begin?');
  assert.equal(store.getDirectChallengeProgress(contactFingerprint).questionIndex, 0);

  await sendContactMessage(radioManager, 3, 'incorrect');
  assert.match(radioManager.sentMessages[2].text, /Not quite/);
  assert.match(radioManager.sentMessages[2].text, /What year/);
  assert.equal(store.getDirectChallengeProgress(contactFingerprint).questionIndex, 0);

  await sendContactMessage(radioManager, 4, '  2019  ');
  assert.equal(radioManager.sentMessages[3].text, 'Which organization puts on Queen City Con?');
  assert.equal(store.getDirectChallengeProgress(contactFingerprint).questionIndex, 1);

  bot.stop();
  store.close();
});

test('does not link duplicate advertised names to one player fingerprint', async () => {
  const secondPublicKey = new Uint8Array(32).fill(0x43);
  const radioManager = createRadioManager([
    { publicKey, advName: 'QCC-Player' },
    { publicKey: secondPublicKey, advName: 'QCC-Player' }
  ]);
  const store = new MetricsStore({ dbPath: ':memory:' });
  const bot = createBot({ radioManager, store });
  bot.start();
  radioManager.events.emit('radio.connected');

  assert.deepEqual(await bot.lookupContactByAdvertisedName('QCC-Player', 1), { status: 'ambiguous' });

  bot.stop();
  store.close();
});
