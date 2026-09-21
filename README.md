# MeshCore Observer

A Node.js observer for a Heltec V3 (or compatible) radio running MeshCore
Companion firmware. It connects over USB serial (or TCP, for a
bridged/containerized deployment), captures RF packets, publishes them and
an observer status heartbeat to one or more MQTT brokers, and can run any
number of independently-configured channel bots that reply to trigger
commands on public hashtag channels.

## Requirements

- Node.js 22.12 or newer
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

Configure any number of brokers using numbered slots (`MQTT1`, `MQTT2`, ...).
Each broker connects and reconnects independently - one being down never
affects the others.

```sh
PACKETCAPTURE_MQTT1_ID=okimesh
PACKETCAPTURE_MQTT1_ENABLED=true
PACKETCAPTURE_MQTT1_HOST=mqtt1.okimesh.org
PACKETCAPTURE_MQTT1_PORT=1883
PACKETCAPTURE_MQTT1_TRANSPORT=tcp
PACKETCAPTURE_MQTT1_TLS=false
PACKETCAPTURE_MQTT1_AUTH_METHOD=none
```

`PACKETCAPTURE_MQTTn_AUTH_METHOD` is one of:

- **`none`** - anonymous (e.g. OKI Mesh)
- **`password`** - static `..._USERNAME` / `..._PASSWORD`
- **`token`** - a JWT signed **on the radio itself** (the private key never
  leaves the device) and refreshed automatically before it expires. Used
  for LetsMesh. Set `..._TOKEN_AUDIENCE` and optionally `..._TOKEN_TTL`
  (seconds, default 24h).

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
    "name": "echo",              // a label, used in logs
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
      { "trigger": "!commands", "response": "Available commands: !about, !commands, !echo, !packet, !link" },
      { "trigger": "!packet", "response": "🔗 @[{sender}] - https://map.okimesh.org/#/packets/{hash}"},
      { "trigger": "!link", "response": "🔗 https://github.com/Robotti-io/Meshcore-Observer" }
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

### 3. Metrics UI (optional)

An optional live dashboard shows radio/MQTT/bot status and packet counters,
served over plain HTTP with no server-side dependency. It's off by default.

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
refreshes. The top-row tiles (packets received/published) and the
existing bot status table (enabled/ready/all-time replies sent) remain
live, all-time-since-start counters, unaffected by the duration selector.

| Variable | Purpose |
| --- | --- |
| `PACKETCAPTURE_METRICS_UI_HOST` | Bind address; default `127.0.0.1` |
| `PACKETCAPTURE_METRICS_UI_PORT` | Bind port; default `8090` |
| `PACKETCAPTURE_METRICS_UI_SAMPLE_INTERVAL_MS` | How often the dashboard samples health state and persists a packet sample; default `10000` |
| `PACKETCAPTURE_METRICS_UI_DB_PATH` | Local SQLite file for persisted packet/bot-command metrics; default `data/metrics.sqlite3` |
| `PACKETCAPTURE_METRICS_UI_RETENTION_DAYS` | Days of persisted metrics to keep; default `0` (unlimited - watch disk usage) |
| `PACKETCAPTURE_METRICS_UI_MAX_CHART_BUCKETS` | Upper bound on buckets returned per history query; default `180` |

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
  packets/    raw radio event -> normalize -> validate -> decode -> deduplicate pipeline
  mqtt/       broker connections, topic templates, observer status, LetsMesh on-device JWT auth
  bots/       channel bots: channel discovery/creation, message decrypt, trigger matching, replies
  health/     internal health-state snapshot (HTTP-agnostic; src/web/ is its consumer)
  metrics/    local SQLite-backed persistence for packet/bot-command metrics (node:sqlite)
  web/        optional live metrics dashboard (plain node:http + SSE), gated by PACKETCAPTURE_METRICS_UI_ENABLED
```

Engineering conventions (validation, logging, protected boundaries, dependency policy) are in [`AGENTS.md`](AGENTS.md).

## Troubleshooting

- Run with `PACKETCAPTURE_LOG_LEVEL=debug`. The channel bots log exactly why a message didn't get a reply - wrong channel, decrypt/MAC failure, no matching trigger, or too few hops - rather than staying silent.
- A `"dropped duplicate packet"` debug log from `services.packetCapture` is about the general MQTT capture pipeline, not the bots; it doesn't by itself mean a bot failed to reply.
- The mesh can (and does) deliver the same physical message more than once over different relay paths with different hop counts. Only one reply is ever sent per logical message, from whichever delivery first satisfies the bot's configured `minHops`.
- A message heard with zero hops (sender directly adjacent, no relay needed) is rejected under the default `minHops: 1` - this is intentional, not a bug.

## License

ISC (see `package.json`).
