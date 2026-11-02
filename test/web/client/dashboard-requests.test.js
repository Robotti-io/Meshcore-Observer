import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createNodeListController, loadDashboardReports, reportingDataForRange,
  fetchDashboardJson } from '../../../src/web/client/dashboard-requests.js';
import { createSectionState, beginSectionRequest, completeSectionRequest, failSectionRequest } from '../../../src/web/client/dashboard-logic.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('node list keeps the latest captured filter/page and ignores superseded errors', async () => {
  const calls = [], renders = [], errors = [];
  const controller = createNodeListController({
    load(path, signal) { const result = deferred(); calls.push({ path, signal, ...result }); return result.promise; },
    onStart() {}, onSuccess(data, params) { renders.push({ data, params }); }, onError(error) { errors.push(error); }
  });
  const old = controller.refresh({ q: 'old', offset: 0 });
  const params = { q: 'new', offset: 25 };
  const current = controller.refresh(params);
  params.offset = 99;
  assert.equal(calls[0].signal.aborted, true);
  const nodes = [{ name: null, lastHeardAt: 100 }, { name: 'Named', lastHeardAt: 100 }];
  calls[1].resolve({ nodes }); await current;
  calls[0].reject(new Error('old request failed')); await old;
  assert.deepEqual(renders, [{ data: { nodes }, params: { q: 'new', offset: 25 } }]);
  assert.deepEqual(errors, []);
});

test('an older successful node response cannot replace the newest page', async () => {
  const pending = [], pages = [];
  const controller = createNodeListController({
    load() { const result = deferred(); pending.push(result); return result.promise; },
    onStart() {}, onSuccess(data) { pages.push(data); }, onError() {}
  });
  const first = controller.refresh({ offset: 0 });
  const second = controller.refresh({ offset: 25 });
  pending[1].resolve('new'); await second;
  pending[0].resolve('old'); await first;
  assert.deepEqual(pages, ['new']);
});

test('node cancellation invalidates a pending success on navigation', async () => {
  const result = deferred(); let rendered = false;
  const controller = createNodeListController({ load: () => result.promise,
    onStart() {}, onSuccess() { rendered = true; }, onError() {} });
  const request = controller.refresh({ offset: 0 }); controller.cancel();
  result.resolve({ nodes: [] }); await request;
  assert.equal(rendered, false);
});

test('report cache retains same-range data and hides prior-range values after partial failure', () => {
  const ready = completeSectionRequest(beginSectionRequest(createSectionState(), 1, 'range=A'), 1, { count: 7 }, 100);
  const failedB = failSectionRequest(beginSectionRequest(ready, 2, 'range=B'), 2, 'offline');
  assert.equal(reportingDataForRange(failedB, 'range=B'), undefined);
  assert.deepEqual(reportingDataForRange(failedB, 'range=A'), { count: 7 });
  const failedA = failSectionRequest(beginSectionRequest(ready, 3, 'range=A'), 3, 'offline');
  assert.deepEqual(reportingDataForRange(failedA, 'range=A'), { count: 7 });
});

function reportFixture() {
  const requests = new Map(), events = [];
  const aggregateSettled = deferred();
  let current = true;
  const running = loadDashboardReports({ aggregatePath: 'aggregate', definitions: [{ key: 'one', path: 'focused' }],
    load(path) { const request = deferred(); requests.set(path, request); return request.promise; },
    isCurrent: () => current,
    onAggregate(data) { events.push(['aggregate', data]); aggregateSettled.resolve(); },
    onAggregateError(error) { events.push(['aggregate-error', error.message]); aggregateSettled.resolve(); },
    onReport(definition, data) { events.push([definition.key, data]); }, onReportError(definition, error) { events.push([definition.key + '-error', error.message]); }
  });
  return { requests, events, running, aggregateSettled: aggregateSettled.promise, supersede() { current = false; } };
}

test('healthy aggregate renders while a focused request remains pending', async () => {
  const fixture = reportFixture(); await Promise.resolve();
  fixture.requests.get('aggregate').resolve('current metrics');
  await fixture.aggregateSettled;
  assert.deepEqual(fixture.events, [['aggregate', 'current metrics']]);
  fixture.requests.get('focused').resolve('focused data'); await fixture.running;
  assert.deepEqual(fixture.events[1], ['one', 'focused data']);
});

test('aggregate rejection is handled immediately and does not discard focused success', async () => {
  const fixture = reportFixture(); await Promise.resolve();
  fixture.requests.get('aggregate').reject(new Error('offline'));
  await fixture.aggregateSettled;
  assert.deepEqual(fixture.events, [['aggregate-error', 'offline']]);
  fixture.requests.get('focused').resolve('retained evidence'); await fixture.running;
  assert.deepEqual(fixture.events[1], ['one', 'retained evidence']);
});

test('superseded reports cannot publish successes or failures', async () => {
  const fixture = reportFixture(); await Promise.resolve(); fixture.supersede();
  fixture.requests.get('aggregate').resolve('old'); fixture.requests.get('focused').reject(new Error('old failure'));
  await fixture.running;
  assert.deepEqual(fixture.events, []);
});

test('a stalled report times out and frees refresh ownership while navigation cancellation is immediate', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', (_path, { signal }) => new Promise((_, reject) => {
    const fail = () => reject(new Error('aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  }));
  try {
    const timedOut = assert.rejects(fetchDashboardJson('/synthetic'), /aborted/);
    await vi.advanceTimersByTimeAsync(15000);
    await timedOut;
    const navigation = new AbortController();
    const cancelled = assert.rejects(fetchDashboardJson('/synthetic', navigation.signal), /aborted/);
    navigation.abort(); await cancelled;
    assert.equal(vi.getTimerCount(), 0);
  } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
});
