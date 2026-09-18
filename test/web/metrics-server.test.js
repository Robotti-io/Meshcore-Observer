import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsServer } from '../../src/web/metrics-server.js';
import { MetricsHistory } from '../../src/web/metrics-history.js';

function fakeLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function fakeServiceHealth() {
  return {
    snapshot: () => ({
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      radioConnected: true,
      radioLastConnectedAt: new Date('2024-01-01T00:00:00.000Z'),
      radioReconnectCount: 0,
      packetsReceived: 3,
      packetsPublished: 2,
      packetsByType: { 4: 2 },
      mqtt: { okimesh: { connected: true, lastConnectedAt: null } },
      bots: [{ name: 'echo', enabled: true, ready: true, repliesSent: 1 }]
    })
  };
}

async function withServer(fn) {
  const server = new MetricsServer({
    serviceHealth: fakeServiceHealth(),
    metricsHistory: new MetricsHistory({ historyWindowMs: 60000, sampleIntervalMs: 1000 }),
    host: '127.0.0.1',
    port: 0,
    sampleIntervalMs: 60000, // long enough that no tick fires mid-test
    logger: fakeLogger()
  });
  await server.start();
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.stop();
  }
}

test('GET /api/metrics returns the current ServiceHealth snapshot as JSON', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.equal(body.packetsReceived, 3);
    assert.equal(body.packetsPublished, 2);
  });
});

test('GET /api/metrics/history returns an array of samples', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/history`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });
});

test('GET / returns the dashboard HTML page', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.match(body, /MeshCore Observer Metrics/);
  });
});

test('unknown paths return 404 JSON', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'not found');
  });
});

test('non-GET methods return 405 JSON', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`, { method: 'POST' });
    assert.equal(res.status, 405);
  });
});

test('GET /api/metrics/stream sends an initial snapshot as an SSE event', async () => {
  await withServer(async (baseUrl) => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/metrics/stream`, { signal: controller.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /^data: /);

    const payload = JSON.parse(text.slice('data: '.length).trim());
    assert.equal(payload.packetsReceived, 3);

    controller.abort();
  });
});

test('stop() closes the server so a subsequent request fails to connect', async () => {
  const server = new MetricsServer({
    serviceHealth: fakeServiceHealth(),
    metricsHistory: new MetricsHistory({ historyWindowMs: 60000, sampleIntervalMs: 1000 }),
    host: '127.0.0.1',
    port: 0,
    sampleIntervalMs: 60000,
    logger: fakeLogger()
  });
  await server.start();
  const { port } = server.address();
  await server.stop();

  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/metrics`));
});
