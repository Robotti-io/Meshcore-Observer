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
const DASHBOARD_VIEWS = ['overview', 'packets', 'brokers', 'bots', 'repeaters'];
const VIEW_LABELS = {
  overview: 'overview',
  packets: 'packet activity',
  brokers: 'broker deliveries',
  bots: 'bot replies',
  repeaters: 'repeater activity'
};
const UPDATED_AT_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'medium'
});

let chart = null;
let pieChart = null;
let packetChartsInitialized = false;
let lastHistorySignature = null;
let lastPacketTypesSignature = null;
let lastBrokerDeliveriesSignature = null;
let lastBrokerStatusSignature = null;
let lastNodesRenderSignature = null;
let botChartObserver = null;
let currentView = 'overview';
let currentRange = DEFAULT_RANGE; // a RANGE_PRESETS value, or 'custom'
let customStartMs = null;
let customEndMs = null;
let activeRangeRefresh = null;
let activeRangeController = null;
let rangeRefreshQueued = false;
let rangeRefreshGeneration = 0;
let lastLiveSuccessAt = null;
let lastLiveAnnouncementState = null;
let uptimeHasRendered = false;
const lastRangeSuccessByView = new Map();
let lastNodesSuccessAt = null;
// Per-bot operational status (enabled/ready) - live, not range-aware, so
// it's kept separately from the range-queried command data and folded
// into each bot's card by applyBotStatusBadges().
const latestBotStatusByName = new Map();
const botEntryByBlock = new WeakMap();
// Search/pagination state for the node table - independent of the page's
// range selector (the table is live current state, not history), so it
// isn't part of refreshRangeData()'s Promise.all batch.
let nodesSearchQuery = '';
let nodesOffset = 0;
let nodesSearchDebounce = null;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function pulseTimeSegment(element) {
  element.classList.remove('heartbeat');
  void element.offsetWidth;
  element.classList.add('heartbeat');
}

function renderUptime(startedAt) {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const segments = [
    { id: 'uptime-days', value: days, suffix: 'd', visible: days > 0 },
    { id: 'uptime-hours', value: hours, suffix: 'h', visible: days > 0 || hours > 0 },
    { id: 'uptime-minutes', value: minutes, suffix: 'm', visible: days > 0 || hours > 0 || minutes > 0 },
    { id: 'uptime-seconds', value: seconds, suffix: 's', visible: true }
  ];

  for (const segment of segments) {
    const element = document.getElementById(segment.id);
    const nextText = segment.value + segment.suffix;
    const changed = element.textContent !== nextText || element.hidden === segment.visible;
    if (element.textContent !== nextText) {
      element.textContent = nextText;
    }
    element.hidden = !segment.visible;
    if (uptimeHasRendered && changed && segment.visible) {
      pulseTimeSegment(element);
    }
  }
  uptimeHasRendered = true;
}

function renderSnapshot(snapshot) {
  renderUptime(snapshot.startedAt);

  const radioStatus = document.getElementById('radio-status');
  radioStatus.textContent = snapshot.radioConnected ? 'Connected' : 'Disconnected';
  radioStatus.className = snapshot.radioConnected ? 'ok' : 'bad';
  document.getElementById('radio-detail').textContent =
    'Last connected: ' + formatTimestamp(snapshot.radioLastConnectedAt) + ' · Reconnects: ' + snapshot.radioReconnectCount;

  const brokerStatusSignature = JSON.stringify(snapshot.mqtt);
  if (brokerStatusSignature !== lastBrokerStatusSignature) {
    lastBrokerStatusSignature = brokerStatusSignature;
    const brokersBody = document.querySelector('#brokers-table tbody');
    brokersBody.innerHTML = '';
    const brokerEntries = Object.entries(snapshot.mqtt);
    if (brokerEntries.length === 0) {
      const row = brokersBody.insertRow();
      const emptyCell = row.insertCell();
      emptyCell.colSpan = 3;
      emptyCell.textContent = 'No MQTT brokers are configured.';
    }
    for (const [brokerId, state] of brokerEntries) {
      const row = brokersBody.insertRow();
      row.insertCell().textContent = brokerId;
      const statusCell = row.insertCell();
      statusCell.textContent = state.connected ? 'Connected' : 'Disconnected';
      statusCell.className = state.connected ? 'ok' : 'bad';
      row.insertCell().textContent = formatTimestamp(state.lastConnectedAt);
    }
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
  const historyCanvas = document.getElementById('chart');
  historyCanvas.setAttribute('role', 'img');
  historyCanvas.setAttribute('aria-label', 'Packet activity over the selected reporting range');

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
  const packetTypesCanvas = document.getElementById('packet-types-pie');
  packetTypesCanvas.setAttribute('role', 'img');
  packetTypesCanvas.setAttribute('aria-label', 'Packet totals by type for the selected reporting range');

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

function ensurePacketChartsInitialized() {
  if (packetChartsInitialized) return;
  packetChartsInitialized = true;
  initChart();
}

// Renders the backend-computed buckets from GET /api/metrics/history
// wholesale, replacing the chart's data each refresh - no client-side
// bucketing or point-count capping, the server already bounded both.
function renderChart(historyResponse) {
  if (!chart) return;
  const buckets = historyResponse.buckets;
  const signature = JSON.stringify(buckets);
  if (signature === lastHistorySignature) return;
  lastHistorySignature = signature;
  const receivedTotal = buckets.reduce((sum, bucket) => sum + bucket.packetsReceived, 0);
  const decodedTotal = buckets.reduce((sum, bucket) => sum + bucket.packetsDecoded, 0);
  const { labels, receivedData, typeSeriesData } = buildHistoryChartData(buckets, PACKET_TYPE_BUCKETS);

  chart.data.labels = labels;
  chart.data.datasets[0].data = receivedData;
  typeSeriesData.forEach((data, idx) => {
    chart.data.datasets[idx + 1].data = data;
  });
  chart.update('none');

  document.getElementById('chart-note').textContent = chartNoteForBuckets(buckets);
  document.getElementById('chart-summary').textContent =
    'Packets received: ' + receivedTotal + '; packets decoded: ' + decodedTotal +
    '. Exact packet-type totals are listed in the table below.';
}

function renderPacketTypes(packetTypesResponse) {
  const signature = JSON.stringify(packetTypesResponse.totals);
  if (signature === lastPacketTypesSignature) return;
  lastPacketTypesSignature = signature;
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
  document.getElementById('packet-types-chart-summary').textContent =
    'Packet type distribution across ' + counts.length + ' categories; ' +
    counts.reduce((sum, count) => sum + count, 0) +
    ' decoded packets. Exact per-type counts are listed in the adjacent table.';

  if (pieChart) {
    pieChart.data.datasets[0].data = counts;
    pieChart.update('none');
  }
}

function renderBrokerDeliveries(brokerDeliveriesResponse) {
  const signature = JSON.stringify(brokerDeliveriesResponse.brokers);
  if (signature === lastBrokerDeliveriesSignature) return;
  lastBrokerDeliveriesSignature = signature;
  const body = document.querySelector('#broker-deliveries-table tbody');
  body.innerHTML = '';
  if (brokerDeliveriesResponse.brokers.length === 0) {
    const row = body.insertRow();
    const emptyCell = row.insertCell();
    emptyCell.colSpan = 4;
    emptyCell.textContent = 'No MQTT broker delivery data is configured.';
    return;
  }
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

function renderMetricTrend(elementId, delta) {
  const element = document.getElementById(elementId);
  if (typeof delta !== 'number') {
    element.className = 'metric-trend unchanged';
    element.textContent = '—';
    element.setAttribute('aria-label', 'No previous period comparison available');
    return;
  }

  if (delta > 0) {
    element.className = 'metric-trend increase';
    element.textContent = '↑ +' + delta.toLocaleString();
    element.setAttribute('aria-label', 'Increased by ' + delta.toLocaleString() + ' compared with previous period');
  } else if (delta < 0) {
    const decrease = Math.abs(delta).toLocaleString();
    element.className = 'metric-trend decrease';
    element.textContent = '↓ -' + decrease;
    element.setAttribute('aria-label', 'Decreased by ' + decrease + ' compared with previous period');
  } else {
    element.className = 'metric-trend unchanged';
    element.textContent = '—';
    element.setAttribute('aria-label', 'No change from previous period');
  }
}

function renderOverview(summary) {
  document.getElementById('packets-received').textContent = summary.packets.received;
  document.getElementById('packets-decoded').textContent = summary.packets.decoded;
  document.getElementById('overview-replies-sent').textContent = summary.replies.outcomes.sent;
  document.getElementById('overview-replies-expired').textContent = summary.replies.outcomes.expired;
  document.getElementById('overview-replies-failed').textContent = summary.replies.outcomes.failed;

  const brokerTotals = summary.brokers.reduce(
    (totals, broker) => ({ sent: totals.sent + broker.sent, failed: totals.failed + broker.failed }),
    { sent: 0, failed: 0 }
  );
  document.getElementById('overview-broker-sent').textContent = brokerTotals.sent;
  document.getElementById('overview-broker-failed').textContent = brokerTotals.failed;
  document.getElementById('overview-repeaters-added').textContent = summary.repeaters.added;
  document.getElementById('overview-repeaters-updated').textContent = summary.repeaters.updated;

  const trendValues = summary.trends ?? {};
  renderMetricTrend('packets-received-trend', trendValues.packetsReceived);
  renderMetricTrend('packets-decoded-trend', trendValues.packetsDecoded);
  renderMetricTrend('overview-replies-sent-trend', trendValues.repliesSent);
  renderMetricTrend('overview-replies-expired-trend', trendValues.repliesExpired);
  renderMetricTrend('overview-replies-failed-trend', trendValues.repliesFailed);
  renderMetricTrend('overview-broker-sent-trend', trendValues.brokerSent);
  renderMetricTrend('overview-broker-failed-trend', trendValues.brokerFailed);
  renderMetricTrend('overview-repeaters-added-trend', trendValues.repeatersAdded);
  renderMetricTrend('overview-repeaters-updated-trend', trendValues.repeatersUpdated);

  const comparisonNote = document.getElementById('overview-comparison-note');
  if (!summary.comparison) {
    comparisonNote.textContent = currentRange === 'all'
      ? 'Trend comparison is unavailable for the All time range.'
      : 'Trend comparison will appear after a complete previous period is available.';
  } else if (currentRange === 'custom') {
    comparisonNote.textContent = 'Compared with the immediately preceding period of the same duration.';
  } else {
    const rangeLabel = RANGE_PRESETS.find((preset) => preset.value === currentRange)?.label ?? currentRange;
    comparisonNote.textContent = 'Compared with the previous ' + rangeLabel + ' period.';
  }
}

function renderDashboardView(view, data) {
  if (view === 'overview') {
    renderOverview(data);
    return;
  }
  if (view === 'packets') {
    renderChart(data.history);
    renderPacketTypes(data.packetTypes);
    return;
  }
  if (view === 'brokers') {
    renderBrokerDeliveries(data);
    return;
  }
  if (view === 'bots') {
    renderReplyQueueTotals({ totals: data.replyOutcomes });
    renderBotCommands(data);
    return;
  }
  if (view === 'repeaters') {
    renderNodeTotals(data);
  }
}

function renderUpdatedRangeStatus(view, viewLabel, timestamp) {
  const status = document.getElementById('range-data-status');
  let timeElement = status.querySelector('time');
  if (!timeElement || timeElement.dataset.view !== view) {
    status.replaceChildren(document.createTextNode('Updated ' + viewLabel + ': '));
    timeElement = document.createElement('time');
    timeElement.dataset.view = view;
    status.appendChild(timeElement);
  }
  status.className = 'data-status ready';

  const date = new Date(timestamp);
  const parts = UPDATED_AT_FORMATTER.formatToParts(date);
  const signature = parts.map((part) => part.type).join('|');
  if (timeElement.dataset.parts !== signature) {
    timeElement.replaceChildren(
      ...parts.map((part) => {
        if (part.type === 'literal') return document.createTextNode(part.value);
        const segment = document.createElement('span');
        segment.className = 'heartbeat-segment';
        segment.dataset.timePart = part.type;
        segment.textContent = part.value;
        return segment;
      })
    );
    timeElement.dataset.parts = signature;
  } else {
    for (const part of parts) {
      if (part.type === 'literal') continue;
      const segment = timeElement.querySelector('[data-time-part="' + part.type + '"]');
      if (segment.textContent !== part.value) {
        segment.textContent = part.value;
        pulseTimeSegment(segment);
      }
    }
  }
  timeElement.dateTime = date.toISOString();
}

function setRangeLoadingStatus(view, viewLabel, lastSuccessAt) {
  const status = document.getElementById('range-data-status');
  const existingTime = status.querySelector('time');
  if (lastSuccessAt === null || existingTime?.dataset.view !== view) {
    setDataStatus(
      'range-data-status',
      'loading',
      lastSuccessAt === null
        ? 'Loading selected-range ' + viewLabel + '…'
        : 'Refreshing selected-range ' + viewLabel + '. ' + formatLastSuccess(lastSuccessAt)
    );
  } else {
    status.className = 'data-status loading';
  }
}

// Truncated to a readable prefix for the table cell; the full key is still
// available via the cell's title attribute (hover/long-press) and is what
// the search box itself matches against in full - see queryNodes() in
// src/metrics/store.js.
function formatPublicKeyCell(publicKeyHex) {
  return publicKeyHex.slice(0, 12) + '…';
}

function renderNodesList(nodesResponse) {
  const signature = JSON.stringify({ nodes: nodesResponse.nodes, total: nodesResponse.total, offset: nodesOffset });
  if (signature !== lastNodesRenderSignature) {
    lastNodesRenderSignature = signature;
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
  setDataStatus(
    'nodes-data-status',
    'loading',
    lastNodesSuccessAt === null ? 'Loading current repeater list…' : 'Refreshing current repeater list.'
  );
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
    lastNodesSuccessAt = Date.now();
    setDataStatus('nodes-data-status', 'ready', 'Updated: ' + formatTimestamp(lastNodesSuccessAt));
  } catch (err) {
    console.error('failed to refresh the repeaters table', err);
    setDataStatus(
      'nodes-data-status',
      'error',
      'Unable to load current repeater list. ' + formatLastSuccess(lastNodesSuccessAt)
    );
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

// Per-bot DOM/chart state, keyed by bot name. Cards are built once on first
// sight; charts are created only as their cards approach the viewport, then
// updated only when the range data changes.
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
    '<div class="table-scroll" role="region" aria-label="Bot command reply counts" tabindex="0">' +
    '<table><thead><tr><th></th><th>Command</th><th>Count</th></tr></thead><tbody></tbody></table></div>' +
    '<div><div class="pie-wrap"><canvas aria-hidden="true"></canvas></div>' +
    '<p class="chart-summary">Command reply distribution; exact counts are in the adjacent table.</p></div>' +
    '</div>' +
    '<p class="total-replies"></p>';
  block.querySelector('.bot-name').textContent = botName;
  block.querySelector('.table-scroll').setAttribute('aria-label', botName + ' command reply counts');
  container.appendChild(block);

  const entry = {
    block,
    chart: null,
    chartData: [],
    dataSignature: null,
    canvas: block.querySelector('canvas'),
    chartSummary: block.querySelector('.chart-summary'),
    statusBadge: block.querySelector('.status-badge'),
    tbody: block.querySelector('tbody'),
    emptyNote: block.querySelector('.empty-note'),
    totalEl: block.querySelector('.total-replies')
  };
  botCommandBlocks.set(botName, entry);
  botEntryByBlock.set(block, entry);
  return entry;
}

function ensureBotChartObserver() {
  if (botChartObserver || typeof window.IntersectionObserver === 'undefined' || typeof Chart === 'undefined') return;
  botChartObserver = new window.IntersectionObserver((observedEntries) => {
    for (const observed of observedEntries) {
      if (!observed.isIntersecting) continue;
      const entry = botEntryByBlock.get(observed.target);
      if (entry) initializeBotChart(entry);
      botChartObserver.unobserve(observed.target);
    }
  }, { rootMargin: '100px' });
}

function observeBotChart(entry) {
  if (entry.chart) return;
  ensureBotChartObserver();
  if (botChartObserver) {
    botChartObserver.observe(entry.block);
  } else if (typeof window.IntersectionObserver === 'undefined' && currentView === 'bots') {
    // Keep charts usable in browsers without IntersectionObserver. This
    // fallback runs only when the bot detail view is active.
    initializeBotChart(entry);
  }
}

function initializeBotChart(entry) {
  if (entry.chart || typeof Chart === 'undefined') return;
  entry.chart = new Chart(entry.canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: entry.chartData.map((row) => row.trigger),
      datasets: [{
        data: entry.chartData.map((row) => row.count),
        backgroundColor: entry.chartData.map((_, idx) => botCommandColor(idx))
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: true } }
    }
  });
  entry.canvas.setAttribute('role', 'img');
  entry.canvas.setAttribute(
    'aria-label',
    'Command reply counts for ' + entry.block.querySelector('.bot-name').textContent + ' in the selected reporting range'
  );
  entry.canvas.removeAttribute('aria-hidden');
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
  document.getElementById('bots-empty-state').hidden = botCommandsResponse.bots.length > 0;
  for (const bot of botCommandsResponse.bots) {
    const entry = botCommandBlocks.get(bot.botName) ?? buildBotCommandBlock(bot.botName);
    const signature = JSON.stringify({ commands: bot.commands, totalReplies: bot.totalReplies });
    if (signature === entry.dataSignature) continue;
    entry.dataSignature = signature;

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
    entry.chartData = bot.commands;
    entry.chartSummary.textContent =
      bot.totalReplies === 0
        ? 'No command replies in this range; exact counts are in the adjacent table.'
        : 'Total replies: ' + bot.totalReplies + ' across ' + bot.commands.filter((row) => row.count > 0).length +
          ' commands; exact counts are in the adjacent table.';

    if (entry.chart) {
      entry.chart.data.labels = entry.chartData.map((row) => row.trigger);
      entry.chart.data.datasets[0].data = entry.chartData.map((row) => row.count);
      entry.chart.data.datasets[0].backgroundColor = entry.chartData.map((row, idx) => botCommandColor(idx));
      entry.chart.update('none');
    }
    observeBotChart(entry);
  }
  applyBotStatusBadges();
}

function setDataStatus(elementId, state, message) {
  const status = document.getElementById(elementId);
  status.className = 'data-status ' + state;
  status.textContent = message;
}

function formatLastSuccess(timestamp) {
  return timestamp === null
    ? 'No successful update yet.'
    : 'Last successful update: ' + formatTimestamp(timestamp);
}

function setLiveFreshness(state, message) {
  const freshness = document.getElementById('live-freshness');
  freshness.className = 'freshness ' + state;
  freshness.textContent = message;
  if (state !== lastLiveAnnouncementState) {
    document.getElementById('live-announcement').textContent =
      state === 'ready' ? 'Live metrics updates are current.' : 'Live metrics updates are unavailable or stale.';
    lastLiveAnnouncementState = state;
  }
}

function setConnectionState(state) {
  const indicator = document.getElementById('connection-indicator');
  indicator.className = state;
  indicator.textContent = state === 'live' ? 'live' : state === 'down' ? 'disconnected' : 'connecting…';
}

function refreshRangeData({ supersede = false } = {}) {
  const params = resolveRangeQuery({ range: currentRange, customStartMs, customEndMs });
  if (!params) return; // custom range selected but not yet applied
  const view = currentView;
  const viewLabel = VIEW_LABELS[view];
  const lastSuccessAt = lastRangeSuccessByView.get(view) ?? null;

  if (activeRangeRefresh) {
    if (!supersede) {
      // SSE ticks during a slow refresh collapse into one follow-up refresh,
      // so the newest sample is picked up without building an unbounded queue.
      rangeRefreshQueued = true;
      return activeRangeRefresh;
    }
    activeRangeController?.abort();
  }

  const generation = ++rangeRefreshGeneration;
  const controller = new AbortController();
  activeRangeController = controller;

  const request = (async () => {
    try {
      setRangeLoadingStatus(view, viewLabel, lastSuccessAt);
      const qs = buildQueryString({ ...params, view });
      const response = await fetch('/api/metrics/dashboard?' + qs, { signal: controller.signal });
      if (!response.ok) {
        throw new Error('dashboard ' + view + ' query failed (' + response.status + ')');
      }
      const result = await response.json();
      if (result.view !== view || !result.data) {
        throw new Error('dashboard response did not match requested view');
      }
      if (controller.signal.aborted || generation !== rangeRefreshGeneration) return;

      renderDashboardView(view, result.data);
      const updatedAt = Date.now();
      lastRangeSuccessByView.set(view, updatedAt);
      renderUpdatedRangeStatus(view, viewLabel, updatedAt);
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error('failed to refresh range-aware metrics', err);
        setDataStatus(
          'range-data-status',
          'error',
          'Unable to load selected-range ' + viewLabel + '. ' + formatLastSuccess(lastSuccessAt)
        );
      }
    } finally {
      if (activeRangeController === controller) {
        activeRangeController = null;
        activeRangeRefresh = null;
        if (rangeRefreshQueued) {
          rangeRefreshQueued = false;
          void refreshRangeData();
        }
      }
    }
  })();
  activeRangeRefresh = request;
  return request;
}

function setActiveRangeButton() {
  document.querySelectorAll('.range-btn').forEach((btn) => {
    const selected = btn.dataset.range === currentRange;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', String(selected));
  });
  document.getElementById('range-custom').classList.toggle('visible', currentRange === 'custom');
}

function selectPresetRange(value) {
  currentRange = value;
  document.getElementById('range-error').textContent = '';
  setActiveRangeButton();
  refreshRangeData({ supersede: true });
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
  refreshRangeData({ supersede: true });
}

function viewFromLocation() {
  const requestedView = new URL(window.location.href).searchParams.get('view');
  return DASHBOARD_VIEWS.includes(requestedView) ? requestedView : 'overview';
}

function showDashboardView(view, { focus = false } = {}) {
  currentView = view;
  document.querySelectorAll('.dashboard-view').forEach((section) => {
    section.hidden = section.dataset.view !== view;
  });
  document.querySelectorAll('[data-view-link]').forEach((link) => {
    if (link.dataset.viewLink === view) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
  if (focus) {
    document.querySelector('#view-' + view + ' h2')?.focus();
  }

  if (view === 'packets') {
    ensurePacketChartsInitialized();
  }
  if (view === 'bots' && typeof window.IntersectionObserver === 'undefined') {
    botCommandBlocks.forEach((entry) => initializeBotChart(entry));
  }
  if (view === 'repeaters') {
    void refreshNodesList();
  }
  void refreshRangeData({ supersede: true });
}

function navigateDashboardView(view, { pushHistory = true, focus = pushHistory } = {}) {
  if (!DASHBOARD_VIEWS.includes(view)) return;
  if (pushHistory && view === currentView) return;

  if (pushHistory) {
    const url = new URL(window.location.href);
    url.searchParams.set('view', view);
    window.history.pushState({ view }, '', url);
  }
  showDashboardView(view, { focus });
}

function initDashboardNavigation() {
  document.querySelectorAll('[data-view-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigateDashboardView(link.dataset.viewLink);
    });
  });
  window.addEventListener('popstate', () => {
    navigateDashboardView(viewFromLocation(), { pushHistory: false, focus: true });
  });
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

function bootstrap() {
  initRangeSelector();
  initNodesSearch();
  initDashboardNavigation();

  const source = new EventSource('/api/metrics/stream');
  source.onopen = () => setConnectionState('live');
  source.onerror = () => {
    setConnectionState('down');
    setLiveFreshness(
      'error',
      'Connection lost. Last valid live snapshot: ' + (lastLiveSuccessAt === null ? 'none' : formatTimestamp(lastLiveSuccessAt))
    );
  };
  source.onmessage = (event) => {
    try {
      const snapshot = JSON.parse(event.data);
      if (
        !snapshot ||
        typeof snapshot !== 'object' ||
        Array.isArray(snapshot) ||
        !Array.isArray(snapshot.bots) ||
        !snapshot.mqtt ||
        typeof snapshot.mqtt !== 'object' ||
        Array.isArray(snapshot.mqtt)
      ) {
        throw new Error('invalid metrics snapshot shape');
      }
      renderSnapshot(snapshot);
      lastLiveSuccessAt = Date.now();
      setLiveFreshness('ready', 'Last live snapshot: ' + formatTimestamp(lastLiveSuccessAt));
    } catch (err) {
      console.error('failed to process a live metrics update', err);
      setLiveFreshness(
        'error',
        'Invalid live update. Last valid snapshot: ' + (lastLiveSuccessAt === null ? 'none' : formatTimestamp(lastLiveSuccessAt))
      );
    }
    // Refresh the active range view on the sample cadence so "now"-anchored
    // ranges stay current without querying hidden pages.
    refreshRangeData();
  };

  // The stream sends the initial operational snapshot on connect. Activate
  // the requested page after opening it so the live connection is not held
  // up by the page's range or repeater queries.
  navigateDashboardView(viewFromLocation(), { pushHistory: false });
}

bootstrap();
