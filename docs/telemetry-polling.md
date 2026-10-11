# Telemetry polling configuration

Delivered phases: **#34 T1–T6 startup, protocol, guarded owner, durable state, opt-in runtime producer and offline acceptance**.
Polling remains disabled by default. Explicitly enabling it with valid policy and
guest-secret files now activates guarded collection after the startup delay and
distributed component deadlines. Integrated acceptance uses synthetic offline
transport frames; no live device, credential or deployment is used. Saved telemetry
freshness and shared history retention continue to operate independently.

## Startup settings

All reads happen through central configuration before the store, radio or network
starts. Polling defaults to disabled, two hops, 72-hour passive eligibility and a
24-hour per-component refresh objective. `.env.example` lists matching code
defaults and accepted units/bounds. Retry base/maximum accept whole minutes from
1 to 10,080; maximum must be at least base. Explicit empty, fractional, negative,
out-of-range or malformed settings fail startup even when disabled. Omission
uses the documented defaults.

The physical budget remains the existing shared remote budget (default one
request per minute). Refresh is an objective; login and data compete with
region discovery and foreground work. Passive eligibility, sample freshness,
refresh cadence and pruning are separate settings.

## Protected files

The default file paths are absent. With polling disabled and both paths omitted,
no telemetry policy/secret files are opened. To configure polling, provide both
`PACKETCAPTURE_TELEMETRY_POLL_CONFIG_FILE` and
`PACKETCAPTURE_TELEMETRY_POLL_SECRETS_FILE`. Enabled polling requires the pair;
explicit configuration while disabled also requires and validates the pair.
This prevents a partially configured policy from quietly gaining unresolved
credential references later.

Use `telemetry.config.example.json` and `telemetry.secrets.example.json` as
**synthetic examples only**. Their keys/passwords identify no real repeaters and
are not community credentials. Choose an intentional guest-only credential;
there is no guessed or built-in password. Keep it different from the management
password. Firmware may grant management access before the host can reject a
mistaken credential; the shared owner stops further queries on unsafe role proof.
Guest login itself establishes transient remote ACL/session state.

Store operator files under local names `telemetry.config.json` and
`telemetry.secrets.json`, both ignored by Git, or supply explicit private mount
paths. Apply restrictive operator filesystem permissions and mount the secret
file read-only in containers. Arbitrary alternate filenames are not automatically
ignored: keep them outside the checkout or add an operator-specific ignore rule.
Do not put passwords in ordinary environment values, issue reports or logs. The
loader follows normal filesystem symlinks for mounted secrets and requires the
opened target to be a regular UTF-8 JSON file of at most 65,536 bytes. Invalid
encoding, unreadable/oversize files and malformed JSON produce fixed errors with
no private paths, raw excerpts or underlying OS/parser details.

## Version 1 policy

Required fields are `version: 1` and `defaultCredentialRef`. Optional fields are
`components`, `neighbours`, `groups` and `targets`. Unknown fields are rejected
at every object boundary.

- `components` permits `status`, `sensors`, `neighbours` booleans; omissions
  default to true and at least one must be enabled.
- `neighbours` permits version 0, count 1–3, offset 0–65,535, orderBy 0–3 and
  prefixLength 32. Defaults are 0/3/0/0/32. This is one page with full-key
  prefixes, never a complete-neighbourhood claim. Sensor permission mask stays 0.
- Each group requires `id`, `credentialRef` and nonempty `targetPublicKeys`.
  Group IDs must be unique; a target can belong to at most one group. At most 16
  groups and 256 distinct assigned targets across groups/targets are accepted.
- Each target requires a complete uppercase 64-hex-character `targetPublicKey`;
  optional `credentialRef` overrides its group/default. Target rows must be
  unique. A target row may intentionally also belong to a group: its explicit
  credential wins; a profile-only row inherits the group credential.
- All references must exist in the supplied secret file, including defaults or
  group references shadowed by an explicit target override. A failed login will
  never try another reference. Names and shortened keys never select credentials.
- Profile overrides are target scoped. `statusProfile` requires a verified
  `layout` (`common48` or `current56`) and `evidence: "established"`.
  `emitterProfile: "positive-channels"` requires independently verified emitter
  evidence. Omission keeps common48/unknown status and unknown sensor decoding.
  Login firmware level or repeater name does not establish these profiles.

- `excludedTargets` is an optional list (at most 256 unique, complete uppercase
  64-hex-character public keys) of repeaters that are never sent a login or data
  request. Use it for repeaters whose operator changed the guest password, so
  the Observer stops spending airtime on logins that cannot succeed. Without an
  exclusion, a denied login is retried once per authentication cooldown (24 hours
  by default). A key may
  not be both excluded and assigned in `targets` or a group: startup fails
  rather than guessing which wins. Edits require a restart, like all policy.

Assignments choose credentials/profile interpretation only. They never make a
target eligible, prove a route or authorize a management command. Independent
evidence, contact and shared-owner gates must all pass. Guest firmware may expose only battery
and MCU temperature; environmental readings can remain unavailable.

## Version 1 secret file and private memory

The shape is `{ "version": 1, "secrets": { "default": "operator-guest-value" } }`.
Use 1–32 references, each 1–32 characters starting with a letter and containing
only letters, digits, `_` or `-`. Group IDs use the same syntax. Each guest value
must be nonblank, contain no control/unpaired-surrogate characters and encode to
1–15 UTF-8 bytes. Multibyte characters count as multiple bytes. No trimming or
silent wire truncation occurs. Every value is validated, including unused ones.

The normalized `telemetryPolling` config is deeply frozen and contains scheduling
values, component parameters and safe profiles only. Paths, group IDs, references
and credentials live outside it. An internal WeakMap binds private credentials to
the original enabled startup config; JSON serialization, inspection, cloning or
an independently constructed config cannot restore credential authority. A
narrow internal callback supplies a password only for eventual private command
preparation; consumer errors are sanitized. Consumers must never log or expose
passwords/secret wire buffers. JavaScript strings cannot be reliably zeroized;
credentials remain private process memory for the startup configuration's life.
No credentials are retained for disabled polling, although explicit files are
fully validated. There is no live reload: credential/policy edits require restart.

## Error handling and rollout

Errors identify the setting category and corrective requirement without including
operator values, references, filenames or parser excerpts. Configuration failure
terminates startup before store/radio/network work. Verify files and references
locally rather than copying secret contents into diagnostics.

T1–T3 add no store migration, live polling producer, route change or contact mutation.
T2 validates protocol/contact shapes; T3 adds the guarded shared owner;
T4 adds durable state; T5 connects opt-in collection; T6 validates integrated offline acceptance.
Live radio/device validation and deployment activation remain separately scoped
under #37. Authentication prefix/static-tag correlation limits are recorded in
the approved #34 plan and will not be presented as nonce-based replay proof.

## Pure protocol/contact checks (#34 T2)

These pure helpers perform preparation/parsing; T3 connects them through the guarded radio owner. They prepare only a full
unfiltered contact list read (command 4), an exact-key read (command 30), or a
private guest-login frame (command 26). Private login bytes are consumed through
a trusted callback and cleared when the callback settles; no transport is called
by these helpers. Invalid inputs and callback failures produce fixed errors.

A bounded reducer validates start/contact/end framing and exactly the declared
number of distinct contacts, at most 1,024. It retains only full keys and minimal
selected-target route evidence, never names, locations or raw frames. All contact
types participate in target login-prefix collision checks. An incomplete/filtered
listing, duplicate key, non-repeater target, prefix collision or known new-contact
push cannot prove safe login association. Configured monotonic deadline/rollback
guards also apply to completed proof; large tables can time out before reaching
the contact-count bound. Timeout or missing evidence defers instead of probing.

Saved path metadata encodes prefix width and relay count. Widths 1–3 and at most
64 path bytes are supported; target distance is relay count plus one. Unknown
paths and reserved width 4 are rejected. An existing direct route is only local
contact evidence: these helpers label outbound delivery unverified and never
reverse passive paths or edit contacts.

Login success requires the pinned modern 14-byte shape, admin flag zero,
permission byte exactly zero and firmware protocol level 2. Nonzero permission
bits, eight-byte legacy success and unfamiliar protocol levels are unavailable.
Firmware level is not a firmware-version/layout/sensor-profile attestation.
Login denial requires the exact eight-byte reserved-zero shape. A login ACK must
select direct routing and echo the static first-four-byte key prefix as its tag.
That tag is not a nonce. The response exposes only a six-byte prefix and public
server clock; raw proof cannot independently identify the full key or reject all
same-target delayed replies. The later shared owner must enforce current
reporter/generation, replay/timing, reservation and session lifecycle gates before
using proof. No successful parser result on its own activates data collection.

## Guarded shared radio owner (#34 T3)

The existing coordinator now provides narrow internal `tryGuestLogin` and
`tryTelemetryRequest` entry points. They require enabled validated startup policy,
synchronous eligibility and durable-reservation callbacks. Login additionally
requires a synchronous public-server-time high-water read and authentication
outcome save. T4 supplies their owned-store APIs; T5 connects the
producer and callbacks. The existing generic binary primitive remains compatible for its
trusted internal consumers; the telemetry producer must use these guarded entry
points. Enabled polling can send login and telemetry requests only after all
eligibility, due-time, route, role, ownership and physical-budget gates pass.

Login reads the complete bounded inventory and then the exact full-key contact
inside the same generation-bound local command transaction. Both reads share
the original configured preflight deadline. The route must remain consistent
between reads. Every login/data send rechecks current reporter/generation,
eligibility, foreground work, quiet air, shared physical budget and a synchronous
saved reservation. Data also requires an unexpired guest session and another
exact-key route read. Physical write failures consume budget; local contact reads
and deferrals do not. Unknown outcomes reset the captured connection before the
untagged local/ACK channel can be reused.

Guest proof must follow the exact direct static-prefix ACK; early, foreign and
duplicate proof cannot grant authority. The ACK wait is bounded by existing
limits, and its estimated response wait is clamped to the shared ceiling. Require
server timestamp greater than the durable high-water when one exists. Missing,
invalid or asynchronous state/save callbacks fail closed. Save the safe outcome
before granting any session. Permission/legacy/protocol/denial failures are
separate authentication outcomes; they do not invent data responses. Captured
local dispatch/receipt/completion times remain distinct from the public server
clock. Local completion rollback prevents session authority.

At most 32 guest sessions bind the original private policy object, full target
key, current reporter and connection generation, with the configured monotonic
TTL. Restart restores none. A bounded pair of listeners invalidates idle
authority on disconnect/identity change and drains at stop; no session timer or
poll queue is introduced. Known contact mutation and route/auth failures revoke
reuse. Ordinary foreground/quiet/budget/producer-turn deferrals preserve a valid
session while granting no send permission.

Login prefixes have a separate 32-entry quarantine. Its lifetime is the shared
ACK ceiling plus response ceiling plus 60 seconds; unexpired evidence is never
evicted to make space, so saturation defers login. Expiry is not nonce proof:
same-target delayed replies and externally mutated contacts remain the approved
protocol limitations. Distinct guest/management credentials remain essential.

Region and telemetry demands coalesce into two expiring slots. A physical send,
including a failed write, rotates the next turn and consumes its demand. A peer
withdrawing unavailable preflight/eligibility, or an expired demand, cannot keep
blocking the available producer. Demand lifetime derives from existing limits:
the greater of twice shared minimum spacing and ACK plus response ceilings.
There is no accumulating queue, catch-up burst or guarantee under sustained
foreground/busy air. These guards require no internet, MQTT or dashboard.

## Owned durable evidence, authentication and polling state (#34 T4)

Migration 17 adds three datasets to the same always-on MetricsStore, even with
polling/dashboard disabled. Stop Observer and verify a closed database backup
before upgrading; use the README backup procedure. Each migration is atomic.
Older inventories/results do not backfill reporter-scoped evidence or create
authentication authority. A successful upgrade requires a compatible pre-upgrade
backup for an application downgrade.

`recordTelemetryDirectEvidence` stores a newly verified zero-hop advert’s
captured reporter, target, original receipt, source run and nonsecret event digest.
It preserves the latest marker without incrementing existing advert metrics; T5
calls it alongside the existing verified-advert path even with polling disabled. Exact eligibility and
keyset candidate reads require repeater type, matching reporter, exclusive stale
cutoff, no future receipt and a source run without known clock anomaly. Flood
candidates additionally need nonrepeated traversed topology, a retained original
receipt and unique full-key prefix resolution across every node type, within
radius. Unknown, remaining-route and colliding evidence cannot grant eligibility.
Candidate pages return eligible targets, not a ready-to-transmit queue; T5 owns
distributed component selection and due checks. Passive evidence never proves a
saved outbound contact route.

`reserveTelemetryPoll` validates an approved canonical component/parameter scope,
owned active run, current evidence and clock, then saves request identity, attempt
count and conservative deadline synchronously. Local contact checks and
`deferTelemetryPoll` consume no RF attempts. A saved reservation is permission
bookkeeping, not evidence that a command was sent. Shared physical rate limits
and live guest authority remain the coordinator’s responsibility. Retry failures
back off to the configured cap; exhausted/unsupported component cycles wait for
refresh. Slower policy can extend deadlines; faster policy cannot shorten saved
ones. New cycles adopt the current validated configuration after that prior
deadline has elapsed. Policy inspection does not slide the original reservation/completion anchor.

`completeTelemetryPoll` writes the original #33 outcome/observation and advances
its matching reservation in one transaction. The existing `recordTelemetryResult`
contract remains unchanged; its internal transaction seam is inaccessible through
HTTP. Any write failure rolls back results, latest pointers and scheduling state.
The pending reservation then blocks replacement for its scope. T5 pauses all
new telemetry on terminal persistence failure, retains at most one unsaved terminal
and drains before store close. No producer/drain queue is introduced in T4.

`completeTelemetryAuthentication` separately saves the coordinator’s validated
public context, original local dispatch/completion, actual route, fixed reason
and modern public proof. Success requires direct guest-only proof matching the
target prefix, nonanomalous time and server timestamp strictly above the stored
high-water. Invalid/privileged/mismatched/replayed success cannot commit. Denied/unsafe/replayed
authentication advances the longer target cooldown, blocking all data components;
transport/timeout failures use ordinary capped retry backoff. Authentication failure
never fabricates a status/sensor/neighbour result. `getTelemetryAuthReplayState`
returns only the greatest accepted public server timestamp. That guard survives
restart/pruning, with its original request/source run retained separately from a
newer failed attempt. No database row grants or restores a live guest session.

Shared original-time days retention removes authentication history only when
both dispatch and completion precede the cutoff; equality survives. Latest direct
markers, replay high-water, active/latest poll state and required run FKs remain.
They can become stale and confer no permanent freshness. Indefinite retention
still has no lifetime disk ceiling. There is no new cleanup timer, store, raw
frame archive, credential/reference/fingerprint field or public API.

After reopen, `recoverTelemetryPollReservations` uses bounded request-ID pages to
retire reservations from another run and extend conservative cooldowns while
keeping consumed attempts. It records no invented terminal response and does not
resend old work. Current-run pending requests remain owned until terminal save or
drain. Wall-clock rollback/future evidence defers admission instead of making stale
state fresh. T5 invokes recovery before admitting the new producer.

## Opt-in runtime scheduling and drain (#34 T5)

The verified-advert consumer captures `origin_id` and original receipt time
before asynchronous signature verification. A newly verified zero-hop repeater
receipt supplies a reporter-scoped marker; a subsequent reporter change cannot
reattribute it. Relayed/unverified/invalid-context receptions cannot supply direct
eligibility. The existing inventory and advert-event deduplication are preserved.
Marker errors use a fixed safe warning and do not interrupt capture or publication.

Enabled startup constructs one scheduler on the existing store and coordinator.
It first retires other-run reservations in pages of at most 100. Candidate pages
hold at most 16 targets with a full-key cursor; each tick selects one due
component. Initial reporter/target/component phases are deterministic offsets
within the configured refresh cadence, anchored at scheduler startup. Saved
deadlines survive restart; missing scopes discovered after their phase are due
on that tick. Existing observations can extend that initial deadline. There is no
catch-up batch. Clock agreement uses monotonic elapsed time and the durable
wall-time high-water before RF permission is considered.

The scheduler uses guarded data admission; when a guest session is absent, it
attempts one due guest login instead. Successful proof must be saved synchronously
before the owner grants its ephemeral session. The component is revisited on a
later tick under the shared physical budget. Session expiry, disconnect/reporter
change or failures require fresh proof; stored permission history is never a
live grant. Slower cadence overrides are checked before spending RF on login;
the store still enforces conservative current-cycle timing and attempt limits.
Target profile overrides select only the approved decoder contracts. A query
failure stores an outcome without inventing a reading; authentication failures
remain only in authentication history.

One validated terminal can await a local save. Repeated save failure blocks all
new telemetry work, emits a fixed deduplicated warning and retries that same
original result locally. A repaired authentication save does not retrospectively
grant a session. An invalid/missing terminal leaves admission paused and refuses
clean shutdown. A reservation followed by cancellation before physical dispatch
remains a conservative scope block until restart recovery; no failure/reading is
fabricated to release it.

Shutdown stops producer admission before cancelling shared remote ownership,
then drains telemetry while the store is open. Pending advert verification also
settles before clean run closure/store close. Unresolved terminal persistence
prevents a clean run marker and normal store closure, following the existing
bounded shutdown failure path. Broker/UI availability has no role in collection.
T5 validation uses isolated synthetic credentials, signed adverts and raw radio
frames. T6 adds real-entrypoint offline acceptance; #37 retains live-device proof.
Enabling the feature is an operator action and was not performed
on a real device during implementation.

## Operator handoff and effective coverage (#34 T6)

Offline collection needs the local Companion, a writable owned SQLite database,
fresh passive evidence, usable pre-existing contact routes, and explicitly
supplied guest policy/secret files. It needs no internet, MQTT broker or enabled
dashboard. Local packet capture, verified inventory, topology and bot replies
remain independent consumers. Dashboard/API presentation is owned by #35/#36;
absence of a public telemetry view does not mean collection stopped.

Before deliberate activation, establish the target firmware's modern guest role
proof, confirm the chosen guest password differs from management, and verify
contact routes and full-key uniqueness. Use independently established profiles
only when their layout/emitter meaning is known. Unknown profiles remain partial;
guest access may provide battery/MCU temperature without environmental fields.
Neighbours are one bounded page, possibly empty, rather than proof of every
nearby repeater. Login firmware level alone never establishes decoder profiles.
Legacy, privileged, denied or replayed login proof cannot authorize data.

Stop the Observer and preserve a verified closed database backup before changing
runtime policy or upgrading. Follow the README backup procedure: verify normal
shutdown, retain the entire closed SQLite file, and restore that file as a unit.
Do not hot-copy only the main file while WAL transactions or another owner are
active. A failed terminal save leaves shutdown unconfirmed and the reservation
recoverable; restarting is recovery, not evidence that the missing reply was
saved. Keep the original files when investigating storage faults.

Supply the two private file paths and deliberately set
`PACKETCAPTURE_TELEMETRY_POLL_ENABLED=true` only for authorized collection.
Omission stays false. Validate synthetic configuration first; production startup
rejects invalid explicit settings/files before opening the store or transport.
Secret mounts remain read-only and restricted to the Observer operator. Restart
is required for policy/credential edits. To pause RF collection, stop the process,
set the enabled flag false, and restart; retain the database and evidence.
Disabled collection still records verified reporter-scoped direct markers.

Refresh cadence describes an objective. With the default shared budget of one
physical remote request per minute there are at most **1,440 request slots/day**
before quiet-air, foreground work and errors. A fresh guest login plus three
components costs at least **four slots per target**, so an isolated first sweep
of 100 targets requires at least **400 minutes (6h 40m)**. This is a lower bound,
not a capacity guarantee: distributed component phases, the ten-minute session
lifetime, additional logins, retries and region discovery can increase it. Both
background producers share the same cap and fair admissions; foreground work
wins. Raising the physical budget changes RF load, not passive eligibility or
firmware permissions. No performance target or default budget changed in T6.

Use saved per-component deadlines/outcomes and retained-history coverage to
interpret missing data. Stale/out-of-radius/ambiguous evidence, missing or flood
contacts and prefix collisions defer rather than probing. Disconnect/reporter
changes revoke live sessions; neither restart nor backup restore grants one.
Persisted server-time replay markers survive those operations. A repeater clock
reset can therefore defer login even with a correct guest password. Local clock
rollback also pauses collection until clock agreement returns. These are safe
deferred states: do not discard history or weaken role/route checks to make them
look successful. A persistence warning means one original terminal is being
retried locally with new collection paused; it never schedules an RF replay.

The T6 fixture runs the real entrypoint, SDK frame dispatch, radio manager,
packet decoder, guest owner, scheduler and SQLite lifecycle with synthetic
transport and controlled clocks. It checks actual reserve-before-send boundaries,
all three components, default-off capture/bot behavior, busy air, rejection paths,
timeouts, both auth/data save failures, stop at ACK/reply waits, ten crash
boundaries, clean/abrupt restart, and closed-backup restore. No operator secret,
real socket, radio login, firmware/contact edit or deployment is exercised.
Pinned protocol fixtures establish code behavior; #37 owns separately authorized
named-device/RF/soak proof and rollout readiness.
