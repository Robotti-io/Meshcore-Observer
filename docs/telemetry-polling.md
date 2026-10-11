# Telemetry polling configuration

Delivered phases: **#34 T1 startup contracts and T2 pure protocol helpers**.
The shared radio login owner, scheduler and active collection are later phases.
Setting `PACKETCAPTURE_TELEMETRY_POLL_ENABLED`
does not yet activate radio traffic. Saved telemetry freshness and shared history
retention continue to operate independently.

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
mistaken credential; later phases will stop further queries on unsafe role proof.
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

Assignments choose credentials/profile interpretation only. They never make a
target eligible, prove a route or authorize a management command. Those gates
arrive in the subsequent approved phases. Guest firmware may expose only battery
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

T1/T2 add no store migration, live session/login, poll timer, route change or
telemetry request. T2 validates protocol/contact shapes; T3 adds the guarded shared owner;
T4 adds durable state; T5 wires opt-in collection; T6 proves offline acceptance.
Live radio/device validation and deployment activation remain separately scoped
under #37. Authentication prefix/static-tag correlation limits are recorded in
the approved #34 plan and will not be presented as nonce-based replay proof.

## Pure protocol/contact checks (#34 T2)

The new helpers are not connected to the radio owner. They prepare only a full
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
