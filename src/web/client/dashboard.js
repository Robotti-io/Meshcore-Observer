// The DOM/Chart.js/fetch-driving half of the dashboard - everything that
// can be expressed as a pure function (range handling, response
// transformation, chart-data preparation) lives in dashboard-logic.js
// instead, so it can be unit-tested directly under Node (see that file's
// doc comment and test/web/client/dashboard-logic.test.js). This module
// stays thin: read data in, hand it to a pure function, apply the result
// to the DOM/a chart.
//
// A real ES module (loaded via <script type="module">), not a bundled or
// built artifact - imports below resolve to sibling files served by
// MetricsServer, exactly as authored, no build step.
import { PACKET_TYPE_BUCKETS } from './packet-type-buckets.js';
import {
  formatDuration,
  formatTimestamp,
  buildQueryString,
  resolveRangeQuery,
  parseCustomRangeInputs,
  buildHistoryChartData,
  chartNoteForBuckets,
  buildPacketTypeTotals,
  formatNodePageRange
} from './dashboard-logic.js';

// The dashboard's "Repeaters" section is deliberately scoped to REPEATER
// only (both the added/updated tiles and the search/browse table below) -
// the node registry itself tracks every advertised type as a general
// contact list (see docs/plans/feat-bot_command_to_lookup_repeater_name.md),
// but this section mirrors the !lookup bot command's own REPEATER-only
// scope rather than exposing every type here too.
const NODE_TYPE = 'REPEATER';
const NODES_PAGE_SIZE = 25;

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

let chart = null;
let pieChart = null;
let currentRange = DEFAULT_RANGE; // a RANGE_PRESETS value, or 'custom'
let customStartMs = null;
let customEndMs = null;
// Per-bot operational status (enabled/ready) - live, not range-aware, so
// it's kept separately from the range-queried command data and folded
// into each bot's card by applyBotStatusBadges().
const latestBotStatusByName = new Map();
// Search/pagination state for the node table - independent of the page's
// range selector (the table is live current state, not history), so it
// isn't part of refreshRangeData()'s Promise.all batch.
let nodesSearchQuery = '';
let nodesOffset = 0;
let nodesSearchDebounce = null;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderSnapshot(snapshot) {
  document.getElementById('uptime').textContent = formatDuration(Date.now() - new Date(snapshot.startedAt).getTime());

  const radioStatus = document.getElementById('radio-status');
  radioStatus.textContent = snapshot.radioConnected ? 'Connected' : 'Disconnected';
  radioStatus.className = snapshot.radioConnected ? 'ok' : 'bad';
  document.getElementById('radio-detail').textContent =
    'Last connected: ' + formatTimestamp(snapshot.radioLastConnectedAt) + ' · Reconnects: ' + snapshot.radioReconnectCount;

  document.getElementById('packets-received').textContent = snapshot.packetsReceived;
  document.getElementById('packets-decoded').textContent = snapshot.packetsDecoded;

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

  // Enabled/ready is per-bot operational status, not a range-aware
  // metric - stashed here so renderBotCommands() can fold a status
  // badge into each bot's card instead of a separate table.
  for (const bot of snapshot.bots) {
    latestBotStatusByName.set(bot.name, { enabled: bot.enabled, ready: bot.ready });
  }
  applyBotStatusBadges();

  // Queue depth is the one reply-queue tile that's genuinely live,
  // in-process state - sent/expired/failed are historical counts and
  // come from the range-scoped /api/metrics/reply-queue endpoint instead
  // (see renderReplyQueueTotals).
  document.getElementById('queue-size').textContent = snapshot.replyQueue.size;
}

function renderReplyQueueTotals(replyQueueResponse) {
  const totals = replyQueueResponse.totals;
  document.getElementById('queue-sent').textContent = totals.sent;
  document.getElementById('queue-expired').textContent = totals.expired;
  document.getElementById('queue-failed').textContent = totals.failed;
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
  const { labels, receivedData, typeSeriesData } = buildHistoryChartData(buckets, PACKET_TYPE_BUCKETS);

  chart.data.labels = labels;
  chart.data.datasets[0].data = receivedData;
  typeSeriesData.forEach((data, idx) => {
    chart.data.datasets[idx + 1].data = data;
  });
  chart.update('none');

  document.getElementById('chart-note').textContent = chartNoteForBuckets(buckets);
}

function renderPacketTypes(packetTypesResponse) {
  const counts = buildPacketTypeTotals(packetTypesResponse.totals, PACKET_TYPE_BUCKETS);

  const body = document.querySelector('#packet-types-table tbody');
  body.innerHTML = '';
  PACKET_TYPE_BUCKETS.forEach((bucket, idx) => {
    const row = body.insertRow();
    const swatchCell = row.insertCell();
    swatchCell.innerHTML = '<span class="swatch" style="background:var(' + bucket.varName + ')"></span>';
    row.insertCell().textContent = bucket.label;
    const countCell = row.insertCell();
    countCell.className = 'count';
    countCell.textContent = counts[idx];
  });

  if (pieChart) {
    pieChart.data.datasets[0].data = counts;
    pieChart.update('none');
  }
}

function renderBrokerDeliveries(brokerDeliveriesResponse) {
  const body = document.querySelector('#broker-deliveries-table tbody');
  body.innerHTML = '';
  for (const broker of brokerDeliveriesResponse.brokers) {
    const row = body.insertRow();
    row.insertCell().textContent = broker.brokerId;
    row.insertCell().textContent = broker.sent;
    row.insertCell().textContent = broker.skipped;
    row.insertCell().textContent = broker.failed;
  }
}

function renderNodeTotals(nodeTotalsResponse) {
  document.getElementById('nodes-added').textContent = nodeTotalsResponse.totals.added;
  document.getElementById('nodes-updated').textContent = nodeTotalsResponse.totals.updated;
}

// Truncated to a readable prefix for the table cell; the full key is still
// available via the cell's title attribute (hover/long-press) and is what
// the search box itself matches against in full - see queryNodes() in
// src/metrics/store.js.
function formatPublicKeyCell(publicKeyHex) {
  return publicKeyHex.slice(0, 12) + '…';
}

function renderNodesList(nodesResponse) {
  const body = document.querySelector('#nodes-table tbody');
  body.innerHTML = '';
  for (const node of nodesResponse.nodes) {
    const row = body.insertRow();
    row.insertCell().textContent = node.name;
    const keyCell = row.insertCell();
    keyCell.textContent = formatPublicKeyCell(node.publicKeyHex);
    keyCell.title = node.publicKeyHex;
    row.insertCell().textContent = formatTimestamp(node.firstHeardAt);
    row.insertCell().textContent = formatTimestamp(node.lastHeardAt);
  }

  document.getElementById('nodes-page-note').textContent = formatNodePageRange(nodesOffset, NODES_PAGE_SIZE, nodesResponse.total);
  document.getElementById('nodes-prev').disabled = nodesOffset === 0;
  document.getElementById('nodes-next').disabled = nodesOffset + NODES_PAGE_SIZE >= nodesResponse.total;
}

// Fetches the current node-table page (search/type-filtered, paginated) -
// deliberately separate from refreshRangeData()'s Promise.all batch, since
// this reflects live current state (see MetricsStore#queryNodes), not a
// history window, and isn't re-fetched on every SSE tick either (that
// would reset pagination/clobber an in-progress search every few seconds).
async function refreshNodesList() {
  try {
    const params = { type: NODE_TYPE, limit: NODES_PAGE_SIZE, offset: nodesOffset };
    if (nodesSearchQuery) {
      params.q = nodesSearchQuery;
    }
    const res = await fetch('/api/nodes?' + buildQueryString(params));
    if (!res.ok) {
      throw new Error('nodes query failed (' + res.status + ')');
    }
    renderNodesList(await res.json());
  } catch (err) {
    console.error('failed to refresh the repeaters table', err);
  }
}

function initNodesSearch() {
  document.getElementById('nodes-search').addEventListener('input', (event) => {
    clearTimeout(nodesSearchDebounce);
    nodesSearchDebounce = setTimeout(() => {
      nodesSearchQuery = event.target.value.trim();
      nodesOffset = 0;
      refreshNodesList();
    }, 300);
  });
  document.getElementById('nodes-prev').addEventListener('click', () => {
    nodesOffset = Math.max(0, nodesOffset - NODES_PAGE_SIZE);
    refreshNodesList();
  });
  document.getElementById('nodes-next').addEventListener('click', () => {
    nodesOffset += NODES_PAGE_SIZE;
    refreshNodesList();
  });
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
    '<h3><span class="bot-name"></span><span class="status-badge"></span></h3>' +
    '<p class="empty-note" hidden></p>' +
    '<div class="split-layout">' +
    '<table><thead><tr><th></th><th>Command</th><th>Count</th></tr></thead><tbody></tbody></table>' +
    '<div class="pie-wrap"><canvas></canvas></div>' +
    '</div>' +
    '<p class="total-replies"></p>';
  block.querySelector('.bot-name').textContent = botName;
  container.appendChild(block);

  let entryChart = null;
  if (typeof Chart !== 'undefined') {
    entryChart = new Chart(block.querySelector('canvas').getContext('2d'), {
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

  const entry = {
    block,
    chart: entryChart,
    statusBadge: block.querySelector('.status-badge'),
    tbody: block.querySelector('tbody'),
    emptyNote: block.querySelector('.empty-note'),
    totalEl: block.querySelector('.total-replies')
  };
  botCommandBlocks.set(botName, entry);
  return entry;
}

// Re-applies latestBotStatusByName to every bot card currently in the
// DOM - called whenever that map changes (renderSnapshot) and whenever
// a new card is built, so status is never stale in either direction.
function applyBotStatusBadges() {
  botCommandBlocks.forEach((entry, botName) => {
    const status = latestBotStatusByName.get(botName);
    if (!status) return;
    const label = !status.enabled ? 'Disabled' : status.ready ? 'Ready' : 'Not ready';
    entry.statusBadge.textContent = label;
    entry.statusBadge.className = 'status-badge ' + (status.enabled && status.ready ? 'ok' : 'bad');
  });
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
  applyBotStatusBadges();
}

function setConnectionState(state) {
  const indicator = document.getElementById('connection-indicator');
  indicator.className = state;
  indicator.textContent = state === 'live' ? 'live' : state === 'down' ? 'disconnected' : 'connecting…';
}

async function refreshRangeData() {
  const params = resolveRangeQuery({ range: currentRange, customStartMs, customEndMs });
  if (!params) return; // custom range selected but not yet applied

  try {
    const qs = buildQueryString(params);
    const nodesTotalsQs = buildQueryString({ ...params, type: NODE_TYPE });
    const [historyRes, packetTypesRes, replyQueueRes, botCommandsRes, brokersRes, nodeTotalsRes] = await Promise.all([
      fetch('/api/metrics/history?' + qs),
      fetch('/api/metrics/packet-types?' + qs),
      fetch('/api/metrics/reply-queue?' + qs),
      fetch('/api/metrics/bots/commands?' + qs),
      fetch('/api/metrics/brokers?' + qs),
      fetch('/api/metrics/nodes?' + nodesTotalsQs)
    ]);
    if (!historyRes.ok || !packetTypesRes.ok || !replyQueueRes.ok || !botCommandsRes.ok || !brokersRes.ok || !nodeTotalsRes.ok) {
      throw new Error(
        'range query failed (history ' + historyRes.status + ', packet-types ' + packetTypesRes.status +
          ', reply-queue ' + replyQueueRes.status + ', bots/commands ' + botCommandsRes.status +
          ', brokers ' + brokersRes.status + ', nodes ' + nodeTotalsRes.status + ')'
      );
    }
    renderChart(await historyRes.json());
    renderPacketTypes(await packetTypesRes.json());
    renderReplyQueueTotals(await replyQueueRes.json());
    renderBotCommands(await botCommandsRes.json());
    renderBrokerDeliveries(await brokersRes.json());
    renderNodeTotals(await nodeTotalsRes.json());
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

  const result = parseCustomRangeInputs(startInput.value, endInput.value);
  if (!result.ok) {
    errorEl.textContent = result.error;
    return;
  }

  customStartMs = result.start;
  customEndMs = result.end;
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
  initNodesSearch();

  try {
    const metricsRes = await fetch('/api/metrics');
    renderSnapshot(await metricsRes.json());
  } catch (err) {
    console.error('failed to load initial metrics', err);
  }
  await refreshRangeData();
  // Not part of refreshRangeData()'s range-aware batch (the table is live
  // current state, not history - see refreshNodesList()'s own doc
  // comment) and not re-fetched on every SSE tick either, so typing in the
  // search box or paging through results doesn't get clobbered by the
  // next live update a few seconds later.
  await refreshNodesList();

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
