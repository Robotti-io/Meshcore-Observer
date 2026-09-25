# Metrics dashboard manual verification checklist

Automated tests cover the dashboard's HTTP endpoints and the pure logic in
`src/web/client/dashboard-logic.js` (see `test/web/metrics-server.test.js`
and `test/web/client/dashboard-logic.test.js`), but nothing in this repo
drives a real browser. Run through this list by hand after any change that
touches `src/web/dashboard-page.js` or `src/web/client/`.

Start the observer with `PACKETCAPTURE_METRICS_UI_ENABLED=true` and open
the dashboard (default `http://127.0.0.1:8090/`).

## T7 validation record

On 2026-09-25, the repository was reviewed on Windows PowerShell with Node
v24.18.0. No local dashboard server or browser session was available, so
desktop/mobile rendering and DevTools measurements remain pending. The
request counts below are derived from the old and current client refresh paths;
they are not packet captures from a running browser.

| Measure | Before view consolidation | Current view refresh |
| --- | ---: | ---: |
| Range requests per sample | 6 | 1 for the active view |
| Range requests per minute at a 10-second sample interval | 36 | 6 |
| Range requests per hour at a 10-second sample interval | 2,160 | 360 |
| Reduction in recurring range requests | — | 83.3% |

The current view request is one `GET /api/metrics/dashboard` call for the
overview or selected detail view. The persistent EventSource is separate.
The repeater inventory uses `GET /api/nodes` on entry to that view and on
search or pagination; it is not refreshed for every sample. While a range
request is active, sample ticks coalesce into at most one sequential follow-up.
A range or view change aborts the prior browser request and starts the latest
selection.

Overview trend comparisons add database work without adding a browser request:
when a complete previous period is available, the overview reads current and
previous packet, reply, broker, and repeater totals plus the earliest sample
time needed to confirm full comparison coverage. The overview no longer
aggregates bot-command counts for a separate duplicate KPI; per-command counts
remain on the Channel bots page.

Automated validation on this checkout: `npm run lint` passes. `npm test`
reports 428 passing and one failing test: `test/metrics/store.test.js` expects
`lastAttemptAt` to remain 3000 after a flood-advert send, while the store
returns 5000. This failure is outside the dashboard UI paths changed for T6;
it remains to be reviewed separately.

For rendering comparison, use a representative configuration with at least
20 bots. In DevTools, record `Object.keys(Chart.instances).length` on entering
Channel bots and after scrolling through the cards; only cards within the
viewport or its 100-pixel observer margin should have charts. Filter the
Network panel for `/api/metrics/` and record requests over several sample
intervals on Overview and one detail view. Repeat at desktop and phone-width
viewports, and record the browser/version, bot count, viewport, chart counts,
and request counts here after that browser run.

- [ ] Page loads with no browser console errors.
- [ ] The EventSource connects immediately during page startup; a slow range
      request or repeater-list request does not delay the live connection or
      first snapshot.
- [ ] The status line below Reporting range keeps its update label stable;
      only changed date/time components briefly pulse green when refreshed.
- [ ] The header's last-live-snapshot time advances as SSE events arrive.
- [ ] Uptime seconds advance without flashing the whole tile; only each
      changed time segment briefly pulses green, including higher units when
      they roll over. Reduced-motion settings suppress the animation.
- [ ] Range metrics and the repeater list load independently; throttling or
      failing one request group leaves the other view usable and shows a
      loading/error message with the last successful update time where one
      exists.
- [ ] After a range request failure, the last rendered data remains visible;
      a later successful request clears the error and advances the update time.
- [ ] If a malformed SSE event can be injected with local browser tooling,
      it is reported without stopping the stream; a later valid event still
      updates the dashboard.
- [ ] The overview loads range-scoped packet, reply, broker, and repeater
      summary metrics; uptime and radio status remain live.
- [ ] Overview trend deltas compare a 1h selection with the immediately
      preceding hour; increases show green `↑ +X`, decreases show red `↓ -X`,
      and unchanged values use a neutral marker.
- [ ] Custom ranges compare against the immediately preceding equal-length
      period. `All` shows that comparison is unavailable, and a trend stays
      unavailable until a complete previous period is stored.
- [ ] The overview shows one replies-sent total; bot command breakdowns remain
      in the Channel bots view without a duplicate overview total.
- [ ] The navigation opens focused Overview, Packet activity, MQTT brokers,
      Channel bots, and Repeaters views; browser Back/Forward tracks view
      changes without opening another stream connection, and keyboard focus
      moves to the selected view heading.
- [ ] Range preset buttons expose their selected state (`aria-pressed`) to
      assistive technology, including the Custom selection.
- [ ] Connection/freshness changes are announced to assistive technology,
      while routine timestamp updates do not generate repeated announcements.
- [ ] Packet-activity chart renders when its detail view is opened; hovering
      shows a tooltip.
- [ ] With many configured bots, bot command charts initialize as their cards
      approach the viewport while the command tables remain available immediately.
- [ ] Each packet and bot chart has a clear accessible name and adjacent text
      summary; if Chart.js is unavailable, exact packet-type and per-bot counts
      remain available in their tables.
- [ ] Repeated range refreshes with unchanged values do not rebuild the packet,
      broker-delivery, bot-command, or repeater tables or redraw unchanged charts.
- [ ] Clicking each range preset (1h/6h/24h/7d/30d/90d/1y/All) refreshes the
      active view. Navigating to another view preserves that range.
- [ ] After selecting a non-default range, a full page reload resets the
      range to 24h while opening the view named by the URL.
- [ ] Custom range: leaving a date blank, or picking start >= end, shows an
      inline error instead of querying; a valid range applies and redraws.
- [ ] Packet-types table and its pie chart agree with each other.
- [ ] Channel bots view: "Queued now" changes independently of the range
      selector (it's live); Sent/Expired/Failed and command counts follow
      the shared range.
- [ ] Each configured bot has its own card with an enabled/ready status
      badge, a command table, and a matching pie chart.
- [ ] MQTT brokers view shows each configured broker's live connect state
      and range-scoped delivery counts.
- [ ] With no brokers or bots configured, each view explains that the section
      has no configured entries instead of showing a blank table or chart area.
- [ ] Repeaters view: Added/Updated tiles change when the range selector
      changes (they're range-scoped, like Sent/Expired/Failed).
- [ ] Repeaters table lists known repeaters, most-recently-heard first, and
      does *not* change when the range selector changes (it's live current
      state) or reset on every live SSE tick (it should hold still while
      you're reading/searching it).
- [ ] Typing in the repeaters search box (a name substring or a public-key
      hex prefix) filters the table after a brief pause, and resets to page
      1; clearing it shows every repeater again.
- [ ] Repeaters table pagination: Next/Prev step through pages correctly,
      Prev is disabled on page 1, Next is disabled on the last page, and the
      "X-Y of Z" note matches what's shown.
- [ ] Connection indicator (top right) reads "connecting…" briefly, then
      "live"; disconnecting the observer process flips it to
      "disconnected".
- [ ] Toggle the OS between light and dark mode while the page is open -
      chart colors (lines, legend, pie slices, bot-command pies) repaint to
      match, without a page reload.
- [ ] Block the Chart.js CDN (e.g. via browser devtools request blocking on
      `cdn.jsdelivr.net`) and reload: the chart area shows the "Chart
      unavailable" fallback message, but every tile/table/live update still
      works.
- [ ] Resize the window to a narrow (phone-width) viewport: layout doesn't
      overflow or clip; wide tables scroll within their own keyboard-focusable
      regions rather than forcing horizontal scrolling on the whole page.
