import { test } from 'vitest';
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

test('accepts an opt-in requiresTarget command and leaves the default omitted', () => {
  const bot = { ...VALID_BOT, commands: [{ ...VALID_BOT.commands[0], requiresTarget: true }] };
  const result = withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath));
  assert.equal(result[0].commands[0].requiresTarget, true);
  assert.equal(VALID_BOT.commands[0].requiresTarget, undefined);
});

test('accepts suppression opt-in only for a sender-addressed exact response', () => {
  const bot = { ...VALID_BOT, commands: [{ ...VALID_BOT.commands[0], suppressIfAnswered: true }] };
  const result = withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath));
  assert.equal(result[0].commands[0].suppressIfAnswered, true);
  assert.throws(() => withTempFile(JSON.stringify([{
    ...VALID_BOT,
    commands: [{ trigger: '!lookup', kind: 'lookup', suppressIfAnswered: true,
      foundResponse: 'found {sender}', notFoundResponse: 'none {sender}',
      ambiguousResponse: 'many {sender}', invalidResponse: 'bad {sender}' }]
  }]), (filePath) => loadBotsConfig(filePath)), /no satisfactory-response matcher/);
  assert.throws(() => withTempFile(JSON.stringify([{
    ...VALID_BOT,
    commands: [{ trigger: '!echo', response: 'pong', suppressIfAnswered: true }]
  }]), (filePath) => loadBotsConfig(filePath)), /must address \{sender\}/);
});

test('strictly rejects a non-boolean requiresTarget value', () => {
  const bot = { ...VALID_BOT, commands: [{ ...VALID_BOT.commands[0], requiresTarget: 'yes' }] };
  assert.throws(() => withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath)), BotsConfigError);
});

test('accepts a command with an optional overflowResponse', () => {
  const bot = {
    ...VALID_BOT,
    commands: [
      {
        trigger: '!echo',
        response: '🔁 @[{sender}]! {hopCount} hops via {path}',
        overflowResponse: '🔁 @[{sender}]! {hopCount} hops - 🔗 https://map.okimesh.org/#/packets/{hash}'
      }
    ]
  };
  const result = withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath));
  assert.equal(result[0].commands[0].overflowResponse, '🔁 @[{sender}]! {hopCount} hops - 🔗 https://map.okimesh.org/#/packets/{hash}');
});

test('accepts an optional per-bot maxMessageBytes', () => {
  const bot = { ...VALID_BOT, maxMessageBytes: 100 };
  const result = withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath));
  assert.equal(result[0].maxMessageBytes, 100);
});

test('accepts an optional case-sensitive regionScope separate from the channel', () => {
  const bot = { ...VALID_BOT, channel: '#echo', regionScope: 'Oki' };
  const result = withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath));
  assert.equal(result[0].channel, '#echo');
  assert.equal(result[0].regionScope, 'Oki');
  for (const regionScope of ['', '   ', 'bad\nregion', 'x'.repeat(31)]) {
    assert.throws(() => withTempFile(JSON.stringify([{ ...VALID_BOT, regionScope }]),
      (filePath) => loadBotsConfig(filePath)), BotsConfigError);
  }
});

test('accepts explicit per-command scope and fallback policies', () => {
  const bot = {
    ...VALID_BOT,
    commands: [{ ...VALID_BOT.commands[0], scope: { mode: 'region', region: 'Oki' }, fallback: { mode: 'region', region: 'Cvg' } }]
  };
  const result = withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath));
  assert.deepEqual(result[0].commands[0].scope, { mode: 'region', region: 'Oki' });
  assert.deepEqual(result[0].commands[0].fallback, { mode: 'region', region: 'Cvg' });
});

test('rejects malformed command policy and policy that widens a bot region constraint', () => {
  for (const scope of [{ mode: 'region' }, { mode: 'region', region: '$' }, { mode: 'global' }]) {
    const bot = { ...VALID_BOT, commands: [{ ...VALID_BOT.commands[0], scope }] };
    assert.throws(() => withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath)), BotsConfigError);
  }
  const fixedConflict = { ...VALID_BOT, regionScope: 'Oki', commands: [{
    ...VALID_BOT.commands[0], scope: { mode: 'device-default' }
  }] };
  assert.throws(() => withTempFile(JSON.stringify([fixedConflict]), (filePath) => loadBotsConfig(filePath)), /conflicts with bot fixed regionScope/);
  const allowlistConflict = { ...VALID_BOT, regionScope: ['Oki'], commands: [{
    ...VALID_BOT.commands[0], fallback: { mode: 'region', region: 'Cvg' }
  }] };
  assert.throws(() => withTempFile(JSON.stringify([allowlistConflict]), (filePath) => loadBotsConfig(filePath)), /must be a region in bot regionScope allowlist/);
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

test('rejects same-channel trigger overlap when either local command requires targeting', () => {
  const targetBot = { ...VALID_BOT, name: 'targeted', commands: [{ ...VALID_BOT.commands[0], requiresTarget: true }] };
  const legacyBot = { ...VALID_BOT, name: 'legacy' };
  assert.throws(
    () => withTempFile(JSON.stringify([targetBot, legacyBot]), (filePath) => loadBotsConfig(filePath)),
    /Ambiguous target command "!echo"/
  );
});

test('preserves same-channel legacy overlap when targeting is not enabled', () => {
  const first = { ...VALID_BOT, name: 'first' };
  const second = { ...VALID_BOT, name: 'second' };
  assert.equal(withTempFile(JSON.stringify([first, second]), (filePath) => loadBotsConfig(filePath)).length, 2);
});

test('a disabled targeted bot does not make a same-channel legacy trigger ambiguous', () => {
  const disabledTargetBot = { ...VALID_BOT, name: 'disabled', enabled: false,
    commands: [{ ...VALID_BOT.commands[0], requiresTarget: true }] };
  const legacyBot = { ...VALID_BOT, name: 'legacy' };
  assert.equal(withTempFile(JSON.stringify([disabledTargetBot, legacyBot]),
    (filePath) => loadBotsConfig(filePath)).length, 2);
});

const VALID_LOOKUP_COMMAND = {
  trigger: '!lookup',
  kind: 'lookup',
  foundResponse: '📡 {query} = {name}',
  notFoundResponse: '❓ no repeater heard with prefix {query}',
  ambiguousResponse: '⚠️ {matchCount} repeaters match {query}, most recent: {name}',
  invalidResponse: '⚠️ give at least 1 byte in hex'
};

test('loads a well-formed kind: "lookup" command', () => {
  const bot = { ...VALID_BOT, commands: [VALID_LOOKUP_COMMAND] };
  const result = withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath));
  assert.equal(result[0].commands[0].kind, 'lookup');
});

test('rejects a kind: "lookup" command missing one of its four outcome templates', () => {
  const withoutAmbiguous = { ...VALID_LOOKUP_COMMAND };
  delete withoutAmbiguous.ambiguousResponse;
  const bot = { ...VALID_BOT, commands: [withoutAmbiguous] };
  assert.throws(
    () => withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath)),
    /missing ambiguousResponse/
  );
});

test('rejects a kind: "lookup" command that also carries a response template', () => {
  const bot = { ...VALID_BOT, commands: [{ ...VALID_LOOKUP_COMMAND, response: 'not allowed here' }] };
  assert.throws(
    () => withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath)),
    /must not have response\/overflowResponse/
  );
});

test('rejects an exact (non-lookup) command that carries a lookup-only field', () => {
  const bot = { ...VALID_BOT, commands: [{ trigger: '!echo', response: 'hi', foundResponse: 'not allowed here' }] };
  assert.throws(
    () => withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath)),
    /has foundResponse/
  );
});

const VALID_STATS_COMMAND = {
  trigger: '!stats',
  kind: 'stats',
  response: '📊 {range}: {packetsReceived} pkts, {packetsDecoded} decoded, {repliesSent} replies, {repeatersHeard} repeaters',
  usageResponse: '⚠️ usage: !stats <1h|6h|1d|3d|all>'
};

test('loads a well-formed kind: "stats" command', () => {
  const bot = { ...VALID_BOT, commands: [VALID_STATS_COMMAND] };
  const result = withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath));
  assert.equal(result[0].commands[0].kind, 'stats');
});

test('rejects a kind: "stats" command missing usageResponse', () => {
  const withoutUsage = { ...VALID_STATS_COMMAND };
  delete withoutUsage.usageResponse;
  const bot = { ...VALID_BOT, commands: [withoutUsage] };
  assert.throws(
    () => withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath)),
    /missing usageResponse/
  );
});

test('rejects a kind: "stats" command missing response', () => {
  const withoutResponse = { ...VALID_STATS_COMMAND };
  delete withoutResponse.response;
  const bot = { ...VALID_BOT, commands: [withoutResponse] };
  assert.throws(
    () => withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath)),
    /missing response/
  );
});

test('rejects a kind: "stats" command that carries a lookup-only field', () => {
  const bot = { ...VALID_BOT, commands: [{ ...VALID_STATS_COMMAND, foundResponse: 'not allowed here' }] };
  assert.throws(
    () => withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath)),
    /must not have foundResponse/
  );
});

test('rejects an exact (non-stats) command that carries usageResponse', () => {
  const bot = { ...VALID_BOT, commands: [{ trigger: '!echo', response: 'hi', usageResponse: 'not allowed here' }] };
  assert.throws(
    () => withTempFile(JSON.stringify([bot]), (filePath) => loadBotsConfig(filePath)),
    /has usageResponse/
  );
});
