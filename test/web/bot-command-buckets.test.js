import { test } from 'vitest';
import assert from 'node:assert/strict';
import { bucketBotCommandCounts } from '../../src/web/bot-command-buckets.js';

test('zero-fills every configured trigger that has no counts in range, in config order', () => {
  const commands = [{ trigger: '!echo' }, { trigger: '!test' }];
  const rows = bucketBotCommandCounts(commands, [{ trigger: '!echo', count: 3 }]);
  assert.deepEqual(rows, [
    { trigger: '!echo', count: 3 },
    { trigger: '!test', count: 0 }
  ]);
});

test('retains each configured command individually when the bot has 7 or fewer commands', () => {
  const commands = Array.from({ length: 7 }, (_, i) => ({ trigger: `!cmd${i}` }));
  const rows = bucketBotCommandCounts(commands, []);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((row) => row.trigger), commands.map((command) => command.trigger));
});

test('retains every configured command and its exact count beyond the former seven-command limit', () => {
  const commands = Array.from({ length: 10 }, (_, i) => ({ trigger: `!cmd${i}` }));
  const counts = [
    { trigger: '!cmd0', count: 1 },
    { trigger: '!cmd7', count: 5 },
    { trigger: '!cmd9', count: 2 }
  ];
  const rows = bucketBotCommandCounts(commands, counts);

  assert.equal(rows.length, commands.length);
  assert.deepEqual(rows[7], { trigger: '!cmd7', count: 5 });
  assert.deepEqual(rows[8], { trigger: '!cmd8', count: 0 });
  assert.deepEqual(rows[9], { trigger: '!cmd9', count: 2 });
});

test('row order is stable regardless of the counts array order (never sorted by usage rank)', () => {
  const commands = [{ trigger: '!a' }, { trigger: '!b' }, { trigger: '!c' }];
  const highUsageFirst = bucketBotCommandCounts(commands, [
    { trigger: '!c', count: 100 },
    { trigger: '!a', count: 1 }
  ]);
  assert.deepEqual(
    highUsageFirst.map((r) => r.trigger),
    ['!a', '!b', '!c']
  );
});
