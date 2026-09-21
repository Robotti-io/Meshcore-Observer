import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsServer } from '../../src/web/metrics-server.js';
import { MetricsStore } from '../../src/metrics/store.js';

function fakeLogger() {
  const warnings = [];
  return {
    debug() {},
    info() {},
    warn(source, message, meta) {
      warnings.push({ source, message, meta });
    },
    error() {},
    warnings
  };
}

function fakeServiceHealth(overrides = {}) {
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
      bots: [{ name: 'echo', enabled: true, ready: true, repliesSent: 1 }],
      ...overrides
    })
  };
}

function defaultBotsConfig() {
  return [
    {
      name: 'echo',
      channel: '#echo',
      enabled: true,
      minHops: 1,
      commands: [{ trigger: '!echo', response: 'hi' }, { trigger: '!test', response: 'hi' }]
    }
  ];
}

async function withServer({ serviceHealth = fakeServiceHealth(), metricsStore = new MetricsStore({ dbPath: ':memory:' }), botsConfig = defaultBotsConfig(), sampleIntervalMs = 60000, maxChartBuckets = 180, retentionDays = 0, logger = fakeLogger() } = {}, fn) {
  const server = new MetricsServer({
    serviceHealth,
    metricsStore,
    botsConfig,
    host: '127.0.0.1',
    port: 0,
    sampleIntervalMs,
    maxChartBuckets,
    retentionDays,
    logger
  });
  await server.start();
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, { metricsStore, server, logger });
  } finally {
    await server.stop();
    metricsStore.close();
  }
}

test('GET /api/metrics returns the current ServiceHealth snapshot as JSON', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.equal(body.packetsReceived, 3);
    assert.equal(body.packetsPublished, 2);
  });
});

test('GET /api/metrics/history returns bucketed data for the default 24h range', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/history?range=24h`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.buckets));
    assert.ok(Number.isInteger(body.start));
    assert.ok(Number.isInteger(body.end));
  });
});

test('GET /api/metrics/history rejects a request with neither range nor start/end', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/history`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /invalid query/);
  });
});

test('GET /api/metrics/history rejects range and start/end supplied together', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/history?range=24h&start=1&end=2`);
    assert.equal(res.status, 400);
  });
});

test('GET /api/metrics/history rejects start >= end', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/history?start=2000&end=1000`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /start must be before end/);
  });
});

test('GET /api/metrics/history honors an explicit start/end window against persisted samples', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  metricsStore.recordPacketSample({
    sampleAt: 5000,
    intervalMs: 1000,
    packetsReceived: 2,
    packetsPublished: 2,
    radioConnected: true,
    brokersConnected: 1,
    brokersTotal: 1,
    botsReady: 1,
    botsTotal: 1,
    packetsByType: { advert: 2 }
  });

  await withServer({ metricsStore }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/history?start=0&end=10000&maxBuckets=10`);
    const body = await res.json();
    assert.equal(body.buckets.length, 1);
    assert.equal(body.buckets[0].countsByType.advert, 2);
    assert.equal(body.buckets[0].packetsReceived, 2);
  });
});

test('GET /api/metrics/packet-types returns range-filtered totals plus the display bucket metadata', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  metricsStore.recordPacketSample({
    sampleAt: 5000,
    intervalMs: 1000,
    packetsReceived: 1,
    packetsPublished: 1,
    radioConnected: true,
    brokersConnected: 1,
    brokersTotal: 1,
    botsReady: 1,
    botsTotal: 1,
    packetsByType: { advert: 3, txtMsg: 1 }
  });

  await withServer({ metricsStore }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/packet-types?start=0&end=10000`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.totals.sort((a, b) => a.packetTypeBucket.localeCompare(b.packetTypeBucket)),
      [
        { packetTypeBucket: 'advert', total: 3 },
        { packetTypeBucket: 'txtMsg', total: 1 }
      ]
    );
    assert.ok(Array.isArray(body.buckets));
    assert.ok(body.buckets.some((b) => b.key === 'advert' && b.label === 'Advert'));
  });
});

test('GET /api/metrics/packet-types resolves "all" against the earliest persisted sample', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  metricsStore.recordPacketSample({
    sampleAt: 5000,
    intervalMs: 1000,
    packetsReceived: 1,
    packetsPublished: 1,
    radioConnected: true,
    brokersConnected: 1,
    brokersTotal: 1,
    botsReady: 1,
    botsTotal: 1,
    packetsByType: { advert: 1 }
  });

  await withServer({ metricsStore }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/packet-types?range=all`);
    const body = await res.json();
    assert.equal(body.start, 5000);
    assert.deepEqual(body.totals, [{ packetTypeBucket: 'advert', total: 1 }]);
  });
});

test('GET /api/metrics/bots/commands returns every configured bot, zero-filled, in config order', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  metricsStore.recordBotCommand({ botName: 'echo', trigger: '!echo', occurredAt: 5000 });
  metricsStore.recordBotCommand({ botName: 'echo', trigger: '!echo', occurredAt: 6000 });

  const botsConfig = [
    {
      name: 'echo',
      channel: '#echo',
      enabled: true,
      minHops: 1,
      commands: [{ trigger: '!echo', response: 'hi' }, { trigger: '!test', response: 'hi' }]
    },
    {
      name: 'weather',
      channel: '#weather',
      enabled: true,
      minHops: 1,
      commands: [{ trigger: '!weather', response: 'sunny' }]
    }
  ];

  await withServer({ metricsStore, botsConfig }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/bots/commands?start=0&end=10000`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.deepEqual(body.bots, [
      {
        botName: 'echo',
        commands: [
          { trigger: '!echo', count: 2 },
          { trigger: '!test', count: 0 }
        ],
        totalReplies: 2
      },
      {
        botName: 'weather',
        commands: [{ trigger: '!weather', count: 0 }],
        totalReplies: 0
      }
    ]);
  });
});

test('GET /api/metrics/bots/commands folds an 8th-and-later configured command into "Other"', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  const commands = Array.from({ length: 8 }, (_, i) => ({ trigger: `!cmd${i}`, response: 'x' }));
  metricsStore.recordBotCommand({ botName: 'multi', trigger: '!cmd7', occurredAt: 5000 });

  const botsConfig = [{ name: 'multi', channel: '#multi', enabled: true, minHops: 0, commands }];

  await withServer({ metricsStore, botsConfig }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/bots/commands?start=0&end=10000`);
    const body = await res.json();

    assert.equal(body.bots[0].commands.length, 8); // 7 primary + Other
    assert.deepEqual(body.bots[0].commands[7], { trigger: 'Other', count: 1 });
    assert.equal(body.bots[0].totalReplies, 1);
  });
});

test('GET /api/metrics/bots/commands rejects an invalid range query the same way as the other range endpoints', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/bots/commands`);
    assert.equal(res.status, 400);
  });
});

test('GET / returns the dashboard HTML page', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.match(body, /MeshCore Observer Metrics/);
  });
});

test('unknown paths return 404 JSON', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'not found');
  });
});

test('non-GET methods return 405 JSON', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`, { method: 'POST' });
    assert.equal(res.status, 405);
  });
});

test('GET /api/metrics/stream sends an initial snapshot as an SSE event', async () => {
  await withServer({}, async (baseUrl) => {
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
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  const server = new MetricsServer({
    serviceHealth: fakeServiceHealth(),
    metricsStore,
    host: '127.0.0.1',
    port: 0,
    sampleIntervalMs: 60000,
    maxChartBuckets: 180,
    retentionDays: 0,
    logger: fakeLogger()
  });
  await server.start();
  const { port } = server.address();
  await server.stop();
  metricsStore.close();

  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/metrics`));
});

test('the sample timer persists at least one packet sample once running (exact delta arithmetic is covered by metrics-sample.test.js)', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });

  await withServer({ metricsStore, sampleIntervalMs: 20 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));

    const totals = metricsStore.queryPacketTypeTotals({ start: 0, end: Date.now() + 1000 });
    const advertTotal = totals.find((t) => t.packetTypeBucket === 'advert')?.total ?? 0;
    assert.ok(advertTotal > 0, 'expected at least one tick to have persisted a sample');
  });
});
