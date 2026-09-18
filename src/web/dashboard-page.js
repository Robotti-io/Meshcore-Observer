const CHARTJS_VERSION = '4.4.4';
const CHARTJS_URL = `https://cdn.jsdelivr.net/npm/chart.js@${CHARTJS_VERSION}/dist/chart.umd.js`;
// Pinned to the exact bytes of dist/chart.umd.js for that version (verified
// against jsdelivr's own published hash before pinning). Deliberately NOT
// chart.umd.min.js - jsdelivr generates that minified file on the fly per
// request and warns against using SRI with it, since the served bytes
// aren't guaranteed stable.
const CHARTJS_INTEGRITY = 'sha384-G436+Z2nlA8+PNoeRvWdxKbvOf8E/y+lYxqht2iBwNHTQDV5CJr3+AGVj8fGZi5t';

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
    --series-advert: #2a78d6;
    --series-txtMsg: #eb6834;
    --series-grpTxt: #1baf7a;
    --series-ack: #eda100;
    --series-path: #e87ba4;
    --series-trace: #008300;
    --series-grpData: #4a3aa7;
    --series-other: #e34948;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --chart-ink-secondary: #c3c2b7;
      --chart-muted: #898781;
      --chart-gridline: #2c2c2a;
      --series-advert: #3987e5;
      --series-txtMsg: #d95926;
      --series-grpTxt: #199e70;
      --series-ack: #c98500;
      --series-path: #d55181;
      --series-trace: #008300;
      --series-grpData: #9085e9;
      --series-other: #e66767;
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
  <div id="chart-wrap">
    <canvas id="chart"></canvas>
    <div id="chart-fallback">Chart unavailable - Chart.js could not be loaded from the CDN (no internet access?). Totals below are still live.</div>
  </div>
  <table id="packet-types-table">
    <thead><tr><th></th><th>Type</th><th>Total</th></tr></thead>
    <tbody></tbody>
  </table>
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

<script src="${CHARTJS_URL}" integrity="${CHARTJS_INTEGRITY}" crossorigin="anonymous"></script>
<script>
(function () {
  const MAX_CHART_POINTS = 1000;
  let lastSample = null;
  let chart = null;

  // Fixed categorical order - never reordered or generated. MeshCore
  // PAYLOAD_TYPE_* codes (see @liamcottle/meshcore.js) not explicitly
  // listed here (REQ 0, RESPONSE 1, ANON_REQ 7, RAW_CUSTOM 15, and any
  // future code) fold into "other" rather than spending a 9th hue.
  const PACKET_TYPE_BUCKETS = [
    { key: 'advert', codes: ['4'], label: 'Advert', varName: '--series-advert' },
    { key: 'txtMsg', codes: ['2'], label: 'Text message', varName: '--series-txtMsg' },
    { key: 'grpTxt', codes: ['5'], label: 'Group text', varName: '--series-grpTxt' },
    { key: 'ack', codes: ['3'], label: 'Ack', varName: '--series-ack' },
    { key: 'path', codes: ['8'], label: 'Path', varName: '--series-path' },
    { key: 'trace', codes: ['9'], label: 'Trace', varName: '--series-trace' },
    { key: 'grpData', codes: ['6'], label: 'Group data', varName: '--series-grpData' },
    { key: 'other', codes: ['0', '1', '7', '15'], label: 'Other', varName: '--series-other' }
  ];
  const RECEIVED_SERIES = { key: 'received', label: 'Received (raw)', varName: '--chart-muted' };
  const SERIES = [RECEIVED_SERIES, ...PACKET_TYPE_BUCKETS];

  function bucketKeyForCode(code) {
    const match = PACKET_TYPE_BUCKETS.find((b) => b.codes.includes(code));
    return match ? match.key : 'other';
  }

  function bucketedCounts(packetsByType) {
    const counts = Object.fromEntries(PACKET_TYPE_BUCKETS.map((b) => [b.key, 0]));
    for (const [code, count] of Object.entries(packetsByType || {})) {
      const key = bucketKeyForCode(code);
      counts[key] += count;
    }
    return counts;
  }

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

  function renderPacketTypesTable(snapshot) {
    const counts = bucketedCounts(snapshot.packetsByType);
    const body = document.querySelector('#packet-types-table tbody');
    body.innerHTML = '';

    const receivedRow = body.insertRow();
    const receivedSwatchCell = receivedRow.insertCell();
    receivedSwatchCell.innerHTML = '<span class="swatch dashed"></span>';
    receivedRow.insertCell().textContent = RECEIVED_SERIES.label;
    const receivedCountCell = receivedRow.insertCell();
    receivedCountCell.className = 'count';
    receivedCountCell.textContent = snapshot.packetsReceived;

    for (const bucket of PACKET_TYPE_BUCKETS) {
      const row = body.insertRow();
      const swatchCell = row.insertCell();
      swatchCell.innerHTML = '<span class="swatch" style="background:var(' + bucket.varName + ')"></span>';
      row.insertCell().textContent = bucket.label;
      const countCell = row.insertCell();
      countCell.className = 'count';
      countCell.textContent = counts[bucket.key];
    }
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

    renderPacketTypesTable(snapshot);

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

  // A delta between two cumulative snapshots, one per series - what the
  // chart plots is a per-interval rate, not the running totals themselves.
  function deltaPoint(prev, curr) {
    const prevCounts = bucketedCounts(prev.packetsByType);
    const currCounts = bucketedCounts(curr.packetsByType);
    const point = { received: Math.max(0, curr.packetsReceived - prev.packetsReceived) };
    for (const bucket of PACKET_TYPE_BUCKETS) {
      point[bucket.key] = Math.max(0, currCounts[bucket.key] - prevCounts[bucket.key]);
    }
    return point;
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
    chart = new Chart(document.getElementById('chart').getContext('2d'), {
      type: 'line',
      data: {
        labels: [],
        datasets: SERIES.map((series) => ({
          label: series.label,
          data: [],
          borderColor: cssVar(series.varName),
          borderDash: series.key === 'received' ? [4, 3] : [],
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

    // The chart is drawn once with resolved colors; if the OS theme flips
    // while the page is open, re-resolve the CSS variables and repaint -
    // dark mode is its own validated step, not an automatic filter.
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const next = chartColors();
      chart.data.datasets.forEach((ds, i) => (ds.borderColor = cssVar(SERIES[i].varName)));
      chart.options.plugins.legend.labels.color = next.ink;
      chart.options.scales.x.ticks.color = next.muted;
      chart.options.scales.y.ticks.color = next.muted;
      chart.options.scales.x.grid.color = next.gridline;
      chart.options.scales.y.grid.color = next.gridline;
      chart.update('none');
    });
  }

  function labelForDate(date) {
    return date.toLocaleTimeString();
  }

  function trimChart() {
    while (chart.data.labels.length > MAX_CHART_POINTS) {
      chart.data.labels.shift();
      chart.data.datasets.forEach((ds) => ds.data.shift());
    }
  }

  function seedChart(historySamples) {
    if (!chart) return;
    for (let i = 1; i < historySamples.length; i += 1) {
      const point = deltaPoint(historySamples[i - 1], historySamples[i]);
      chart.data.labels.push(labelForDate(new Date(historySamples[i].timestamp)));
      SERIES.forEach((series, idx) => chart.data.datasets[idx].data.push(point[series.key]));
    }
    trimChart();
    chart.update();
  }

  function pushPoint(prevSample, currSample) {
    if (!chart) return;
    const point = deltaPoint(prevSample, currSample);
    chart.data.labels.push(labelForDate(new Date()));
    SERIES.forEach((series, idx) => chart.data.datasets[idx].data.push(point[series.key]));
    trimChart();
    chart.update('none');
  }

  function setConnectionState(state) {
    const indicator = document.getElementById('connection-indicator');
    indicator.className = state;
    indicator.textContent = state === 'live' ? 'live' : state === 'down' ? 'disconnected' : 'connecting…';
  }

  async function bootstrap() {
    initChart();

    try {
      const [metricsRes, historyRes] = await Promise.all([
        fetch('/api/metrics'),
        fetch('/api/metrics/history')
      ]);
      const metrics = await metricsRes.json();
      renderSnapshot(metrics);
      const historySamples = await historyRes.json();
      seedChart(historySamples);
      lastSample = historySamples[historySamples.length - 1] ?? metrics;
    } catch (err) {
      console.error('failed to load initial metrics', err);
    }

    const source = new EventSource('/api/metrics/stream');
    source.onopen = () => setConnectionState('live');
    source.onerror = () => setConnectionState('down');
    source.onmessage = (event) => {
      const snapshot = JSON.parse(event.data);
      renderSnapshot(snapshot);
      if (lastSample) {
        pushPoint(lastSample, snapshot);
      }
      lastSample = snapshot;
    };
  }

  bootstrap();
})();
</script>
</body>
</html>
`;
}
