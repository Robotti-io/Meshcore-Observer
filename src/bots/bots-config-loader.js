import { existsSync, readFileSync } from 'node:fs';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { botsConfigSchema, LOOKUP_RESPONSE_FIELDS, STATS_RESPONSE_FIELDS } from './schemas.js';
import { validateCommandScopeCompatibility } from './reply-scope-policy.js';

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
 * A command can't mix response shapes across kinds AJV's schema alone can't
 * cleanly enforce (see schemas.js): a 'lookup' command needs all four
 * outcome-specific templates and must not carry `response`/
 * `overflowResponse`; a 'stats' command needs `response` and
 * `usageResponse` and must not carry any lookup-only field; an 'exact'
 * command (the default - `kind` omitted) needs `response` and must not
 * carry any lookup-only field or `usageResponse`.
 */
function validateCommandFieldsForKind(command, botName, filePath) {
  const context = `command "${command.trigger}" for bot "${botName}" in "${filePath}"`;
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
 * Loads, parses, and validates the channel bots config file: a JSON array
 * of independent bot definitions, each naming the channel it listens on
 * and its own set of trigger -> response-template commands. Returns an
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
  for (const bot of parsed) {
    if (names.has(bot.name)) {
      throw new BotsConfigError(`Duplicate bot name "${bot.name}" in bots config file "${filePath}"`);
    }
    names.add(bot.name);

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

  validateTargetCommandOverlaps(parsed, filePath);

  return parsed;
}
