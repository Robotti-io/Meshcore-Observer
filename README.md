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

ISC; see [LICENSE.txt](LICENSE.txt).
