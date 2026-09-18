import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, truncateToUtf8Bytes, renderResponse } from '../../src/bots/response-template.js';

test('renderTemplate fills known placeholders', () => {
  const result = renderTemplate('🔁 @[{sender}]! {hopCount} hops via {path}', {
    sender: 'Jeymz',
    hopCount: 3,
    path: 'AA➡️BB➡️CC'
  });
  assert.equal(result, '🔁 @[Jeymz]! 3 hops via AA➡️BB➡️CC');
});

test('renderTemplate leaves an unknown placeholder as literal text', () => {
  const result = renderTemplate('hello {unknown}', { sender: 'Jeymz' });
  assert.equal(result, 'hello {unknown}');
});

test('truncateToUtf8Bytes never splits a multi-byte character', () => {
  // 🔁 is 4 UTF-8 bytes; budgets that land mid-character must drop it whole.
  assert.equal(truncateToUtf8Bytes('🔁🔁🔁', 4), '🔁');
  assert.equal(truncateToUtf8Bytes('🔁🔁🔁', 5), '🔁');
  assert.equal(truncateToUtf8Bytes('🔁🔁🔁', 8), '🔁🔁');
  assert.equal(Buffer.byteLength(truncateToUtf8Bytes('🔁🔁🔁', 5), 'utf8') <= 5, true);
});

test('truncateToUtf8Bytes returns the whole string when it already fits', () => {
  assert.equal(truncateToUtf8Bytes('hello', 100), 'hello');
});

test('renderResponse returns the full render unmodified when it fits', () => {
  const { message, degraded } = renderResponse({
    template: '🔁 @[{sender}]! {hopCount} hops via {path}',
    values: { sender: 'Jeymz', hopCount: 3, path: 'AA➡️BB➡️CC' },
    maxBytes: 120
  });
  assert.equal(message, '🔁 @[Jeymz]! 3 hops via AA➡️BB➡️CC');
  assert.equal(degraded, false);
});

test('renderResponse drops the path first when the full render is too long', () => {
  const longPath = Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join('➡️');
  const { message, degraded } = renderResponse({
    template: '🔁 @[{sender}]! {hopCount} hops via {path}',
    values: { sender: 'Jeymz', hopCount: 30, path: longPath },
    maxBytes: 120
  });

  assert.equal(degraded, true);
  assert.ok(Buffer.byteLength(message, 'utf8') <= 120);
  assert.ok(!message.includes(longPath));
  assert.equal(message, '🔁 @[Jeymz]! 30 hops via ');
});

test('renderResponse hard-truncates as a last resort when even the pathless render is too long', () => {
  const { message, degraded } = renderResponse({
    template: '🔁 @[{sender}]! says hi with a very very very long fixed message body regardless of path',
    values: { sender: 'Jeymz', hopCount: 1, path: 'AA' },
    maxBytes: 20
  });

  assert.equal(degraded, true);
  assert.ok(Buffer.byteLength(message, 'utf8') <= 20);
});

test('renderResponse hard-truncates directly when there is no path field at all', () => {
  const { message, degraded } = renderResponse({
    template: 'a very very very long response with no path placeholder in it whatsoever',
    values: { sender: 'Jeymz' },
    maxBytes: 20
  });

  assert.equal(degraded, true);
  assert.ok(Buffer.byteLength(message, 'utf8') <= 20);
});

test('renderResponse uses the default max byte budget of 120 when none is given', () => {
  const longPath = Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join('➡️');
  const { degraded } = renderResponse({
    template: '🔁 @[{sender}]! {hopCount} hops via {path}',
    values: { sender: 'Jeymz', hopCount: 30, path: longPath }
  });
  assert.equal(degraded, true);
});
