import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHintCommandHandler } from '../../src/bots/command-handlers/hint.js';

const command = {
  trigger: '!hint',
  kind: 'hint',
  response: 'Wait {retryMinutes}m.',
  notFoundResponse: 'No clue remains; {remainingCommands} commands remain.'
};
const clues = [
  { trigger: '!cleopatra', hint: 'A queen whose cipher guards the hall.' },
  { trigger: '!sphinx', hint: 'A riddle-loving guardian.' }
];

test('returns a random configured hint from unsolved commands and reserves the cooldown', () => {
  let reserved = false;
  const store = {
    getDiscoveredBotCommands: () => ['!hint', '!cleopatra'],
    reserveBotHintCooldown(input) {
      assert.equal(input.channel, '#thetomb');
      assert.equal(input.cooldownMs, 60 * 60 * 1000);
      reserved = true;
      return { allowed: true, retryAfterMs: 0 };
    }
  };
  const handler = createHintCommandHandler({
    store, channel: '#thetomb', commandTriggers: ['!hint', ...clues.map((clue) => clue.trigger)], maxMessageBytes: 120
  });
  const match = handler.match({ commands: [command, ...clues], text: '!hint' });
  const prepared = handler.prepareReply({ command, commands: [command, ...clues], now: 10 });
  assert.equal(reserved, true);
  assert.ok(clues.some((clue) => handler.restore(prepared).message === clue.hint));
  assert.equal(handler.execute({ data: handler.restore(prepared) }).message, handler.restore(prepared).message);
  assert.equal(match.command, command);
});

test('reports cooldown and remaining commands without choosing another hint', () => {
  let reserveCount = 0;
  const store = {
    getDiscoveredBotCommands: () => [],
    reserveBotHintCooldown: () => {
      reserveCount += 1;
      return { allowed: false, retryAfterMs: 61_000 };
    }
  };
  const handler = createHintCommandHandler({
    store, channel: '#thetomb', commandTriggers: ['!hint', ...clues.map((clue) => clue.trigger)], maxMessageBytes: 120
  });
  const state = handler.prepareReply({ command, commands: [command, ...clues], now: 10 });
  assert.equal(handler.restore(state).message, 'Wait 2m.');
  assert.equal(reserveCount, 1);
});

test('reports when the configured clue commands are solved without consuming cooldown', () => {
  let reserveCount = 0;
  const store = {
    getDiscoveredBotCommands: () => ['!hint', ...clues.map((clue) => clue.trigger)],
    reserveBotHintCooldown: () => {
      reserveCount += 1;
      return { allowed: true, retryAfterMs: 0 };
    }
  };
  const handler = createHintCommandHandler({
    store, channel: '#thetomb', commandTriggers: ['!hint', ...clues.map((clue) => clue.trigger)], maxMessageBytes: 120
  });
  const state = handler.prepareReply({ command, commands: [command, ...clues], now: 10 });
  assert.equal(handler.restore(state).message, 'No clue remains; 0 commands remain.');
  assert.equal(reserveCount, 0);
});
