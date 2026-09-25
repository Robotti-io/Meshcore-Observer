const CHARTJS_VERSION = '4.4.4';
const CHARTJS_URL = `https://cdn.jsdelivr.net/npm/chart.js@${CHARTJS_VERSION}/dist/chart.umd.js`;
// Pinned to the exact bytes of dist/chart.umd.js for that version (verified
// against jsdelivr's own published hash before pinning). Deliberately NOT
// chart.umd.min.js - jsdelivr generates that minified file on the fly per
// request and warns against using SRI with it, since the served bytes
// aren't guaranteed stable.
const CHARTJS_INTEGRITY = 'sha384-G436+Z2nlA8+PNoeRvWdxKbvOf8E/y+lYxqht2iBwNHTQDV5CJr3+AGVj8fGZi5t';

/**
 * Renders the metrics dashboard's HTML shell. The page's CSS and browser
 * JavaScript are NOT inlined here - they live as ordinary files under
 * src/web/client/ (dashboard.css, dashboard.js, and the pure-logic module
 * dashboard-logic.js it imports), served as static assets by MetricsServer.
 * That split is what lets ESLint actually parse the browser script as real
 * JavaScript source (rather than opaque template-string contents) and lets
 * dashboard-logic.js's pure functions be unit-tested directly under Node -
 * see that file's own doc comment and test/web/client/dashboard-logic.test.js.
 * No build step either way: dashboard.js is loaded as a real
 * `<script type="module">` and imports its sibling files by plain relative
 * URL, resolved by the browser itself.
 *
 * The one external resource, Chart.js, is loaded by the browser directly
 * from a CDN with Subresource Integrity pinned (see CHARTJS_INTEGRITY
 * above) rather than vendored through this app, per explicit project
 * decision. That CDN load means the packet-activity chart specifically
 * needs the viewing browser to have outbound internet access; the rest of
 * the dashboard (tiles, tables, SSE live updates) does not.
 */
export function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MeshCore Observer Metrics</title>
<link rel="stylesheet" href="dashboard.css">
</head>
<body>
<header>
  <h1>MeshCore Observer Metrics</h1>
  <span id="connection-indicator" aria-live="off">connecting…</span>
  <span id="live-freshness" class="freshness" aria-live="off">Waiting for first live snapshot</span>
  <span id="live-announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></span>
</header>

<section id="live-tiles" class="tile-grid" aria-label="Live observer status">
  <div class="tile"><h2>Uptime <span class="scope-label">Live</span></h2><p id="uptime" class="uptime" role="timer" aria-label="Observer uptime" aria-live="off"><span id="uptime-days" class="uptime-segment heartbeat-segment" hidden></span><span id="uptime-hours" class="uptime-segment heartbeat-segment" hidden></span><span id="uptime-minutes" class="uptime-segment heartbeat-segment" hidden></span><span id="uptime-seconds" class="uptime-segment heartbeat-segment">0s</span></p></div>
  <div class="tile"><h2>Radio <span class="scope-label">Live</span></h2><p id="radio-status">-</p><p class="sub" id="radio-detail"></p></div>
</section>

<section id="range-controls">
  <h2>Reporting range</h2>
  <div class="range-selector" id="range-selector">
    <span id="range-presets" role="group" aria-label="Reporting range presets"></span>
    <button type="button" class="range-btn" id="range-custom-toggle" data-range="custom" aria-pressed="false">Custom</button>
    <span class="range-custom" id="range-custom">
      <input type="date" id="range-start">
      <span>to</span>
      <input type="date" id="range-end">
      <button type="button" id="range-apply">Apply</button>
      <span class="range-error" id="range-error"></span>
    </span>
  </div>
  <p class="data-status" id="range-data-status">Loading selected-range metrics…</p>
</section>

<nav class="dashboard-nav" aria-label="Metrics views">
  <a href="?view=overview" data-view-link="overview">Overview</a>
  <a href="?view=packets" data-view-link="packets">Packet activity</a>
  <a href="?view=brokers" data-view-link="brokers">MQTT brokers</a>
  <a href="?view=bots" data-view-link="bots">Channel bots</a>
  <a href="?view=repeaters" data-view-link="repeaters">Repeaters</a>
</nav>

<main id="dashboard-views">
<section class="dashboard-view" id="view-overview" data-view="overview">
  <h2 tabindex="-1">Overview</h2>
  <p class="section-note">Summary metrics use the reporting range above. Trend indicators compare with the previous equivalent period; connectivity and uptime are live.</p>
  <p class="section-note" id="overview-comparison-note"></p>
  <div id="overview-tiles" class="tile-grid">
    <div class="tile"><h2>Packets received</h2><p class="metric-value"><span id="packets-received">0</span><span id="packets-received-trend" class="metric-trend" aria-label="No prior period comparison available">—</span></p></div>
    <div class="tile"><h2>Packets decoded</h2><p class="metric-value"><span id="packets-decoded">0</span><span id="packets-decoded-trend" class="metric-trend" aria-label="No prior period comparison available">—</span></p></div>
    <div class="tile"><h2>Replies sent</h2><p class="metric-value"><span id="overview-replies-sent">0</span><span id="overview-replies-sent-trend" class="metric-trend" aria-label="No prior period comparison available">—</span></p></div>
    <div class="tile"><h2>Replies expired</h2><p class="metric-value"><span id="overview-replies-expired">0</span><span id="overview-replies-expired-trend" class="metric-trend" aria-label="No prior period comparison available">—</span></p></div>
    <div class="tile"><h2>Replies failed</h2><p class="metric-value"><span id="overview-replies-failed">0</span><span id="overview-replies-failed-trend" class="metric-trend" aria-label="No prior period comparison available">—</span></p></div>
    <div class="tile"><h2>Broker deliveries sent</h2><p class="metric-value"><span id="overview-broker-sent">0</span><span id="overview-broker-sent-trend" class="metric-trend" aria-label="No prior period comparison available">—</span></p></div>
    <div class="tile"><h2>Broker deliveries failed</h2><p class="metric-value"><span id="overview-broker-failed">0</span><span id="overview-broker-failed-trend" class="metric-trend" aria-label="No prior period comparison available">—</span></p></div>
    <div class="tile"><h2>Repeaters added</h2><p class="metric-value"><span id="overview-repeaters-added">0</span><span id="overview-repeaters-added-trend" class="metric-trend" aria-label="No prior period comparison available">—</span></p></div>
    <div class="tile"><h2>Repeaters updated</h2><p class="metric-value"><span id="overview-repeaters-updated">0</span><span id="overview-repeaters-updated-trend" class="metric-trend" aria-label="No prior period comparison available">—</span></p></div>
  </div>
</section>

<section class="dashboard-view" id="view-packets" data-view="packets" hidden>
  <h2 tabindex="-1">Packet activity</h2>
  <p class="section-note" id="chart-note">Loading…</p>
  <div id="chart-wrap">
    <canvas id="chart" aria-hidden="true"></canvas>
    <div id="chart-fallback">Chart unavailable - Chart.js could not be loaded from the CDN (no internet access?). Packet totals remain available in the table.</div>
  </div>
  <p class="chart-summary" id="chart-summary">Packet activity over time; exact packet-type totals are listed in the table below.</p>
  <div class="split-layout">
    <div class="table-scroll" role="region" aria-label="Packet totals by type" tabindex="0">
      <table id="packet-types-table">
      <thead><tr><th></th><th>Type</th><th>Total</th></tr></thead>
      <tbody></tbody>
      </table>
    </div>
    <div>
      <div class="pie-wrap">
        <canvas id="packet-types-pie" aria-hidden="true"></canvas>
      </div>
      <p class="chart-summary" id="packet-types-chart-summary">Packet distribution by type; exact totals are listed in the adjacent table.</p>
    </div>
  </div>
</section>

<section class="dashboard-view" id="view-brokers" data-view="brokers" hidden>
  <h2 tabindex="-1">MQTT brokers <span class="scope-label">Live status</span></h2>
  <div class="table-scroll" role="region" aria-label="Live MQTT broker connection status" tabindex="0">
    <table id="brokers-table">
    <thead><tr><th>Broker</th><th>Connected</th><th>Last connected</th></tr></thead>
    <tbody></tbody>
    </table>
  </div>
  <p class="section-note">Connected/last connected are live; deliveries below reflect the range selected above.</p>
  <div class="table-scroll" role="region" aria-label="MQTT broker delivery totals for selected range" tabindex="0">
    <table id="broker-deliveries-table">
    <thead><tr><th>Broker</th><th>Sent</th><th>Skipped</th><th>Failed</th></tr></thead>
    <tbody></tbody>
    </table>
  </div>
</section>

<section class="dashboard-view" id="view-bots" data-view="bots" hidden>
  <h2 tabindex="-1">Channel bots</h2>
  <p class="section-note">Queued now is live; sent/expired/failed and per-bot command counts reflect the range selected above.</p>
  <div id="reply-queue-tiles" class="tile-grid">
    <div class="tile"><h2>Queued now <span class="scope-label">Live</span></h2><p id="queue-size">0</p></div>
    <div class="tile"><h2>Sent</h2><p id="queue-sent">0</p></div>
    <div class="tile"><h2>Expired</h2><p id="queue-expired">0</p></div>
    <div class="tile"><h2>Failed</h2><p id="queue-failed">0</p></div>
  </div>
  <p id="bots-empty-state" class="empty-state" hidden>No channel bots are configured.</p>
  <div id="bot-commands-container"></div>
</section>

<section class="dashboard-view" id="view-repeaters" data-view="repeaters" hidden>
  <h2 tabindex="-1">Repeaters</h2>
  <p class="section-note"><span class="scope-label">Live</span> Current repeater inventory is searchable and not range-scoped. Added/updated reflect the reporting range.</p>
  <div id="node-tiles" class="tile-grid">
    <div class="tile"><h2>Added</h2><p id="nodes-added">0</p></div>
    <div class="tile"><h2>Updated</h2><p id="nodes-updated">0</p></div>
  </div>
  <div class="search-bar">
    <input type="search" id="nodes-search" placeholder="Search by name or public key prefix…" aria-label="Search repeaters">
  </div>
  <p class="data-status" id="nodes-data-status">Loading current repeater list…</p>
  <div class="table-scroll" role="region" aria-label="Current repeater inventory" tabindex="0">
    <table id="nodes-table">
      <thead><tr><th>Name</th><th>Public key</th><th>First heard</th><th>Last heard</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <div class="pagination" id="nodes-pagination">
    <button type="button" id="nodes-prev">Prev</button>
    <span id="nodes-page-note"></span>
    <button type="button" id="nodes-next">Next</button>
  </div>
</section>
</main>

<script src="${CHARTJS_URL}" integrity="${CHARTJS_INTEGRITY}" crossorigin="anonymous"></script>
<script type="module" src="dashboard.js"></script>
</body>
</html>
`;
}
