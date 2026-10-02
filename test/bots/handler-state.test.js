import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createExactCommandHandler } from '../../src/bots/command-handlers/exact.js';
import { createHandlerStateCodec } from '../../src/bots/command-handlers/handler-state.js';
import { createLookupCommandHandler } from '../../src/bots/command-handlers/lookup.js';
import { createStatsCommandHandler } from '../../src/bots/command-handlers/stats.js';

test('built-in handlers serialize and restore their versioned private state', () => {
  const nodeRegistry = {
    findByPrefix: () => ({
      status: 'found',
      query: 'E85C',
      node: { name: 'Summit', publicKeyHex: 'E85C'.repeat(16), lastHeardAt: 1000 }
    }),
    countRepeaters: () => 3
  };
  const statsReporter = { earliestSampleAt: () => 0, summarize: () => ({ packetsReceived: 1 }) };
  const cases = [
    {
      handler: createExactCommandHandler(),
      command: { trigger: '!exact', response: 'ok' },
      text: '!exact',
      expected: {}
    },
    {
      handler: createLookupCommandHandler({ nodeRegistry }),
      command: { trigger: '!lookup', kind: 'lookup' },
      text: '!lookup E85C',
      expected: {
        query: 'E85C', outcome: 'found', name: 'Summit', matchCount: null,
        lastHeardAt: 1000, nodePrefix: 'E85C', repeaterCount: null
      }
    },
    {
      handler: createStatsCommandHandler({ statsReporter }),
      command: { trigger: '!stats', kind: 'stats' },
      text: '!stats 1h',
      expected: { query: '1h' }
    }
  ];

  for (const { handler, command, text, expected } of cases) {
    const matched = handler.match({ commands: [command], text });
    assert.ok(matched);
    assert.deepEqual(handler.restore(matched.state), expected);
  }
});

test('handler state restoration rejects malformed, mismatched, unsupported, and extra-property state', () => {
  const restore = createExactCommandHandler().restore;
  assert.throws(() => restore('{'), /not valid JSON/);
  assert.throws(() => restore(JSON.stringify({ kind: 'stats', version: 1, data: {} })), /invalid/);
  assert.throws(() => restore(JSON.stringify({ kind: 'exact', version: 2, data: {} })), /invalid/);
  assert.throws(() => restore(JSON.stringify({ kind: 'exact', version: 1, data: { arbitrary: true } })), /invalid/);
});

test('a future handler can own a strict context schema without changing the common envelope', () => {
  const codec = createHandlerStateCodec({
    kind: 'survey',
    dataSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['questionId', 'choices'],
      properties: {
        questionId: { type: 'string' },
        choices: { type: 'array', items: { type: 'string' } }
      }
    }
  });
  const data = { questionId: 'weather', choices: ['sun', 'rain'] };
  const serialized = codec.serialize(data);

  assert.deepEqual(codec.restore(serialized), data);
  assert.throws(() => codec.restore(JSON.stringify({ kind: 'survey', version: 1, data: { ...data, extra: true } })), /invalid/);
});

test('handler context serialization enforces its byte bound', () => {
  const codec = createHandlerStateCodec({
    kind: 'bounded',
    dataSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['value'],
      properties: { value: { type: 'string' } }
    }
  });

  assert.throws(() => codec.serialize({ value: 'x'.repeat(5000) }), /maximum serialized size/);
});
