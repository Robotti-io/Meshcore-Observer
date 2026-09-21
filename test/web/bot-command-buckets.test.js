import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketBotCommandCounts, OTHER_TRIGGER_LABEL } from '../../src/web/bot-command-buckets.js';

test('zero-fills every configured trigger that has no counts in range, in config order', () => {
  const commands = [{ trigger: '!echo' }, { trigger: '!test' }];
  const rows = bucketBotCommandCounts(commands, [{ trigger: '!echo', count: 3 }]);
  assert.deepEqual(rows, [
    { trigger: '!echo', count: 3 },
    { trigger: '!test', count: 0 }
  ]);
});

test('does not add an "Other" row when the bot has 7 or fewer configured commands', () => {
  const commands = Array.from({ length: 7 }, (_, i) => ({ trigger: `!cmd${i}` }));
  const rows = bucketBotCommandCounts(commands, []);
  assert.equal(rows.length, 7);
  assert.ok(!rows.some((r) => r.trigger === OTHER_TRIGGER_LABEL));
});

test('folds the 8th-and-later configured commands into a single "Other" row, summing their counts', () => {
  const commands = Array.from({ length: 10 }, (_, i) => ({ trigger: `!cmd${i}` }));
  const counts = [
    { trigger: '!cmd0', count: 1 },
    { trigger: '!cmd7', count: 5 },
    { trigger: '!cmd9', count: 2 }
  ];
  const rows = bucketBotCommandCounts(commands, counts);

  assert.equal(rows.length, 8); // 7 primary + 1 Other
  assert.deepEqual(
    rows.slice(0, 7).map((r) => r.trigger),
    ['!cmd0', '!cmd1', '!cmd2', '!cmd3', '!cmd4', '!cmd5', '!cmd6']
  );
  assert.deepEqual(rows[7], { trigger: OTHER_TRIGGER_LABEL, count: 7 }); // cmd7(5) + cmd9(2), cmd8 unused
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
