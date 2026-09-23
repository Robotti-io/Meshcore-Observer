# MeshCore Observer JS

## Implementation Plan and Specification

**Status:** Proposed
**Target:** Greenfield replacement for the customized Python `meshcore-packet-capture` observer
**Primary runtime:** Node.js on Windows with a USB-connected Heltec V3
**Language:** JavaScript only
**Module system:** ES modules
**Primary local radio transport:** Serial / COM port
**Future deployment target:** Containerized internal Kubernetes environment using a transport that does not assume direct desktop COM-port access

---

## 1. Purpose

Build a maintainable JavaScript MeshCore observer that replaces the current customized Python installation while preserving the behavior that is currently useful:

* Connect to a Heltec V3 running MeshCore Companion firmware over USB serial.
* Recover automatically when the radio is unavailable or not ready during Windows startup.
* Capture MeshCore RF packet events.
* Preserve useful packet metadata including route, packet type, path, RSSI, SNR, raw packet data, and packet hash.
* Publish observer status and captured packets to multiple MQTT brokers.
* Support LetsMesh using authenticated MQTT over WebSockets/TLS.
* Support OKI Mesh using MQTT over TCP.
* Operate a `#echo` channel bot.
* Remain modular enough to run against a TCP-connected Companion device in a containerized environment later.
* Follow the repository engineering constitution and Robotti developer-agent workflow.

The new implementation is a clean JavaScript application. It is **not** a line-by-line translation of the Python application.

---

## 2. Governing Engineering Rules

`AGENTS.md` is authoritative.

The project must use JavaScript only. Python and TypeScript are prohibited. ES modules and module-oriented design are preferred.

Inbound structured data crossing a trust boundary must be validated with centralized strict JSON Schema using AJV before business logic executes. Schemas should default to `additionalProperties: false`.

Configuration, validation, logging, and error handling must remain centralized. Feature modules must not scatter direct `process.env` access throughout the codebase.

Repository-defined npm scripts are the primary execution interface. The agent must inspect `package.json` before running workflows and prefer `npm run ...` over ad-hoc platform-specific commands.

The application must remain capable of containerized deployment into the internal Kubernetes environment. Runtime configuration must remain environment-driven and the implementation must avoid unnecessary host-specific coupling.

Behavior changes should be test-backed. Changes must remain small and reviewable, and protected boundaries such as authentication, logging contracts, public APIs, dependencies, storage, and deployment require human approval.

The Robotti development workflow requires preserving established seams, making small auditable changes, using straightforward JavaScript, and surfacing risky ambiguity instead of guessing.

The coding agent must implement one approved task at a time and report drift or blockers rather than silently expanding scope.

---

## 3. Human Approval Gates

Before implementation, distinguish already approved architectural direction from decisions that still require approval.

### Already approved

* Replace the customized Python application with Node.js.
* Use JavaScript, not TypeScript.
* Preserve observer behavior.
* Preserve and improve the `#echo` bot.
* Support the current Windows + USB Heltec V3 installation.
* Design for later containerized operation.

### Approval required before adding

Proposed runtime dependencies:

* `@liamcottle/meshcore.js`
* `mqtt`
* `ajv`

`@liamcottle/meshcore.js` is the official JavaScript-oriented MeshCore client and supports Node.js Companion connections over both USB serial through `NodeJSSerialConnection` and TCP through `TCPConnection`.

MQTT.js supports Node.js MQTT connections over TCP/TLS and WebSockets/WSS and includes reconnect facilities appropriate for both OKI and LetsMesh.

AJV is required by the repository constitution.

Avoid additional runtime dependencies until a concrete need is demonstrated.

In particular:

* Do not add Express merely for a health endpoint.
* Do not add a logging framework unless required by the existing centralized logging infrastructure.
* Do not add a second MeshCore packet-decoding library until the existing protocol/client APIs have been evaluated.
* Do not add persistence/database dependencies in v1.

---

## 4. Current Behavioral Baseline

The current Python implementation is the compatibility reference, not the architectural reference.

The current deployment uses:

```text
Radio:
  Heltec V3
  MeshCore Companion firmware
  Serial port: COM3

Region:
  CVG

Broker 1:
  LetsMesh
  mqtt-us-v1.letsmesh.net
  Port 443
  WebSockets
  TLS
  MeshCore/JWT authentication

Broker 2:
  OKI Mesh
  mqtt1.okimesh.org
  Port 1883
  TCP
  No TLS
  Anonymous authentication

Topics:
  meshcore/{IATA}/{PUBLIC_KEY}/status
  meshcore/{IATA}/{PUBLIC_KEY}/packets

Echo bot:
  Enabled
  Channel: #echo
  Triggers:
    !echo
    !test
    !spam
    !yolo
  Minimum hops: 1
```

The current echo response format is:

```text
🔁 @[sender]! {hopCount} hops via {formattedPath}
```

The replacement should preserve this externally visible behavior unless explicitly changed by the owner.

---

## 5. Non-Goals for Version 1

Do not add the following during the initial replacement:

* Web UI.
* General-purpose REST API.
* Administrative HTTP API.
* Database or other durable application storage.
* BLE support.
* Automatic firmware flashing.
* Multi-radio orchestration.
* Generic chatbot functionality.
* New public APIs.
* Automatic updates from upstream repositories.
* Kubernetes manifests or GitLab pipeline changes without explicit approval.
* Private-key extraction from the radio.

The goal is first to replace the existing observer reliably.

---

## 6. Proposed Repository Layout

```text
meshcore-observer/
├── AGENTS.md
├── IMPLEMENTATION_SPEC.md
├── package.json
├── package-lock.json
├── .gitignore
├── .env.example
│
├── src/
│   ├── index.js
│   │
│   ├── config/
│   │   ├── index.js
│   │   └── schema.js
│   │
│   ├── logging/
│   │   └── logger.js
│   │
│   ├── radio/
│   │   ├── radio-manager.js
│   │   ├── command-queue.js
│   │   └── transports/
│   │       ├── serial-transport.js
│   │       └── tcp-transport.js
│   │
│   ├── packets/
│   │   ├── packet-normalizer.js
│   │   ├── packet-decoder.js
│   │   ├── packet-deduplicator.js
│   │   └── schemas.js
│   │
│   ├── mqtt/
│   │   ├── mqtt-manager.js
│   │   ├── mqtt-broker.js
│   │   ├── topic-resolver.js
│   │   ├── letsmesh-auth.js
│   │   └── schemas.js
│   │
│   ├── bots/
│   │   ├── echo-bot.js
│   │   └── schemas.js
│   │
│   └── health/
│       └── service-health.js
│
└── test/
    ├── fixtures/
    ├── config/
    ├── radio/
    ├── packets/
    ├── mqtt/
    └── bots/
```

Do not create modules merely to satisfy this diagram. If a proposed module has no meaningful responsibility yet, omit it until needed.

---

## 7. Architectural Seams

### 7.1 Entrypoint

`src/index.js` owns only process-level orchestration.

Responsibilities:

* Load validated configuration.
* Initialize logging.
* Construct major services.
* Register graceful shutdown handlers.
* Start the radio manager.
* Start MQTT publishing.
* Start enabled bot modules.
* Coordinate shutdown.

It must not contain packet parsing, MQTT implementation details, or bot business logic.

---

### 7.2 Configuration

All configuration must be read in `src/config/index.js`.

Feature code must receive configuration through constructor/function arguments and must not directly read `process.env`.

For compatibility, version 1 should retain existing `PACKETCAPTURE_*` environment names where practical.

This allows migration using the current `.env.local` without unnecessarily changing configuration at the same time as the runtime.

Example supported variables:

```text
PACKETCAPTURE_CONNECTION_TYPE
PACKETCAPTURE_SERIAL_PORTS
PACKETCAPTURE_TCP_HOST
PACKETCAPTURE_TCP_PORT

PACKETCAPTURE_IATA
PACKETCAPTURE_OWNER_EMAIL

PACKETCAPTURE_BROKERS_CONFIG_FILE
PACKETCAPTURE_MQTT1_PASSWORD (etc - see src/config/index.js's readBrokers)

PACKETCAPTURE_TEST_BOT_ENABLED
PACKETCAPTURE_TEST_BOT_CHANNEL
PACKETCAPTURE_TEST_BOT_TRIGGERS
PACKETCAPTURE_TEST_BOT_MIN_HOPS

PACKETCAPTURE_MAX_CONNECTION_RETRIES
PACKETCAPTURE_CONNECTION_RETRY_DELAY
```

Build one normalized internal configuration object.

Validate it before constructing services.

Example internal shape:

```js
{
  radio: {
    type: "serial",
    serialPorts: ["COM3"],
    reconnect: {
      maxRetries: 0,
      initialDelayMs: 3000,
      maxDelayMs: 15000
    }
  },

  observer: {
    iata: "CVG",
    ownerEmail: "..."
  },

  brokers: [
    {
      id: "letsmesh",
      enabled: true,
      ...
    },
    {
      id: "okimesh",
      enabled: true,
      ...
    }
  ],

  echoBot: {
    enabled: true,
    channel: "#echo",
    triggers: ["!echo", "!test", "!spam", "!yolo"],
    minHops: 1
  }
}
```

Configuration errors must terminate startup with a useful error before hardware or network side effects occur.

---

## 8. Logging Contract

Use structured logs with stable logical `source` values.

Suggested sources:

```text
app.bootstrap
services.radio
services.radio.serial
services.radio.commands
services.packetCapture
services.mqtt
services.mqtt.letsmesh
services.mqtt.okimesh
bots.echo
```

Standalone service logs must not invent `reqInfo.requestID`.

No HTTP endpoint exists in v1, so HTTP request logging requirements do not apply yet.

The implementation must never log:

* JWTs.
* MQTT passwords.
* private keys.
* bearer tokens.
* session/authentication secrets.
* raw secret channel keys.

This is especially important because the current Python debug mode can emit the complete LetsMesh JWT. The replacement must explicitly redact it. The repository constitution prohibits logging bearer tokens and related secrets.

Debug logging may report:

```text
JWT generated successfully
JWT expires at ...
JWT audience ...
```

but never the JWT itself.

---

## 9. Radio Transport

Create a transport seam even though serial is the first implementation.

Conceptually:

```text
RadioManager
    |
    +-- SerialTransport
    |
    +-- TCPTransport
```

The application must not let higher-level features know whether the Companion radio is on COM3 or behind TCP.

The official MeshCore JavaScript library already exposes Node serial and TCP connection mechanisms, so these adapters should remain thin.

### Serial requirements

Initial Windows target:

```text
COM3
```

but no production source file may hardcode it.

Startup must tolerate Windows exposing the serial device before the Heltec Companion interface is fully responsive.

Required behavior:

```text
open serial
    |
    v
attempt Companion handshake
    |
    +-- success --> running
    |
    +-- failure --> close transport
                     |
                     v
                  wait/backoff
                     |
                     v
                    retry
```

By default, `maxRetries = 0` should mean unlimited retries.

A radio unavailable during Windows startup must not require manually starting the program twice.

---

## 10. Radio Manager

`RadioManager` owns the lifecycle of the MeshCore connection.

Responsibilities:

* Establish transport.
* Perform Companion startup handshake.
* Obtain self/device information.
* Expose device public key and name.
* Expose radio settings.
* Detect disconnection.
* Reconnect automatically.
* Re-run required setup after reconnection.
* Emit normalized application events.
* Shut down cleanly.

The manager should expose application-level events such as:

```text
radio.connected
radio.disconnected
radio.packet
radio.channelMessage
radio.error
```

Higher-level modules should not depend directly on MeshCore library event internals.

---

## 11. Device Command Serialization

The existing Python implementation uses a command lock because Companion commands may involve a request followed by a matching asynchronous response, and some operations consist of multiple commands that must remain atomic.

Preserve this behavior.

Implement a simple internal promise-based command queue or mutex.

Examples that must run through the queue:

* channel lookup
* channel creation
* channel send
* device info requests
* clock requests
* LetsMesh signing commands
* any multi-step signing transaction

Do not add a mutex dependency unless clearly justified.

The goal is:

```text
exactly one device command transaction in flight
```

when command response correlation could otherwise become ambiguous.

---

## 12. Clock Synchronization

After connecting:

1. Read device time.
2. Compare to system Unix time.
3. If the device is behind system time, update it.
4. If device time is equal or ahead, do not move it backward.
5. Clock-sync failure should warn but should not terminate observer startup.

Run the operation through the device command queue.

---

## 13. Packet Pipeline

Raw radio data must pass through a single pipeline:

```text
MeshCore raw event
       |
       v
normalize
       |
       v
AJV validation
       |
       v
decode metadata
       |
       v
emit "packet" -> MQTT publisher
```

Every decoded reception is emitted, including re-hearings of the same
logical packet delivered via a different relay path. The mesh can (and
does) deliver one physical message more than once with a different
route/RSSI/SNR each time, and downstream consumers on the OkiMesh network
need to see every path a packet took, not just the first one heard - so
the pipeline does not deduplicate before publish (see Section 15).

The channel bots (EchoBot's successor) are an independent consumer of the
same raw MeshCore event, not of this pipeline's output - see Section 15.

Business logic must not consume unvalidated externally sourced structured events.

---

## 14. Packet Compatibility

Before implementing packet parsing, capture representative output from the working Python application and store sanitized examples as test fixtures.

Fixtures should cover at minimum:

```text
ANON_REQ
GRP_TXT
PATH
TXT_MSG
ADVERT
```

and paths using both single-byte and multi-byte hop hashes if available.

The initial JS packet object should preserve the currently useful packet fields:

```js
{
  origin,
  origin_id,
  timestamp,
  type,
  direction,
  len,
  packet_type,
  route,
  payload_len,
  raw,
  SNR,
  RSSI,
  hash
}
```

Additional decoded data may be added under a nested property, but do not change existing MQTT compatibility fields without explicit approval.

Do not assume the current Python output is correct merely because it exists. Tests should compare known radio frames against independently expected metadata where possible.

---

## 15. Packet Deduplication

The MQTT capture pipeline (Section 13) does not deduplicate: every distinct
RF reception is published, even repeat deliveries of the same logical
packet heard via a different relay path. The mesh can and does deliver one
physical message multiple times with a different route/RSSI/SNR/timestamp
each time, and OkiMesh needs every path an observer heard, not just the
first. (The reference `agessaman/meshcore-packet-capture` observer takes
the same approach - it has no logical dedup either, only a narrow
same-exact-bytes guard against its own dual BLE event sources, which this
codebase's single `LogRxData` subscription doesn't need.)

Suppressing a repeat *reply* is a separate, bot-local concern: each channel
bot must never respond twice because one MeshCore message arrived through
both a raw RF event and a higher-level channel-message event. Each bot
keeps its own deduplicator instance for this - do not share one deduplicator
between the MQTT pipeline and the bots, and do not share one deduplicator
across bots either.

Prefer a stable identifier derived from the raw packet or existing MeshCore packet hash.

A bot's deduplicator should:

* use a bounded cache;
* expire entries;
* avoid unbounded memory growth;
* allow the bot to know whether a packet is newly observed.

---

## 16. MQTT Manager

MQTT must support an arbitrary configured list of brokers.

Broker connections are independent.

Failure of one broker must not prevent another broker from operating.

Required per-broker state:

```text
disabled
connecting
connected
disconnected
retrying
failed
```

Use MQTT.js reconnect behavior where appropriate rather than writing a second competing reconnect system. MQTT.js supports MQTT/TCP and WSS transports and configurable reconnection behavior.

The manager must publish independently to every currently connected broker.

---

## 17. MQTT Topics

Preserve topic template behavior:

```text
meshcore/{IATA}/{PUBLIC_KEY}/status
meshcore/{IATA}/{PUBLIC_KEY}/packets
```

Topic expansion belongs in `topic-resolver.js`.

Reject unresolved template variables before publishing.

Do not concatenate topic strings independently throughout broker code.

---

## 18. Observer Status

Publish retained observer status.

Preserve the current logical shape where data is available:

```js
{
  status: "online",
  timestamp: "...",
  origin: "...",
  origin_id: "...",
  model: "...",
  firmware_version: "...",
  radio: "...",
  client_version: "..."
}
```

Optional device statistics may be included later when supported and tested.

On a graceful shutdown, publish `offline` when possible.

Use broker Last Will where practical so abrupt process termination can also reflect observer loss.

---

## 19. OKI Mesh Broker

Initial configuration:

```text
host: mqtt1.okimesh.org
port: 1883
transport: TCP
TLS: false
authentication: none
```

This broker should be implemented before LetsMesh because it establishes basic packet-publishing compatibility without introducing JWT signing.

Acceptance requires the observer to become visible in the OKI environment and captured packets to appear there.

---

## 20. LetsMesh Authentication

LetsMesh requires a dedicated authentication seam.

Do not combine JWT creation with generic MQTT connection code.

Suggested interface:

```text
LetsMeshAuth
    |
    +-- createToken()
    +-- getExpiration()
    +-- refreshIfNeeded()
```

Security requirement:

**Prefer on-device signing.**

The Companion's private key must remain on the radio.

Do not export or persist the radio private key merely to simplify the Node implementation.

If the JS MeshCore API cannot provide the required signing operation, stop and surface the gap. Moving to host-side private-key extraction is an authentication/security change and requires explicit human approval.

JWTs must:

* be short-lived;
* exist only in memory;
* be refreshed before expiration;
* never appear in logs.

---

## 21. Echo Bot

Implement the bot as an independent consumer of normalized radio events.

It must not own the serial transport.

Configuration:

```text
channel: #echo
triggers:
  !echo
  !test
  !spam
  !yolo
minimum hops: 1
```

### Channel initialization

At startup/reconnect:

1. Search Companion channel slots for the configured channel.
2. Compare names case-insensitively.
3. If found, retain its channel index.
4. If absent, find an empty slot.
5. Create the configured public hashtag channel.
6. Derive the appropriate hashtag channel key.
7. Log success without logging the secret key.

If no channel slot is available, disable replies and continue observer operation.

Bot failure must not stop packet capture or MQTT.

### Trigger matching

Triggers are exact matches.

Do not use substring matching.

Examples:

```text
!echo       -> respond
!test       -> respond
hello !echo -> do not respond
!echo now   -> do not respond
```

### Hop requirement

Do not reply unless:

```text
hopCount >= configured minimum
```

### Reply

Preserve:

```text
🔁 @[sender]! {hopCount} hops via {path}
```

Path tokens should remain uppercase and arrow-separated.

Example:

```text
🔁 @[Jeymz]! 3 hops via A1➡️B2➡️C3
```

### Duplicate prevention

The bot must produce at most one reply for one physical RF packet.

Whether a message appears through:

* raw RF packet processing,
* decrypted GRP_TXT processing,
* or a high-level MeshCore channel event,

it must converge on one canonical message identifier before bot business logic.

This intentionally improves on the current implementation, where separate event paths can potentially represent the same underlying message.

---

## 22. Graceful Shutdown

Handle at minimum:

```text
SIGINT
SIGTERM
```

Shutdown order:

```text
stop accepting bot work
stop schedulers
publish offline status if feasible
disconnect MQTT
close MeshCore connection
exit
```

Shutdown should have a bounded maximum duration.

---

## 23. Health Model

Version 1 should implement internal health state without introducing HTTP.

Track at least:

```js
{
  startedAt,
  radioConnected,
  radioLastConnectedAt,
  radioReconnectCount,
  packetsReceived,
  packetsPublished,
  mqtt: {
    letsmesh: { connected, lastConnectedAt },
    okimesh: { connected, lastConnectedAt }
  },
  echoBot: {
    enabled,
    ready,
    repliesSent
  }
}
```

This data may later support a health endpoint, Kubernetes probe, or centralized health update.

Adding HTTP is a separate change and should receive approval because it introduces a new attack surface and invokes the repository's HTTP/Helmet/CSP requirements.

---

## 24. Local Runtime

`package.json` scripts are the supported interface.

Minimum intended scripts:

```json
{
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "node --test",
    "lint": "eslint ."
  }
}
```

Exact lint tooling requires dependency approval.

Local environment-file handling should be implemented through the approved Node runtime/package-script approach rather than feature modules manually parsing `.env.local`.

Production/container configuration must come from process environment.

---

## 25. Windows Operation

Initial supported runtime:

```text
Windows
Heltec V3
COM3
USB serial
```

Do not assume PowerShell inside application logic.

Do not hardcode Windows paths.

The application should start through:

```text
npm start
```

Windows Task Scheduler integration should happen only after normal foreground execution is reliable.

Recommended Task Scheduler behavior later:

```text
trigger: startup or user login
delay: approximately 20-30 seconds
working directory: repository root
command: npm start
restart on process failure: enabled
```

The application's own radio retry logic remains required even with a delayed task.

---

## 26. Container / Kubernetes Compatibility

Do not attempt to make the first version access a Windows COM port from Kubernetes.

Instead preserve the radio transport seam.

Future deployment can use:

```text
Heltec
  |
serial
  |
serial-to-TCP bridge
  |
network
  |
Kubernetes observer
```

and configure:

```text
PACKETCAPTURE_CONNECTION_TYPE=tcp
PACKETCAPTURE_TCP_HOST=...
PACKETCAPTURE_TCP_PORT=...
```

The rest of the application must be transport-agnostic.

Do not create GitLab CI/CD or Kubernetes resources until explicitly approved.

---

## 27. Testing Strategy

Use tests as part of implementation, not after implementation.

Prefer Node's built-in test runner initially unless repository conventions require another framework.

### Unit tests

Required areas:

```text
configuration normalization
configuration rejection
AJV schemas
topic expansion
packet normalization
packet path parsing
packet hash/deduplication
echo trigger matching
minimum-hop behavior
echo reply formatting
MQTT payload construction
JWT metadata/redaction behavior
connection backoff calculation
```

### Fixture tests

Store sanitized MeshCore raw-frame samples from the known-working Python observer.

For each fixture assert expected:

```text
route
packet type
hop count
path
RSSI
SNR
packet hash
payload boundaries
```

### Service tests

Use fake/injected transports.

Do not require COM3 for normal automated tests.

Test:

```text
serial connection fails then succeeds
serial disconnects while running
MQTT broker 1 down, broker 2 remains operational
both brokers reconnect
radio reconnect reinitializes echo channel
duplicate event paths produce one echo
shutdown closes resources
```

### Hardware acceptance

A manual hardware test is still required before declaring migration complete.

---

## 28. Implementation Phases

### Phase 0 — Preserve the reference behavior

Before writing replacement logic:

* Archive the current Python observer.
* Do not modify it further except to collect test fixtures.
* Capture sanitized packet examples.
* Capture current OKI status payload.
* Capture current LetsMesh status payload.
* Capture a working `#echo` request/reply.
* Record Heltec device information and radio parameters.
* Create a behavior checklist.

Deliverable:

```text
test/fixtures/reference/
```

No Node functionality is implemented yet.

---

### Phase 1 — Repository bootstrap

Create:

```text
package.json
src/index.js
src/config/
src/logging/
test/
.env.example
.gitignore
```

Copy `AGENTS.md` into the repo.

Add this implementation spec.

Establish approved Node version.

Add only approved dependencies.

Create:

```text
npm run start
npm run test
npm run lint
```

Deliverable:

A process that starts, validates configuration, logs startup, and shuts down cleanly without touching the radio.

---

### Phase 2 — Radio connection

Implement:

```text
RadioManager
SerialTransport
TCPTransport seam
command queue
reconnection
device self-info
clock synchronization
```

Acceptance:

* COM3 connects.
* Radio name/public key/frequency are obtained.
* Unplugging and reconnecting the radio recovers automatically.
* Starting immediately after a Windows reboot does not require a second manual launch.
* No MQTT exists yet.

---

### Phase 3 — Packet capture

Implement raw packet event handling.

Port only the packet parsing behavior required for observer compatibility.

Do not port unrelated Python architecture.

Validate normalized radio-event objects with AJV before processing.

Acceptance:

* Known fixture frames decode correctly.
* Live Heltec traffic produces expected metadata.
* RSSI/SNR/path are correct.
* Duplicate packets are bounded/deduplicated.
* No MQTT exists yet.

---

### Phase 4 — OKI MQTT

Add generic MQTT broker infrastructure and OKI as the first broker.

Acceptance:

* Observer publishes retained online status.
* Live packets publish to the expected CVG topic.
* Observer appears in OKI Mesh.
* Broker outage does not stop radio capture.
* Reconnection happens automatically.
* Shutdown publishes offline when practical.

---

### Phase 5 — LetsMesh

Implement LetsMesh-specific authentication.

Use on-device signing.

Acceptance:

* JWT can be produced without exporting private key.
* JWT never appears in logs.
* WSS/TLS broker connects.
* Token renewal succeeds.
* Both OKI and LetsMesh operate simultaneously.
* One broker failing does not disable the other.

If required on-device signing cannot be achieved with approved APIs, stop here and request owner guidance.

---

### Phase 6 — Echo bot

Implement channel initialization and bot event consumer.

Acceptance:

* `#echo` is found or created.
* Exact configured triggers receive a reply.
* Non-trigger messages receive no reply.
* Minimum-hop setting is honored.
* Path formatting matches expected behavior.
* One physical packet causes at most one reply.
* Bot failure cannot stop observer/MQTT operation.

---

### Phase 7 — Runtime hardening

Implement:

```text
structured health state
signal handling
bounded shutdown
resource cleanup
connection metrics
redacted debug logging
long-running soak test
```

Perform an extended live test.

Verify:

```text
no unbounded packet cache
no unbounded dedupe cache
no event-listener growth
no connection-object leaks after reconnect
no duplicate MQTT clients after reconnect
no duplicate echo subscriptions
```

---

### Phase 8 — Windows managed startup

Only after foreground operation is stable:

* Create documented Task Scheduler setup.
* Start through repository-defined npm script.
* Configure delayed startup.
* Configure restart-on-failure.
* Reboot Windows and verify unattended recovery.

Acceptance:

```text
reboot Windows
do not open terminal
observer comes online
OKI reports observer
LetsMesh connects
#echo replies
```

---

### Phase 9 — Container readiness

Do not deploy yet.

Validate:

* no feature logic assumes COM3;
* TCP radio transport works;
* configuration is environment-driven;
* logs go to stdout/stderr;
* no required writable local filesystem exists;
* process responds correctly to SIGTERM.

Container/GitLab/Kubernetes implementation is a separate approved task.

---

## 29. Migration Strategy

Do not modify the working Python observer in-place into the Node project.

Keep them separate.

Recommended transition:

```text
meshcore_observer_python/
meshcore-observer-js/
```

The Python observer remains the known-good fallback until hardware acceptance is complete.

Because both applications need exclusive access to the same COM port, they cannot be tested against COM3 simultaneously.

Use sequential comparison:

```text
run Python
capture expected behavior
stop Python
run Node
compare
```

After the Node implementation meets all acceptance criteria, disable the Python automatic startup but retain the code temporarily for rollback.

---

## 30. Git Strategy

Initialize the Node project as its own Git repository from the beginning.

Do not use an installer that downloads upstream source into the working tree.

Recommended branch expectations should remain compatible with the organization's:

```text
main
development
production
```

Do not create or modify GitLab pipelines until explicitly approved.

Every implementation phase should result in small commits with clear scope.

Examples:

```text
feat(config): add validated observer configuration
feat(radio): connect companion over serial
feat(packet): normalize rx log packets
feat(mqtt): publish packets to OKI
feat(auth): add LetsMesh device signing
feat(bot): add echo channel responder
fix(radio): retry initial Windows serial handshake
```

---

## 31. Coding-Agent Operating Instructions

For every phase, the coding agent must:

1. Read `AGENTS.md`, this specification, and the relevant existing source before coding.
2. Inspect `package.json` before executing project workflows.
3. Identify any protected-boundary change before implementation.
4. State the smallest intended change.
5. Implement only that task.
6. Add or update tests.
7. Run repository-defined validation scripts.
8. Report:

   * files changed;
   * tests added;
   * scripts run;
   * results;
   * unresolved risks;
   * any deviation from this specification.
9. Stop if completing the task would require an unapproved dependency, architecture change, authentication change, logging change, persistence change, API change, or deployment change.

Do not silently broaden a task.

---

## 32. Definition of Done

Version 1 is complete when all of the following are true:

```text
[ ] JavaScript only; ES modules
[ ] Centralized validated configuration
[ ] No scattered process.env access
[ ] Structured/redacted logging
[ ] Heltec V3 connects through serial
[ ] First startup after Windows reboot self-recovers
[ ] Runtime radio disconnect self-recovers
[ ] Device commands are serialized safely
[ ] Radio clock synchronization works
[ ] RF packets are captured and normalized
[ ] Packet fixtures are test-covered
[ ] Multi-byte paths are handled correctly
[ ] Duplicate packets are bounded/deduplicated
[ ] OKI MQTT works
[ ] LetsMesh MQTT works
[ ] LetsMesh private key remains on-device
[ ] JWT values are never logged
[ ] Both brokers operate independently
[ ] Status topics remain compatible
[ ] Packet topics remain compatible
[ ] #echo channel is found or created
[ ] Echo trigger behavior matches the existing implementation
[ ] Echo minimum-hop behavior works
[ ] One incoming packet cannot create duplicate replies
[ ] Graceful SIGINT/SIGTERM shutdown works
[ ] Tests run through npm scripts
[ ] No COM3 requirement exists outside configuration
[ ] TCP transport seam exists for future containers
[ ] Foreground Windows soak test passes
[ ] Automated Windows reboot/startup test passes
[ ] Python implementation remains available for rollback until acceptance
```

---

## 33. First Task for the Coding Agent

Do **not** start by implementing MeshCore serial communication.

The first task is:

> Bootstrap the JavaScript repository in compliance with `AGENTS.md`, create the centralized configuration and logging seams, define the proposed package scripts, and add configuration-schema tests. Do not connect to hardware, MQTT, or external services. Before installing any new third-party dependencies other than constitutionally required AJV, surface the proposed dependency list for human approval.

Once that task is reviewed and approved, proceed to the radio-connection phase.

---

## 34. Guiding Principle

The replacement should be simpler than the system it replaces.

The Python application is useful as a behavior oracle, but its accumulated internal complexity should not automatically be reproduced.

Prefer:

```text
small modules
explicit state
one event pipeline
central validation
central configuration
bounded caches
isolated integrations
predictable reconnects
test fixtures
```

over:

```text
one large service class
multiple overlapping event paths
implicit global state
installer-managed source trees
automatic source replacement
host-specific assumptions
```

The desired outcome is a system the owner can understand, test, upgrade, and operate without being dependent on the internal architecture or update process of the original Python observer.
