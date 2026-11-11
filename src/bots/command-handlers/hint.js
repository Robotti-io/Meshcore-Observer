import { randomInt } from 'node:crypto';
import { createHandlerStateCodec } from './handler-state.js';
import { matchesCommandTrigger } from './command-matching.js';
import { DEFAULT_MAX_MESSAGE_BYTES, renderResponse } from '../response-template.js';

const HINT_COOLDOWN_MS = 60 * 60 * 1000;
const stateCodec = createHandlerStateCodec({
  kind: 'hint',
  dataSchema: {
    type: 'object', additionalProperties: false,
    required: ['message'],
    properties: { message: { type: 'string', minLength: 1, maxLength: 512 } }
  }
});

function messageState(message) {
  return stateCodec.serialize({ message });
}

/** Chooses one unsolved configured clue and reserves a durable channel cooldown. */
export function createHintCommandHandler({ store, channel, commandTriggers = [], maxMessageBytes }) {
  const maxBytes = Math.min(maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES, 512);

  return {
    kind: 'hint',
    match({ commands, text }) {
      const command = commands.find((candidate) => candidate.kind === 'hint'
        && matchesCommandTrigger(candidate.trigger, text));
      return command ? { command, state: messageState('☥ The scribes search the tomb.') } : null;
    },
    restore: stateCodec.restore,
    prepareReply({ command, commands, now }) {
      const discovered = new Set(store.getDiscoveredBotCommands({ channel }));
      const unsolved = commands.filter((candidate) => candidate.hint && !discovered.has(candidate.trigger));
      if (unsolved.length === 0) {
        const remainingCommands = commandTriggers.filter((trigger) => !discovered.has(trigger)).length;
        const { message } = renderResponse({
          template: command.notFoundResponse,
          values: { remainingCommands },
          maxBytes
        });
        return messageState(message);
      }

      const reservation = store.reserveBotHintCooldown({
        channel,
        requestedAt: now,
        cooldownMs: HINT_COOLDOWN_MS
      });
      if (!reservation.allowed) {
        const retryMinutes = Math.max(1, Math.ceil(reservation.retryAfterMs / 60000));
        const { message } = renderResponse({
          template: command.response,
          values: { retryMinutes },
          maxBytes
        });
        return messageState(message);
      }

      const selected = unsolved[randomInt(unsolved.length)];
      return messageState(selected.hint);
    },
    execute({ data }) {
      return { message: data.message, values: {} };
    }
  };
}
