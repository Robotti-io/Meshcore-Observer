# Telemetry polling configuration

Owner info is collected as a separate authenticated telemetry step and stored
with the other normalized observations. The stored contact string is available
in repeater response history and is never copied to application logs.

Delivered phases: **#34 T1–T6 startup, protocol, guarded owner, durable state, opt-in runtime producer and offline acceptance**.
Polling remains disabled by default. Explicitly enabling it with a valid policy
and optional guest-secret file now activates guarded collection after the
startup delay and distributed component deadlines. Integrated acceptance uses synthetic offline
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

The shared remote budget defaults to one request per minute. Bounded target
exchanges can borrow closely spaced turns for dependent trace/login/data work,
then repay every RF attempt in a cooldown before more remote work starts; see
the exchange contract below. Refresh is an objective. Passive eligibility,
sample freshness, refresh cadence and pruning are separate settings.

### Contact preflight and reconnect diagnostics

Guest-login preflight reads the full local contact inventory before reading the
exact target contact. `PACKETCAPTURE_TELEMETRY_POLL_INVENTORY_SECONDS` bounds
the inventory drain (default 30 seconds);
`PACKETCAPTURE_TELEMETRY_POLL_PREFLIGHT_SECONDS` separately bounds the exact
target read (default 5 seconds). Inventory logs include the
request ID, operation, radio generation, preflight kind, timeout, elapsed time,
contact count and whether the stream reached its terminal marker. They never
include contact names, keys, routes, credentials or raw frames.

A new-advert/contact-list mutation during inventory invalidates the snapshot.
The observer drains the response through its end marker and defers that target
without resetting the radio. A stable snapshot can add or repair a target
contact from a fresh signed advert route. If no fresh signed route is
available, the observer can infer a fallback from recent captured
flood-traversed message paths: the target must appear as a uniquely resolved
repeater in the path, and the relay suffix after it is reversed into
observer-to-target order. Candidate routes are ranked by the number of
individual recent path receptions, not the lifetime aggregate counter. Every
relay must resolve uniquely to a repeater and to a unique two-byte contact ID.
The first outbound relay must also have fresh, reporter-scoped proof of a
zero-hop signed advert from this observer. The observer applies the same
adjacency check to signed-advert routes before using them. This prevents a
high-count path from treating a relay heard deeper in the mesh as a directly
reachable next hop. If the route does not begin with a proven local neighbor,
the request is deferred and logs the route rejection reason; no missing relay
is guessed or prepended.
Stale, future, anomalous or looping evidence, repeated prefixes, routes outside
the configured radius, and tied top reception counts are rejected. The fallback
is used when fresh advert evidence is absent or when that exact advert route
was temporarily suppressed after a delivery failure; it does not override a
usable fresh signed route. Migration 19 persists target-bound signed-advert
route evidence and its reception count with the contact metadata. If a target
is absent and no fresh, unambiguous route is available, the poll defers without
changing device contacts. An explicit firmware TABLE_FULL response is the only condition that
allows removal of the oldest non-favourite contact other than the target,
followed by one retry. The exact target is reread before login. Request
diagnostic logs include the target identity and selected route evidence; the
full device contact inventory and raw contact frames are never logged. Malformed or
count-inconsistent frames, an oversized list, an incomplete stream or a timeout
still reset the connection because the untagged local response stream cannot be
proven settled. Recovery warnings include the preflight phase/kind, configured
timeout, elapsed time, reason and connection generation so operators can tell
which read caused recovery.

A dispatched route that ends in an ACK timeout, response timeout or route
mismatch is marked temporarily invalid for that target. The next attempt skips
that exact path and asks the topology history for the next supported candidate;
for example, a failed direct path can yield a route through E85C when recent
message-path evidence supports it. The exclusion expires after the configured
maximum retry interval and is process-local, so a restart clears it. Other
failures such as authentication denial, radio disconnect or a local write error
do not invalidate route evidence.

## Protected files

The default file paths are absent. With polling disabled and both paths omitted,
no telemetry policy/secret files are opened. Enabled polling requires
`PACKETCAPTURE_TELEMETRY_POLL_CONFIG_FILE`; the secrets path is optional. If no
default guest password is defined, the default credential is the empty string,
matching MeshCore repeaters whose guest password remains blank. A configured
secret file may also define a reference with an empty value. Any non-default
credential reference in a group or target must still resolve in that file.
Providing a secrets path without a policy path is invalid.

Use `telemetry.config.example.json` and `telemetry.secrets.example.json` as
**synthetic examples only**. Their keys/passwords identify no real repeaters and
are not community credentials. MeshCore's documented default guest password is
blank, so blank is the default when no value is configured. A nonblank guest
credential may be supplied by the default reference or overridden by target or
group. Never use the management password. On MeshCore firmware, a blank login
may reuse the caller's existing ACL entry before password comparison; the
Observer accepts only a verified guest-only proof and will not send telemetry
data after an admin or otherwise unsafe proof. Guest login itself establishes
transient remote ACL/session state.

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

- `components` permits `status`, `sensors`, `neighbours`, `ownerInfo` booleans; omissions
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
- All non-default references must exist in the supplied secret file, including
  group references shadowed by an explicit target override. The default
  reference may be absent, which selects the blank guest password. A failed
  login will never try another reference. Names and shortened keys never select
  credentials.
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
The secrets file itself may be omitted to use a blank default guest password.
When present, an absent default reference or an explicit empty default value also
means blank. Per-target and group references other than the default must resolve.
Use 1–32 references, each 1–32 characters starting with a letter and containing
only letters, digits, _ or -. Group IDs use the same syntax. Guest values may be
empty; nonempty values must contain no control/unpaired-surrogate characters
and encode to at most 15 UTF-8 bytes. Multibyte characters count as multiple
bytes. No trimming or silent wire truncation occurs. Every value is validated,
including unused ones.

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
Fresh, fully decoded neighbour reports can also establish eligibility for the
next outward layer under the shared route checks described below. Discovery,
the final eligibility read and atomic reservation use the same report resolver.
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
hold at most 16 targets ordered by minimum eligible distance, then full public
key. An internal distance/key cursor carries scanning across ticks; each tick
selects one due component. Initial reporter/target/component phases are
deterministic offsets
within the configured refresh cadence, anchored at scheduler startup. Saved
deadlines survive restart; missing scopes discovered after their phase are due
on that tick. Existing observations can extend that initial deadline. There is no
catch-up batch. Clock agreement uses monotonic elapsed time and the durable
wall-time high-water before RF permission is considered.

Passive proximity and the usable outbound route have separate radius checks.
Before admitting a due candidate to the radio owner, the scheduler reads the
same fresh signed-advert route used by preflight. If that route exceeds the
radius, a fresh bounded topology/neighbour alternative may still qualify the
target. Without an available alternative, the rejection advances to the next
candidate inside that bounded 16-target page, rather than starting a contact
inventory and consuming a whole request turn. If the page contains only rejected/not-due candidates,
the cursor advances and scanning resumes on the next tick; there is no
unbounded loop or RF burst. Other route decisions still follow the existing
owner/fallback path. The owner rereads route evidence and enforces eligibility,
radius, session, quiet-air and shared physical budgets at admission/dispatch.
An early skip grants no authority, deletes no node/history, and does not reset
saved component deadlines. New shorter evidence can make the target selectable
again. A target skipped before request admission creates no request diagnostic;
the registry, stored route and prior diagnostics remain available.

The scheduler uses guarded data admission; when a guest session is absent, it
attempts one due guest login instead. Successful proof must be saved synchronously
before the owner grants its ephemeral session. The exact selected component is
retained for the next eligible tick, ahead of scanning other targets, under the
shared physical budget. One transient continuation can wait through foreground,
quiet-air or budget deferrals; it is discarded after dispatch, a terminal
deferral, session-window expiry, lost eligibility, connection/reporter change,
clock rollback or shutdown. The owner rechecks actual session authority on each
attempt. This continuation is never persisted or restored after restart and
does not extend the session lifetime. Session expiry, disconnect/reporter
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
remain independent consumers. The focused reporting API slice is implemented in #35 and dashboard
presentation is connected through #36; absence of live-device or browser
validation does not mean collection stopped.

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
before quiet-air, foreground work and errors. A fresh guest login plus four
enabled data components costs at least **five slots per target**, so an isolated
first sweep of 100 targets requires at least **500 minutes (8h 20m)**. This is a lower bound,
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
the original status/sensors/neighbours components, default-off capture/bot behavior, busy air, rejection paths,
timeouts, both auth/data save failures, stop at ACK/reply waits, ten crash
boundaries, clean/abrupt restart, and closed-backup restore. No operator secret,
real socket, radio login, physical device contact edit or deployment is exercised.
Pinned protocol fixtures establish code behavior; #37 owns separately authorized
named-device/RF/soak proof and rollout readiness.

Each completed telemetry scheduler attempt is retained in
`telemetry_request_diagnostics`, including preflight deferrals that never send an
RF request. The record captures operation and phase, selected route candidate and
evidence/support, contact inventory size and result, target-contact result,
contact synchronization action (including a table-full eviction), actual
dispatch mode, and terminal status/reason. Read bounded retained records through
`GET /api/metrics/telemetry/diagnostics`; the Repeaters dashboard renders these
attempt records beside the observation/outcome summaries.

`dispatchMode: direct` means direct packet mode using the target's configured
outbound contact path; it does not mean a zero-hop route. The selected hop list is
shown separately. `No validated path` means the request was deferred without
changing the device contact. Use request IDs from structured logs to correlate
radio recovery details with the retained dashboard attempt. Historical coverage
is retention-bounded and cannot reconstruct attempts from before this migration.

Outbound routes are anchored only by a recent successful direct telemetry
exchange with a repeater. Verified adverts and passive message paths seed route
candidates, but direct reception alone does not make a repeater eligible as the
first outbound hop. Before the contact table is changed or guest login is sent,
the selected route is traced using two-byte repeater identifiers. A matching,
structurally valid TraceData response is required. Trace timeouts retry the
same exact path three times; the fourth timeout suppresses that path temporarily
and permits another candidate. A guest-login timeout does not by itself
disqualify the route because the failure may be on the response/return
direction. Routed responses receive a minimum wait of four seconds plus five
seconds per contact hop, bounded by
`PACKETCAPTURE_REMOTE_REQUEST_RESPONSE_TIMEOUT_MAX_MS` (45 seconds by default).
Contact paths exclude the target; the actual trace contains the outbound relay
IDs, the target's two-byte ID, and the relay IDs in reverse order. For example,
contact path `[A001, B002]` to `C003` is probed as
`[A001, B002, C003, B002, A001]`. A direct contact path `[]` is probed as
`[C003]`, allowing that repeater to forward the trace back to the observer.
The command has a ten-byte header (command, four-byte tag, four-byte zero auth,
two-byte-hash flags). A matching `Sent` acknowledgement must arrive before a
trace response is accepted; a command rejection fails immediately as
`command-error`, and a missing acknowledgement resets uncertain command ownership.
Replies must echo the complete requested loop and contain exactly one SNR per
hash plus the receiver's SNR. The radio adapter corrects the installed SDK's
multi-byte SNR decoding without changing the SDK package or its prototypes.
Round trips are bounded to 15 outbound relays to preserve the existing 32-hash
and 33-SNR diagnostic limits; longer, repeated, target-containing, or self-containing
contact paths defer as `ineligible` before reserving or transmitting a probe.
Diagnostic `routeCandidatePath` remains the outbound contact path;
`tracePathHashes` contains the full returned loop. A non-null `dispatchedAt`
records handing a command to the companion; `command-error` and `ack-timeout`
do not establish that a packet was transmitted over the air.
The zero-hop target is the bootstrap case: a fresh direct advert can seed its
own trace and telemetry attempt, and only a successful direct telemetry result
promotes that repeater into the first-hop anchor set. Candidate ranking gives
each relay a position-specific support count; a strong second-hop record does
not promote that relay into first-hop eligibility. The dashboard displays the
selected route's anchor and position weights.

A completed `guest-login` diagnostic records a completed login exchange; it is
not a telemetry observation or query outcome. The Repeaters table labels this
state explicitly. A successful login is useful target-specific
request/response evidence, while route-anchor promotion still requires a
successful direct telemetry exchange. Route support counts describe observed
traffic and do not predict that every target on a route accepts guest login or
returns a response.

For route ranking, count recent successful trace responses against the exact
requested two-byte contact-path token at each position. Compare direct
telemetry anchor successes first, then trace-success counts from hop one outward,
then fresh decoded neighbour reports, then passive path receptions at the
corresponding position. A neighbour report can seed exactly one additional hop:
append the reporting repeater's unique two-byte ID to the trace-confirmed path
used to query it. Resolve the reported target prefix to one known repeater,
require the report and its heard-age to be within the evidence window, and reject
ambiguous identities, loops, stale reports, unanchored reporter paths, and paths
beyond the configured radius. The resulting candidate is traced independently
before contact synchronization or login; a neighbour report is a route seed, not
proof of a working return path. Keep its support count separate from message-path
receptions in diagnostics and the dashboard. TraceData-returned hashes and SNR
remain diagnostic measurements; they are not resolved as normal repeater
identities. A guest-login response never contributes to first-hop anchor or
trace-success weights.

## Neighbour-led inside-out polling — 2026-10-26

The polling strategy now uses neighbour reports to grow the candidate set,
rather than using those reports only as a route fallback for targets already
eligible from adverts or passive paths. No new setting is required when polling
and the `neighbours` component are enabled.

1. Fresh reporter-scoped direct advert evidence bootstraps nearby candidates.
   A successful direct telemetry exchange is still required before a repeater
   becomes the first relay of an outward route; a login alone is insufficient.
2. Candidate scans visit the minimum evidenced distance first and use the full
   key as a stable tie-break. Within a target, due components are considered in
   `neighbours → status → sensors → owner-info` order. Existing phases, refresh deadlines,
   retries and authentication cooldowns are preserved. This prioritizes a due
   neighbour query; it does not force an early refresh.
3. A fresh decoded neighbour response from a proven reporter can add a known,
   uniquely resolved repeater even without an independent passive receipt of
   that destination. Append the reporter to the exact trace-confirmed path used
   to query it. A direct reporter needs no preceding relay path. Each report
   extends one layer; expanding through the new repeater requires a successful
   exchange with that repeater and its own neighbour report.
4. The destination counts toward the radius: `[E85C]` reaches a target at
   distance 2, and `[E85C, 9905]` reaches a target at distance 3. Reject unknown
   or non-repeater identities, collisions (including other node types), the
   observer itself, repeated nodes, anomalous runs, untraced reporter routes,
   future/stale reports and entries whose reported heard-age reaches the stale
   cutoff. Full-key neighbour identity does not waive two-byte route ambiguity.
5. The selected route still passes the independent trace and all shared owner
   checks before contact synchronization, guest login or data dispatch. Fresh
   signed advert routes retain their normal preference. A long signed route can
   now fall back to a valid shorter topology/neighbour path within the radius.
   Independently supported alternatives remain available when a failed path is
   temporarily suppressed. Equally supported alternatives retain the existing
   conservative tie rejection.

Scanning continues outward before wrapping to the nearest layer, so due outer
targets and status/sensor components retain turns. A successful login continues
its exact selected component on the next admissible tick. New or changed
evidence behind the cursor is considered on the next sweep. Candidate pages
remain capped at 16, and neighbour expansion reads at most the 512 newest
qualifying saved pages per lookup. These limits and the configured bounded
neighbour page make coverage a lower bound, rather than a complete mesh graph.
The scheduler expands one collected layer at a time; it does not issue an
unbounded recursive walk or RF catch-up batch.

Fresh decoded neighbour entries now guide both target and route priority. An
entry with SNR at or above 0 dB is a strong candidate; a lower SNR is a weak
fallback. At equal distance, strong candidates are scheduled before weak ones,
and route selection compares trace success before neighbour strength. A
passively suggested route whose last relay has a fresh, complete, uniquely
resolved single-page neighbour report that omits the destination is ranked as
likely impossible, but retained as a last-resort route. Absence is unknown when
the report is stale, partial, paginated, ambiguous, or otherwise incomplete.
This is directional evidence from the reporting repeater's neighbor list; a
message path alone does not establish the return direction. Existing route
trace and owner checks still decide whether a selected route is usable.

The neighbour-frontier pivot reuses existing SQLite observations and diagnostics;
that pivot added no migration, public HTTP/MQTT contract or dependency. The later
owner-info component is covered by migration v21 and existing generic telemetry
reads. The distance/priority/key cursor is internal scheduler bookkeeping.
Restart an already-running telemetry instance
to load the change, preserving its database and configuration. Saved evidence
keeps its original time, and saved deadlines are not reset. Port 3000's
publication/bot instance does not need telemetry enabled for this change.

## Timing references: repeater login state and response waits — 2026-10-26

The ten-minute Observer guest-session lifetime is a local authorization-cache
deadline. It is not a negotiated repeater expiry. The one-minute remote-request
spacing is also Observer policy, separate from the time allowed for a reply.
The current soak's four login-to-neighbour gaps were approximately 60, 60, 80
and 90 seconds, explained by shared rate limits, ten-second ticks and quiet-air
deferrals. These measurements do not establish a remote session timeout.

Primary protocol/source references inspected:

- [Official Companion protocol](https://github.com/meshcore-dev/MeshCore/blob/main/docs/companion_protocol.md):
  local command handling commonly uses five-second waits. The SENT response
  includes a separate suggested timeout as a uint32 millisecond value.
  Local command acknowledgement is distinct from an over-the-air answer.
- [Companion timeout calculations](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/examples/companion_radio/MyMesh.cpp):
  the inspected direct-route estimate is `500 + (6 * A + 250) * (N + 1)` ms,
  where `A` is the outgoing packet's estimated airtime in milliseconds and `N`
  is the relay hash count. The flood estimate is `500 + 16 * A` ms. These are
  estimates, not guarantees that a larger response or congested return path
  will finish within them.
- [Repeater login/request handlers](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/examples/simple_repeater/MyMesh.cpp)
  and [client table](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/src/helpers/ClientACL.cpp):
  no fixed sixty-second guest idle-expiry check was found in the inspected
  stock repeater implementation. Login establishes client-table state; a full
  table may replace its least-active non-admin entry. Guest state is not
  persisted across reboot. The repeater sets the legacy recommended keep-alive
  field to zero.
- [Maintained-connection helper](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/src/helpers/BaseChatMesh.cpp):
  a separately started keep-alive connection expires after 2.5 times its
  configured keep-alive interval. This is not a universal repeater guest-login
  deadline; the Companion starts that maintained connection only when a login
  reply advertises a nonzero interval.

In separate-request mode, Observer uses the greater of the Companion estimate plus one second
and a routed minimum of `4000 + 5000 * relayCount` ms, capped by the configured
response maximum. Thus the observed two-/three-relay neighbour queries waited
14/19 seconds. Neither those waits nor the local ten-minute lifetime is a
protocol-mandated remote timeout. Raising only the maximum does not increase
14/19-second waits when the selected estimate/minimum remains below that cap.

These source findings do not attest the exact build, client-table pressure or
return path of each deployed repeater. A fixed sixty-second session-expiry
explanation is unsupported by this source check. The next proposed diagnostic
step is a bounded longer neighbour-response window, with unchanged RF send
limits and evidence that distinguishes delayed responses from silence. No
runtime setting, authentication policy or response window was changed by this
documentation investigation. The subsequent authorized implementation below
changes exchange pacing and collection waits.

## Bounded trace/login/collection exchanges — 2026-10-26

The operator approved moving network-settling time after the related requests.
Previously, a successful login consumed the same one-request-per-minute budget
as the following collection. The first restarted run showed 60–90-second gaps
and repeated `rate-limited` deferrals before collection. The new target exchange
keeps dependent requests together while retaining the same guest-proof,
eligibility, trace, contact, foreground, quiet-air and persistence checks.

An exchange admits one target under the ordinary shared budget, validates its
route, traces it and sends guest login after the successful trace and short
step/quiet-air checks. A successful proof must be saved before the next due
collection can run. Due components use `neighbours → status → sensors → owner-info` order,
each at most once in that exchange. Successful collections advance to the next
due component on the short exchange tick. Future refresh deadlines are never
pulled forward. An already-valid guest session still uses the existing exact
contact/session checks. No new credential, role or management permission is
introduced.

| Environment suffix after `PACKETCAPTURE_TELEMETRY_POLL_` | Default | Bounds / meaning |
| --- | --- | --- |
| `EXCHANGE_MAX_REQUESTS` | 6 | 1 restores separate-request mode; 2–6 caps physical RF attempts per exchange, including trace, login, data and failed writes |
| `EXCHANGE_WINDOW_SECONDS` | 300 | 30–600; no new send permission after the bounded exchange window |
| `EXCHANGE_STEP_SECONDS` | 1 | 1–10; minimum RF step spacing and scheduler continuation tick |
| `EXCHANGE_REST_SECONDS` | 60 | 10–3,600; minimum post-exchange remote cooldown |
| `RESPONSE_WAIT_SECONDS` | 60 | 5–120; desired minimum collection response wait, still capped by the shared response ceiling |

The shared budget creates a private pacing capability tied to the exact target,
Observer identity, connection generation and original configuration. It grants
no authentication authority. Other remote targets/producers cannot spend its
credit. Normal foreground traffic keeps priority; capture, local reads and bot
replies continue. Region-discovery fairness resumes after the bounded exchange
and its cooldown. Stop, generation/identity loss, clock disagreement, exhausted
credit, expiry or persistence failure closes the exchange. An already-sent
request retains its bounded response/recovery owner until termination.

Every exchange RF write is charged immediately, including the trace and failed
writes. After the exchange ends, the shared remote cooldown is at least:

`max(exchangeRestMs, usedAttempts * max(minIntervalMs, ceil(60000 / maxPerMinute)))`

With the default one-per-minute policy, trace + login + one query owes at least
three minutes **after completion**. Trace + login + all four due components
owes at least six minutes. These are repaid turns, not an additional allowance
of six requests every minute. Quiet-air checks can add delay within the exchange.
An exchange with no RF dispatch spends no credit. Budget credit/debt is
process-local, like the existing shared budget; reconnect does not reset it.
A process restart creates a fresh initial budget delay and restores no exchange
or guest authority. Durable component deadlines/attempts remain in SQLite.

Collection response wait is now the maximum of the requested response floor,
the Companion estimate plus one second and the existing hop-aware allowance,
capped by `PACKETCAPTURE_REMOTE_REQUEST_RESPONSE_TIMEOUT_MAX_MS`. Login and
trace retain their own existing wait calculations. The checked-in shared
ceiling remains 45,000 ms, so the 60-second requested floor is capped at
45 seconds unless the operator raises that ceiling. Port 3003's local setting
was changed from 45,000 to **90,000 ms for its next startup**, allowing the full
60-second collection floor and larger estimates up to 90 seconds. Its running
process was not restarted or changed by the agent.

Retry behavior remains bounded and durable. A failed collection ends the
exchange, applies the shared cooldown and preserves its failed outcome. It is
eligible for another separately identified attempt only after its saved
exponential backoff (default 15 minutes, capped at 360), with at most three
attempts per component cycle by default. Exhaustion waits for refresh; unsafe
authentication retains the longer target cooldown. There is no immediate RF
retry loop, deadline reset or replay of an old tagged request. The retry test
demonstrates a later successful attempt with a new request identity while
retaining the failed attempt.

This follow-up changes pacing and scheduling through the existing owner/store
seams. It introduces no migration, dependency or public HTTP/MQTT change. Existing
separate-request regression cases explicitly select `EXCHANGE_MAX_REQUESTS=1`;
new default-mode real-startup and real-owner scenarios cover prompt collection
of the original three data components, delayed replies, cooldown repayment, retained retries,
foreground priority, unsafe proof, failed persistence and generation loss.
The agent performed no live RF test or process restart for this implementation.
