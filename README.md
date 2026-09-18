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
      { "trigger": "!echo", "response": "🔁 @[{sender}]! {hopCount} hops via {path}" }
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
  health/     internal health-state snapshot (no HTTP endpoint in this version)
```

Engineering conventions (validation, logging, protected boundaries, dependency policy) are in [`AGENTS.md`](AGENTS.md).

## Troubleshooting

- Run with `PACKETCAPTURE_LOG_LEVEL=debug`. The channel bots log exactly why a message didn't get a reply - wrong channel, decrypt/MAC failure, no matching trigger, or too few hops - rather than staying silent.
- A `"dropped duplicate packet"` debug log from `services.packetCapture` is about the general MQTT capture pipeline, not the bots; it doesn't by itself mean a bot failed to reply.
- The mesh can (and does) deliver the same physical message more than once over different relay paths with different hop counts. Only one reply is ever sent per logical message, from whichever delivery first satisfies the bot's configured `minHops`.
- A message heard with zero hops (sender directly adjacent, no relay needed) is rejected under the default `minHops: 1` - this is intentional, not a bug.

## License

ISC (see `package.json`).
