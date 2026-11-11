import { existsSync, readFileSync } from 'node:fs';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { botsConfigSchema, LOOKUP_RESPONSE_FIELDS, STATS_RESPONSE_FIELDS } from './schemas.js';
import { validateCommandScopeCompatibility } from './reply-scope-policy.js';
import { ONBOARDING_TRIGGER } from './command-handlers/onboarding.js';

const validate = compileSchema(botsConfigSchema);

export class BotsConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BotsConfigError';
  }
}

function validateTargetCommandOverlaps(bots, filePath) {
  for (let leftIndex = 0; leftIndex < bots.length; leftIndex += 1) {
    const leftBot = bots[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < bots.length; rightIndex += 1) {
      const rightBot = bots[rightIndex];
      if (!leftBot.enabled || !rightBot.enabled || leftBot.channel !== rightBot.channel) continue;

      for (const leftCommand of leftBot.commands) {
        const rightCommand = rightBot.commands.find((command) => command.trigger === leftCommand.trigger);
        if (rightCommand && (leftCommand.requiresTarget === true || rightCommand.requiresTarget === true)) {
          throw new BotsConfigError(
            `Ambiguous target command "${leftCommand.trigger}" for bots "${leftBot.name}" and "${rightBot.name}" on channel "${leftBot.channel}" in "${filePath}"`
          );
        }
      }
    }
  }
}

/**
 * Validates kind-specific template combinations that AJV's shared property
 * schema can't express cleanly: lookup needs outcome templates, stats needs
 * a success and usage template, discovery needs the !commands cooldown
 * template, and exact commands use a single response template.
 */
function validateCommandFieldsForKind(command, botName, filePath) {
  const context = `command "${command.trigger}" for bot "${botName}" in "${filePath}"`;
  if ('hint' in command && ['discovery', 'hint'].includes(command.kind)) {
    throw new BotsConfigError(`${context} has a hint but is not a discoverable command`);
  }
  if (command.suppressIfAnswered === true) {
    const responseFields = [command.response, command.overflowResponse].filter((value) => value !== undefined);
    if ((command.kind ?? 'exact') !== 'exact') {
      throw new BotsConfigError(`${context} opts into suppressIfAnswered but its handler has no satisfactory-response matcher`);
    }
    if (responseFields.some((template) => !template.includes('{sender}'))) {
      throw new BotsConfigError(`${context} opts into suppressIfAnswered but each response template must address {sender}`);
    }
  }

  if (command.kind === 'lookup') {
    const missing = LOOKUP_RESPONSE_FIELDS.filter((field) => !(field in command));
    if (missing.length > 0) {
      throw new BotsConfigError(`${context} is kind "lookup" but is missing ${missing.join(', ')}`);
    }
    if ('response' in command || 'overflowResponse' in command) {
      throw new BotsConfigError(`${context} is kind "lookup" and must not have response/overflowResponse`);
    }
    return;
  }

  if (command.kind === 'stats') {
    const missing = STATS_RESPONSE_FIELDS.filter((field) => !(field in command));
    if (missing.length > 0) {
      throw new BotsConfigError(`${context} is kind "stats" but is missing ${missing.join(', ')}`);
    }
    const extraLookupFields = LOOKUP_RESPONSE_FIELDS.filter((field) => field in command);
    if (extraLookupFields.length > 0) {
      throw new BotsConfigError(`${context} is kind "stats" and must not have ${extraLookupFields.join(', ')}`);
    }
    return;
  }

  if (command.kind === 'discovery') {
    if (command.trigger !== '!commands') {
      throw new BotsConfigError(`${context} is kind "discovery" and must use the trigger "!commands"`);
    }
    if (!('response' in command)) {
      throw new BotsConfigError(`${context} is kind "discovery" but is missing the cooldown response template`);
    }
    const unsupportedFields = [
      ...LOOKUP_RESPONSE_FIELDS,
      'usageResponse',
      'requiresTarget',
      'suppressIfAnswered',
      'scope',
      'fallback'
    ].filter((field) => field in command);
    if (unsupportedFields.length > 0) {
      throw new BotsConfigError(`${context} is kind "discovery" and must not have ${unsupportedFields.join(', ')}`);
    }
    return;
  }

  if (command.kind === 'hint') {
    if (command.trigger !== '!hint') {
      throw new BotsConfigError(`${context} is kind "hint" and must use the trigger "!hint"`);
    }
    if (!('response' in command) || !('notFoundResponse' in command)) {
      throw new BotsConfigError(`${context} is kind "hint" but is missing the cooldown or completed-challenge response`);
    }
    const unsupportedFields = [
      ...LOOKUP_RESPONSE_FIELDS.filter((field) => field !== 'notFoundResponse'),
      'usageResponse',
      'overflowResponse',
      'hint',
      'requiresTarget',
      'suppressIfAnswered',
      'scope',
      'fallback'
    ].filter((field) => field in command);
    if (unsupportedFields.length > 0) {
      throw new BotsConfigError(`${context} is kind "hint" and must not have ${unsupportedFields.join(', ')}`);
    }
    return;
  }

  if (!('response' in command)) {
    throw new BotsConfigError(`${context} is missing a response template`);
  }
  const extraLookupFields = LOOKUP_RESPONSE_FIELDS.filter((field) => field in command);
  if (extraLookupFields.length > 0) {
    throw new BotsConfigError(`${context} is not kind "lookup" but has ${extraLookupFields.join(', ')}`);
  }
  const extraStatsFields = STATS_RESPONSE_FIELDS.filter((field) => field in command && field !== 'response');
  if (extraStatsFields.length > 0) {
    throw new BotsConfigError(`${context} is not kind "stats" but has ${extraStatsFields.join(', ')}`);
  }
}

/**
 * Loads, parses, and validates the bot config file: a JSON array of
 * independent channel or direct-message bot definitions with their own
 * trigger -> response-template commands. Returns an
 * empty array (not an error) if the file simply doesn't exist - callers
 * that require the file to exist (an explicitly configured path) should
 * check that themselves before calling this.
 *
 * File shape:
 * [
 *   {
 *     "name": "echo",
 *     "channel": "#echo",
 *     "enabled": true,
 *     "minHops": 1,
 *     "maxMessageBytes": 120,
 *     "commands": [
 *       { "trigger": "!echo", "response": "🔁 @[{sender}]! {hopCount} hops via {path}" }
 *     ]
 *   }
 * ]
 *
 * @throws {BotsConfigError} if the file can't be read/parsed, fails schema
 * validation, or has a duplicate bot name or duplicate trigger within a bot.
 */
export function loadBotsConfig(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new BotsConfigError(`Failed to read bots config file "${filePath}": ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BotsConfigError(`Bots config file "${filePath}" is not valid JSON: ${err.message}`);
  }

  if (!validate(parsed)) {
    throw new BotsConfigError(`Invalid bots config file "${filePath}": ${formatErrors(validate.errors)}`);
  }

  const names = new Set();
  const discoveryCommandsByChannel = new Map();
  const hintCommandsByChannel = new Map();
  const onboardingBotsByChannel = new Map();
  for (const bot of parsed) {
    if (names.has(bot.name)) {
      throw new BotsConfigError(`Duplicate bot name "${bot.name}" in bots config file "${filePath}"`);
    }
    names.add(bot.name);

    if (bot.type !== 'direct' && bot.onboarding
      && bot.commands.some((command) => command.trigger === ONBOARDING_TRIGGER)) {
      throw new BotsConfigError(`Bot "${bot.name}" in "${filePath}" uses the reserved internal onboarding trigger`);
    }

    if (bot.type !== 'direct' && bot.enabled) {
      if (bot.onboarding) {
        const count = (onboardingBotsByChannel.get(bot.channel) ?? 0) + 1;
        onboardingBotsByChannel.set(bot.channel, count);
        if (count > 1) {
          throw new BotsConfigError(`Only one onboarding bot may be configured for channel "${bot.channel}" in "${filePath}"`);
        }
      }

      const discoveryCommands = bot.commands.filter((command) => command.kind === 'discovery');
      if (discoveryCommands.length > 0) {
        const existing = discoveryCommandsByChannel.get(bot.channel) ?? 0;
        discoveryCommandsByChannel.set(bot.channel, existing + discoveryCommands.length);
        if (discoveryCommandsByChannel.get(bot.channel) > 1) {
          throw new BotsConfigError(`Only one discovery command may be configured for channel "${bot.channel}" in "${filePath}"`);
        }
      }

      const hintCommands = bot.commands.filter((command) => command.kind === 'hint');
      if (hintCommands.length > 0) {
        const existing = hintCommandsByChannel.get(bot.channel) ?? 0;
        hintCommandsByChannel.set(bot.channel, existing + hintCommands.length);
        if (hintCommandsByChannel.get(bot.channel) > 1) {
          throw new BotsConfigError(`Only one hint command may be configured for channel "${bot.channel}" in "${filePath}"`);
        }
      }
    }

    const triggers = new Set();
    for (const command of bot.commands) {
      if (triggers.has(command.trigger)) {
        throw new BotsConfigError(`Duplicate trigger "${command.trigger}" for bot "${bot.name}" in "${filePath}"`);
      }
      triggers.add(command.trigger);

      validateCommandFieldsForKind(command, bot.name, filePath);
      const scopeError = validateCommandScopeCompatibility(bot.regionScope, command);
      if (scopeError) throw new BotsConfigError(`${scopeError} for bot "${bot.name}" in "${filePath}"`);
    }
  }

  const enabledDirectBot = parsed.some((bot) => bot.type === 'direct' && bot.enabled);
  for (const bot of parsed) {
    if (bot.type === 'direct') {
      if (!bot.challenge) continue;
      const maxMessageBytes = bot.maxMessageBytes ?? 512;
      const challengeMessages = [bot.challenge.incorrectResponse, bot.challenge.completeResponse,
        ...bot.challenge.questions.map((question) => question.prompt)];
      if (challengeMessages.some((message) => Buffer.byteLength(message, 'utf8') > maxMessageBytes)) {
        throw new BotsConfigError(`Direct challenge message for bot "${bot.name}" in "${filePath}" exceeds maxMessageBytes`);
      }
      continue;
    }
    if (bot.onboarding && !enabledDirectBot) {
      throw new BotsConfigError(`Bot "${bot.name}" in "${filePath}" has onboarding messages but no enabled direct bot`);
    }
    if (bot.onboarding && bot.regionScope !== undefined) {
      throw new BotsConfigError(`Bot "${bot.name}" in "${filePath}" cannot use onboarding messages with regionScope`);
    }
    if (!bot.commands.some((command) => command.kind === 'hint')) continue;
    const commandsOnChannel = parsed
      .filter((candidate) => candidate.type !== 'direct' && candidate.enabled && candidate.channel === bot.channel)
      .flatMap((candidate) => candidate.commands);
    if (!commandsOnChannel.some((command) => typeof command.hint === 'string')) {
      throw new BotsConfigError(`Hint command for bot "${bot.name}" in "${filePath}" requires at least one command with a hint`);
    }
    const maxMessageBytes = bot.maxMessageBytes ?? 120;
    for (const command of commandsOnChannel.filter((candidate) => candidate.hint !== undefined)) {
      if (Buffer.byteLength(command.hint, 'utf8') > maxMessageBytes) {
        throw new BotsConfigError(`Hint for command "${command.trigger}" in bot "${bot.name}" exceeds maxMessageBytes`);
      }
    }
  }

  for (const bot of parsed) {
    if (bot.type === 'direct' || !bot.commands.some((command) => command.kind === 'discovery')) continue;
    const maxMessageBytes = bot.maxMessageBytes ?? 120;
    if (maxMessageBytes < 32) {
      throw new BotsConfigError(`Discovery command for bot "${bot.name}" in "${filePath}" requires maxMessageBytes of at least 32`);
    }
    const channelCommands = parsed
      .filter((candidate) => candidate.type !== 'direct' && candidate.enabled && candidate.channel === bot.channel)
      .flatMap((candidate) => candidate.commands);
    for (const command of channelCommands) {
      const minimumListMessage = `☥ + ${command.trigger}`;
      if (Buffer.byteLength(minimumListMessage, 'utf8') > maxMessageBytes) {
        throw new BotsConfigError(`Command "${command.trigger}" for bot "${bot.name}" in "${filePath}" is too long for its discovered-command list`);
      }
    }
  }

  validateTargetCommandOverlaps(parsed, filePath);

  return parsed;
}
