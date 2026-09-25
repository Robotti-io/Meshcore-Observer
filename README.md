# MeshCore Observer

A Node.js observer for a Heltec V3 (or compatible) radio running MeshCore
Companion firmware. It connects over USB serial (or TCP, for a
bridged/containerized deployment), captures RF packets, publishes them and
an observer status heartbeat to one or more MQTT brokers, and can run any
number of independently-configured channel bots that reply to trigger
commands on public hashtag channels.

## Requirements

- **Node.js 22.13.0 or newer - a hard requirement.** This observer's
  persisted data store (`node:sqlite`, a Node built-in) is a core
  component, not something specific to the optional metrics dashboard
  (see "Metrics UI" below) - the process refuses to start on an older
  Node. See `engines` in `package.json`.
- A Heltec V3 (or compatible) radio running MeshCore Companion firmware,
  reachable over USB serial (Windows: a COM port) or a TCP bridge
- Windows is the primary supported runtime today; the radio transport is
  abstracted behind a serial/TCP seam so a TCP bridge can be used in a
  future containerized/Linux deployment

## Install

```sh
git clone <this repository>
cd meshcore-observer
npm install
```

## Configure

Configuration is entirely environment-driven, with two optional local files
for convenience during development.

### 1. Environment variables

```sh
cp .env.example .env.local
```

`npm start` / `npm run dev` automatically load `.env.local`. It's
git-ignored and never needs to be committed. In production or a container,
set these as real process environment variables instead of using the file.

See `.env.example` for the full, commented list. The essentials:

| Variable | Purpose |
| --- | --- |
| `PACKETCAPTURE_CONNECTION_TYPE` | `serial` (default) or `tcp` |
| `PACKETCAPTURE_SERIAL_PORTS` | Comma-separated candidate COM ports, tried in order |
| `PACKETCAPTURE_TCP_HOST` / `PACKETCAPTURE_TCP_PORT` | Used only when `CONNECTION_TYPE=tcp` |
| `PACKETCAPTURE_IATA` | Your observer's location code, used in MQTT topics |
| `PACKETCAPTURE_OWNER_EMAIL` | Included in LetsMesh JWT claims, if used |
| `PACKETCAPTURE_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `PACKETCAPTURE_BOTS_CONFIG_FILE` | Path to your channel bots config (see below) |
| `PACKETCAPTURE_METRICS_UI_ENABLED` | `true` to serve the live metrics dashboard (see below); default `false` |

#### MQTT brokers

Configure any number of brokers in a JSON file, `PACKETCAPTURE_BROKERS_CONFIG_FILE`
(default `brokers.config.json`; see `brokers.config.example.json`). Each
broker connects and reconnects independently - one being down never affects
the others.

```json
[
  {
    "id": "okimesh",
    "enabled": true,
    "host": "mqtt1.okimesh.org",
    "port": 1883,
    "transport": "tcp",
    "tls": false,
    "auth": { "method": "none" }
  }
]
```

`auth.method` is one of:

- **`none`** - anonymous (e.g. OKI Mesh)
- **`password`** - a static `auth.username` (in the file) and password. The
  password itself is never stored in the file - set it as
  `PACKETCAPTURE_MQTT<n>_PASSWORD`, where `<n>` is that broker's **1-based
  position in the array** (the first entry is `MQTT1`, the second `MQTT2`,
  and so on - reordering the array changes which entry a given
  `..._PASSWORD` variable belongs to).
- **`token`** - a JWT signed **on the radio itself** (the private key never
  leaves the device) and refreshed automatically before it expires. Used
  for LetsMesh. Set `auth.audience` (required) and optionally
  `auth.tokenTtlSeconds` (default 24h) in the file - no environment
  variable needed, since there's no static secret to keep out of it.

Published topics (compatible with the existing MeshCore MQTT convention):

```text
meshcore/{IATA}/{PUBLIC_KEY}/status    (retained; online/offline, with a Last Will for abrupt disconnects)
meshcore/{IATA}/{PUBLIC_KEY}/packets
```

### 2. Channel bots

```sh
cp bots.config.example.json bots.config.json
```

Then either leave `PACKETCAPTURE_BOTS_CONFIG_FILE` unset (`bots.config.json`
in the project root is the default path) or point it at wherever you keep
the file. A missing *default* file just means no bots run - not an error;
explicitly setting the env var to a path that doesn't exist is an error.

Each entry in the array is one independent bot - its own channel, its own
minimum-hop threshold, and its own set of exact-match trigger →
response-template commands:

```jsonc
[
  {
    "name": "echo_bot",              // a label, used in logs
    "channel": "#echo",          // a public hashtag channel; created automatically if it doesn't already exist on the radio
    "enabled": true,
    "minHops": 1,                // reject messages heard with fewer relay hops than this
    "maxMessageBytes": 120,      // channel messages have a real mesh-repeating limit; replies degrade gracefully rather than exceed it
    "commands": [
      {
        "trigger": "!echo",
        "response": "🔁 @[{sender}]! {hopCount} hops via {path}",
        "overflowResponse": "🔁 @[{sender}]! {hopCount} hops - 🔗 https://map.okimesh.org/#/packets/{hash}"
      },
      { "trigger": "!about", "response": "🤖 Robotti is a mesh network bot that can echo messages, and provide packet links. Use !commands to see commands."},
      { "trigger": "!commands", "response": "Available commands: !about, !commands, !echo, !packet, !link, !lookup" },
      { "trigger": "!packet", "response": "🔗 @[{sender}] - https://map.okimesh.org/#/packets/{hash}"},
      { "trigger": "!link", "response": "🔗 https://github.com/Robotti-io/Meshcore-Observer" },
      {
        "trigger": "!lookup",
        "kind": "lookup",
        "foundResponse": "📡 @[{sender}]! {nodePrefix} (heard {lastHeard}) = {name}",
        "notFoundResponse": "❓ @[{sender}]! no repeater with prefix {query} heard in our list of {repeaterCount} repeaters.",
        "ambiguousResponse": "⚠️ @[{sender}]! {matchCount} repeaters match {query}, most recent: {name} - use more hex digits",
        "invalidResponse": "⚠️ @[{sender}]! give at least 1 byte in hex, e.g. !lookup E8"
      }
    ]
  }
]
```

Response templates can use `{sender}`, `{hopCount}`, `{path}`, `{trigger}`,
and `{hash}` (the same packet hash published to MQTT, lowercased - handy
for linking back to the packet on a platform like OKI Mesh's CoreScope
dashboard: `https://map.okimesh.org/#/packets/{hash}`).

Triggers match exactly - `!echo` does not match `!echo now` or
`hello !echo`. A message is replied to at most once no matter how many
times the mesh relays it to you.

A command's `overflowResponse` is optional. When the rendered `response`
doesn't fit `maxMessageBytes` (the hop-path listing is the field most
likely to grow past it - a real path from a heavily-relayed message can run
well past 100 bytes on its own), `overflowResponse` is rendered instead,
with the same placeholders available. This is the place to swap a long
`{path}` listing for something short and still useful, like the `{hash}`
packet link shown above. Without an `overflowResponse`, a command falls
back to the old behavior: the same `response` re-rendered with `{path}`
emptied out, then hard truncation as a last resort if it's still too long.

#### Repeater name lookup (`kind: "lookup"`)

A command can opt into argument parsing instead of exact matching by
setting `"kind": "lookup"`. This observer keeps a SQLite-backed record of
every REPEATER whose advertised name it has verified (its ADVERT's
signature checks out against its own claimed public key - an unverified
advert never contributes a name), keyed by full public key. A `!lookup`
command resolves its argument as a hex prefix of that key:

```text
!lookup E85C   -> the repeater whose public key starts E85C, if exactly one does
```

A `"lookup"` command needs four response templates instead of one -
`foundResponse`, `notFoundResponse`, `ambiguousResponse`, and
`invalidResponse` - and must not set `response`/`overflowResponse` (see the
`!lookup` example above). They're chosen by outcome:

- **found** - exactly one repeater's key starts with the query. `{name}`
  and `{lastHeard}` are available. `{lastHeard}` is a compact relative age
  such as `20m ago` or `1h ago`, calculated when the queued reply is sent.
  `{nodePrefix}` is the normalized query for prefixes of at least two
  bytes; shorter prefixes show the first two bytes of the matched key
  (for example, `!lookup E85` can return `E85C`).
- **not_found** - a valid query, but no matching repeater has been heard
  from. `{repeaterCount}` is the count of all stored repeaters, including
  entries heard at any time because the registry has no TTL.
- **ambiguous** - more than one repeater's key starts with the query.
  `{matchCount}` is the total, and `{name}` is the most recently heard of
  the matches - a useful guess while asking for a longer, more specific
  prefix.
- **invalid** - the query is missing, shorter than 1 byte (2 hex
  characters), or contains a non-hex character.

A query longer than 1 byte doesn't need to stay byte-aligned - `!lookup
E85` (2.5 bytes) works the same as `!lookup E85C`.

#### Reply queue (mesh congestion)

Every bot reply goes through one shared, FIFO queue (one per process, not
one per bot - "the local frequency" is a single physical radio, so
ordering and congestion-avoidance only make sense as one shared
resource) rather than being sent the instant a trigger matches. A queued
reply is held until the shared RF channel has been quiet - no heard
packets from anyone, on any channel - for a configured duration, and is
dropped unsent if it waits longer than a configured TTL without ever
seeing that quiet window:

| Variable | Purpose |
| --- | --- |
| `PACKETCAPTURE_BOT_REPLY_QUIET_MS` | Required silence before a queued reply is sent; default `5000` |
| `PACKETCAPTURE_BOT_REPLY_TTL_MS` | Drop a queued reply unsent after waiting this long; default `60000` |

There's deliberately no size cap on the queue - sending a reply also
counts as channel activity, so the next queued item always needs its own
fresh quiet window afterward. That self-resetting makes the drain rate
inherently bounded to roughly one reply per quiet period no matter how
many are queued, so a burst of triggers can only make the queue back up
(bounded by the TTL), never burst replies out.

Every way a queued reply is resolved - sent, failed, expired (dropped
after waiting past the TTL), or cancelled (dropped, unsent, on shutdown
before it could be sent) - is persisted when the metrics UI is enabled,
per bot and per trigger, not just successful sends. The dashboard's
sent/expired/failed tiles read the sum of this across every bot for
whichever duration is currently selected (same selector that drives the
packet-activity chart), so - unlike queue depth ("Queued now"), which is
genuinely live, in-process state and always shows right now regardless of
the selected duration - these survive a restart and reflect real history,
not just what happened since the process last started. The per-bot/
per-trigger breakdown isn't surfaced on the dashboard yet; it's captured
now so a future "queue health" view doesn't need a schema change to add it.

**Why quiet-window detection, and why not just retry if a reply doesn't
land:** MeshCore's `GRP_TXT` (channel/group) messages carry **no
protocol-level acknowledgement** - only direct 1:1 messages get a
delivery-confirming `SendConfirmed` push tied back to a specific send
(see [docs.meshcore.io/companion_protocol](https://docs.meshcore.io/companion_protocol/)).
A broadcast to a whole channel has no single destination to ACK from, so
there is nothing to retry against; `sendChannelTextMessage()`'s success
response only means "the local radio accepted the command for
transmission," never "someone received it." This is a MeshCore protocol
property, not a gap in this app - and there's no channel-energy/CAD
reading exposed to this companion app either, so "quiet" is inferred
from application-level RF activity (heard `radio.packet` events), not a
direct radio readout.

What this queue *does* help with: a trigger message is itself just been
flood-relayed, and nearby repeaters can still be actively
re-transmitting/settling that same flood for several seconds afterward.
Replying while that's still happening collides with it. A 5-second quiet
requirement (found through field testing on a real deployment; a flat
500ms-2.5s pre-reply delay - tried first - was measurably worse) gives
that propagation room to settle before this bot's reply adds new traffic
to the channel. This lines up with MeshCore's own documented behavior: a
node that finds the channel busy gives up waiting and transmits anyway
after about 4 seconds (`ERR_EVENT_CAD_TIMEOUT`), and the project's own
maintainers have flagged repeater backoff defaults as too low for this
kind of collision (see the repeater configuration note below).

#### Recommended repeater configuration

This app's reply queue only controls when *this observer's own bot* keys
up - it doesn't change how repeaters on the mesh handle collisions in
general. If you or people you coordinate with operate repeaters on the
same mesh, MeshCore's own maintainers have flagged the stock repeater
backoff defaults as too low, which independently contributes to the same
congestion this queue works around
([meshcore-dev/MeshCore#2123](https://github.com/meshcore-dev/MeshCore/issues/2123)).
Via the repeater's CLI (see
[docs.meshcore.io/cli_commands](https://docs.meshcore.io/cli_commands/)):

| Setting | Command | Default | Recommended minimum |
| --- | --- | --- | --- |
| Flood retransmit backoff | `set txdelay <value>` | `0.5` (~2 backoff slots) | `1.6` (~8 backoff slots) |
| Direct-message backoff | `set direct.txdelay <value>` | `0.2`-`0.3` | `1` (~5 backoff slots) |
| Receive-window backoff (experimental) | `set rxdelay <value>` | `0` (off) | `3` |

Use `get txdelay` / `get direct.txdelay` / `get rxdelay` to check a
repeater's current values before changing them - defaults can vary by
firmware version. This is a mesh-wide, repeater-operator change, not
something this observer (a companion-mode client, not a repeater) can
set on your behalf.

#### Companion flood adverts

After the radio connects, the observer asks the Companion device to send
its own flood advert. It waits for the same quiet-air window as bot replies,
and shares the radio's outbound reservation with them. The next advert is
scheduled from the time the Companion accepts the previous command; the
interval is a minimum cadence and can be delayed by traffic or a radio
disconnect. Requests that become due while disconnected or while the air is
busy coalesce into one pending advert. Pending work survives process
restarts, and an interrupted command is deferred because the device may
already have accepted it. Flood adverts can be retransmitted by repeaters.

| Variable | Purpose |
| --- | --- |
| `PACKETCAPTURE_FLOOD_ADVERT_INTERVAL_HOURS` | Periodic flood advert interval in whole hours; default and local community recommendation `47`, valid values `47` through `168`. Set to `0` for startup-only. One-hour zero-hop adverts are a separate mode. |

### 3. Metrics UI (optional)

This observer always persists its metrics/state (packet activity, bot
reply outcomes, the `!lookup` repeater registry, and the flood-advert
scheduler job) to a local SQLite
database (`node:sqlite`, a Node built-in - see PACKETCAPTURE_METRICS_UI_DB_PATH
below) - that's a core capability, not something you need the dashboard
enabled for. What's actually optional is the HTTP dashboard itself: a live
view of radio/MQTT/bot status, packet counters, and a searchable table of
known repeaters, served over plain HTTP with no server-side dependency.
It's off by default.

```sh
PACKETCAPTURE_METRICS_UI_ENABLED=true
```

Then open `http://127.0.0.1:8090/` (or your configured host/port) while
the observer is running. It has **no authentication**, so the listener
defaults to `127.0.0.1` (loopback-only, not reachable from the network).
Only set `PACKETCAPTURE_METRICS_UI_HOST` to `0.0.0.0` or a LAN address if
you understand the dashboard and its `/api/metrics*` endpoints will then be
reachable by anyone who can reach that address - put your own
reverse proxy and authentication in front of it if you need remote access.

The packet-activity chart and packet-types pie chart are rendered
client-side with [Chart.js](https://www.chartjs.org/), loaded by the
browser directly from the jsdelivr CDN (pinned to an exact version with
Subresource Integrity, so the browser refuses it if the served bytes ever
don't match) rather than vendored into this app - an explicit, scoped
exception to the "no further dependencies" rule in [`AGENTS.md`](AGENTS.md),
made because it's a browser-side visualization library, not a server
dependency. Practically, this means **the charts specifically need the
viewing browser to have outbound internet access**; everything else on the
dashboard (tiles, tables, live SSE updates) works with no internet access
at all, and the charts degrade to a visible "unavailable" message rather
than breaking the page if the CDN can't be reached.

The dashboard's own CSS/JS live as ordinary files under `src/web/client/`
(not inlined into the HTML, not bundled - `dashboard.js` is loaded as a
real `<script type="module">` and imports its sibling `dashboard-logic.js`
by plain relative URL, resolved by the browser itself), served as static
assets by `MetricsServer`. `dashboard-logic.js` holds every pure,
DOM-free piece of client logic (range handling, response-to-chart-data
shaping, formatting) and is unit-tested directly under Node - see
`test/web/client/dashboard-logic.test.js`. Since nothing here drives an
actual browser, `docs/dashboard-manual-check.md` is a short checklist to
run through by hand after changes to the dashboard.

Packet activity (the line chart), the packet-types table, the packet-types
pie chart, and a "Bot commands" section (one pie chart + table + total
replies per configured channel bot, showing which of its commands are
actually being used) are all driven by the same duration selector -
presets from 1 hour up to "All", or a custom start/end date range -
backed by packet/bot-command metrics persisted locally in a SQLite file
via Node's built-in `node:sqlite` (requires Node >=22.13.0; see `engines`
in `package.json`). Bucketing for the line chart happens on the server,
capped at `PACKETCAPTURE_METRICS_UI_MAX_CHART_BUCKETS` points regardless
of how much history exists, so a multi-year "All" query still returns a
bounded response. A bot with more than 7 configured commands has the
overflow folded into a single "Other" row/slice rather than adding more
categorical colors, and every pie/doughnut chart reuses the same
validated 8-color palette in a fixed order (see the dataviz method) - a
command's color is tied to its position in that bot's own configuration,
never to how often it's currently used, so colors stay stable across
refreshes. The top-row tiles (packets received/decoded) and the
existing bot status table (enabled/ready/all-time replies sent) remain
live, all-time-since-start counters, unaffected by the duration selector.

"Decoded" means a packet reached the publish pipeline, not that a broker
actually received it - the store separately persists a per-broker
sent/skipped/failed delivery breakdown, and a full reply-lifecycle history
(sent/failed/expired/cancelled, per bot and per trigger, not just
successful sends) for the shared reply queue. Neither is on the dashboard
yet, but both are captured now specifically so a future view can query
them without a schema change (see `MetricsStore#queryBrokerDeliveryTotals`
and `#queryBotReplyOutcomeTotals`).

The `HOST`/`PORT`/`MAX_CHART_BUCKETS` variables below only matter when the
HTTP dashboard itself is enabled; `DB_PATH`/`SAMPLE_INTERVAL_MS`/
`RETENTION_DAYS` are always in effect (they configure the always-on data
store and its sampling loop), regardless of `PACKETCAPTURE_METRICS_UI_ENABLED`.

| Variable | Purpose |
| --- | --- |
| `PACKETCAPTURE_METRICS_UI_HOST` | Dashboard bind address; default `127.0.0.1` |
| `PACKETCAPTURE_METRICS_UI_PORT` | Dashboard bind port; default `8090` |
| `PACKETCAPTURE_METRICS_UI_SAMPLE_INTERVAL_MS` | How often health state is sampled and a packet sample persisted; default `10000` |
| `PACKETCAPTURE_METRICS_UI_DB_PATH` | Local SQLite file for all persisted state (packet/broker-delivery/reply-lifecycle metrics, the `!lookup` repeater registry); default `data/metrics.sqlite3` |
| `PACKETCAPTURE_METRICS_UI_RETENTION_DAYS` | Days of persisted historical metrics to keep; default `0` (unlimited - watch disk usage) |
| `PACKETCAPTURE_METRICS_UI_MAX_CHART_BUCKETS` | Upper bound on buckets returned per history query (dashboard-only); default `180` |

## Run

```sh
npm start       # normal use
npm run dev     # restarts on file changes
npm test        # run the test suite
npm run lint    # eslint
```

## Unattended startup on Windows

Once `npm start` has been confirmed reliable running in the foreground:

```sh
npm run task:register     # registers a Scheduled Task: runs at logon, restarts on failure
npm run task:unregister   # removes it
```

See `scripts/register-scheduled-task.ps1` for exactly what it configures.
Registering it changes this machine's Windows startup behavior - review
the script before running it.

## Architecture

```text
src/
  config/     centralized, schema-validated configuration (the only place process.env is read)
  logging/    structured JSON logging with automatic secret redaction
  radio/      Companion connection lifecycle: transport (serial/tcp), reconnect/backoff, command queue, clock sync
  packets/    raw radio event -> normalize -> validate -> decode pipeline (every reception is published, no dedup gate - see below)
  mqtt/       broker connections (config-file loader + schema), topic templates, observer status, LetsMesh on-device JWT auth
  bots/       channel bots: channel discovery/creation, message decrypt, trigger matching; the shared reply queue owns send timing and reply-lifecycle metrics
  nodes/      the node/repeater registry `!lookup` reads/writes (advert parsing + verification) - backed by metrics/store.js, not its own in-memory state
  health/     internal health-state snapshot (HTTP-agnostic; src/web/ is its consumer)
  metrics/    the observer's core, always-on SQLite-backed data store (node:sqlite) and its sample-persist-prune loop - not gated by the dashboard flag
  web/        optional live metrics dashboard (plain node:http + SSE) - a *viewer* over metrics/, gated by PACKETCAPTURE_METRICS_UI_ENABLED
  web/client/ the dashboard's own CSS/JS, served as static files (see below) - not inlined, not bundled
```

Engineering conventions (validation, logging, protected boundaries, dependency policy) are in [`AGENTS.md`](AGENTS.md).

## Troubleshooting

- Run with `PACKETCAPTURE_LOG_LEVEL=debug`. The channel bots log exactly why a message didn't get a reply - wrong channel, decrypt/MAC failure, no matching trigger, or too few hops - rather than staying silent.
- The mesh can (and does) deliver the same physical message more than once over different relay paths with different hop counts. The MQTT capture pipeline publishes every one of these deliveries (same `hash`, different `route`/RSSI/SNR) rather than dropping repeats - OkiMesh needs every path an observer heard, not just the first. Bot replies are a separate concern: only one reply is ever sent per logical message, from whichever delivery first satisfies the bot's configured `minHops`, tracked by that bot's own independent deduplicator (never shared with the MQTT pipeline or other bots).
- A message heard with zero hops (sender directly adjacent, no relay needed) is rejected under the default `minHops: 1` - this is intentional, not a bug.

## License

ISC (see `package.json`).
