# Metrics dashboard manual verification checklist

Automated tests cover the dashboard's HTTP endpoints and the pure logic in
`src/web/client/dashboard-logic.js` (see `test/web/metrics-server.test.js`
and `test/web/client/dashboard-logic.test.js`), but nothing in this repo
drives a real browser. Run through this list by hand after any change that
touches `src/web/dashboard-page.js` or `src/web/client/`.

Start the observer with `PACKETCAPTURE_METRICS_UI_ENABLED=true` and open
the dashboard (default `http://127.0.0.1:8090/`).

- [ ] Page loads with no browser console errors.
- [ ] Top tiles (Uptime, Radio, Packets received, Packets decoded) populate
      within a few seconds and keep updating live.
- [ ] Packet-activity chart renders lines; hovering shows a tooltip.
- [ ] Clicking each range preset (1h/6h/24h/7d/30d/90d/1y/All) redraws the
      chart, packet-types table/pie, reply-queue tiles, and per-bot command
      cards without a page reload.
- [ ] Custom range: leaving a date blank, or picking start >= end, shows an
      inline error instead of querying; a valid range applies and redraws.
- [ ] Packet-types table and its pie chart agree with each other.
- [ ] Reply-queue tiles: "Queued now" changes independently of the range
      selector (it's live); Sent/Expired/Failed change when the range
      selector changes.
- [ ] Each configured bot has its own card with an enabled/ready status
      badge, a command table, and a matching pie chart.
- [ ] MQTT brokers table shows each configured broker's live connect state.
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
      overflow or clip.
