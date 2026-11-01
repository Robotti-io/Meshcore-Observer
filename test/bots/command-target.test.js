import { test } from 'vitest';
import assert from 'node:assert/strict';
import { matchesCompanionTarget, parseLeadingCommandTarget } from '../../src/bots/command-target.js';

test('leaves ordinary command text and its arguments unchanged', () => {
  assert.deepEqual(parseLeadingCommandTarget('!lookup E8'), { kind: 'untagged', commandText: '!lookup E8' });
});

test('parses one leading target followed by whitespace and preserves command arguments', () => {
  assert.deepEqual(parseLeadingCommandTarget('@[Mesh Bot]\t !lookup E8  extra'), {
    kind: 'targeted', name: 'Mesh Bot', commandText: '!lookup E8  extra'
  });
});

test.each([
  '@[] !echo',
  '@[Mesh Bot !echo',
  '@[Mesh Bot]!echo',
  '@[Mesh Bot] ',
  '@[Mesh Bot]x !echo',
  `@[${'😀'.repeat(8)}] !echo`,
  `@[${'x'.repeat(32)}] !echo`,
  '@[\ud800] !echo'
])('rejects malformed or unsupported leading selector %j', (text) => {
  assert.deepEqual(parseLeadingCommandTarget(text), { kind: 'invalid' });
});

test('matches normalized names literally and case-sensitively', () => {
  const identity = { name: 'Café .*', generation: 1 };
  assert.equal(matchesCompanionTarget('Cafe\u0301 .*', identity), true);
  assert.equal(matchesCompanionTarget('CAFÉ .*', identity), false);
  assert.equal(matchesCompanionTarget('CafeX anything', identity), false);
  assert.equal(matchesCompanionTarget('Café .*', null), false);
  assert.equal(matchesCompanionTarget('bad\ud800', identity), false);
});

test('only a leading selector is parsed as targeting text', () => {
  assert.deepEqual(parseLeadingCommandTarget('!echo @[Other Bot]'), {
    kind: 'untagged', commandText: '!echo @[Other Bot]'
  });
});
