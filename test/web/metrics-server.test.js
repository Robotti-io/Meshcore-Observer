import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { MetricsServer } from '../../src/web/metrics-server.js';
import { MetricsStore } from '../../src/metrics/store.js';
import { MetricsSampler } from '../../src/metrics/sampler.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web');

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
      packetsDecoded: 2,
      packetsByType: { 4: 2 },
      mqtt: { okimesh: { connected: true, lastConnectedAt: null, deliveries: { sent: 2, skipped: 0, failed: 0 } } },
      bots: [{ name: 'echo', enabled: true, ready: true, repliesSent: 1 }],
      replyQueue: { size: 0 },
      ...overrides
    })
  };
}

// Seeds one already-resolved reply (enqueue -> peek -> resolve) rather
// than a direct table insert - bot_replies covers a reply's whole
// lifecycle now (see the store's v5 migration doc comment), so there's no
// standalone "just record an outcome" API to seed historical rows with
// directly. Mirrors test/metrics/store.test.js's own helper of the same
// name/shape.
function seedResolvedReply(store, { botName, trigger, status, occurredAt }) {
  store.enqueueReplyItem({
    botName,
    channel: '#test',
    trigger,
    sender: 'Jeymz',
    hopCount: 1,
    path: 'AA',
    hash: 'deadbeef',
    enqueuedAt: occurredAt,
    expiresAt: occurredAt + 60000
  });
  const item = store.peekOldestPendingReplyItem();
  store.resolveReplyItem(item.id, { status, resolvedAt: occurredAt, queuedMs: 0 });
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

// MetricsSampler now owns the sample-persist-prune loop independently of
// MetricsServer (see src/metrics/sampler.js and AGENTS.md's "Persistence"
// section) - every test gets one running alongside the server, matching
// how src/index.js wires them, so the two tests that actually care about
// live sampling/SSE-broadcast behavior still exercise it for real.
async function withServer({ serviceHealth = fakeServiceHealth(), metricsStore = new MetricsStore({ dbPath: ':memory:' }), botsConfig = defaultBotsConfig(), sampleIntervalMs = 60000, maxChartBuckets = 180, retentionDays = 0, logger = fakeLogger() } = {}, fn) {
  const sampler = new MetricsSampler({ serviceHealth, metricsStore, sampleIntervalMs, retentionDays, logger });
  sampler.start();

  const server = new MetricsServer({
    serviceHealth,
    metricsStore,
    botsConfig,
    host: '127.0.0.1',
    port: 0,
    sampleIntervalMs,
    maxChartBuckets,
    logger,
    sampler
  });
  await server.start();
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, { metricsStore, sampler, server, logger });
  } finally {
    await server.stop();
    sampler.stop();
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
    assert.equal(body.packetsDecoded, 2);
  });
});

test('GET /api/metrics/reply-queue reports outcome totals summed across every bot, from the persisted store', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  seedResolvedReply(metricsStore, { botName: 'echo', trigger: '!echo', status: 'sent', occurredAt: 1000 });
  seedResolvedReply(metricsStore, { botName: 'weather', trigger: '!wx', status: 'sent', occurredAt: 2000 });
  seedResolvedReply(metricsStore, { botName: 'echo', trigger: '!echo', status: 'failed', occurredAt: 3000 });
  seedResolvedReply(metricsStore, { botName: 'echo', trigger: '!echo', status: 'expired', occurredAt: 4000 });
  seedResolvedReply(metricsStore, { botName: 'echo', trigger: '!echo', status: 'cancelled', occurredAt: 5000 });
  // Outside the queried window below - must not be counted.
  seedResolvedReply(metricsStore, { botName: 'echo', trigger: '!echo', status: 'sent', occurredAt: 999_999 });

  await withServer({ metricsStore }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/reply-queue?start=0&end=10000`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.start, 0);
    assert.equal(body.end, 10000);
    assert.deepEqual(body.totals, { sent: 2, failed: 1, expired: 1, cancelled: 1 });
  });
});

test('GET /api/metrics/reply-queue rejects an invalid range query the same way as the other range endpoints', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/reply-queue`);
    assert.equal(res.status, 400);
  });
});

test('GET /api/metrics/nodes reports added/updated distinct-node counts for the requested range', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  metricsStore.upsertNode({ publicKeyHex: 'AA'.repeat(32), name: 'Added In Range', type: 'REPEATER', heardAt: 1000 });
  metricsStore.upsertNode({ publicKeyHex: 'BB'.repeat(32), name: 'Re-heard', type: 'REPEATER', heardAt: -1000 });
  metricsStore.upsertNode({ publicKeyHex: 'BB'.repeat(32), name: 'Re-heard', type: 'REPEATER', heardAt: 2000 });
  // Outside the queried window below - must not be counted.
  metricsStore.upsertNode({ publicKeyHex: 'CC'.repeat(32), name: 'Outside Range', type: 'REPEATER', heardAt: 999_999 });

  await withServer({ metricsStore }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/nodes?start=0&end=10000`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.start, 0);
    assert.equal(body.end, 10000);
    assert.deepEqual(body.totals, { added: 1, updated: 1 });
  });
});

test('GET /api/metrics/nodes with type=REPEATER excludes nodes of a different type', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  metricsStore.upsertNode({ publicKeyHex: 'AA'.repeat(32), name: 'A Repeater', type: 'REPEATER', heardAt: 1000 });
  metricsStore.upsertNode({ publicKeyHex: 'BB'.repeat(32), name: 'A Chat Node', type: 'CHAT', heardAt: 1000 });

  await withServer({ metricsStore }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/nodes?start=0&end=10000&type=REPEATER`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.totals, { added: 1, updated: 0 });
  });
});

test('GET /api/metrics/nodes rejects an invalid range query the same way as the other range endpoints', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/nodes`);
    assert.equal(res.status, 400);
  });
});

test('GET /api/nodes returns a page of the current node contact list, most-recently-heard first', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  metricsStore.upsertNode({ publicKeyHex: 'AA'.repeat(32), name: 'Older', type: 'REPEATER', heardAt: 1000 });
  metricsStore.upsertNode({ publicKeyHex: 'BB'.repeat(32), name: 'Newer', type: 'REPEATER', heardAt: 2000 });

  await withServer({ metricsStore }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/nodes`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 2);
    assert.deepEqual(body.nodes.map((n) => n.name), ['Newer', 'Older']);
  });
});

test('GET /api/nodes filters by q (name substring or public-key prefix) and type', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  metricsStore.upsertNode({ publicKeyHex: 'AA'.repeat(32), name: 'Summit Repeater', type: 'REPEATER', heardAt: 1000 });
  metricsStore.upsertNode({ publicKeyHex: 'BB'.repeat(32), name: 'Valley Room', type: 'ROOM', heardAt: 2000 });

  await withServer({ metricsStore }, async (baseUrl) => {
    const byName = await (await fetch(`${baseUrl}/api/nodes?q=summit`)).json();
    assert.equal(byName.total, 1);
    assert.equal(byName.nodes[0].name, 'Summit Repeater');

    const byPrefix = await (await fetch(`${baseUrl}/api/nodes?q=BB`)).json();
    assert.equal(byPrefix.total, 1);
    assert.equal(byPrefix.nodes[0].publicKeyHex, 'BB'.repeat(32));

    const byType = await (await fetch(`${baseUrl}/api/nodes?type=ROOM`)).json();
    assert.equal(byType.total, 1);
    assert.equal(byType.nodes[0].type, 'ROOM');
  });
});

test('GET /api/nodes rejects an unrecognized query parameter', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/nodes?typo=1`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /invalid query/);
  });
});

test('GET /api/nodes rejects an out-of-range limit', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/nodes?limit=500`);
    assert.equal(res.status, 400);
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

test('GET /api/metrics/history rejects an unrecognized query parameter rather than silently ignoring it', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/history?range=24h&typo=1`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /invalid query/);
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
    packetsDecoded: 2,
    radioConnected: true,
    brokersConnected: 1,
    brokersTotal: 1,
    botsReady: 1,
    botsTotal: 1,
    replyQueueSize: 0,
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
    packetsDecoded: 1,
    radioConnected: true,
    brokersConnected: 1,
    brokersTotal: 1,
    botsReady: 1,
    botsTotal: 1,
    replyQueueSize: 0,
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
    packetsDecoded: 1,
    radioConnected: true,
    brokersConnected: 1,
    brokersTotal: 1,
    botsReady: 1,
    botsTotal: 1,
    replyQueueSize: 0,
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
  seedResolvedReply(metricsStore, { botName: 'echo', trigger: '!echo', status: 'sent', occurredAt: 5000 });
  seedResolvedReply(metricsStore, { botName: 'echo', trigger: '!echo', status: 'sent', occurredAt: 6000 });

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
  seedResolvedReply(metricsStore, { botName: 'multi', trigger: '!cmd7', status: 'sent', occurredAt: 5000 });

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

test('GET /api/metrics/brokers returns every currently-configured broker, zero-filled, with sent/skipped/failed totals', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  metricsStore.recordPacketSample({
    sampleAt: 5000,
    intervalMs: 1000,
    packetsReceived: 3,
    packetsDecoded: 3,
    radioConnected: true,
    brokersConnected: 2,
    brokersTotal: 2,
    botsReady: 1,
    botsTotal: 1,
    replyQueueSize: 0,
    brokerDeliveries: {
      okimesh: { sent: 2, skipped: 1, failed: 0 },
      letsmesh: { sent: 0, skipped: 0, failed: 1 }
    }
  });

  const serviceHealth = fakeServiceHealth({
    mqtt: {
      okimesh: { connected: true, lastConnectedAt: null, deliveries: { sent: 2, skipped: 1, failed: 0 } },
      letsmesh: { connected: false, lastConnectedAt: null, deliveries: { sent: 0, skipped: 0, failed: 1 } },
      // Configured but never delivered anything in range - must still be zero-filled.
      unused: { connected: false, lastConnectedAt: null, deliveries: { sent: 0, skipped: 0, failed: 0 } }
    }
  });

  await withServer({ metricsStore, serviceHealth }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/brokers?start=0&end=10000`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.brokers, [
      { brokerId: 'okimesh', sent: 2, skipped: 1, failed: 0 },
      { brokerId: 'letsmesh', sent: 0, skipped: 0, failed: 1 },
      { brokerId: 'unused', sent: 0, skipped: 0, failed: 0 }
    ]);
  });
});

test('GET /api/metrics/brokers rejects an invalid range query the same way as the other range endpoints', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/brokers`);
    assert.equal(res.status, 400);
  });
});

test('GET / returns the dashboard HTML page, referencing its stylesheet and browser script as separate assets', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.match(body, /MeshCore Observer Metrics/);

    // Not inlined - a real <link>/<script type="module"> pair pointing at
    // the static assets served below, per the src/web/client/ split.
    assert.match(body, /<link rel="stylesheet" href="dashboard\.css">/);
    assert.match(body, /<script type="module" src="dashboard\.js">/);

    // A representative sample of the element ids the browser script binds
    // to, so a rename of one in the template without updating the other
    // fails a test instead of only failing silently in a browser.
    for (const id of ['packets-decoded', 'chart-wrap', 'range-presets', 'queue-size', 'queue-sent', 'bot-commands-container']) {
      assert.match(body, new RegExp(`id="${id}"`), `expected an element with id="${id}"`);
    }
  });
});

test('GET /dashboard.css serves the dashboard stylesheet as a real CSS file', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/dashboard.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/css/);
    const body = await res.text();
    assert.match(body, /\.tile\s*{/);
  });
});

test('GET /dashboard.js serves the browser entry point as a real ES module', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/dashboard.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/javascript/);
    const body = await res.text();
    assert.match(body, /import \{[^}]*\} from '\.\/dashboard-logic\.js'/);
    assert.match(body, /import \{ PACKET_TYPE_BUCKETS \} from '\.\/packet-type-buckets\.js'/);
  });
});

test('GET /dashboard-logic.js serves the pure logic module the dashboard imports', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/dashboard-logic.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/javascript/);
    const body = await res.text();
    assert.match(body, /export function formatDuration/);
  });
});

test('GET /packet-type-buckets.js serves the actual server module, byte-for-byte - never a hand-copied duplicate', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/packet-type-buckets.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/javascript/);
    const served = await res.text();
    const onDisk = readFileSync(join(WEB_DIR, 'packet-type-buckets.js'), 'utf8');
    assert.equal(served, onDisk);
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

test('an abruptly disconnected SSE client is cleaned up without crashing the tick loop or the server', async () => {
  await withServer({ sampleIntervalMs: 20 }, async (baseUrl) => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/metrics/stream`, { signal: controller.signal });
    await res.body.getReader().read(); // consume the initial event
    controller.abort(); // no clean close handshake

    // Give the tick loop a couple of cycles to run with the now-broken
    // client still possibly registered, then confirm the server is still
    // healthy and responsive - a broken SSE client must never crash it or
    // stop future ticks from persisting samples.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const followUp = await fetch(`${baseUrl}/api/metrics`);
    assert.equal(followUp.status, 200);
  });
});

test('GET /api/metrics returns a generic 500 (never the real error message) if ServiceHealth.snapshot() throws', async () => {
  const serviceHealth = {
    snapshot: () => {
      throw new Error('radioManager exploded');
    }
  };
  const logger = fakeLogger();

  await withServer({ serviceHealth, logger }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics`);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.deepEqual(body, { error: 'internal error' });
    assert.ok(!JSON.stringify(body).includes('radioManager exploded'), 'must not leak the real error message to the client');

    const warning = logger.warnings.find((w) => w.message.includes('unexpected error handling a dashboard request'));
    assert.ok(warning, 'expected the real error to be logged server-side');
    assert.equal(warning.meta.error, 'radioManager exploded');

    // The dashboard being broken must not take the whole server down -
    // a subsequent, unrelated request still works.
    const followUp = await fetch(`${baseUrl}/api/metrics/history?range=24h`);
    assert.equal(followUp.status, 200);
  });
});

test('a range endpoint returns a generic 500 if a metrics-store query throws, rather than crashing the server', async () => {
  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  metricsStore.queryPacketTypeTotals = () => {
    throw new Error('database disk image is malformed');
  };
  const logger = fakeLogger();

  await withServer({ metricsStore, logger }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/metrics/packet-types?range=24h`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(body, { error: 'internal error' });
    assert.ok(logger.warnings.some((w) => w.meta.error === 'database disk image is malformed'));
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

test('start() rejects and leaves the server stoppable when the port is already occupied', async () => {
  const occupant = createServer();
  await new Promise((resolve) => occupant.listen(0, '127.0.0.1', resolve));
  const { port } = occupant.address();

  const metricsStore = new MetricsStore({ dbPath: ':memory:' });
  const logger = fakeLogger();
  const server = new MetricsServer({
    serviceHealth: fakeServiceHealth(),
    metricsStore,
    botsConfig: defaultBotsConfig(),
    host: '127.0.0.1',
    port,
    sampleIntervalMs: 60000,
    maxChartBuckets: 180,
    retentionDays: 0,
    logger
  });

  try {
    await assert.rejects(() => server.start(), /EADDRINUSE/);
    assert.equal(server.address(), null);

    // stop() must remain safe and idempotent after a failed startup.
    await server.stop();
    await server.stop();

    // A retry against a free port should succeed once the state is clear.
    const retryServer = new MetricsServer({
      serviceHealth: fakeServiceHealth(),
      metricsStore,
      botsConfig: defaultBotsConfig(),
      host: '127.0.0.1',
      port: 0,
      sampleIntervalMs: 60000,
      maxChartBuckets: 180,
      retentionDays: 0,
      logger
    });
    await retryServer.start();
    assert.ok(retryServer.address());
    await retryServer.stop();
  } finally {
    metricsStore.close();
    await new Promise((resolve) => occupant.close(resolve));
  }
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
