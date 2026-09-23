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
  <span id="connection-indicator">connecting…</span>
</header>

<section id="tiles">
  <div class="tile"><h2>Uptime</h2><p id="uptime">-</p></div>
  <div class="tile"><h2>Radio</h2><p id="radio-status">-</p><p class="sub" id="radio-detail"></p></div>
  <div class="tile"><h2>Packets received</h2><p id="packets-received">0</p></div>
  <div class="tile"><h2>Packets decoded</h2><p id="packets-decoded">0</p></div>
</section>

<section>
  <h2>Packet activity</h2>
  <div class="range-selector" id="range-selector">
    <span id="range-presets"></span>
    <button type="button" class="range-btn" id="range-custom-toggle" data-range="custom">Custom</button>
    <span class="range-custom" id="range-custom">
      <input type="date" id="range-start">
      <span>to</span>
      <input type="date" id="range-end">
      <button type="button" id="range-apply">Apply</button>
      <span class="range-error" id="range-error"></span>
    </span>
  </div>
  <p class="section-note" id="chart-note">Loading…</p>
  <div id="chart-wrap">
    <canvas id="chart"></canvas>
    <div id="chart-fallback">Chart unavailable - Chart.js could not be loaded from the CDN (no internet access?). Totals below are still live.</div>
  </div>
  <div class="split-layout">
    <table id="packet-types-table">
      <thead><tr><th></th><th>Type</th><th>Total</th></tr></thead>
      <tbody></tbody>
    </table>
    <div class="pie-wrap">
      <canvas id="packet-types-pie"></canvas>
    </div>
  </div>
</section>

<section>
  <h2>MQTT brokers</h2>
  <table id="brokers-table">
    <thead><tr><th>Broker</th><th>Connected</th><th>Last connected</th></tr></thead>
    <tbody></tbody>
  </table>
  <p class="section-note">Connected/last connected are live; deliveries below reflect the range selected above.</p>
  <table id="broker-deliveries-table">
    <thead><tr><th>Broker</th><th>Sent</th><th>Skipped</th><th>Failed</th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<section>
  <h2>Channel bots</h2>
  <p class="section-note">Queued now is live; sent/expired/failed and per-bot command counts reflect the range selected above.</p>
  <div id="reply-queue-tiles" class="tile-grid">
    <div class="tile"><h2>Queued now</h2><p id="queue-size">0</p></div>
    <div class="tile"><h2>Sent</h2><p id="queue-sent">0</p></div>
    <div class="tile"><h2>Expired</h2><p id="queue-expired">0</p></div>
    <div class="tile"><h2>Failed</h2><p id="queue-failed">0</p></div>
  </div>
  <div id="bot-commands-container"></div>
</section>

<section>
  <h2>Repeaters</h2>
  <p class="section-note">Added/updated reflect the range selected above; the table below is live current state (searchable), not range-scoped.</p>
  <div id="node-tiles" class="tile-grid">
    <div class="tile"><h2>Added</h2><p id="nodes-added">0</p></div>
    <div class="tile"><h2>Updated</h2><p id="nodes-updated">0</p></div>
  </div>
  <div class="search-bar">
    <input type="search" id="nodes-search" placeholder="Search by name or public key prefix…" aria-label="Search repeaters">
  </div>
  <table id="nodes-table">
    <thead><tr><th>Name</th><th>Public key</th><th>First heard</th><th>Last heard</th></tr></thead>
    <tbody></tbody>
  </table>
  <div class="pagination" id="nodes-pagination">
    <button type="button" id="nodes-prev">Prev</button>
    <span id="nodes-page-note"></span>
    <button type="button" id="nodes-next">Next</button>
  </div>
</section>

<script src="${CHARTJS_URL}" integrity="${CHARTJS_INTEGRITY}" crossorigin="anonymous"></script>
<script type="module" src="dashboard.js"></script>
</body>
</html>
`;
}
