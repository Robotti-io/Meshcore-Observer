import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetricsStore } from '../../src/metrics/store.js';
import { createReplySuppressionCoordinator } from '../../src/bots/reply-suppression.js';

function silentLogger() {
  const calls = { info: [], warn: [] };
  return {
    calls,
    info: (source, message, meta) => calls.info.push({ source, message, meta }),
    warn: (source, message, meta) => calls.warn.push({ source, message, meta })
  };
}

function enqueue(store, overrides = {}) {
  return store.enqueueReplyItem({
    botName: 'echo', channel: '#echo', trigger: '!echo', sender: 'Alice', hopCount: 1,
    path: 'AA', hash: 'request', handlerStateJson: '{"kind":"exact","version":1,"data":{}}',
    enqueuedAt: 1000, expiresAt: 10000, ...overrides
  });
}

function response(overrides = {}) {
  return { channel: '#echo', responseText: 'Ack @Alice', responseSender: 'Other Bot',
    observedAt: 2000, packetHash: 'response-hash', ...overrides };
}

function matcher(matches) {
  return ({ item, responseText }) => matches(item, responseText);
}

test('suppresses one unique response match across the channel and keeps other replies pending', () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const logger = silentLogger();
  const firstId = enqueue(store, { sender: 'Alice' });
  const secondId = enqueue(store, { botName: 'other', sender: 'Bob', enqueuedAt: 1100 });
  const coordinator = createReplySuppressionCoordinator({
    store,
    botsByName: new Map([
      ['echo', { isSatisfactoryResponse: matcher((item, text) => text === `Ack @${item.sender}`) }],
      ['other', { isSatisfactoryResponse: matcher((item, text) => text === `Ack @${item.sender}`) }]
    ]),
    logger
  });

  assert.equal(coordinator(response()), true);
  assert.equal(store.getReplyById(firstId).status, 'suppressed');
  assert.equal(store.getReplyById(secondId).status, 'pending');
  assert.equal(logger.calls.info.length, 1);
  store.close();
});

test('ambiguous same-response requests suppress none', () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const firstId = enqueue(store, { sender: 'Alice' });
  const secondId = enqueue(store, { botName: 'other', sender: 'Alice', enqueuedAt: 1100 });
  const coordinator = createReplySuppressionCoordinator({
    store,
    botsByName: new Map([
      ['echo', { isSatisfactoryResponse: matcher((item, text) => text === `Ack @${item.sender}`) }],
      ['other', { isSatisfactoryResponse: matcher((item, text) => text === `Ack @${item.sender}`) }]
    ]),
    logger: silentLogger()
  });

  assert.equal(coordinator(response()), false);
  assert.equal(store.getReplyById(firstId).status, 'pending');
  assert.equal(store.getReplyById(secondId).status, 'pending');
  store.close();
});

test('candidate overflow fails closed without resolving any reply', () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const ids = Array.from({ length: 257 }, (_, index) => enqueue(store, {
    botName: `bot-${index}`,
    enqueuedAt: 1000 + index
  }));
  const botsByName = new Map(ids.map((_, index) => [`bot-${index}`, {
    isSatisfactoryResponse: () => true
  }]));
  const coordinator = createReplySuppressionCoordinator({ store, botsByName, logger: silentLogger() });

  assert.equal(coordinator(response()), false);
  assert.equal(store.countPendingReplyItems(), 257);
  store.close();
});

test('dispatch commitment wins the race and cannot be suppressed afterward', () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const id = enqueue(store);
  const coordinator = createReplySuppressionCoordinator({
    store,
    botsByName: new Map([['echo', { isSatisfactoryResponse: ({ item }) => {
      assert.equal(store.claimReplyDispatch({ id: item.id, dispatchStartedAt: 1900 }), true);
      return true;
    } }]]),
    logger: silentLogger()
  });

  assert.equal(coordinator(response()), false);
  assert.equal(store.getReplyById(id).status, 'dispatching');
  store.close();
});

test('receipt-time and expiry filter candidates; duplicate packets cannot suppress a later request', () => {
  const store = new MetricsStore({ dbPath: ':memory:' });
  const logger = silentLogger();
  const bot = { isSatisfactoryResponse: matcher((item, text) => text === `Ack @${item.sender}`) };
  const coordinator = createReplySuppressionCoordinator({ store, botsByName: new Map([['echo', bot]]), logger });
  const expiredId = enqueue(store, { expiresAt: 1900 });
  assert.equal(coordinator(response()), false);
  assert.equal(store.getReplyById(expiredId).status, 'pending');

  const lateRequestId = enqueue(store, { enqueuedAt: 2100, expiresAt: 10000 });
  assert.equal(coordinator(response({ observedAt: 2000 })), false);
  assert.equal(store.getReplyById(lateRequestId).status, 'pending');
  assert.equal(coordinator(response({ observedAt: 2200 })), false);
  assert.equal(store.getReplyById(lateRequestId).status, 'pending');
  store.close();
});

test('restart keeps suppression as a distinct terminal outcome', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bot-reply-suppression-'));
  const dbPath = join(directory, 'metrics.sqlite3');
  let store;
  try {
    store = new MetricsStore({ dbPath });
    const id = enqueue(store);
    assert.equal(store.suppressPendingReplyItem({ id, resolvedAt: 2000 }), true);
    store.close();
    store = new MetricsStore({ dbPath });
    assert.equal(store.getReplyById(id).status, 'suppressed');
    assert.equal(store.queryReplyOutcomeTotals({ start: 0, end: 10000 }).sent, 0);
    assert.equal(store.queryReplyLifecycleTotals({ start: 0, end: 10000 }).suppressed, 1);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
