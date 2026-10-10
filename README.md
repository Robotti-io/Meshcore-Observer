# Robotti MeshCore Observer

![Robotti MeshCore Observer](assets/branding/robotti-meshcore-observer-hero-wordmark.png)

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

## Upgrade from v2.3.x

1. Stop the running observer before updating its files.
2. Preserve your local `.env.local`, `brokers.config.json`, and
   `bots.config.json`; do not replace them with the example files. Back up the
   configured metrics database as well (by default, `data/metrics.sqlite3`).
3. Update the source checkout to the v2.4.0 release tag and install the locked
   dependencies:

   ```sh
   git fetch --tags
   git checkout v2.4.0
   npm ci
   ```

4. Start the observer with `npm start`.

The existing SQLite store applies its pending migrations transactionally at
startup. v2.4.0 does not require replacing existing configuration files.
Password-authenticated brokers may continue using the legacy positional
`PACKETCAPTURE_MQTT<n>_PASSWORD` variables in v2.x; new configurations should
use each broker's stable `auth.passwordEnv` mapping (see the MQTT section).

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
  password itself is never stored in the file. For a stable mapping, set
  `auth.passwordEnv` to the uppercase environment-variable name containing
  the password:

  The broker example includes two password-auth placeholders,
  `mqtt1.example.com` and `mqtt2.example.com`. Their `passwordEnv` selectors
  map to `MQTT1_EXAMPLE_PASSWORD` and `MQTT2_EXAMPLE_PASSWORD` in
  `.env.example`, respectively. Replace the placeholder hosts and usernames
  with your broker's settings and provide real password values through the
  process environment or `.env.local`. The example keeps the passwords out
  of JSON and uses TLS for these password-auth connections. The OKIMesh
  entries are anonymous; MeshMapper and LetsMesh use device-signed tokens.
  If `passwordEnv` is configured, that variable is used exclusively; a
  missing or empty value is a startup error, even if the legacy positional
  variable is set. Multiple brokers may intentionally share one named
  variable. For backward compatibility, `PACKETCAPTURE_MQTT<n>_PASSWORD`
  remains supported when `passwordEnv` is absent, where `<n>` is the
  broker's **1-based position in the array**. This positional mapping is
  legacy and reordering the array changes which broker it applies to; new
  configurations should use `passwordEnv`.
- **`token`** - a MeshCore auth JWT signed **on the radio itself** (the
  private key never leaves the device) and refreshed automatically before
  it expires. The example includes MeshMapper at `mqtt.meshmapper.net` and
  LetsMesh at `mqtt-us-v1.letsmesh.net`, both using device-signed token auth.
  See the [MeshCore-HA setup](https://wiki.meshmapper.net/mqtt-ha/) for the
  MeshMapper connection settings and the [broker overview](https://wiki.meshmapper.net/mqtt-main/)
  for both broker endpoints. Set `auth.audience` (required) and optionally
  `auth.tokenTtlSeconds` (default 24h) in the file. Token auth does not use
  a static password environment variable.

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
      { "trigger": "!commands", "response": "Available commands: !about, !commands, !echo, !packet, !link, !lookup, !stats" },
      { "trigger": "!packet", "response": "🔗 @[{sender}] - https://map.okimesh.org/#/packets/{hash}"},
      { "trigger": "!link", "response": "🔗 https://github.com/Robotti-io/Meshcore-Observer" },
      {
        "trigger": "!lookup",
        "kind": "lookup",
        "foundResponse": "📡 @[{sender}]! {nodePrefix} (heard {lastHeard}) = {name}",
        "notFoundResponse": "❓ @[{sender}]! no repeater with prefix {query} heard in our list of {repeaterCount} repeaters.",
        "ambiguousResponse": "⚠️ @[{sender}]! {matchCount} repeaters match {query}, most recent: {name} - use more hex digits",
        "invalidResponse": "⚠️ @[{sender}]! give at least 1 byte in hex, e.g. !lookup E8"
      },
      {
        "trigger": "!stats",
        "kind": "stats",
        "response": "📊 {range}: {packetsReceived} pkts, {packetsDecoded} decoded, {repliesSent} replies, {repeatersHeard} repeaters",
        "usageResponse": "⚠️ usage: !stats <1h|6h|1d|3d|all>"
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
times the mesh relays it to you. Decrypted command messages must include a
valid `sender:` prefix; messages without one are not matched, even by
commands whose templates do not use `{sender}`. The bot's own senderless
reply rebroadcasts are still checked for repeat confirmation.

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

The lookup action runs when the queued reply is dispatched, after hop and
duplicate checks. The registry result therefore reflects the data available
when the reply is sent, including after a pending reply is recovered on
restart.

#### Observer stats overview (`kind: "stats"`)

A command can opt into range-argument parsing instead of exact matching by
setting `"kind": "stats"`. A `!stats <range>` command reports packet
volume, replies sent, and distinct repeaters heard over a requested
window, drawn from this observer's own persisted metrics history (the same
data the dashboard's charts read from) - not anything published elsewhere
on the mesh:

```text
!stats 1h    -> the last hour
!stats 6h    -> the last 6 hours
!stats 1d    -> the last day
!stats 3d    -> the last 3 days
!stats all   -> since the earliest data still in the store (bounded by
                PACKETCAPTURE_METRICS_UI_RETENTION_DAYS pruning, not since
                this process started)
```

A `"stats"` command needs `response` (the success case) plus
`usageResponse` (missing or unrecognized range - see the `!stats` example
above), and must not set any `"lookup"`-only field. `response` can use
`{range}` (the token as given), `{packetsReceived}`, `{packetsDecoded}`,
`{repliesSent}`, and `{repeatersHeard}`, alongside the placeholders every
command has.

Numbers are computed fresh at the moment the reply actually sends (after
its own turn in the reply queue below), not when the trigger was heard -
so they reflect "now," not a several-seconds-stale snapshot. This command
intentionally does not report the mesh repeat-check counters (see the
dashboard/logs) - those are process-lifetime counters, not
range-filterable history, so they'd be misleading in a windowed summary.

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
| `PACKETCAPTURE_BOT_REPLY_REPEAT_CHECK_MS` | After a reply is sent, wait this long for its rebroadcast before counting it unconfirmed; default `10000` |

The repeat-check window starts after a reply is sent, separately from the
queue TTL above. Set `PACKETCAPTURE_BOT_REPLY_REPEAT_CHECK_MS=0` for an
immediate timeout, which is counted on the next tracker sweep or operation.

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
actual browser, browser layout and interaction behavior is not covered by
automated tests.

Packet activity (the line chart), the packet-types table, the packet-types
pie chart, and a "Bot commands" section (one pie chart + table + total
replies per configured channel bot, counting successful deliveries by
completion time) are all driven by the same duration selector -
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

Bot interaction history also records accepted usage: an eligible command
counts when the shared reply queue successfully persists it after duplicate
filtering. Usage queries use Observer acceptance time; sent, failed, expired,
and cancelled outcomes use completion time. Queue recovery updates the same
interaction ID without adding another use. The existing bot-local duplicate
window remains transient; history does not provide permanent RF deduplication.

Backend usage reads group by original sender name, command, bot, and channel
over `[start, end)` millisecond ranges. Distinct sender names are not verified
people or public keys; channel messages supply no reliable key attribution.
Optional identifier/kind/source evidence remains null for these messages.
Legacy rows without acceptance timestamps are reported as retained unknown
acceptance, outside range counts, rather than inferred from reply completion.
`getEarliestBotAcceptanceAt` reports retained bot coverage independently of
packet samples. Group pages are capped at 200 rows. New sender aggregates and
individual history are not exposed by the existing HTTP dashboard; their
presentation is tracked separately in release issues #35/#36.

Interaction history uses `PACKETCAPTURE_METRICS_UI_RETENTION_DAYS` (default
`0`, unlimited), even with the dashboard disabled. Completed interaction
rows are pruned by completion time strictly before the cutoff; pending rows
are protected. A recently completed interaction can therefore retain an
acceptance older than the configured window. IDs are stable within this
database and are not reused after pruning. Migration 9 preserves existing
records and adds attribution fields and an acceptance-time index; it does
not archive message or reply bodies.

Verified node adverts also persist independently of the dashboard. Inventory
uses each node's full public key, including verified unnamed nodes displayed
as `Unnamed`. It keeps the latest known name when a later advert omits one.
Separate advert history initially covers Companion (`CHAT`) and Repeater
nodes, with the received name/type preserved for each distinct signed payload.
Three fresh adverts from one new key count as three events, one distinct node,
one discovery and two re-hears. Copies along different paths count once.
Observer reception time determines ranges and recency; asynchronous signature
verification cannot move the latest name or timestamps backward.

`queryAdvertTotals`, `queryAdvertTypeTotals` and bounded `queryAdvertNodeCounts`
provide internal `[start, end)` reporting reads. `earliestEventAt` reports the
earliest retained event for the selected type independently of the requested
range. Migration 10 preserves current inventory and existing metrics/bot state;
it does not invent events or direct evidence for legacy nodes. The existing
HTTP dashboard continues to show its current inventory views; new event views
are tracked in #35/#36.

Detailed advert events use shared metrics retention, by first reception time.
History cleanup preserves inventory, first discovery and direct-heard evidence,
and SHA-256 identity fingerprints retained indefinitely by default prevent a
pruned advert's replay from recreating history. This fingerprint ledger stores a 32-byte digest and
an inventory association, with no raw frame or message body. A 20,000-entry
test measured about 43 bytes per fingerprint in SQLite pages (roughly 43 MB
per million); actual size varies with database page usage and node IDs.

For optional space recovery, set
`PACKETCAPTURE_REPEATER_FINGERPRINT_PRUNE_AFTER_DAYS` to whole days of repeater
inactivity (`0` default disables cleanup; accepted range `0`–`36500`). For
example, `7` selects repeaters whose last verified reception was at least seven
days ago, including duplicate receptions as activity. Local maintenance runs
at most daily, even with the dashboard off or MQTT unavailable. It removes
only fingerprints whose detailed events have already expired, and always
protects the original discovery fingerprint. Inventory identities, known
names/types, first/last-heard and direct evidence survive indefinitely. Other
node types are unaffected. Cleanup failure is logged without stopping sampling.
SQLite marks deleted pages reusable; cleanup does not automatically shrink the
database file.

After operator-enabled fingerprint cleanup, a previously pruned non-discovery
advert heard again can become a retained re-hear event. A returning known key
never becomes newly discovered merely because cleanup ran; retained history
still deduplicates its signed payloads. Keep pruning disabled when permanent
cross-pruning event deduplication matters more than reclaiming ledger space.
If shared history retention is also unlimited, fingerprints remain protected
by their retained events and this setting removes nothing.

Local radio observation, SQLite persistence, lookup and internal reporting
reads do not require internet or a successful broker publication. Broker
forwarding is an independent consumer, so connectivity loss cannot stop trusted
local advert collection. The existing dashboard still loads Chart.js from a
CDN, so full browser operation without internet is a remaining dashboard
delivery requirement. The default favors preserving learned information for
offline operation; this feature does not provide a raw-packet archive or the
additional reporting views planned in #35/#36.

`PACKETCAPTURE_DIRECT_HEARD_WINDOW_HOURS` defaults to `72` when omitted and
accepts whole hours from `1` through `8760`. Only a verified zero-hop Repeater
reception refreshes the durable direct timestamp, including a zero-hop copy
of an already recorded advert. Relayed adverts still refresh general activity.
Eligibility expires exactly at the configured window; future evidence is
ineligible until the clock catches up, and restarting never renews its age.
Inventory persistence therefore does not imply continued region-query
eligibility. This release issue provides evidence for #31; it sends no region
queries itself.

Observer process history is also always on. Migration 11 adds a database-local
instance UUID and per-start run UUID without manufacturing legacy run history.
Each run records application/Node versions, platform/architecture, bootstrap
start, last successful alive checkpoint and observed elapsed milliseconds.
It stores no host identity, PID, credentials or configuration dump. A copied
database copies its instance/history; a new database starts a new identity.

Elapsed runtime uses a monotonic clock, including validated bootstrap time.
Wall timestamps label observations; backward timestamps or drift greater than
one second between wall time and monotonic elapsed time flag a discontinuity.
That flag is evidence of uncertainty rather than an inferred exact timeline.
The existing configurable sample interval also checkpoints runs, with no extra
timer, and failures log a warning while preserving the previous checkpoint.
Local run collection continues with the dashboard off and without brokers.

Only successful bounded teardown records a `clean` end (`SIGINT`/`SIGTERM`),
after schedulers/services and pending advert verification finish, before storage
closes. A failed or timed-out teardown does not claim success; the ten-second
shutdown bound remains in effect. On restart, an unclosed run becomes `unclean`
with its end time left null. Its persisted duration is a lower bound, not an
invented death time; downtime between runs is never added.

One active Observer per database is enforced by SQLite exclusive connection
ownership before run recovery. The operating system releases ownership on
process death, without a lease, network coordination or manual stale-lock-file
cleanup. **External SQLite tools/readers require the Observer stopped** before
opening the same file; the optional dashboard uses the owning connection.
If startup encounters a database lock, its error explains the single-Observer
limit and asks you to stop the other instance or close external SQLite
tools/scripts before restarting. It also explains that ownership releases
automatically when the owning process exits.
Keep SQLite on storage that supports its normal local locking/WAL guarantees.
This change does not add an online database backup/export interface.

Internal `queryObserverRuns` pages select bootstrap starts in `[start,end)` with
a 200-row maximum; they do not prorate runtime across uncertain wall-clock
intervals. `queryObserverRuntimeSummary` reports retained observed duration,
earliest retained start, clean/unclean/running counts and lower-bound/clock flags.
It always labels its scope as retained history, never an all-installation
lifetime total. Shared `PACKETCAPTURE_METRICS_UI_RETENTION_DAYS` defaults to
unlimited: clean runs expire by end time, recovered unclean runs by last-known
alive time, strictly before the cutoff. Running runs, instance identity and
parents referenced by retained SQLite foreign-key children survive cleanup.
Process samples/events expire child-first before parent cleanup. Public
run/resource reporting and dashboard integration remain #35/#36.

Process resource history is always on, using the same configurable sample
interval (default 10 seconds, minimum 1 second), even with the dashboard off
or the internet unavailable. Migration 12 adds run-linked `process_samples`
and selected `runtime_events`, with no fabricated legacy measurements.
A process sample and matching run heartbeat commit together; optional
measurement/write failures warn and preserve ordinary packet sampling and
the existing heartbeat fallback. First resource observations, counter resets
and unavailable intervals have null utilization, distinct from measured zero.

CPU user/system deltas use microseconds over actual monotonic elapsed
milliseconds. `cpuPercent = 100 * (userUs + systemUs) / (intervalMs * 1000)`
means one logical CPU: 250,000 microseconds over one second is 25%; concurrent
threads can exceed 100%. This is not a host/container-quota percentage. RSS,
heap total, heap used and external memory are byte gauges. Built-in event-loop
active/idle deltas use milliseconds, and utilization is a fraction from 0 to 1
of time outside the event provider; it is separate from CPU utilization and
does not measure event-loop delay. No delay histogram or extra timer is added.
See [Node CPU/memory measurement](https://nodejs.org/docs/latest-v22.x/api/process.html#processcpuusagepreviousvalue)
and [event-loop utilization](https://nodejs.org/docs/latest-v22.x/api/perf_hooks.html#performanceeventlooputilizationutilization1-utilization2).

Selected event kinds are `radio.connected`, `radio.disconnected`,
`radio.connect-error`, `broker.state` and `bot.readiness`. Radio observations
use hook-reception time (`precision: event`); broker/bot transitions are
observed between consecutive snapshots (`precision: sample`) and carry the
actual monotonic observation window. First snapshots establish a baseline;
stable states do not repeat, and flaps entirely between samples may be missed.
Only configured logical service IDs, enum states and timing are stored;
radio error text, credentials, packet/message bodies and configuration dumps
are excluded.

`PACKETCAPTURE_RUNTIME_EVENT_MAX_PER_MINUTE=60` limits event write attempts
in a sliding monotonic 60-second window across all selected services. The
validated operator override is a whole integer from 1 to 600; the example
and omitted-value fallback both use 60. Failed writes consume the budget.
Suppressed/failed-event counts accompany the next successful process sample
and are acknowledged only after persistence. Orderly shutdown detaches
collectors and flushes a final resource/count sample before service teardown.
Counts are observed lower bounds: abrupt termination or failed final writes
can lose counts not yet persisted. The budget bounds event volume per minute,
not lifetime disk growth; unlimited retention remains the default.

Internal `queryProcessSamples` and `queryRuntimeEvents` pages cap at 200 rows,
with `[start,end)` observation ranges and optional run filters; event pages
also filter by kind/logical service ID. `queryProcessHistory` caps at 1000
buckets, weights CPU/ELU by valid raw counter intervals, reports gauge means
and selected maxima with per-measurement counts, and leaves absent buckets
empty. A bucket spanning multiple runs reports `runCount` and null `runId`;
filter by run for separate histories. No downtime/interpolation or missing
measurement is converted to zero. Shared day-based metrics retention expires
these children by observation time, protecting any still-referenced run.

The `HOST`/`PORT`/`MAX_CHART_BUCKETS` variables below only matter when the
HTTP dashboard itself is enabled; `DB_PATH`/`SAMPLE_INTERVAL_MS`/
`RETENTION_DAYS` are always in effect (they configure the always-on data
store and its sampling loop), regardless of `PACKETCAPTURE_METRICS_UI_ENABLED`.

| Variable | Purpose |
| --- | --- |
| `PACKETCAPTURE_METRICS_UI_HOST` | Dashboard bind address; default `127.0.0.1` |
| `PACKETCAPTURE_METRICS_UI_PORT` | Dashboard bind port; default `8090` |
| `PACKETCAPTURE_METRICS_UI_SAMPLE_INTERVAL_MS` | Health/packet/resource sample and run-checkpoint cadence in milliseconds; default `10000`, minimum `1000` |
| `PACKETCAPTURE_METRICS_UI_DB_PATH` | Local SQLite file for all persisted state, including run/resource/event history and the repeater registry; default `data/metrics.sqlite3` |
| `PACKETCAPTURE_METRICS_UI_RETENTION_DAYS` | Days of persisted historical metrics to keep; default `0` (unlimited - watch disk usage) |
| `PACKETCAPTURE_METRICS_UI_MAX_CHART_BUCKETS` | Upper bound on buckets returned per history query (dashboard-only); default `180` |
| `PACKETCAPTURE_RUNTIME_EVENT_MAX_PER_MINUTE` | Selected local event write attempts in a rolling 60 seconds; whole integer `1`–`600`, default `60`, dashboard-independent |

## Run

```sh
npm start       # normal use
npm run dev     # restarts on file changes
npm test        # one-shot test run
npm run test:watch    # watch tests during development
npm run test:coverage # test suite plus local coverage reports
npm run test:ci       # CI test and coverage run
npm run lint    # eslint
```

Test runs write JUnit results to `artifacts/junit.xml`. Coverage runs also
write HTML, LCOV, JSON, and Cobertura reports under `coverage/`.

Coverage runs enforce minimum repository totals of 72% statements, 71%
branches, 73% functions, and 70% lines. These floors apply to every
`src/**/*.js` file, including browser code. Do not add coverage exclusions just
to improve the totals. Any proposed exclusion or threshold change should
include a code-review rationale grounded in measured coverage and meaningful
behavior tests.

### GitHub Actions

`.github/workflows/ci.yml` runs for pull requests targeting `main` and pushes
to `main`. Its independent lint job runs on Ubuntu with Node 24.x. The test
matrix runs on Ubuntu and Windows with Node 22.x and 24.x; each job runs
`npm ci` followed by `npm run test:ci`.

Each test-matrix job uploads an artifact named
`test-reports-<runner>-node-<version>`, containing the reports produced by
that job:

```text
artifacts/junit.xml
coverage/cobertura-coverage.xml
coverage/lcov.info
coverage/coverage-final.json
coverage/index.html
```

The upload step runs after a failed test or coverage check as well. If setup
fails before report files are created, that job has no report artifact.

Successful and intentionally failing PR runs have both produced their report
artifacts. The checks to require for pull requests targeting `main` are:

- `lint`
- `test (ubuntu-latest, Node 22.x)`
- `test (ubuntu-latest, Node 24.x)`
- `test (windows-latest, Node 22.x)`
- `test (windows-latest, Node 24.x)`

Required-check configuration is still pending. If the runner or Node matrix
changes, update the workflow and this check list together, then confirm every
new OS/Node combination passes before changing branch protection.
This CI workflow validates code; it does not build or deploy containers.

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

### Shared remote-request foundation

The shared coordinator uses the existing Companion connection locally and
requires no internet service. It remains idle unless a producer requests work.
Region discovery is disabled by default and uses the separately configured
opt-in scheduler described below. Telemetry and region MQTT publication remain
separate release features.

Operator overrides and code defaults match `.env.example`. All settings are
whole numbers; an omitted value uses the default, while an explicit blank,
fractional or out-of-range value fails startup before storage, radio or network
effects.

| Setting | Default | Valid range |
| --- | --- | --- |
| `PACKETCAPTURE_REMOTE_REQUEST_ACK_TIMEOUT_MS` | 5000 | 1000–30000 milliseconds |
| `PACKETCAPTURE_REMOTE_REQUEST_RESPONSE_TIMEOUT_MAX_MS` | 30000 | 1000–120000 milliseconds |
| `PACKETCAPTURE_REMOTE_REQUEST_MIN_INTERVAL_MS` | 60000 | 10000–3600000 milliseconds |
| `PACKETCAPTURE_REMOTE_REQUEST_MAX_PER_MINUTE` | 1 | 1–6 attempts per sliding minute |

One aggregate remote request owns its context until a tagged answer or terminal
outcome. Command and shared airtime ownership end after its acknowledgement,
so bot replies, adverts, local commands and existing on-device signing can
proceed while the RF answer is pending. Pending durable replies/adverts take
priority at admission and again at actual dispatch. Busy air can indefinitely
defer background work: the quiet window is a local activity heuristic, not a
channel reservation guarantee. There is no coordinator retry loop or backlog.

The initial request waits one configured interval. Minimum spacing and the
sliding-minute cap both count physical attempts, including errors/timeouts;
deferrals do not count. Reconnect retains the budget and idle time grants no
catch-up burst. Queue waiting and physical-write/ACK waiting have separate ACK
bounds. After Sent, the response bound is the smaller of the configured cap and
the Companion estimate plus 1000ms, with a 1000ms minimum.

Missing/malformed acknowledgements and ambiguous write failures reset only the
captured connection generation, preventing a late acknowledgement from being
assigned to another command. This briefly interrupts capture during reconnect.
Warnings explain the reset; ordinary post-ACK response timeout does not reset
the connection. If transport closure cannot be confirmed within 5000ms, the
application fails closed and reports that the operator must verify closure and
restart Observer. It never opens a competing replacement transport. Shutdown
drains remote ownership before radio/storage teardown under the existing
10-second deadline; failed teardown leaves the run unclosed for recovery rather
than claiming a clean stop.

Results mean a tag-matched answer attributed by the trusted Companion to the
submitted context. The binary envelope provides no full RF sender identity.
Generation guards reject old-session callbacks, and a 32-entry retired-tag map
rejects known recent reuse for response cap plus 60000ms. This bounded process
bookkeeping does not prove cryptographic identity or prevent every RF replay
across restarts/arbitrary delay. Anonymous regions use a fixed adapter over the
installed library's raw-frame transport, a read-only exact-key contact check,
and owned region storage. The coordinator changes no contacts, routes, ACLs or
login behavior.

Deterministic tests cover installed serial/TCP framing with stub drivers, shared
bot/advert/signing/capture work, 1,000 mixed completion/failure cycles and 1,000
busy-air deferrals. They do not certify deployed firmware, hardware or RF
delivery; region fixture acceptance is complete under #31, telemetry activation
remains #34, and hardware/soak validation remains #37.

### Durable region observations

The always-on SQLite store retains normalized region answers and terminal query
outcomes locally, including when the dashboard is disabled or no broker is
configured. This works without internet access. The #31 scheduler can collect
answers locally when explicitly enabled; broker opt-in, MQTT payloads, delivery
policy and CoreScope integration remain #32. Storage settings alone do not
enable discovery, and the dashboard has no region-history view yet.

An answer is an observation from the trusted Companion, associated with the
captured full Observer and target public keys. It is not proof of a repeater's
entire configuration. The bounded parser keeps exact case, whitespace, order,
duplicates and `*`; it accepts a valid empty list as a measured answer. Invalid
UTF-8, embedded control characters and malformed CSV produce no partial answer.
Firmware may omit names that do not fit without signalling completeness, so
completeness is always **unknown**, even for a short or empty list. Raw packet
bodies, request tags and credentials are not stored in this dataset.

Failed or unsupported evaluations stay separate from successful answers and
preserve the previous successful declaration. Operational deferrals and missing
evidence after a crash are not fabricated as physical-send counts or empty
answers. Every successful observation is retained, while one latest snapshot is
selected per Observer/target by original receipt time and stable answer ID.
Older arrivals cannot overwrite a newer snapshot. Conflicting declarations at
the same reporter/target/millisecond remain saved and flagged as ambiguous;
their timestamps are never rewritten to evade downstream deduplication.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PACKETCAPTURE_REGION_ANSWER_FRESHNESS_HOURS` | 72 | Whole hours 1–8760; age labels use original Observer receipt time, independently of direct-advert eligibility or polling cadence |
| `PACKETCAPTURE_METRICS_UI_RETENTION_DAYS` | 0 | Shared history retention; zero keeps history indefinitely, positive whole days prune eligible historical detail |

Code defaults match `.env.example`; an omitted freshness setting uses 72 hours.
Explicit blank, fractional or out-of-range freshness settings fail before
database, hardware or network initialization. Age equal to the freshness window
is stale. Future-dated, clock-anomalous or ambiguous observations do not claim
freshness. The process query high water and saved run last-known-alive evidence
guard wall-clock rollback; the query time itself is not persisted, and run
checkpoints are a retained lower bound. Freshness labels neither trigger RF nor
delete data.

Save-first retention preserves the latest successful snapshot indefinitely,
including old or empty answers, and protects every pending/publishing reference.
Published bookkeeping expires only when its saved result is strictly before
the cutoff. Historical answers expire only when both receipt and terminal times
are older, no latest pointer references them and no publication reference
remains. Source/claim-run foreign keys protect needed older runs. Equality stays
retained. Disabled or removed broker IDs do not purge their pending work.
Retained counts/earliest timestamps are not proof of complete lifetime history.

Internal history pages default to 100 with a strict 200-row maximum and explicit
time ranges/scopes. Per-broker publication storage stages only explicitly
requested destinations (at most 64 distinct IDs of 1–256 characters); the
default stages none. A due claim captures the active owned run and a unique
token. Conditional results cannot resolve a different broker, stale token or
now-ambiguous answer. On owned restart, interrupted publishing rows become
pending with original observation times and prior attempt/result evidence
preserved. A prior acknowledgement can remain unknown: broker acceptance before
local recording may cause an idempotent duplicate retry. `published` records a
QoS 1 broker acknowledgement, **not CoreScope
ingestion or exactly-once delivery**. Claim tokens are absent from history pages.

Monitor the configured database volume: unlimited history, latest snapshots and
long-lived pending work can grow disk usage even when detail retention is set.
The result/fan-out bounds are not a lifetime storage cap. Cleanup makes SQLite
pages reusable and does not promise an automatic reduction in file size. This
shared cleanup is synchronous; the retained-volume fixture measured roughly a
one-second maintenance pause, separately from normal write/read latency.
Deployment storage and retained volume can change that cost. This
feature adds no automatic abandonment, separate database or backup/export
endpoint. Keep the configured database on persistent container storage with
SQLite-compatible local locking; the dashboard flag never gates persistence.

Before an upgrade, stop Observer and all other users of the database, then take
and verify a consistent backup of the closed database. A live WAL may contain
committed data absent from the main file: do not copy only the main file while
the database is active or discard sidecars from an unverified backup. The tests
verify restore from a closed, checkpointed database. Keep the matching
application version and configuration with the backup. Migrations 14, 15 and 16 are
transactional on failure; an application downgrade after a successful upgrade
requires a compatible pre-upgrade backup, not deleting tables or lowering the
schema version manually. Preserve the upgraded database before any restore;
restoring an older backup loses observations recorded after that backup.

Migration 15 adds reporter/target scheduling metadata to this same always-on
store, including while discovery and the dashboard are disabled. The backend
provides bounded candidate pages, pre-send reservations and atomic
answer/retry completion used by the opt-in runtime scheduler. A reservation
saves permission and a conservative cooldown before a
send can be allowed. It is not evidence of transmitted RF or a successful
reply, and restart never replays it or invents a terminal result.

Scheduling rows and their needed source-run references survive shared history
pruning and remain indefinitely per reporter/target pair. A new Companion key
uses its own schedule. Refresh/retry overrides can extend deadlines, but
shortened intervals or raised attempt limits cannot accelerate a saved
cooldown. Lowered limits can stop an active cycle. Clock rollback pauses new
reservations until agreement with durable observation time; captured result
timestamps remain unchanged. Long outages, forward clock jumps and retained
per-pair state can affect availability and capacity. Monitor the persistent
volume and preserve a verified closed backup before the first upgraded start.

The producer is constructed only with `PACKETCAPTURE_REGION_DISCOVERY_ENABLED=true`;
the omitted default is false. Code defaults and `.env.example` agree. An omitted
setting uses its default; explicit blank, fractional or out-of-range values
fail startup before opening storage, radio or network services, even when
discovery is disabled. Retry base must not exceed its maximum.

| Setting | Default | Valid range / role |
| --- | --- | --- |
| `PACKETCAPTURE_REGION_DISCOVERY_ENABLED` | false | true/false; explicit opt-in |
| `PACKETCAPTURE_REGION_QUERY_REFRESH_HOURS` | 24 | Whole hours 1–8760; minimum target refresh and exhausted/unsupported cycle cooldown |
| `PACKETCAPTURE_REGION_QUERY_RETRY_BASE_MINUTES` | 15 | Whole minutes 3–1440; initial retry and known contact deferral |
| `PACKETCAPTURE_REGION_QUERY_RETRY_MAX_HOURS` | 6 | Whole hours 1–168; exponential retry ceiling including positive jitter |
| `PACKETCAPTURE_REGION_QUERY_MAX_ATTEMPTS` | 3 | Whole 1–10; conservative pre-send reservations per cycle, including slots unused after a race/crash |
| `PACKETCAPTURE_REGION_QUERY_TICK_INTERVAL_MS` | 10000 | Whole milliseconds 1000–60000; wait after one completed producer pass |
| `PACKETCAPTURE_REGION_QUERY_STARTUP_DELAY_MS` | 60000 | Whole milliseconds 10000–3600000; initial producer wait |
| `PACKETCAPTURE_REGION_QUERY_PREFLIGHT_TIMEOUT_MS` | 5000 | Whole milliseconds 1000–30000; exact-key local contact-read deadline |
| `PACKETCAPTURE_DIRECT_HEARD_WINDOW_HOURS` | 72 | Whole hours 1–8760; verified zero-hop advert reception eligibility |
| `PACKETCAPTURE_REGION_ANSWER_FRESHNESS_HOURS` | 72 | Whole hours 1–8760; stored answer age label, independent of eligibility and refresh |

It uses one unreferenced timer and one in-progress operation, selecting one
target from a bounded 100-key page per pass. It advances after that selected
full key and uses an empty pass to wrap, with no queued catalog or catch-up
burst. Pending bot replies/adverts, quiet-air checks and shared remote limits
still govern actual dispatch. The dashboard and brokers need not be enabled.

Admission and dispatch both require a current verified repeater with original
zero-hop reception within `PACKETCAPTURE_DIRECT_HEARD_WINDOW_HOURS` (72 hours by
default), expiring at equality. The Companion must already contain the exact
key with a zero-length outbound path. Missing/unsafe contacts receive a saved
base-retry delay without RF or a terminal outcome. Unsupported or uncertain
local contact reads pause discovery on the captured generation; uncertain
reads trigger the coordinator's explained reset. A new ready generation can
reconsider work without resetting saved cooldowns or global RF budgets.

Original dispatch and matching binary receipt times accompany terminal data.
Wall-clock rollback pauses new RF against durable high water and a whole-second
monotonic elapsed lower bound; saved observations retain millisecond wall times
and explicit anomaly flags. Successful empty/nonempty answers refresh normally;
malformed responses/timeouts preserve prior latest answers and use bounded
retry policy. A command-level unsupported error has its own refresh cooldown.
Safe successful answers stage delivery records atomically for enabled brokers
that explicitly opt into region publication (see below). Clock-anomalous or
conflicting observations stay saved locally without speculative publication.

If final persistence fails, discovery pauses with one unsaved result and
retries only that local write on subsequent ticks. Its original times and saved
cooldown remain intact. Shutdown first stops admission, cancels/drains remote
ownership, then drains result persistence before radio/run/store teardown.
An unsaved result or unvalidated completion prevents a clean run end; the
existing 10-second shutdown bound still applies. Fixed warnings explain these
conditions without including raw frames, contact data or credentials.

#### Region discovery prerequisites and operation

Before enabling discovery, verify the following for the intended deployment:

1. Node >=22.13.0 and the always-on SQLite store are available on persistent
   storage. Preserve a verified closed-database backup before upgrading to
   migration 15, using the backup procedure above.
2. The installed library's serial/TCP raw-frame transport and deployed
   Companion support exact-key contact read command 30 and anonymous request
   command 57. The adapter is tested against the pinned 148-byte Contact layout
   with a 64-byte path field. The repeater must support anonymous region
   requests. Library PR #44, a firmware build date or a version string alone
   does not establish these deployed capabilities; no dependency upgrade is
   required by this adapter.
3. Operator-managed Companion contacts already contain each full target key
   with a zero-length outbound path. Observer does not create, edit, evict or
   restore contacts, change routing, log in, or fall back to a flood request.
   Command 57 itself can create a missing contact in firmware, so the preceding
   read cannot eliminate a race with another client deleting/changing contacts.
   Coordinate access to the Companion; host preflight is not a firmware lock.
4. Each target has a signature-verified REPEATER advert received locally with
   zero recorded hops within the configured direct window. A name, general
   registry presence, relayed advert or passive proximity path is insufficient.
   Unnamed/renamed repeaters remain keyed by their full public key.
5. Set `PACKETCAPTURE_REGION_DISCOVERY_ENABLED=true` in the runtime
   configuration when ready to collect. Other settings can be omitted for the
   defaults above. Local development uses `.env.local`; containers receive
   environment configuration through the existing startup process. Discovery
   requires neither the dashboard nor broker/internet availability.

At defaults, collection waits at least the 60-second startup delay and shared
60-second initial spacing; one physical attempt/minute and foreground/quiet-air
checks limit the whole radio. Refresh is a minimum per-target interval, not a
fleet freshness guarantee. A large fleet or sustained foreground traffic can
take hours to cover. Failures use base × 2^(cycle reservation−1), plus positive
0–10% jitter capped at the retry maximum; exhausted cycles wait one refresh
interval. Changing settings never shortens an already saved cooldown.

Answers/outcomes are saved locally with original reporter/target/run/request
identity. Empty means a measured empty reply; unknown means no measured answer.
Completeness remains unknown, including for short/empty lists. The current
dashboard has no region-history view. Optional CoreScope publication follows
the per-broker settings below and preserves those saved observation semantics.

| Symptom / fixed outcome | Meaning and operator action |
| --- | --- |
| No requests after startup | Check opt-in, current verified zero-hop evidence, existing exact-key direct contact, and shared foreground/quiet/rate limits. Do not infer a fault from registry presence alone. |
| `contact-missing`, `unsafe-route`, `preflight-failed` | Known non-RF deferral; the base delay is saved and no terminal answer/attempt is fabricated. Inspect the operator-managed contact/route or Companion error. Observer will not refill a full table or evict contacts. |
| `preflight-unsupported` | The captured Companion generation cannot perform the local read. Discovery pauses on that generation, preserving state; verify deployed capability before reconnecting/restarting to reconsider it. |
| Contact read timed out / unfamiliar or malformed response | Ownership is uncertain. The fixed warning explains a targeted connection reset and possible capture pause. Check the Companion/transport/layout and preflight timeout; disable discovery and restart if repeated resets disrupt operation. No RF permission was granted by that failed read. |
| `unsupported` terminal outcome | The anonymous command returned an explicit unsupported error; the target waits one refresh interval. Verify deployed support. |
| `response-timeout` | Silence is a failed attempt, not proof of unsupported firmware. Prior latest is retained and retry policy applies; no credentials or flood fallback are attempted. |
| `route-mismatch` | Companion Sent reported an unexpected flood route. The physical attempt cannot be undone; prior latest is retained. Review the saved route/external-client race before further collection. |
| Region result could not be saved | One original result is retained for local write retry and new discovery is paused. Check storage availability/capacity. A failed final drain cannot mark the run clean; abrupt exit can lose that unsaved result while retaining its pre-saved cooldown. |
| Reservation has no validated completion | Discovery fails closed and clean shutdown remains unconfirmed. Inspect the fixed warning and the supported completion contract; a saved reservation is not evidence of delivery. |
| Clock agreement paused / future or anomalous answer | Correct/verify the host clock. Do not delete scheduling data to force a retry. Original evidence and conservative deadlines remain saved; resumed RF waits for clock agreement and eligibility. |

Complete offline fixture acceptance covers startup, disabled behavior,
empty/nonempty/malformed/timeout/unsupported/route mismatch, missing/full/unsafe
contacts, real signed adverts, mixed bot/advert/signing/capture work and five
crash boundaries. Restart preserves original answers and cooldowns without
replaying saved reservations or inventing missing replies. Live radio,
firmware/deployment and representative-load soak validation remain separately
scoped to [#37](https://github.com/Robotti-io/Meshcore-Observer/issues/37).

Offline fixtures exercise migration, empty/latest/pending state, pruning,
clean/abrupt restart and closed-backup restore. The retained-volume regression
uses 20,000 answers, 20,000 terminal failures and two-broker state. Normal
two-broker synchronous write p95 must remain below 10ms and bounded reads below
100ms; maximum-64 fan-out, claims, pruning and disk growth are reported separately.
These local fixture targets are regression checks, not deployment latency or
live firmware/RF/CoreScope guarantees. Release hardware and soak validation
remain #37.

### Passive topology evidence

The always-on local store records supported header paths from traffic already
received, independently of the dashboard and internet access. Flood paths
describe observed relays: `AC01 → 9905 → E85C → Observer` gives distances
3, 2 and 1. Direct paths contain remaining forwarding instructions and have
no proximity distance. TRACE, unsupported formats and malformed paths are
excluded; empty paths have a separate no-relay coverage count. No discovery
traffic, contact updates, reverse routes, raw frames or message bodies are
introduced by this feature.

Compact entries are leading public-key bytes. Resolution uses all current
inventory identities before checking repeater type. Unknown entries stay
unknown; collisions select no target, and repeated-prefix paths are excluded
from automatic proximity. A unique local match remains an unverified prefix
association. Observed proximity never proves outbound routing or reachability.
Later telemetry dispatch must recheck freshness, identity, radius, contacts,
routing and backoff. Replacing the Observer radio does not transfer another
radio's proximity evidence.

Configuration defaults are also in `.env.example` and central code:

| Setting | Default | Valid whole units / effect |
| --- | --- | --- |
| `PACKETCAPTURE_TOPOLOGY_FRESHNESS_HOURS` | 72 | 1–8760 hours; separate from direct-advert freshness |
| `PACKETCAPTURE_TOPOLOGY_MAX_OBSERVATIONS_PER_MINUTE` | 600 | 1–6000 write attempts per rolling monotonic minute, including failed attempts |
| `PACKETCAPTURE_TOPOLOGY_PRUNE_AFTER_DAYS` | 0 | 0–36500 days; 0 disables inactive path catalog pruning |

Each successfully stored physical reception adds one count, including repeated
copies. This measures receptions, not distinct messages or successful routes.
Admission suppression never refreshes a path. Coverage records separately
count accepted, suppressed, failed, malformed, unsupported and no-relay
observations on the existing sampler cadence, with a final flush after listener
detachment. These counts describe the decoded packet consumer; frames rejected
earlier in capture are outside its coverage. An unknown Observer identity,
abrupt death or failed final coverage write can leave gaps, so coverage is a
lower bound. Failed coverage writes keep counters pending for retry.

Expiry at the freshness boundary excludes candidates while retaining history;
future evidence is ineligible. Queries guard against wall-clock rollback using
their high water and retained run/coverage clocks. Restart preserves original
reception times. The route summary's cumulative persisted count survives
detail pruning; selected `[start,end)` counts use retained reception records
and cannot reconstruct expired details. Internal pages cap at 200, path views
at 63 positions, and candidates at three alternate path references. Public
reporting and dashboard presentation are separate release features.

Reception detail and coverage use `PACKETCAPTURE_METRICS_UI_RETENTION_DAYS`
(0/unlimited by default). Path summaries/hops remain indefinitely unless
inactive-path pruning is explicitly enabled. Cleanup removes a path only after
its last reception reaches the configured age and no retained detail refers
to it; inventory and other evidence survive. Unlimited detail retention
normally prevents catalog deletion. Purged routes start new route history if
heard again. Cleanup makes SQLite pages reusable without automatically
shrinking the file. Rate, path and result bounds are **not a lifetime disk
ceiling**; monitor disk usage under unlimited retention.

The local topology cost fixture uses 20,000 paths, 100,000 reception details and
4,000 identities. Its write p95 target is below 10ms; ordinary read targets are
below 100ms. Proximity reads have a separately approved 150ms p95 target after
coverage runs measured 115–124ms against the original 100ms target. The latest
complete coverage run measured 83.275ms. These fixture targets are regression
checks, not a universal deployment latency guarantee; indexes, result bounds
and all other performance/coverage checks remain enforced.

For development workflow, see [CONTRIBUTING.md](CONTRIBUTING.md). For the
current architecture and configuration contract, this README and the source
are authoritative; `docs/project_plan.spec.md` is the original replacement
plan and is retained as historical context.

```text
src/
  config/     centralized, schema-validated configuration (the only place process.env is read)
  logging/    structured JSON logging with automatic secret redaction
  radio/      Companion connection lifecycle: transport (serial/tcp), reconnect/backoff, command queue, clock sync
  packets/    raw radio event -> normalize -> validate -> decode pipeline (every reception is published, no dedup gate - see below)
  mqtt/       broker connections (config-file loader + schema), topic templates, observer status, LetsMesh on-device JWT auth
  bots/       channel bots: channel discovery/creation, message decrypt, trigger matching; the shared reply queue owns send timing and reply-lifecycle metrics
  nodes/      the node/repeater registry `!lookup` reads/writes (advert parsing + verification) - backed by metrics/store.js, not its own in-memory state
  regions/    strict bounded region-body parsing and normalized internal contracts; durable state uses metrics/
  health/     internal health-state snapshot (HTTP-agnostic; src/web/ is its consumer)
  metrics/    the observer's core, always-on SQLite-backed data store (node:sqlite) and its sample-persist-prune loop - not gated by the dashboard flag
  web/        optional live metrics dashboard (plain node:http + SSE) - a *viewer* over metrics/, gated by PACKETCAPTURE_METRICS_UI_ENABLED
  web/client/ the dashboard's own CSS/JS, served as static files (see below) - not inlined, not bundled
```

Engineering conventions (validation, logging, protected boundaries, dependency policy) are in [`AGENTS.md`](AGENTS.md).

### Optional CoreScope region publication

Region publication is independently disabled by default on every broker. Set
`regionPublication.enabled: true` in that broker's JSON definition only after
verifying its CoreScope compatibility and client-topic permissions. The broker
itself must also be enabled. At most 64 destinations are supported; keep IDs
stable. A different logical destination should use a new ID, since an ID owns
its saved delivery history. Omitted fields use the same defaults as the example:

| Per-broker setting | Default | Allowed override |
| --- | --- | --- |
| `enabled` | `false` | Boolean |
| `tickIntervalMs` | `10000` | Whole milliseconds, 1000–60000 |
| `publishTimeoutMs` | `5000` | Whole milliseconds, 1000–5000 |
| `retryBaseMs` | `60000` | Whole milliseconds, 1000–86400000 |
| `retryMaxMs` | `3600000` | Whole milliseconds, 1000–604800000; at least the base |

Invalid explicit settings fail startup before the store, hardware or network
opens, including when publication is disabled. Region messages always use
QoS 1 and `retain:false`, independently of packet/status broker settings.

The topic is `meshcore/client/{lowercase reporting Companion key}/regions`.
Its strict payload includes `type:"REGIONS"`, the original answer-receipt ISO
timestamp with milliseconds, a lowercase full target key, unchanged region
names (case/order/duplicates/`*`), `truncated:true` and optional
`repeater_clock`. Remote clock zero is preserved; null is omitted. The
conservative truncation hint means completeness is unknown, including for
short or empty lists. It does not assert that omissions were detected.
There is no GPS, reception coverage, RF sample or observer `/neighbors` object.

New safe answers and delivery records commit together before publication.
When later enabled, each broker backfills the latest safe retained observation
for each target, in pages of 20 headers. Earlier unstaged history remains local;
this is not a bulk history export. Older pending deliveries remain preserved.
Fresh direct-heard eligibility is required for RF queries, not for publication
of an already saved observation. Discovery and the dashboard can remain off.
The worker requires the current ready Companion to match the original reporter;
another Companion never relabels history. Future-dated, clock-anomalous or
ambiguous observations remain local. Opt-out/removal preserves pending rows.

Each broker has one in-flight job. Offline brokers accumulate durable pending
work without counting transport attempts. Failures retry with capped exponential
backoff and original content/time. An acknowledgement timeout retires that
broker's MQTT client, discards its old outgoing queue and reconnects after five
seconds through existing credentials/will configuration. That broker's packet
and status delivery pauses during recovery; local capture and other brokers
continue. A fixed warning explains retry and directs operators to verify client
ACL permissions and broker availability. A failed local delivery-result save
pauses that worker, retries the save only, and prevents a clean-shutdown claim.

`published` means broker PUBACK, not verified CoreScope ingestion. Crash between
broker acceptance and local commit can resend an identical observation.
Compatible CoreScope deduplicates by reporter, target and original observation
time and orders latest by that time rather than upload time. Live compatibility
and permissions must be verified for the actual deployed ingestor.

CoreScope requires `clientRegions.enabled:true`, an ACL binding each reporting
Companion to its own lowercase client topic, and subscription coverage for
`meshcore/client/+/regions` (the default `meshcore/#` covers it). Existing
observer-feed permissions do not grant this client permission. No broker/ACL or
CoreScope deployment is changed by installing this feature. Validate an actual
named-device answer reaching the authorized CoreScope deployment under the
separate [#37 release validation](https://github.com/Robotti-io/Meshcore-Observer/issues/37).
Contract reference: [CoreScope client regions](https://github.com/OKI-Mesh/CoreScope/blob/6cab7d698d15f739dcaa0f04df70eaa80f5d13da/docs/client-regions.md).

### Telemetry validation, decoding, storage and freshness (#33 T1–T5)

`PACKETCAPTURE_TELEMETRY_FRESHNESS_HOURS` defaults to **72** when omitted,
matching `.env.example`. Overrides must be whole hours from **1 to 8760**;
explicit empty or invalid values stop startup with a configuration error.
This setting controls the interpretation of saved observation age and
does not enable collection or change polling cadence, region freshness or pruning.

The internal contracts preserve supported status fields, signed sensor values,
remote-reported neighbour pages, original request context and explicit partial
or unavailable data. They do not derive battery percentages or certify complete
sensor/mesh inventory. T1 provides validation/configuration, T2 pure response
decoders, T3 owned telemetry persistence and T4 bounded internal reads; #34 owns
polling. A truncated known field rejects the entire response;
unknown types/profiles retain only clearly partial supported data. No parser
activates collection, stores GPS values or infers a layout from padded length.
See the [internal contract guide](docs/plans/v2.5.0/telemetry-contracts.md).

On next startup the existing always-on store applies migration **16**, including
when the dashboard is disabled. It adds three telemetry tables and indexes,
preserves existing data and creates no samples until a future authorized
producer submits them. Saves are atomic and require the active owned run;
failure/unsupported outcomes preserve earlier useful data. Shared history
retention protects both latest useful and latest decoded observations and their
source runs, even if stale or older than the configured history duration.

Internal latest reads keep useful and fully decoded snapshots separate, each
with its original measurement time and freshness. Newer partial replies never
refresh older decoded measurements, and a failed poll can coexist with stale
saved data. History uses explicit receipt/completion ranges and pages of at most
200 records. Counts describe retained evidence, not complete lifetime coverage.
Clock rollback, future timestamps and ambiguous observations cannot silently
renew freshness. These reads add no public endpoint or telemetry poller;
integrated telemetry lifecycle/backup acceptance is verified under #33 T5.

Offline fixture acceptance covers schema 13/14/15 upgrades, clean/abrupt
restart, a verified closed-database backup restore and dashboard-disabled
retention using the ordinary sampler. Original request/run/instance identities,
measurement times, supported units, partial/empty/failure evidence and both
snapshots survive. Explicit invalid configuration, storage/migration failure
and competing ownership stop startup before hardware/network work. The
[contract guide](docs/plans/v2.5.0/telemetry-contracts.md#offline-operation-upgrade-and-recovery-33-t5)
explains upgrade/recovery and retained-history limits. Keep a verified closed
backup before migration 16; use the existing backup procedure above. These
source-derived synthetic fixtures do not activate telemetry polling or replace
#37's deployed-device/RF verification.

## Troubleshooting

- Run with `PACKETCAPTURE_LOG_LEVEL=debug`. The channel bots log exactly why a message didn't get a reply - wrong channel, decrypt/MAC failure, no matching trigger, or too few hops - rather than staying silent.
- The mesh can (and does) deliver the same physical message more than once over different relay paths with different hop counts. The MQTT capture pipeline publishes every one of these deliveries (same `hash`, different `route`/RSSI/SNR) rather than dropping repeats - OkiMesh needs every path an observer heard, not just the first. Bot replies are a separate concern: only one reply is ever sent per logical message, from whichever delivery first satisfies the bot's configured `minHops`, tracked by that bot's own independent deduplicator (never shared with the MQTT pipeline or other bots).
- A message heard with zero hops (sender directly adjacent, no relay needed) is rejected under the default `minHops: 1` - this is intentional, not a bug.

## License

ISC; see [LICENSE.txt](LICENSE.txt).
