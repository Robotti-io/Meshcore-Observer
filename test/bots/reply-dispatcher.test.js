import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplyDispatcher } from '../../src/bots/reply-dispatcher.js';

function fakeBot() {
  const calls = [];
  return {
    calls,
    sendQueuedReply: async (item) => {
      calls.push(item);
    }
  };
}

test('routes a queued item to the bot registered under its botName', async () => {
  const echoBot = fakeBot();
  const weatherBot = fakeBot();
  const botsByName = new Map([
    ['echo', echoBot],
    ['weather', weatherBot]
  ]);
  const dispatch = createReplyDispatcher(botsByName);

  const item = { botName: 'weather', trigger: '!weather' };
  await dispatch(item);

  assert.deepEqual(weatherBot.calls, [item]);
  assert.deepEqual(echoBot.calls, []);
});

test('looks up the bot registry live, not a snapshot taken at creation time', async () => {
  const botsByName = new Map();
  const dispatch = createReplyDispatcher(botsByName);

  // Registered after createReplyDispatcher() was called, matching how
  // src/index.js populates botsByName while constructing bots, before
  // any item could actually reach dispatch() (only possible once the
  // radio is connected and a trigger has matched).
  const echoBot = fakeBot();
  botsByName.set('echo', echoBot);

  const item = { botName: 'echo', trigger: '!echo' };
  await dispatch(item);

  assert.deepEqual(echoBot.calls, [item]);
});

test('throws when no bot is registered for the item\'s botName, rather than silently dropping it', async () => {
  const dispatch = createReplyDispatcher(new Map());

  await assert.rejects(() => dispatch({ botName: 'ghost', trigger: '!boo' }), /no bot registered.*"ghost"/);
});

test('propagates a rejection from the bot\'s own sendQueuedReply rather than swallowing it', async () => {
  const brokenBot = { sendQueuedReply: async () => { throw new Error('radio busy'); } };
  const dispatch = createReplyDispatcher(new Map([['echo', brokenBot]]));

  await assert.rejects(() => dispatch({ botName: 'echo', trigger: '!echo' }), /radio busy/);
});
