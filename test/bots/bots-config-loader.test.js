import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBotsConfig, BotsConfigError } from '../../src/bots/bots-config-loader.js';

function withTempFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'meshcore-bots-'));
  const filePath = join(dir, 'bots.config.json');
  if (content !== null) {
    writeFileSync(filePath, content, 'utf8');
  }
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_BOT = {
  name: 'echo',
  channel: '#echo',
  enabled: true,
  minHops: 1,
  commands: [{ trigger: '!echo', response: '🔁 @[{sender}]! {hopCount} hops via {path}' }]
};

test('returns an empty array when the file does not exist', () => {
  const result = withTempFile(null, (filePath) => loadBotsConfig(filePath));
  assert.deepEqual(result, []);
});

test('loads and validates a well-formed bots config file', () => {
  const result = withTempFile(JSON.stringify([VALID_BOT]), (filePath) => loadBotsConfig(filePath));
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'echo');
  assert.equal(result[0].commands[0].trigger, '!echo');
});

test('accepts an optional per-bot maxMessageBytes', () => {
  const bot = { ...VALID_BOT, maxMessageBytes: 100 };
  const result = withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath));
  assert.equal(result[0].maxMessageBytes, 100);
});

test('throws BotsConfigError for invalid JSON', () => {
  assert.throws(() => withTempFile('{ not valid json', (filePath) => loadBotsConfig(filePath)), BotsConfigError);
});

test('throws BotsConfigError when the file fails schema validation', () => {
  const invalid = [{ name: 'echo', channel: '#echo' }]; // missing required fields
  assert.throws(() => withTempFile(JSON.stringify(invalid), (filePath) => loadBotsConfig(filePath)), BotsConfigError);
});

test('rejects an unknown property on a bot definition', () => {
  const withExtra = [{ ...VALID_BOT, unexpectedField: true }];
  assert.throws(() => withTempFile(JSON.stringify(withExtra), (filePath) => loadBotsConfig(filePath)), BotsConfigError);
});

test('rejects a command missing a response template', () => {
  const invalid = [{ ...VALID_BOT, commands: [{ trigger: '!echo' }] }];
  assert.throws(() => withTempFile(JSON.stringify(invalid), (filePath) => loadBotsConfig(filePath)), BotsConfigError);
});

test('throws BotsConfigError for a duplicate bot name', () => {
  const duplicates = [VALID_BOT, { ...VALID_BOT, channel: '#other' }];
  assert.throws(
    () => withTempFile(JSON.stringify(duplicates), (filePath) => loadBotsConfig(filePath)),
    /Duplicate bot name "echo"/
  );
});

test('throws BotsConfigError for a duplicate trigger within one bot', () => {
  const bot = {
    ...VALID_BOT,
    commands: [
      { trigger: '!echo', response: 'a' },
      { trigger: '!echo', response: 'b' }
    ]
  };
  assert.throws(
    () => withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath)),
    /Duplicate trigger "!echo"/
  );
});

test('allows the same trigger name across two different bots', () => {
  const botA = { ...VALID_BOT, name: 'echo-a', channel: '#a' };
  const botB = { ...VALID_BOT, name: 'echo-b', channel: '#b' };
  const result = withTempFile(JSON.stringify([botA, botB]), (filePath) => loadBotsConfig(filePath));
  assert.equal(result.length, 2);
});
