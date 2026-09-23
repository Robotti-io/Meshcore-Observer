import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderDashboardHtml } from './dashboard-page.js';
import { PACKET_TYPE_BUCKETS } from './packet-type-buckets.js';
import {
  parseRangeQuery,
  validateMetricsHistoryQuery,
  validateRangeOnlyQuery,
  validateNodeTotalsQuery,
  parseNodesListQuery,
  validateNodesListQuery
} from './schemas.js';
import { resolveRangeWindow, RangeError as RangeResolutionError } from './metrics-range.js';
import { computeSampleDelta } from './metrics-sample.js';
import { bucketBotCommandCounts } from './bot-command-buckets.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NODES_LIMIT = 50;

const WEB_DIR = dirname(fileURLToPath(import.meta.url));
const TEXT_JS = 'text/javascript; charset=utf-8';

/**
 * The dashboard's browser-side files, served as-is (no bundling/transform)
 * so a `<script type="module">` can import them by plain relative URL - see
 * dashboard-page.js's doc comment. Read once at module load, not per
 * request: these files never change while the process is running.
 * packet-type-buckets.js is the actual server module (not a copy), so the
 * browser's packet-type/color mapping can never drift from what the server
 * buckets samples under.
 */
const STATIC_ASSETS = new Map(
  [
    { route: '/dashboard.css', file: join(WEB_DIR, 'client', 'dashboard.css'), contentType: 'text/css; charset=utf-8' },
    { route: '/dashboard.js', file: join(WEB_DIR, 'client', 'dashboard.js'), contentType: TEXT_JS },
    { route: '/dashboard-logic.js', file: join(WEB_DIR, 'client', 'dashboard-logic.js'), contentType: TEXT_JS },
    { route: '/packet-type-buckets.js', file: join(WEB_DIR, 'packet-type-buckets.js'), contentType: TEXT_JS }
  ].map(({ route, file, contentType }) => [route, { body: readFileSync(file, 'utf8'), contentType }])
);

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

  /**
   * @returns {Promise<void>} resolves once the server is listening, or
   * rejects (e.g. `EADDRINUSE`) if binding fails. On rejection, all state is
   * cleared so the metrics UI is left fully stopped and `start()` can be
   * retried; the sample timer is not started until listening succeeds.
   */
  start() {
    if (this.#server) {
      return Promise.resolve();
    }

    if (!LOOPBACK_HOSTS.has(this.#host)) {
      this.#logger.warn('services.metricsUi', 'metrics UI bound to a non-loopback host with no authentication', {
        host: this.#host
      });
    }

    const server = createServer((req, res) => this.#handleRequest(req, res));
    this.#server = server;

    return new Promise((resolve, reject) => {
      const onStartupError = (err) => {
        this.#server = null;
        this.#logger.warn('services.metricsUi', 'metrics UI failed to start', {
          host: this.#host,
          port: this.#port,
          error: err.message
        });
        reject(err);
      };

      server.once('error', onStartupError);
      server.listen(this.#port, this.#host, () => {
        server.removeListener('error', onStartupError);
        server.on('error', (err) => {
          this.#logger.warn('services.metricsUi', 'metrics UI server error', { error: err.message });
        });

        this.#sampleTimer = setInterval(() => this.#tick(), this.#sampleIntervalMs);
        this.#sampleTimer.unref();

        const address = server.address();
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
      try {
        res.write(payload);
      } catch (err) {
        // A client's connection can go bad between ticks before its own
        // 'close' event fires (see #handleStream) - isolate that here so
        // one broken SSE client can't stop the broadcast to every other
        // one, or stop future ticks from persisting/pruning samples.
        this.#logger.warn('services.metricsUi', 'failed to write to an SSE client, removing it', { error: err.message });
        this.#sseClients.delete(res);
      }
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

  /**
   * The dashboard is optional and unauthenticated by design (see the class
   * doc comment) - it must never be capable of taking down packet capture
   * or MQTT publication just because a request handler hit a bug or the
   * metrics store misbehaved. Every route is dispatched through here so a
   * synchronous throw anywhere below (a corrupt database, an unexpected
   * ServiceHealth.snapshot() error, etc.) is caught, logged with enough
   * detail to diagnose, and turned into a generic 500 - never leaked into
   * the response body, and never left to crash the server's request
   * callback. `#dispatchRequest` and everything it calls is synchronous
   * (node:sqlite's DatabaseSync API included), so a plain try/catch here
   * covers the whole request.
   */
  #handleRequest(req, res) {
    try {
      this.#dispatchRequest(req, res);
    } catch (err) {
      this.#logger.warn('services.metricsUi', 'unexpected error handling a dashboard request', {
        method: req.method,
        url: req.url,
        error: err.message
      });
      try {
        // If headers already went out (the throw happened mid-response,
        // e.g. inside #handleStream after writeHead), there's no clean
        // response left to send - just end the connection rather than
        // leaving the client hanging.
        if (res.headersSent) {
          res.end();
        } else {
          this.#sendJson(res, 500, { error: 'internal error' });
        }
      } catch {
        // Reporting the failure failed too (e.g. the socket is already
        // gone) - nothing more can be done for this response, and this
        // must not escape to crash the request-handling callback itself.
      }
    }
  }

  #dispatchRequest(req, res) {
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

    const asset = STATIC_ASSETS.get(pathname);
    if (asset) {
      res.writeHead(200, { 'Content-Type': asset.contentType });
      res.end(asset.body);
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

    if (pathname === '/api/metrics/reply-queue') {
      this.#handleReplyQueue(res, searchParams);
      return;
    }

    if (pathname === '/api/metrics/bots/commands') {
      this.#handleBotCommands(res, searchParams);
      return;
    }

    if (pathname === '/api/metrics/brokers') {
      this.#handleBrokerDeliveries(res, searchParams);
      return;
    }

    if (pathname === '/api/metrics/nodes') {
      this.#handleNodeTotals(res, searchParams);
      return;
    }

    if (pathname === '/api/nodes') {
      this.#handleNodesList(res, searchParams);
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
   * Reply-lifecycle outcome totals (sent/failed/expired/cancelled) summed
   * across every bot, for the requested range - unlike queue depth (a live
   * gauge, served via /api/metrics), these are historical counts and so
   * follow the same duration-selector pattern as packet-types/history.
   */
  #handleReplyQueue(res, searchParams) {
    const resolved = this.#resolveWindowOrRespondError(res, searchParams, validateRangeOnlyQuery);
    if (!resolved) {
      return;
    }
    const { window } = resolved;

    const totals = this.#metricsStore.queryReplyOutcomeTotals(window);
    this.#sendJson(res, 200, { start: window.start, end: window.end, totals });
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

  /**
   * Per configured broker, sent/skipped/failed packet-delivery totals for
   * the requested range - the historical, range-scoped counterpart to the
   * live connected/last-connected state already in the ServiceHealth
   * snapshot (see renderSnapshot's #brokers-table on the dashboard). Every
   * currently-configured broker is included even with zero deliveries in
   * range, matching the bots/commands endpoint's zero-fill convention.
   * Broker IDs come from the live snapshot rather than a separate config
   * list, since ServiceHealth already derives them from MqttManager.
   */
  #handleBrokerDeliveries(res, searchParams) {
    const resolved = this.#resolveWindowOrRespondError(res, searchParams, validateRangeOnlyQuery);
    if (!resolved) {
      return;
    }
    const { window } = resolved;

    const totals = this.#metricsStore.queryBrokerDeliveryTotals(window);
    const countsByBroker = new Map();
    for (const { brokerId, outcome, total } of totals) {
      const counts = countsByBroker.get(brokerId) ?? { sent: 0, skipped: 0, failed: 0 };
      counts[outcome] = total;
      countsByBroker.set(brokerId, counts);
    }

    const brokerIds = Object.keys(this.#serviceHealth.snapshot().mqtt);
    const brokers = brokerIds.map((brokerId) => ({
      brokerId,
      ...(countsByBroker.get(brokerId) ?? { sent: 0, skipped: 0, failed: 0 })
    }));

    this.#sendJson(res, 200, { start: window.start, end: window.end, brokers });
  }

  /**
   * Distinct-node "added"/"updated" counts for the requested range (see
   * MetricsStore#queryNodeTotals) - the range-scoped half of the node
   * ("!lookup" repeater registry) dashboard section. The other half,
   * search/browse, is /api/nodes below - deliberately *not* range-scoped,
   * since it lists current state, not history.
   */
  #handleNodeTotals(res, searchParams) {
    const resolved = this.#resolveWindowOrRespondError(res, searchParams, validateNodeTotalsQuery);
    if (!resolved) {
      return;
    }
    const { query, window } = resolved;

    const totals = this.#metricsStore.queryNodeTotals({ ...window, type: query.type ?? '' });
    this.#sendJson(res, 200, { start: window.start, end: window.end, totals });
  }

  /**
   * A page of the current node contact list (see MetricsStore#queryNodes),
   * optionally filtered by `q` (name substring or public-key hex prefix)
   * and/or `type`. Not range-scoped - see #handleNodeTotals above for the
   * range-scoped added/updated counts.
   */
  #handleNodesList(res, searchParams) {
    const query = parseNodesListQuery(searchParams);
    if (!validateNodesListQuery(query)) {
      this.#sendJson(res, 400, { error: `invalid query: ${validateNodesListQuery.errors.map((e) => e.message).join('; ')}` });
      return;
    }

    const result = this.#metricsStore.queryNodes({
      q: query.q ?? '',
      type: query.type ?? '',
      limit: query.limit ?? DEFAULT_NODES_LIMIT,
      offset: query.offset ?? 0
    });
    this.#sendJson(res, 200, result);
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
    // A write failure on a broken connection typically surfaces as an
    // 'error' event (asynchronously), not a thrown exception - the
    // try/catch around #tick()'s broadcast loop covers the rarer
    // synchronous-throw case; this covers the common one. Without this,
    // an unremoved dead client would keep failing every future tick.
    res.on('error', (err) => {
      this.#logger.warn('services.metricsUi', 'SSE client connection error, removing it', { error: err.message });
      this.#sseClients.delete(res);
    });
  }

  #sendJson(res, statusCode, body) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
