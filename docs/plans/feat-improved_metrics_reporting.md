# Feat: Improved Metrics Reporting

## Goals

- Let a dashboard user pick a time range (default **24h**) and see packet
  activity over that range, not just the current in-memory session.
- Persist metrics locally so history survives a process restart.
- Make the packet-type breakdown range-aware (same selector as the
  activity chart) and pair it with a pie/doughnut chart next to the
  existing table so relative share is visible at a glance, exact counts
  still readable in the table.
- Track **per-command** usage for each channel bot (not just the existing
  aggregate `repliesSent`), with a pie chart of command share per bot and
  a table of per-command counts + total replies sent, filtered by the
  same time-range selector.
- Keep the chart's x-axis legible across a wide range of selected
  durations (1h up to "all recorded history") by computing buckets on the
  **backend**, not in client JS, and capping the number of buckets
  returned.
- Let a user pick an arbitrary custom start/end date range, in addition
  to the fixed presets, for all three range-aware views (activity
  chart, packet-types pie/table, bot-command pie/table).

## Non-Goals (v1)

- No authentication/authorization on the metrics UI — it remains
  loopback-only, matching the existing threat model
  (`docs/Threat Model Review - 2026-09-19.md`, T6/T7). Not addressed here.
- No export/download of raw metrics data.
- No multi-instance/shared/remote storage — single local SQLite file per
  observer instance.
- No migration of *pre-existing* in-memory history — persistence starts
  accumulating from the moment this ships; nothing before that is
  backfilled.

## Current State (for reference)

- **`src/health/service-health.js`** — `ServiceHealth` holds running
  in-memory totals (`packetsReceived`, `packetsPublished`,
  `packetsByType` Map, radio/mqtt/bot status). Resets to zero on restart.
  Bots only expose one aggregate counter, `repliesSent`
  (`src/bots/channel-bot.js`), no per-command breakdown.
- **`src/web/metrics-history.js`** — `MetricsHistory` is a bounded
  in-memory ring buffer of periodic snapshot deltas, explicitly
  documented as "not persisted" because AGENTS.md prohibited a
  persistence library in v1. This plan supersedes that constraint via an
  explicit, human-approved decision (see Key Decisions).
- **`src/web/metrics-server.js`** — plain `node:http` server exposing
  `GET /`, `GET /api/metrics`, `GET /api/metrics/history`,
  `GET /api/metrics/stream` (SSE). Ticks every `sampleIntervalMs`
  (default 10s) to record a history sample and push live snapshots.
- **`src/web/dashboard-page.js`** — single self-contained HTML/CSS/JS
  page, charts via Chart.js v4.4.4 from a pinned-SRI CDN link (an
  explicitly documented, scoped exception to the "no further
  dependencies" rule for browser-side-only code). Currently builds the
  activity chart client-side from cumulative snapshot deltas bucketed
  into fixed 30-minute windows, capped at 1000 points.
- **`src/bots/channel-bot.js`** — each bot matches an exact-string
  trigger from its own config and replies; on success increments
  `#repliesSent` and logs `trigger` in metadata, but nothing aggregates
  per-trigger counts today.
- No SQLite or persistence library is currently a dependency.
  `docs/project_plan.spec.md` (restored to the repo after this plan was
  first drafted) reconfirms persistence as a protected boundary
  requiring approval (§3, §5) and documents the `source`-naming
  convention used below.

## Key Decisions (approved 2026-09-21)

These touch AGENTS.md's protected boundaries (dependencies, storage) and
were explicitly discussed and approved before drafting this plan:

1. **Storage engine: `node:sqlite` (Node's built-in `DatabaseSync`).**
   Zero new `package.json` dependency, real SQL for range/aggregation
   queries. Per Node's official docs (`nodejs.org/api/sqlite.html`
   changelog), the module landed experimental behind
   `--experimental-sqlite` in **v22.5.0**; the flag requirement was
   dropped in **v22.13.0** (22.x LTS line) / **v23.4.0** (23.x line) —
   confirmed flag-free empirically on the dev machine's Node 24.18.0.
   It was promoted to **Release Candidate** (stability 1.2) in v25.7.0
   but is still not marked stable. **Decision: bump the documented
   `engines.node` floor from `>=22.12.0` to `>=22.13.0`** — the minimal
   change that stays on the same 22.x LTS line and is the exact version
   where `node:sqlite` became flag-free. `npm start`/`npm run dev`
   should still fail fast with a clear error if the running Node lacks
   `node:sqlite`, as a defense-in-depth check beyond the `engines` field
   (which npm only warns on by default, it doesn't enforce).
2. **Longest selectable range is "All"** (everything currently
   retained), not a fixed cap like 30 days. Retention itself stays
   operator-configurable (see Configuration) and defaults to unlimited.
3. **Bucketing happens on the backend.** The API returns pre-aggregated
   buckets, capped at a configurable maximum count, so the client never
   receives more than N points regardless of the selected range or how
   much history exists.
4. **Channel-bot command metrics use the same time-range selector** as
   packet metrics, which means bot reply events need to be recorded with
   a timestamp (not just a running total).

## Architecture Overview

### Storage layer — `src/metrics/store.js`

A small module wrapping `node:sqlite`'s `DatabaseSync`, opened once at
startup against a configurable file path. Responsibilities:

- Open/create the DB file (creating its parent directory if needed).
- Run schema migrations (see below) up to the current version.
- Expose narrow, purpose-built methods — not a generic query interface —
  e.g. `recordPacketSample(sample)`, `recordBotCommand(event)`,
  `queryPacketHistory({ start, end, maxBuckets })`,
  `queryPacketTypeTotals({ start, end })`,
  `queryBotCommandCounts({ botName, start, end })`. This matches the
  codebase's "small explicit modules over large service classes"
  convention and keeps SQL centralized and reviewable in one file.
- All queries use parameterized statements (`DatabaseSync#prepare`) —
  never string-concatenated SQL — even though inputs are validated
  upstream, per the "be careful about injection" baseline.

### Schema (migration 1)

```sql
CREATE TABLE metrics_samples (
  id                 INTEGER PRIMARY KEY,
  sample_at          INTEGER NOT NULL,  -- epoch ms, start of interval
  interval_ms        INTEGER NOT NULL,
  packets_received   INTEGER NOT NULL,
  packets_published  INTEGER NOT NULL,
  radio_connected    INTEGER NOT NULL,  -- 0/1
  brokers_connected  INTEGER NOT NULL,
  brokers_total      INTEGER NOT NULL,
  bots_ready         INTEGER NOT NULL,
  bots_total         INTEGER NOT NULL
);
CREATE INDEX idx_metrics_samples_at ON metrics_samples(sample_at);

CREATE TABLE metrics_sample_packet_types (
  sample_id           INTEGER NOT NULL REFERENCES metrics_samples(id),
  packet_type_bucket  TEXT NOT NULL,  -- e.g. 'advert','txtMsg','grpTxt',...,'other'
  count               INTEGER NOT NULL,
  PRIMARY KEY (sample_id, packet_type_bucket)
);

CREATE TABLE bot_command_events (
  id           INTEGER PRIMARY KEY,
  occurred_at  INTEGER NOT NULL,
  bot_name     TEXT NOT NULL,
  trigger      TEXT NOT NULL
);
CREATE INDEX idx_bot_command_events_bot_time
  ON bot_command_events(bot_name, occurred_at);
```

`packet_type_bucket` reuses the dashboard's existing 8-category scheme
(`PACKET_TYPE_BUCKETS` in `dashboard-page.js`) rather than fixed columns,
so a new MeshCore payload type doesn't require a migration — it just
falls into `other` until explicitly bucketed.

Migrations live as an ordered array of `{ version, statements }` in
`store.js` itself (no migration framework dependency), applied via
`PRAGMA user_version` on startup — consistent with "no further
dependencies without approval."

### Ingestion / write path

- The existing tick loop in `metrics-server.js` (`#tick()`, currently
  driving the in-memory `MetricsHistory`) is extended to also call
  `store.recordPacketSample(...)` with the same per-interval delta data
  it already computes. **`MetricsHistory`'s in-memory ring buffer is
  removed** — SQLite becomes the single source of truth for history,
  eliminating duplicated state. The live SSE stream (`/api/metrics/stream`)
  is unaffected; it keeps pushing point-in-time snapshots so the chart's
  leading edge still updates in real time between range-query refreshes.
- `ChannelBot#reply()` (`src/bots/channel-bot.js`, next to the existing
  `#repliesSent` increment) calls a `recordBotCommand(botName, trigger,
  timestamp)` function passed into its constructor, alongside its
  existing dependencies — no direct import of the store, keeping
  `ChannelBot` decoupled and consistent with the constructor-injection
  pattern already used for its other collaborators.

### Query / bucketing strategy

Given the sample cadence (default every 10s), even "All" history over a
year is on the order of a few million rows — well within what a single
indexed SQLite table aggregates in well under a second. **A single raw
table is sufficient for v1**; no multi-tier rollup/downsampling is
needed yet. This is called out explicitly as a deliberate scope decision
(see Risks) rather than an oversight — if sample cadence drops or
retention grows into multi-year territory later, an hourly/daily rollup
table can be added without changing the API contract.

Backend bucketing algorithm for a request
`{ range, start?, end?, maxBuckets }`:

1. Resolve `[start, end]` epoch ms. Either:
   - `range` (enum: `1h`, `6h`, `24h` [default], `7d`, `30d`, `90d`,
     `1y`, `all`) — for `all`, `start` = the earliest row in
     `metrics_samples` (or service start if empty); or
   - an explicit `start` + `end` pair (epoch ms, or `YYYY-MM-DD`/ISO
     date strings from the date-picker UI, normalized server-side),
     for the custom range picker.
   `range` and `start`/`end` are mutually exclusive in the query schema
   (`oneOf`); the schema also requires `start < end` and clamps `end`
   to "now" server-side if a future date is submitted, so a picked
   future end doesn't silently return empty buckets that look like a
   bug.
2. Compute `idealWidth = (end - start) / maxBuckets`.
3. Snap up to the next "nice" width from a fixed ladder aligned to the
   sample interval (`sampleIntervalMs`, `1m`, `5m`, `15m`, `1h`, `3h`,
   `6h`, `12h`, `1d`, `7d`, `30d`) — the `30d` step matters for `1y`/`all`
   ranges spanning multiple years — guaranteeing the final bucket count
   stays
   `<= maxBuckets` (default configurable, e.g. 180).
4. Run one grouped SQL query per range using integer-division bucketing:

   ```sql
   SELECT ((ms.sample_at - :start) / :bucketWidthMs) AS bucket_idx,
          t.packet_type_bucket,
          SUM(t.count) AS total
   FROM metrics_samples ms
   JOIN metrics_sample_packet_types t ON t.sample_id = ms.id
   WHERE ms.sample_at >= :start AND ms.sample_at < :end
   GROUP BY bucket_idx, t.packet_type_bucket
   ORDER BY bucket_idx;
   ```

5. Assemble into `{ bucketStart, bucketWidthMs, countsByType }[]`,
   filling zero counts for types absent in a given bucket.

Pie-chart/table totals (packet types, and bot commands) are a single
non-bucketed `GROUP BY` over the same `[start, end]` window — no
buckets needed there, just a range-filtered aggregate.

### API surface

- `GET /api/metrics/history?range=24h&maxBuckets=180` (or
  `?start=...&end=...&maxBuckets=180` for a custom range) — replaces
  the current unfiltered history endpoint; returns backend-computed
  buckets as above. `range`, `start`/`end`, and `maxBuckets` are
  validated (enum / bounded integers, mutually-exclusive `range` vs.
  `start`+`end`, `start < end`) via a new AJV schema before use — HTTP
  query params are strings, so they're parsed (`Number(...)`/date
  parsing) and *then* validated as a plain object against the schema,
  consistent with the shared AJV instance's existing
  `strict`/no-`coerceTypes` configuration.
- `GET /api/metrics/packet-types?range=24h` (or `?start=...&end=...`) —
  new; range-filtered totals per packet-type bucket, for the
  pie-chart-and-table pairing.
- `GET /api/metrics/bots/commands?range=24h` (or `?start=...&end=...`)
  — new; per bot, an array of `{ trigger, count }` plus `totalReplies`
  for that range, for the per-bot pie chart + table pairing.
- All three endpoints share one range-resolution helper and one query
  schema shape for the `range` vs. `start`/`end` parameters, so the
  custom-range behavior (validation, clamping, error messages) is
  identical across them rather than reimplemented three times.
- Existing `GET /api/metrics` (live snapshot) and
  `GET /api/metrics/stream` (SSE) are unchanged.
- All new query-parameter shapes get a schema in a new
  `src/web/schemas.js`, following the existing pattern in
  `src/validation/ajv.js` / `src/packets/schemas.js`
  (`$id` under `meshcore-observer/...`, `additionalProperties: false`).

### Dashboard / UI changes (`src/web/dashboard-page.js`)

- Add a duration selector control (button group: 1h / 6h / 24h
  [default] / 7d / 30d / 90d / 1y / All, plus a **Custom** option) that
  drives all three range-aware queries (`history`, `packet-types`,
  `bots/commands`) and re-renders on change.
- Selecting **Custom** reveals two native `<input type="date">` (or
  `datetime-local`, for sub-day precision) fields for start/end. No new
  date-picker dependency — plain HTML date inputs, consistent with the
  page's existing no-build-step/no-extra-library approach. Client-side
  validates `start < end` before firing the query (server-side
  validation is still authoritative, per the AJV schema above); an
  invalid or incomplete custom range disables the query rather than
  sending a bad request.
- Replace the current client-side delta/bucketing logic
  (`deltaPoint`, `trimChart`, fixed `CHART_BUCKET_MS`,
  `MAX_CHART_POINTS`) with straightforward rendering of the
  backend-provided buckets — the client no longer needs to guess bucket
  width or cap point count itself. Live SSE updates still append to (or
  start a new) trailing bucket between range-query refreshes.
- Add a pie/doughnut chart next to the existing packet-types table,
  sharing the same 8-category color scheme (`PACKET_TYPE_BUCKETS`)
  already defined for the line chart, so colors stay consistent across
  chart types.
- Add a per-bot section: pie/doughnut chart of command-trigger share +
  a table of `{ trigger, count }` rows + total replies sent, all
  filtered by the same duration selector. Bots with zero commands in
  range render an empty-state, not an error.

## Configuration additions (`src/config/index.js` + `src/config/schema.js`)

Following the existing `PACKETCAPTURE_METRICS_UI_*` prefix convention
(`readMetricsUi`, `config/schema.js`):

| Env var | Default | Purpose |
| --- | --- | --- |
| `PACKETCAPTURE_METRICS_UI_DB_PATH` | `./data/metrics.sqlite3` | SQLite file location |
| `PACKETCAPTURE_METRICS_UI_RETENTION_DAYS` | `0` (unlimited) | If > 0, rows older than N days are pruned daily |
| `PACKETCAPTURE_METRICS_UI_MAX_CHART_BUCKETS` | `180` | Cap on buckets returned per history query |

All added to `readMetricsUi(env)` and `configSchema`, documented in
`.env.example` and README, matching the existing `historyWindowMs`
precedent. Config validation continues to fail closed (`ConfigError`)
before any hardware/network side effect; DB-file creation happens
during the metrics-UI startup step (after config validation), not
during config parsing itself.

## Validation / schema additions

- `src/web/schemas.js` (new): a shared `rangeQuerySchema` fragment
  (`oneOf`: `{ range: enum }` or `{ start, end }` with `start < end`
  enforced) composed into `metricsHistoryQuerySchema` (adds
  `maxBuckets`), `packetTypeTotalsQuerySchema`, `botCommandsQuerySchema`
  — all `additionalProperties: false`, compiled once via
  `compileSchema()` from `src/validation/ajv.js`.
- Config schema additions for the three new env-derived fields above.

## Logging

New modules log under namespaced `source` values consistent with the
`<area>.<component>` convention set out in `docs/project_plan.spec.md`
§8 and followed by existing infrastructure modules (`services.mqtt`,
`services.packetCapture`, `services.metricsUi`). The new persistence
layer uses `'services.metricsStore'`; `bots.channelBot` already covers
command replies, so no new source is needed there beyond the
`trigger`/timestamp context already logged today. No secret-bearing
values are introduced by this feature; nothing here changes the
logger's redaction surface.

## Threat model impact

To be added as an addendum to
`docs/Threat Model Review - 2026-09-19.md` in Phase 1:

- New local attack surface: a SQLite file on disk. Path is
  operator-configured (env var), never derived from network input, so
  no path-traversal exposure from a remote actor.
- New query parameters on loopback-only HTTP endpoints — validated
  strictly (enum ranges, bounded integers) and always used via
  parameterized statements, so no SQL-injection surface even though the
  endpoints are unauthenticated today (per existing T6/T7 findings,
  unchanged by this plan).
- Unlimited-by-default retention is a disk-growth risk on
  long-running deployments; documented as an operator responsibility,
  with the `RETENTION_DAYS` knob as the mitigation.
- No new secrets are stored or logged.

## Phased implementation plan

Each phase is intended to be approved and merged independently per the
AGENTS.md workflow rule ("one approved task/phase at a time").

1. **Storage foundation.** `src/metrics/store.js`, schema/migrations,
   config additions, engines-floor bump + startup Node-version guard,
   threat-model addendum. No behavior change yet — store exists and is
   wired up but not yet read by the UI.
2. **Packet metrics persistence + range-aware history/pie/table.**
   Wire the tick loop to `store.recordPacketSample`, remove
   `MetricsHistory`, add `/api/metrics/history` (bucketed) and
   `/api/metrics/packet-types` — including the shared `range` vs.
   `start`/`end` query schema — add the dashboard duration selector
   (presets + custom date-range inputs) and packet-types pie chart.
3. **Bot command tracking.** `recordBotCommand` wiring into
   `ChannelBot#reply()`, `/api/metrics/bots/commands` endpoint,
   per-bot pie chart + table + total-replies in the dashboard.
4. **Docs.** README architecture section, `.env.example`, threat model
   addendum finalized against what actually shipped.

## Testing plan

- Unit tests for `store.js`: write/read round-trip, bucket-width
  "nice ladder" selection at boundary conditions (very short range vs.
  `maxBuckets`, very long "all" range), retention pruning.
- Unit tests for the query-param schemas: valid/invalid `range`,
  out-of-bounds `maxBuckets`, valid custom `start`/`end`, `start >= end`
  rejected, `range` + `start`/`end` supplied together rejected
  (`oneOf` violation), a future `end` clamped to "now".
- Unit test for `ChannelBot` recording a command event on successful
  reply and *not* recording on a dedup-suppressed or failed send.
- Manual verification via the `run` skill: start the app, hit each new
  endpoint (including a custom `start`/`end` query), exercise the
  dashboard's duration selector — both presets and the custom
  date-range inputs — and confirm the line chart, pie charts, and
  tables all agree with each other and with raw DB contents for a known
  time window.

## Open questions / still needs a decision or input

1. ~~`docs/project_plan.spec.md` missing~~ — **resolved**: restored to
   the repo at `docs/project_plan.spec.md`. It reconfirms persistence
   as a protected boundary requiring approval (§3, §5: "Do not add
   persistence/database dependencies in v1") — consistent with the Key
   Decisions already approved above — and gives the `source`-naming
   convention now reflected in the Logging section. Its §5 non-goals
   ("Web UI," "general-purpose REST API," "database") describe the
   *original* v1 baseline; the dashboard, metrics API, and history
   tracking already shipped in prior commits are an approved deviation
   from that original baseline, and this plan is a continuation of that
   same already-approved direction — only the *storage* piece is new
   protected-boundary ground, which is why it's called out explicitly
   above rather than assumed.
2. ~~Exact minimum Node version for flag-free `node:sqlite`~~ —
   **resolved**: v22.13.0 / v23.4.0 per Node's official docs (see Key
   Decision 1). `engines.node` floor to become `>=22.13.0`.
3. ~~Duration selector preset list~~ — **resolved (2026-09-21)**:
   `1h / 6h / 24h [default] / 7d / 30d / 90d / 1y / All`.
