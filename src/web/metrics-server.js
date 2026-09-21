import { createServer } from 'node:http';
import { renderDashboardHtml } from './dashboard-page.js';
import { PACKET_TYPE_BUCKETS } from './packet-type-buckets.js';
import { parseRangeQuery, validateMetricsHistoryQuery, validateRangeOnlyQuery } from './schemas.js';
import { resolveRangeWindow, RangeError as RangeResolutionError } from './metrics-range.js';
import { computeSampleDelta } from './metrics-sample.js';
import { bucketBotCommandCounts } from './bot-command-buckets.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Serves the metrics dashboard and its data over plain node:http - no
 * framework dependency, per AGENTS.md. Intentionally has no authentication;
 * that remains its own protected boundary, so the caller is expected to
 * bind this to a loopback host unless the operator has explicitly opted
 * into wider exposure (and accepted the risk that implies).
 */
export class MetricsServer {
  #serviceHealth;
  #metricsStore;
  #botsConfig;
  #host;
  #port;
  #sampleIntervalMs;
  #maxChartBuckets;
  #retentionDays;
  #logger;
  #server = null;
  #sampleTimer = null;
  #sseClients = new Set();
  #lastSnapshot = null;
  #lastPrunedAt = null;

  /**
   * @param {{serviceHealth: object, metricsStore: object, botsConfig: {name: string, commands: {trigger: string}[]}[], host: string, port: number, sampleIntervalMs: number, maxChartBuckets: number, retentionDays: number, logger: object}} options
   * `botsConfig` is the validated bots configuration array (see
   * src/config/schema.js) - only `name` and each command's `trigger` are
   * used, to build the stable, config-ordered trigger list each bot's
   * command chart is keyed against (see bot-command-buckets.js).
   */
  constructor({ serviceHealth, metricsStore, botsConfig, host, port, sampleIntervalMs, maxChartBuckets, retentionDays, logger }) {
    this.#serviceHealth = serviceHealth;
    this.#metricsStore = metricsStore;
    this.#botsConfig = botsConfig;
    this.#host = host;
    this.#port = port;
    this.#sampleIntervalMs = sampleIntervalMs;
    this.#maxChartBuckets = maxChartBuckets;
    this.#retentionDays = retentionDays;
    this.#logger = logger;
  }

  /** @returns {Promise<void>} resolves once the server is listening. */
  start() {
    if (this.#server) {
      return Promise.resolve();
    }

    if (!LOOPBACK_HOSTS.has(this.#host)) {
      this.#logger.warn('services.metricsUi', 'metrics UI bound to a non-loopback host with no authentication', {
        host: this.#host
      });
    }

    this.#sampleTimer = setInterval(() => this.#tick(), this.#sampleIntervalMs);
    this.#sampleTimer.unref();

    this.#server = createServer((req, res) => this.#handleRequest(req, res));

    return new Promise((resolve) => {
      this.#server.listen(this.#port, this.#host, () => {
        const address = this.#server.address();
        this.#logger.info('services.metricsUi', 'metrics UI listening', { host: address.address, port: address.port });
        resolve();
      });
    });
  }

  /** @returns {{address: string, port: number}|null} the bound address once listening, e.g. for tests using port 0. */
  address() {
    return this.#server ? this.#server.address() : null;
  }

  /** Stops the sample timer, closes any open SSE connections, and closes the server. */
  async stop() {
    if (this.#sampleTimer) {
      clearInterval(this.#sampleTimer);
      this.#sampleTimer = null;
    }

    for (const res of this.#sseClients) {
      res.end();
    }
    this.#sseClients.clear();

    if (!this.#server) {
      return;
    }
    const server = this.#server;
    this.#server = null;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  #tick() {
    const snapshot = this.#serviceHealth.snapshot();
    this.#recordSample(snapshot);
    this.#maybePrune();
    this.#lastSnapshot = snapshot;

    const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const res of this.#sseClients) {
      res.write(payload);
    }
  }

  #recordSample(snapshot) {
    const sample = computeSampleDelta({
      prevSnapshot: this.#lastSnapshot,
      snapshot,
      sampleAt: Date.now(),
      intervalMs: this.#sampleIntervalMs
    });

    try {
      this.#metricsStore.recordPacketSample(sample);
    } catch (err) {
      this.#logger.warn('services.metricsUi', 'failed to persist a metrics sample', { error: err.message });
    }
  }

  /** Prunes persisted metrics older than the configured retention window, at most once per day. */
  #maybePrune() {
    if (this.#retentionDays <= 0) {
      return;
    }
    const now = Date.now();
    if (this.#lastPrunedAt !== null && now - this.#lastPrunedAt < ONE_DAY_MS) {
      return;
    }
    this.#lastPrunedAt = now;
    try {
      this.#metricsStore.pruneOlderThan(now - this.#retentionDays * ONE_DAY_MS);
    } catch (err) {
      this.#logger.warn('services.metricsUi', 'failed to prune persisted metrics', { error: err.message });
    }
  }

  #handleRequest(req, res) {
    if (req.method !== 'GET') {
      this.#sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    const { pathname, searchParams } = new URL(req.url, 'http://localhost');

    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHtml());
      return;
    }

    if (pathname === '/api/metrics') {
      this.#sendJson(res, 200, this.#serviceHealth.snapshot());
      return;
    }

    if (pathname === '/api/metrics/history') {
      this.#handleHistory(res, searchParams);
      return;
    }

    if (pathname === '/api/metrics/packet-types') {
      this.#handlePacketTypes(res, searchParams);
      return;
    }

    if (pathname === '/api/metrics/bots/commands') {
      this.#handleBotCommands(res, searchParams);
      return;
    }

    if (pathname === '/api/metrics/stream') {
      this.#handleStream(res);
      return;
    }

    this.#sendJson(res, 404, { error: 'not found' });
  }

  /**
   * Resolves a request's `range` (or `start`+`end`) query into a concrete
   * window against the given AJV validator, shared by both range-aware
   * endpoints below. Returns null (having already sent a 400 response)
   * when the query is invalid, so callers can just check for that and
   * return.
   */
  #resolveWindowOrRespondError(res, searchParams, validate) {
    const query = parseRangeQuery(searchParams);
    if (!validate(query)) {
      this.#sendJson(res, 400, { error: `invalid query: ${validate.errors.map((e) => e.message).join('; ')}` });
      return null;
    }

    try {
      const window = resolveRangeWindow({
        range: query.range,
        start: query.start,
        end: query.end,
        earliestSampleAt: query.range === 'all' ? this.#metricsStore.getEarliestSampleAt() : null
      });
      return { query, window };
    } catch (err) {
      if (err instanceof RangeResolutionError) {
        this.#sendJson(res, 400, { error: err.message });
        return null;
      }
      throw err;
    }
  }

  #handleHistory(res, searchParams) {
    const resolved = this.#resolveWindowOrRespondError(res, searchParams, validateMetricsHistoryQuery);
    if (!resolved) {
      return;
    }
    const { query, window } = resolved;

    const buckets = this.#metricsStore.queryPacketHistory({
      start: window.start,
      end: window.end,
      maxBuckets: query.maxBuckets ?? this.#maxChartBuckets,
      sampleIntervalMs: this.#sampleIntervalMs
    });
    this.#sendJson(res, 200, { start: window.start, end: window.end, buckets });
  }

  #handlePacketTypes(res, searchParams) {
    const resolved = this.#resolveWindowOrRespondError(res, searchParams, validateRangeOnlyQuery);
    if (!resolved) {
      return;
    }
    const { window } = resolved;

    const totals = this.#metricsStore.queryPacketTypeTotals(window);
    this.#sendJson(res, 200, { start: window.start, end: window.end, totals, buckets: PACKET_TYPE_BUCKETS });
  }

  /**
   * Per configured bot, a stably-ordered (config order, not usage rank -
   * see bot-command-buckets.js) trigger breakdown for the requested range,
   * plus that bot's total replies sent in range. Every currently-configured
   * bot is included even with zero commands in range, so the dashboard can
   * render a consistent empty-state rather than a missing section.
   */
  #handleBotCommands(res, searchParams) {
    const resolved = this.#resolveWindowOrRespondError(res, searchParams, validateRangeOnlyQuery);
    if (!resolved) {
      return;
    }
    const { window } = resolved;

    const bots = this.#botsConfig.map((botConfig) => {
      const counts = this.#metricsStore.queryBotCommandCounts({
        botName: botConfig.name,
        start: window.start,
        end: window.end
      });
      const commands = bucketBotCommandCounts(botConfig.commands, counts);
      return {
        botName: botConfig.name,
        commands,
        totalReplies: commands.reduce((sum, row) => sum + row.count, 0)
      };
    });

    this.#sendJson(res, 200, { start: window.start, end: window.end, bots });
  }

  #handleStream(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(`data: ${JSON.stringify(this.#serviceHealth.snapshot())}\n\n`);
    this.#sseClients.add(res);
    res.on('close', () => {
      this.#sseClients.delete(res);
    });
  }

  #sendJson(res, statusCode, body) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
