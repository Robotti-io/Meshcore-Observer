import { createServer } from 'node:http';
import { renderDashboardHtml } from './dashboard-page.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Serves the metrics dashboard and its data over plain node:http - no
 * framework dependency, per AGENTS.md. Intentionally has no authentication;
 * that remains its own protected boundary, so the caller is expected to
 * bind this to a loopback host unless the operator has explicitly opted
 * into wider exposure (and accepted the risk that implies).
 */
export class MetricsServer {
  #serviceHealth;
  #metricsHistory;
  #host;
  #port;
  #sampleIntervalMs;
  #logger;
  #server = null;
  #sampleTimer = null;
  #sseClients = new Set();

  /**
   * @param {{serviceHealth: object, metricsHistory: object, host: string, port: number, sampleIntervalMs: number, logger: object}} options
   */
  constructor({ serviceHealth, metricsHistory, host, port, sampleIntervalMs, logger }) {
    this.#serviceHealth = serviceHealth;
    this.#metricsHistory = metricsHistory;
    this.#host = host;
    this.#port = port;
    this.#sampleIntervalMs = sampleIntervalMs;
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
    this.#metricsHistory.record(snapshot);
    const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const res of this.#sseClients) {
      res.write(payload);
    }
  }

  #handleRequest(req, res) {
    if (req.method !== 'GET') {
      this.#sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    const { pathname } = new URL(req.url, 'http://localhost');

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
      this.#sendJson(res, 200, this.#metricsHistory.getSamples());
      return;
    }

    if (pathname === '/api/metrics/stream') {
      this.#handleStream(res);
      return;
    }

    this.#sendJson(res, 404, { error: 'not found' });
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
