import { createHandlerStateCodec } from './handler-state.js';
import { matchesCommandTrigger } from './command-matching.js';
import { DEFAULT_MAX_MESSAGE_BYTES, renderResponse } from '../response-template.js';

const COMMAND_LIST_COOLDOWN_MS = 60 * 60 * 1000;
const stateCodec = createHandlerStateCodec({
  kind: 'discovery',
  dataSchema: {
    type: 'object', additionalProperties: false,
    required: ['message'],
    properties: { message: { type: 'string', minLength: 1, maxLength: 4096 } }
  }
});

function toHandlerState(message) {
  return stateCodec.serialize({ message });
}

function buildListMessages({ discoveredTriggers, totalCommands, maxBytes }) {
  const remainingCommands = totalCommands - discoveredTriggers.length;
  let summary = `☥ ${discoveredTriggers.length}/${totalCommands}; ${remainingCommands} left`;
  if (Buffer.byteLength(summary, 'utf8') > maxBytes) summary = `☥ ${remainingCommands} left`;
  const messages = [summary];
  let currentMessage = '☥ Found: ';

  for (const trigger of discoveredTriggers) {
    const separator = currentMessage === '☥ Found: ' ? '' : ', ';
    const candidate = `${currentMessage}${separator}${trigger}`;
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      currentMessage = candidate;
      continue;
    }

    if (currentMessage === '☥ Found: ') {
      throw new Error(`Configured command "${trigger}" is too long to include in the discovered-command list`);
    }
    messages.push(currentMessage);
    currentMessage = `☥ + ${trigger}`;
    if (Buffer.byteLength(currentMessage, 'utf8') > maxBytes) {
      throw new Error(`Configured command "${trigger}" is too long to include in the discovered-command list`);
    }
  }

  if (currentMessage !== '☥ Found: ') messages.push(currentMessage);
  return { messages, remainingCommands };
}

/** Builds a persisted, paged view of commands accepted in one channel. */
export function createDiscoveryCommandHandler({ store, channel, commandTriggers, maxMessageBytes }) {
  const uniqueTriggers = [...new Set(commandTriggers)];
  const maxBytes = Math.min(maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES, 512);

  return {
    kind: 'discovery',
    match({ commands, text }) {
      const command = commands.find((candidate) => candidate.kind === 'discovery'
        && matchesCommandTrigger(candidate.trigger, text));
      return command ? { command, state: toHandlerState('☥ Preparing the discovered-command list.') } : null;
    },
    restore: stateCodec.restore,
    prepare({ command, now }) {
      const discovered = new Set(store.getDiscoveredBotCommands({ channel }));
      discovered.add(command.trigger);
      const discoveredTriggers = uniqueTriggers.filter((trigger) => discovered.has(trigger));
      const { messages, remainingCommands } = buildListMessages({
        discoveredTriggers,
        totalCommands: uniqueTriggers.length,
        maxBytes
      });
      if (messages.length > 512) throw new Error('Discovered-command list exceeds the 512-page safety limit');
      return {
        states: messages.map(toHandlerState),
        remainingCommands,
        requestedAt: now,
        cooldownMs: COMMAND_LIST_COOLDOWN_MS
      };
    },
    createCooldownState({ command, retryAfterMs, remainingCommands }) {
      const retryMinutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
      const { message } = renderResponse({
        template: command.response,
        overflowTemplate: command.overflowResponse,
        values: { retryMinutes, remainingCommands },
        maxBytes
      });
      return toHandlerState(message);
    },
    execute({ data }) {
      return { message: data.message, values: {} };
    }
  };
}
