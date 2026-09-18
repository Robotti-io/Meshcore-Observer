import { existsSync, readFileSync } from 'node:fs';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { botsConfigSchema } from './schemas.js';

const validate = compileSchema(botsConfigSchema);

export class BotsConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BotsConfigError';
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
    }
  }

  return parsed;
}
