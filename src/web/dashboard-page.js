import { PACKET_TYPE_BUCKETS } from './packet-type-buckets.js';

const CHARTJS_VERSION = '4.4.4';
const CHARTJS_URL = `https://cdn.jsdelivr.net/npm/chart.js@${CHARTJS_VERSION}/dist/chart.umd.js`;
// Pinned to the exact bytes of dist/chart.umd.js for that version (verified
// against jsdelivr's own published hash before pinning). Deliberately NOT
// chart.umd.min.js - jsdelivr generates that minified file on the fly per
// request and warns against using SRI with it, since the served bytes
// aren't guaranteed stable.
const CHARTJS_INTEGRITY = 'sha384-G436+Z2nlA8+PNoeRvWdxKbvOf8E/y+lYxqht2iBwNHTQDV5CJr3+AGVj8fGZi5t';

const RANGE_PRESETS = [
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: '1y', label: '1y' },
  { value: 'all', label: 'All' }
];
const DEFAULT_RANGE = '24h';

/**
 * Renders the single self-contained metrics dashboard page: inline CSS and
 * vanilla JS, no build step and no server-side static-file router (the one
 * external resource, Chart.js, is loaded by the browser directly from a
 * CDN with Subresource Integrity pinned - see CHARTJS_INTEGRITY above -
 * rather than vendored through this app, per explicit project decision).
 * That CDN load means the packet-activity chart specifically needs the
 * viewing browser to have outbound internet access; the rest of the
 * dashboard (tiles, tables, SSE live updates) does not.
 *
 * The packet-activity chart, packet-types table, and packet-types pie
 * chart are all range-aware: a duration selector (presets, or a custom
 * start/end date range) drives GET /api/metrics/history and
 * GET /api/metrics/packet-types, both of which do their bucketing/
 * aggregation on the backend (see MetricsServer and MetricsStore) so the
 * client never has to reason about how many raw samples exist - it only
 * ever renders however many buckets the server decided to return. The
 * "packet type -> display bucket" mapping (PACKET_TYPE_BUCKETS, from
 * packet-type-buckets.js) is embedded below as data rather than
 * hand-duplicated in this script, so the server (which buckets samples
 * before persisting them) and the browser (which only needs the
 * label/color metadata) can never drift apart.
 *
 * The packet-type chart's categorical colors are the dataviz skill's
 * validated 8-hue default palette (see references/palette.md in that
 * skill), used unmodified and in its documented fixed order - worst
 * adjacent CVD Delta E 9.1 light / 8.4 dark, already clears the >=8
 * target, so it is not re-validated here. MeshCore defines more than 8
 * payload types, so the rarer ones fold into a fixed "Other" bucket (slot
 * 8) rather than generating a 9th hue.
 */
export function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MeshCore Observer Metrics</title>
<style>
  :root {
    color-scheme: light dark;
    --chart-ink-secondary: #52514e;
    --chart-muted: #898781;
    --chart-gridline: #e1e0d9;
    /* dataviz skill's validated 8-hue categorical palette, fixed order -
       reused as-is for every categorical chart on this dashboard (packet
       types, and each bot's command breakdown), never a second palette. */
    --cat-1: #2a78d6;
    --cat-2: #eb6834;
    --cat-3: #1baf7a;
    --cat-4: #eda100;
    --cat-5: #e87ba4;
    --cat-6: #008300;
    --cat-7: #4a3aa7;
    --cat-8: #e34948;
    --control-border: color-mix(in srgb, canvastext 25%, transparent);
    --control-active-bg: color-mix(in srgb, canvastext 12%, transparent);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --chart-ink-secondary: #c3c2b7;
      --chart-muted: #898781;
      --chart-gridline: #2c2c2a;
      --cat-1: #3987e5;
      --cat-2: #d95926;
      --cat-3: #199e70;
      --cat-4: #c98500;
      --cat-5: #d55181;
      --cat-6: #008300;
      --cat-7: #9085e9;
      --cat-8: #e66767;
    }
  }
  body {
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    margin: 0;
    padding: 1.5rem;
    background: canvas;
    color: canvastext;
  }
  header { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1.25rem; }
  header h1 { font-size: 1.25rem; margin: 0; }
  #connection-indicator { font-size: 0.9rem; opacity: 0.7; }
  #connection-indicator.live { color: #2e9e44; opacity: 1; }
  #connection-indicator.down { color: #c4432b; opacity: 1; }
  section { margin-bottom: 1.75rem; }
  section h2 { font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; margin: 0 0 0.6rem; }
  .section-note { font-size: 0.8rem; opacity: 0.7; margin: -0.4rem 0 0.6rem; }
  #tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; }
  .tile { border: 1px solid color-mix(in srgb, canvastext 20%, transparent); border-radius: 8px; padding: 0.85rem 1rem; }
  .tile h2 { margin: 0 0 0.35rem; font-size: 0.8rem; }
  .tile p { margin: 0; font-size: 1.4rem; font-weight: 600; }
  .tile p.sub { font-size: 0.8rem; font-weight: 400; opacity: 0.7; margin-top: 0.25rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid color-mix(in srgb, canvastext 15%, transparent); }
  td.count { text-align: right; font-variant-numeric: tabular-nums; }
  .ok { color: #2e9e44; }
  .bad { color: #c4432b; }
  #chart-wrap { position: relative; height: 240px; border: 1px solid color-mix(in srgb, canvastext 20%, transparent); border-radius: 8px; padding: 0.5rem; box-sizing: border-box; }
  #chart-fallback { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; text-align: center; padding: 1rem; font-size: 0.85rem; opacity: 0.7; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 0.5rem; vertical-align: middle; }
  .swatch.dashed { background: none; border: 1.5px dashed var(--chart-muted); }
  .range-selector { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin-bottom: 0.75rem; }
  .range-btn { font: inherit; font-size: 0.85rem; padding: 0.3rem 0.7rem; border-radius: 999px; border: 1px solid var(--control-border); background: transparent; color: canvastext; cursor: pointer; }
  .range-btn.active { background: var(--control-active-bg); font-weight: 600; }
  .range-custom { display: none; align-items: center; gap: 0.4rem; font-size: 0.85rem; }
  .range-custom.visible { display: flex; }
  .range-custom input[type="date"] { font: inherit; font-size: 0.85rem; padding: 0.2rem 0.4rem; border-radius: 6px; border: 1px solid var(--control-border); background: canvas; color: canvastext; }
  .range-custom button { font: inherit; font-size: 0.85rem; padding: 0.25rem 0.6rem; border-radius: 6px; border: 1px solid var(--control-border); background: transparent; color: canvastext; cursor: pointer; }
  .range-error { font-size: 0.8rem; color: #c4432b; margin-left: 0.3rem; }
  .split-layout { display: flex; flex-wrap: wrap; gap: 1.25rem; align-items: flex-start; }
  .split-layout table { flex: 1 1 320px; min-width: 280px; }
  .pie-wrap { position: relative; width: 200px; height: 200px; flex: 0 0 auto; }
  @media (max-width: 560px) {
    .pie-wrap { width: 160px; height: 160px; }
  }
  .bot-command-block { margin-bottom: 1.5rem; }
  .bot-command-block h3 { font-size: 0.85rem; margin: 0 0 0.5rem; }
  .bot-command-block .total-replies { font-size: 0.8rem; opacity: 0.75; margin: 0.5rem 0 0; }
  .bot-command-block .empty-note { font-size: 0.8rem; opacity: 0.7; }
</style>
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
  <div class="tile"><h2>Packets published</h2><p id="packets-published">0</p></div>
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
</section>

<section>
  <h2>Channel bots</h2>
  <table id="bots-table">
    <thead><tr><th>Name</th><th>Enabled</th><th>Ready</th><th>Replies sent</th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<section>
  <h2>Bot commands</h2>
  <p class="section-note">Reflects the packet-activity range selected above.</p>
  <div id="bot-commands-container"></div>
</section>

<script src="${CHARTJS_URL}" integrity="${CHARTJS_INTEGRITY}" crossorigin="anonymous"></script>
<script>
(function () {
  // Single source of truth for "which raw packet_type code maps to which
  // display bucket" lives server-side (src/web/packet-type-buckets.js) and
  // is serialized here rather than re-typed, so this list can never drift
  // out of sync with what the server actually persisted samples under.
  const PACKET_TYPE_BUCKETS = ${JSON.stringify(PACKET_TYPE_BUCKETS)};
  const RANGE_PRESETS = ${JSON.stringify(RANGE_PRESETS)};
  const DEFAULT_RANGE = ${JSON.stringify(DEFAULT_RANGE)};

  let chart = null;
  let pieChart = null;
  let currentRange = DEFAULT_RANGE; // a RANGE_PRESETS value, or 'custom'
  let customStartMs = null;
  let customEndMs = null;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days) parts.push(days + 'd');
    if (days || hours) parts.push(hours + 'h');
    if (days || hours || minutes) parts.push(minutes + 'm');
    parts.push(seconds + 's');
    return parts.join(' ');
  }

  function formatTimestamp(value) {
    return value ? new Date(value).toLocaleString() : 'never';
  }

  function formatBucketLabel(bucketStartMs, bucketWidthMs) {
    // Sub-day buckets only need a time; anything a day or wider is easier
    // to read as a date.
    return bucketWidthMs < 86400000
      ? new Date(bucketStartMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date(bucketStartMs).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function renderSnapshot(snapshot) {
    document.getElementById('uptime').textContent = formatDuration(Date.now() - new Date(snapshot.startedAt).getTime());

    const radioStatus = document.getElementById('radio-status');
    radioStatus.textContent = snapshot.radioConnected ? 'Connected' : 'Disconnected';
    radioStatus.className = snapshot.radioConnected ? 'ok' : 'bad';
    document.getElementById('radio-detail').textContent =
      'Last connected: ' + formatTimestamp(snapshot.radioLastConnectedAt) + ' · Reconnects: ' + snapshot.radioReconnectCount;

    document.getElementById('packets-received').textContent = snapshot.packetsReceived;
    document.getElementById('packets-published').textContent = snapshot.packetsPublished;

    const brokersBody = document.querySelector('#brokers-table tbody');
    brokersBody.innerHTML = '';
    for (const [brokerId, state] of Object.entries(snapshot.mqtt)) {
      const row = brokersBody.insertRow();
      row.insertCell().textContent = brokerId;
      const statusCell = row.insertCell();
      statusCell.textContent = state.connected ? 'Connected' : 'Disconnected';
      statusCell.className = state.connected ? 'ok' : 'bad';
      row.insertCell().textContent = formatTimestamp(state.lastConnectedAt);
    }

    const botsBody = document.querySelector('#bots-table tbody');
    botsBody.innerHTML = '';
    for (const bot of snapshot.bots) {
      const row = botsBody.insertRow();
      row.insertCell().textContent = bot.name;
      row.insertCell().textContent = bot.enabled ? 'Yes' : 'No';
      const readyCell = row.insertCell();
      readyCell.textContent = bot.ready ? 'Yes' : 'No';
      readyCell.className = bot.ready ? 'ok' : 'bad';
      row.insertCell().textContent = bot.repliesSent;
    }
  }

  function chartColors() {
    return {
      ink: cssVar('--chart-ink-secondary'),
      muted: cssVar('--chart-muted'),
      gridline: cssVar('--chart-gridline')
    };
  }

  function initChart() {
    if (typeof Chart === 'undefined') {
      console.warn('Chart.js failed to load - packet-activity chart disabled, rest of the dashboard still works');
      document.getElementById('chart-fallback').style.display = 'flex';
      return;
    }

    const colors = chartColors();
    const series = [{ key: 'received', label: 'Received (raw)', varName: '--chart-muted' }, ...PACKET_TYPE_BUCKETS];
    chart = new Chart(document.getElementById('chart').getContext('2d'), {
      type: 'line',
      data: {
        labels: [],
        datasets: series.map((s) => ({
          label: s.label,
          data: [],
          borderColor: cssVar(s.varName),
          borderDash: s.key === 'received' ? [4, 3] : [],
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2,
          spanGaps: true
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { color: colors.ink, boxWidth: 10, boxHeight: 10, usePointStyle: true } },
          tooltip: { mode: 'index', intersect: false }
        },
        scales: {
          x: { ticks: { color: colors.muted, maxTicksLimit: 6 }, grid: { color: colors.gridline } },
          y: { beginAtZero: true, ticks: { color: colors.muted, precision: 0 }, grid: { color: colors.gridline } }
        }
      }
    });

    pieChart = new Chart(document.getElementById('packet-types-pie').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: PACKET_TYPE_BUCKETS.map((b) => b.label),
        datasets: [{ data: PACKET_TYPE_BUCKETS.map(() => 0), backgroundColor: PACKET_TYPE_BUCKETS.map((b) => cssVar(b.varName)) }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: true } }
      }
    });

    // The charts are drawn once with resolved colors; if the OS theme
    // flips while the page is open, re-resolve the CSS variables and
    // repaint - dark mode is its own validated step, not an automatic
    // filter.
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const next = chartColors();
      chart.data.datasets.forEach((ds, i) => (ds.borderColor = cssVar(series[i].varName)));
      chart.options.plugins.legend.labels.color = next.ink;
      chart.options.scales.x.ticks.color = next.muted;
      chart.options.scales.y.ticks.color = next.muted;
      chart.options.scales.x.grid.color = next.gridline;
      chart.options.scales.y.grid.color = next.gridline;
      chart.update('none');
      pieChart.data.datasets[0].backgroundColor = PACKET_TYPE_BUCKETS.map((b) => cssVar(b.varName));
      pieChart.update('none');
      botCommandBlocks.forEach((entry) => {
        if (!entry.chart) return;
        entry.chart.data.datasets[0].backgroundColor = entry.chart.data.labels.map((_, idx) => botCommandColor(idx));
        entry.chart.update('none');
      });
    });
  }

  // Renders the backend-computed buckets from GET /api/metrics/history
  // wholesale, replacing the chart's data each refresh - no client-side
  // bucketing or point-count capping, the server already bounded both.
  function renderChart(historyResponse) {
    if (!chart) return;
    const buckets = historyResponse.buckets;

    chart.data.labels = buckets.map((b) => formatBucketLabel(b.bucketStart, b.bucketWidthMs));
    chart.data.datasets[0].data = buckets.map((b) => b.packetsReceived);
    PACKET_TYPE_BUCKETS.forEach((series, idx) => {
      chart.data.datasets[idx + 1].data = buckets.map((b) => b.countsByType[series.key] ?? 0);
    });
    chart.update('none');

    const note = document.getElementById('chart-note');
    if (buckets.length === 0) {
      note.textContent = 'No data recorded for this range yet.';
    } else {
      const widthMs = buckets[0].bucketWidthMs;
      const widthLabel = widthMs < 60000 ? Math.round(widthMs / 1000) + 's'
        : widthMs < 3600000 ? Math.round(widthMs / 60000) + 'm'
        : widthMs < 86400000 ? Math.round(widthMs / 3600000) + 'h'
        : Math.round(widthMs / 86400000) + 'd';
      note.textContent = 'Bucketed into ' + widthLabel + ' windows (' + buckets.length + ' buckets), computed on the server.';
    }
  }

  function renderPacketTypes(packetTypesResponse) {
    const totalsByKey = Object.fromEntries(packetTypesResponse.totals.map((t) => [t.packetTypeBucket, t.total]));

    const body = document.querySelector('#packet-types-table tbody');
    body.innerHTML = '';
    for (const bucket of PACKET_TYPE_BUCKETS) {
      const row = body.insertRow();
      const swatchCell = row.insertCell();
      swatchCell.innerHTML = '<span class="swatch" style="background:var(' + bucket.varName + ')"></span>';
      row.insertCell().textContent = bucket.label;
      const countCell = row.insertCell();
      countCell.className = 'count';
      countCell.textContent = totalsByKey[bucket.key] ?? 0;
    }

    if (pieChart) {
      pieChart.data.datasets[0].data = PACKET_TYPE_BUCKETS.map((b) => totalsByKey[b.key] ?? 0);
      pieChart.update('none');
    }
  }

  // Per-bot DOM/chart state, keyed by bot name. The configured bot set is
  // fixed for the life of a running server, so each bot's block/chart is
  // built once on first sight and only its data is updated on later
  // refreshes (no per-refresh chart teardown/rebuild, no layout jump).
  const botCommandBlocks = new Map();

  function botCommandColor(idx) {
    // Same 8-slot validated palette as PACKET_TYPE_BUCKETS, applied by
    // stable array position (the server already places each bot's
    // configured commands in config order, with any overflow folded into
    // a trailing "Other" row) - never re-ranked by usage, so a trigger's
    // color never reshuffles between refreshes.
    return cssVar('--cat-' + (idx + 1));
  }

  function buildBotCommandBlock(botName) {
    const container = document.getElementById('bot-commands-container');
    const block = document.createElement('div');
    block.className = 'bot-command-block';
    block.innerHTML =
      '<h3></h3>' +
      '<p class="empty-note" hidden></p>' +
      '<div class="split-layout">' +
      '<table><thead><tr><th></th><th>Command</th><th>Count</th></tr></thead><tbody></tbody></table>' +
      '<div class="pie-wrap"><canvas></canvas></div>' +
      '</div>' +
      '<p class="total-replies"></p>';
    block.querySelector('h3').textContent = botName;
    container.appendChild(block);

    let chart = null;
    if (typeof Chart !== 'undefined') {
      chart = new Chart(block.querySelector('canvas').getContext('2d'), {
        type: 'doughnut',
        data: { labels: [], datasets: [{ data: [], backgroundColor: [] }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: { legend: { display: false }, tooltip: { enabled: true } }
        }
      });
    }

    const entry = { block, chart, tbody: block.querySelector('tbody'), emptyNote: block.querySelector('.empty-note'), totalEl: block.querySelector('.total-replies') };
    botCommandBlocks.set(botName, entry);
    return entry;
  }

  function renderBotCommands(botCommandsResponse) {
    for (const bot of botCommandsResponse.bots) {
      const entry = botCommandBlocks.get(bot.botName) ?? buildBotCommandBlock(bot.botName);

      entry.tbody.innerHTML = '';
      bot.commands.forEach((row, idx) => {
        const tr = entry.tbody.insertRow();
        const swatchCell = tr.insertCell();
        swatchCell.innerHTML = '<span class="swatch" style="background:' + botCommandColor(idx) + '"></span>';
        tr.insertCell().textContent = row.trigger;
        const countCell = tr.insertCell();
        countCell.className = 'count';
        countCell.textContent = row.count;
      });

      entry.totalEl.textContent = 'Total replies: ' + bot.totalReplies;
      entry.emptyNote.hidden = bot.totalReplies !== 0;
      entry.emptyNote.textContent = 'No commands recorded in this range.';

      if (entry.chart) {
        entry.chart.data.labels = bot.commands.map((row) => row.trigger);
        entry.chart.data.datasets[0].data = bot.commands.map((row) => row.count);
        entry.chart.data.datasets[0].backgroundColor = bot.commands.map((row, idx) => botCommandColor(idx));
        entry.chart.update('none');
      }
    }
  }

  function setConnectionState(state) {
    const indicator = document.getElementById('connection-indicator');
    indicator.className = state;
    indicator.textContent = state === 'live' ? 'live' : state === 'down' ? 'disconnected' : 'connecting…';
  }

  function currentRangeQuery() {
    if (currentRange === 'custom') {
      return customStartMs !== null && customEndMs !== null ? { start: customStartMs, end: customEndMs } : null;
    }
    return { range: currentRange };
  }

  function buildQueryString(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      search.set(key, String(value));
    }
    return search.toString();
  }

  async function refreshRangeData() {
    const params = currentRangeQuery();
    if (!params) return; // custom range selected but not yet applied

    try {
      const qs = buildQueryString(params);
      const [historyRes, packetTypesRes, botCommandsRes] = await Promise.all([
        fetch('/api/metrics/history?' + qs),
        fetch('/api/metrics/packet-types?' + qs),
        fetch('/api/metrics/bots/commands?' + qs)
      ]);
      if (!historyRes.ok || !packetTypesRes.ok || !botCommandsRes.ok) {
        throw new Error(
          'range query failed (history ' + historyRes.status + ', packet-types ' + packetTypesRes.status +
            ', bots/commands ' + botCommandsRes.status + ')'
        );
      }
      renderChart(await historyRes.json());
      renderPacketTypes(await packetTypesRes.json());
      renderBotCommands(await botCommandsRes.json());
    } catch (err) {
      console.error('failed to refresh range-aware metrics', err);
    }
  }

  function setActiveRangeButton() {
    document.querySelectorAll('.range-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.range === currentRange);
    });
    document.getElementById('range-custom').classList.toggle('visible', currentRange === 'custom');
  }

  function selectPresetRange(value) {
    currentRange = value;
    document.getElementById('range-error').textContent = '';
    setActiveRangeButton();
    refreshRangeData();
  }

  function applyCustomRange() {
    const startInput = document.getElementById('range-start');
    const endInput = document.getElementById('range-end');
    const errorEl = document.getElementById('range-error');
    errorEl.textContent = '';

    if (!startInput.value || !endInput.value) {
      errorEl.textContent = 'Pick both a start and end date.';
      return;
    }
    const start = new Date(startInput.value).getTime();
    // Custom dates are day-granularity inputs; treat the end date as
    // inclusive by running the window through the end of that day.
    const end = new Date(endInput.value).getTime() + 86400000 - 1;
    if (!(start < end)) {
      errorEl.textContent = 'Start must be before end.';
      return;
    }

    customStartMs = start;
    customEndMs = end;
    currentRange = 'custom';
    setActiveRangeButton();
    refreshRangeData();
  }

  function initRangeSelector() {
    const presetsEl = document.getElementById('range-presets');
    for (const preset of RANGE_PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'range-btn';
      btn.dataset.range = preset.value;
      btn.textContent = preset.label;
      btn.addEventListener('click', () => selectPresetRange(preset.value));
      presetsEl.appendChild(btn);
    }
    document.getElementById('range-custom-toggle').addEventListener('click', () => {
      currentRange = 'custom';
      setActiveRangeButton();
    });
    document.getElementById('range-apply').addEventListener('click', applyCustomRange);
    setActiveRangeButton();
  }

  async function bootstrap() {
    initChart();
    initRangeSelector();

    try {
      const metricsRes = await fetch('/api/metrics');
      renderSnapshot(await metricsRes.json());
    } catch (err) {
      console.error('failed to load initial metrics', err);
    }
    await refreshRangeData();

    const source = new EventSource('/api/metrics/stream');
    source.onopen = () => setConnectionState('live');
    source.onerror = () => setConnectionState('down');
    source.onmessage = (event) => {
      renderSnapshot(JSON.parse(event.data));
      // Refetch the range-aware views on the same cadence the server
      // samples at, so the chart/table/pie stay live for "now"-anchored
      // ranges without the client re-deriving anything itself.
      refreshRangeData();
    };
  }

  bootstrap();
})();
</script>
</body>
</html>
`;
}
