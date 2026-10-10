# Telemetry contracts, decoding, owned storage and reads — #33 T1–T5

These internal contracts define the inputs to the pure decoders and owned
telemetry store. T1 supplies contracts/configuration, T2 the pure parsers, and
T3 migration 16 and owned writes/retention, T4 bounded internal reads, and T5
offline lifecycle/compatibility proof. No poller or public API is installed.
All schemas live in `src/telemetry/telemetry-schemas.js`; use
`assertTelemetryInput`/`assertTelemetryResult` from `telemetry-validation.js`
so strict shared AJV validation always precedes semantic checks. Errors contain
only `Invalid telemetry data`, never supplied fields or values.

## Request, response and identity

A raw decoder input contains a validated typed `variant` and a byte array of
1–170 post-tag response bytes. Sensors also require an explicit emitter profile.
It is a previously correlated response, not an arbitrary legacy push. A terminal
result contains decoder version 1, one outcome and, for answered/partial states,
one observation. The outcome owns the UUID request/run, full uppercase
64-character reporter/target keys, original dispatch/receipt/completion times,
route, Companion tag, typed variant and anomaly flag. Observation receipt time
and variant must match that outcome; provenance is `companion-tag-attributed`,
not independent repeater authentication. No secret, raw error, location, SQL,
opaque response archive or credential reference is accepted.

`answered` requires quality `decoded`; `partial` requires `prefix-only` or
`partial` quality. Both require a tag, route and measurement receipt time.
`failed`/`unsupported` carry fixed reasons and no observation. A timeout is a
failed attempt, not proof of unsupported hardware. Inverted wall times require
an explicit anomaly flag and remain original evidence; later storage must not
advance latest pointers from them.

The canonical scope key is generated only from validated fields. Status keys
include layout **and evidence**: `status:common48:unknown` is distinct from
`status:common48:established`, because the former cannot certify fully decoded
quality. Sensors key on requested permission mask. Neighbours key on exact
version/count/offset/order/prefix width. No caller-supplied string key is accepted.
Emitter profile remains explicit sensor observation metadata, not another poll
permission or a claim that sensors are complete. Object property ordering does
not change a key.

## Supported values and quality

Frozen field tables specify widths, signedness, endianness and units. Status
uses the reviewed common 48-byte prefix; only **established current56** allows
the final two uint32 fields. Unknown evidence reads the common prefix, requires
`prefix-only` quality, records an uninterpreted suffix and leaves both extensions
null. Status body bounds are 48–71 unknown, 48–63 established common48, and
56–71 established current56. Body length/zero padding never selects a profile.
RSSI/noise/SNR stay signed; error flags are a bitmask. SNR retains quarter-dB raw
value and exact division by 4. Zero is valid; missing is not zero.

Sensors initially accept voltage (116, signed16 /100 V), current (117, signed16
/1000 A), temperature (103, signed16 /10 degC), humidity (104, uint8 /2 %) and
pressure (115, uint16 /10 hPa). Signed voltage/current follow the pinned actual
CayenneLPP 1.6.1 encoder. Preserve raw value, divisor, unit, channel, wire record
order, zero-based repeated channel/type occurrence and byte offset. Values
follow complete wire ranges, without guessed calibration/ambient/battery claims.
At most 56 readings fit the host body. Supported values cannot be null or
fabricated for absent readings. Unknown emitter profiles cannot certify decoded
quality or padding. GPS/location fields are excluded. Partial diagnostics use
fixed codes and bounded type/offset/remaining-byte metadata, never remainder
content. Unsupported-only and valid empty responses remain different states.

Neighbour pages retain reported total, exact received count and at most 27
ordered entries. Prefix length matches the original request even for full
32-byte remote-reported identities. Relative age is uint32 remote arithmetic,
not a host last-heard timestamp. SNR is signed8 quarter-dB divided by 4. Received
counts fit the requested count, reported page range and actual consumed width.
An empty page at nonzero offset can coexist with a nonempty remote table. No
verified inventory, reachability or stitched complete topology follows from it.

All observations have `coverage: response-only`. Even `decoded` does not certify
complete physical sensors or remote inventory. Byte accounting is exact:
`bodyBytes = decodedBytes + paddingBytes + uninterpretedBytes`. Padding is at
most 15 bytes; it cannot coexist with an uninterpreted suffix. Fully decoded
sensor records cannot hide gaps/skipped records. T2 validates actual fixed
widths, suffix bytes and truncation before producing these normalized DTOs;
typed metadata alone cannot certify a raw response was correctly parsed.

## Pure parser interface — T2

`parseStatusResponseBody`, `parseSensorResponseBody` and
`parseNeighbourResponseBody` live in the corresponding small modules under
`src/telemetry`. Each accepts the strict central `telemetryParseInputSchema`:

```js
{
  response: {
    variant: {
      component: 'sensors',
      params: { permissionMask: 0 }
    },
    emitterProfile: 'positive-channels',
    body: [1, 116, 1, 74]
  },
  observedAt: 1500
}
```

The caller supplies previously correlated post-tag bytes and the original local
receipt time. The wrapper adds that time without changing T1's raw response
contract. Each parser validates the entire input before buffer allocation/read,
requires its own component, and validates the detached normalized observation
again before returning `{status: 'accepted', observation}`. Quality determines
whether a future owned outcome is `answered` or `partial`; an accepted partial
observation never certifies complete decoding. No parser reads the clock,
discovers identity, authenticates, sends RF, persists or logs data.

Invalid input, contradictory counts, a truncated known field or invalid padding
returns only `{status: 'malformed', reason}`. Reasons are fixed: `invalid-input`,
`wrong-component`, `truncated-field`, `invalid-counts`, `invalid-padding` or
`invalid-observation`. There is no partial observation on a malformed result and
no raw bytes, exception string, prefix sample or secret in an error. Future
request handling maps a malformed decode to the fixed `malformed-response`
outcome rather than treating it as evidence of unsupported hardware.

Sensor zero padding is recognized only at complete record boundaries with the
reviewed positive-channel emitter profile and an all-zero suffix of 1–15 bytes.
Unknown profiles keep known positive-channel measurements explicitly partial;
they never certify padding. A lone trailing zero under an unknown profile stays
uninterpreted, while a nonzero incomplete header fails. A channel-zero record or
an overlong zero suffix stops with ambiguity metadata. Width checks for known
fields precede channel ambiguity, so a truncated known sensor/GPS field rejects
the whole response. Empty supported/padded data remains distinct from partial
unsupported-only, excluded-only or ambiguous data.

Only reviewed fixed-width GPS type 136 can be skipped by this initial parser.
It stores type/offset/remaining-byte exclusion metadata and continues later
supported records without reading GPS values. Wire order includes skipped
records; repeated channel/type occurrences count supported readings. If a later
unknown type/channel stops parsing, its stopping diagnostic takes precedence
over earlier exclusion metadata. Retained byte offsets/order and partial quality
still disclose gaps; skipped values and arbitrary remainder bytes are absent.

Status established profiles validate a bounded all-zero suffix after every
structural field; unknown profiles preserve the unresolved suffix as count-only
metadata and decode the common prefix only. Neither strips structural zeros nor
requires a universal post-tag modulo-16 length. Neighbour header relationships
and the complete expected entry budget are checked before the first entry is
read. A single page's order, total, relative ages and request parameters survive
unchanged; there is no page stitching or inventory upsert.

Fixtures in `test/fixtures/telemetry-wire.js` are synthetic byte examples from
the pinned sources, independent of production width tables. They establish
local decoder behavior, not deployed firmware, ACL access or real RF support.

## Configuration and reads

`PACKETCAPTURE_TELEMETRY_FRESHNESS_HOURS` defaults to 72 in code and `.env.example`.
Whole-hour overrides 1–8760 normalize to `telemetry.freshnessWindowMs` in central
configuration. Explicit empty, fractional, nonnumeric or out-of-range values
fail startup. Freshness changes observation-age interpretation only; it enables
no RF activity or pruning. Shared metrics history retention remains 0/unlimited
by default regardless of the UI flag; T3 applies it to telemetry history while
protecting both latest pointers and their required source runs.

Latest input requires full reporter/target, typed variant, `now` and whole-hour
window. Range inputs require millisecond `[start,end)` boundaries and optional
typed scope/run/component/variant filters. A component/variant mismatch fails.
Page limit is 1–200, offset 0–2,147,483,647; omitted limit means the future read
implementation's 100-row default. Empty equal boundaries are valid. There are no
SQL fragments or unbounded result requests. Reads are contracts only until T4.

A normalized terminal result's canonical UTF-8 JSON must be at most 16 KiB.
The current closed shapes and wire/item limits bound legitimate payloads below
this ceiling; maximum supported fixtures verify that. The explicit byte guard
also protects later schema evolution. This bound applies before persistence,
not as a promise about total retained database size.

## Owned transactional storage — T3

The always-on MetricsStore applies migration **16** at startup, independently of
the optional UI. It adds `telemetry_query_outcomes`, `telemetry_observations` and
`telemetry_latest` with scope/time/run indexes, CHECKs and foreign keys. Existing
datasets are unchanged; migration creates no invented samples. A migration
failure rolls back its tables/indexes/version and fails startup before hardware
or network services. It never opens a second database or installs a dependency.

`MetricsStore.recordTelemetryResult(result)` validates the full strict result
before a transaction and requires the active owned running source run. A merely
reopened store has no mutation authority. One transaction writes the immutable
outcome, optional bounded normalized observation, receipt-collision evidence
and both latest pointers, or rolls all of them back. Decoding stays pure and
collection is still #34; T3 supplies no new producer or background timer.

Replaying an identical request/result is idempotent, regardless of object key
ordering. Changing immutable context, times, route/tag, variant or measurement
content under that UUID fails with a fixed identity-conflict error. Array order
remains meaningful. Replay also validates saved content; corrupted normalized
data cannot be silently accepted or leaked through an error. Neither failures
nor unsupported results insert an empty observation or modify latest pointers.

Each full reporter/target/component/canonical-variant scope keeps the latest
useful observation and, independently, the latest fully decoded observation.
An initial partial scope has no fabricated decoded pointer. A newer partial
reply may replace useful data while the older decoded observation retains its
own original receipt time. A late decoded reply can advance the decoded pointer
without replacing a newer partial useful observation. Fields are never merged
or refreshed across observations, and decoded quality remains response-only.

Ordering uses original receipt time and then lexicographic request UUID for
deterministic ties, not commit/arrival order. Any distinct request at the same
scope/receipt time marks every retained peer ambiguous, even for identical
values. The ambiguity flag survives pruning of other peers; a later uniquely
timed observation can become the next useful snapshot. Request replay does not
create a second observation or manufacture a collision.

Explicit request-clock anomalies/impossible receipt ordering stay history-only.
A source run with a known clock anomaly or a request predating its source run
also cannot advance either pointer; original flags/times stay unchanged and
`latest_eligible` records this conservative derived guard. T3 does not read the
current clock: an ordered original timestamp that becomes future-dated relative
to a later read is preserved, with truthful freshness interpretation owned by T4.
Composite foreign keys prevent latest from pointing into another scope, into a
history-only observation or, for the decoded pointer, into partial-quality data.

Shared pruning runs child-first in the existing store transaction. Only
unreferenced observations whose receipt **and** completion are strictly before
the cutoff can be removed; cutoff equality stays. Unreferenced outcomes require
completion and any available receipt to be strictly older too. Both latest
observations, including old/stale/empty snapshots, and their outcome/source run
remain protected. Source-run pruning discovers the new run foreign key through
the existing guard, so clean or unclean runs disappear only after all retained
children are gone. Failure in telemetry or another dataset's shared cleanup
rolls back all attempted deletions. Save-first retention can deliberately keep
data older than the configured history duration; it is not a disk-size cap.

The internal range/latest read contracts are implemented in T4; T5 proves integrated entrypoint
backup/restart/operational acceptance. T3 fixtures prove isolated
fresh/older-schema upgrades, transaction failures, reopen ownership, source-run
protection and prune behavior; they do not complete #33 or establish live RF.

Primary-source pins, protected storage/retention decisions and remaining task
boundaries are recorded in the [approved #33 plan](pillar-1-issues/p1-12.md).

## Bounded internal reads (#33 T4)

`getTelemetryLatest({ observerPublicKey, targetPublicKey, variant, now, windowMs })`
requires full uppercase keys, a typed exact variant and an explicit original
wall-clock read time/freshness window. Supply central configuration's
`telemetry.freshnessWindowMs` (omitted runtime default 72 hours); reads do not
read environment variables or choose their own policy.

The result contains `observation` (nullable latest useful), `fullyDecoded`
(an independently aged object with its own nullable `observation`) and nullable
`latestOutcome`. Both observation views supply `freshness`, `fresh`, `ageMs`
and `futureDated`. Freshness is `unknown` without an eligible pointer, otherwise
`ambiguous` for retained equal-time collisions, `future` when receipt is after
the caller's `now`, `clock-anomaly` for known request/source-run anomalies,
`stale` when age is **at least** the supplied window, and `fresh` otherwise.
These states describe time confidence; observation `quality` and response-only
`coverage` remain independent. A history-only anomaly never manufactures a
latest value. A run that becomes clock-anomalous after an earlier save is also
disclosed through `sourceRunClockAnomaly`, separately from the original request
flag. The read returns both original observation context and its original
`outcome` (identity, dispatch/completion/receipt, route/tag and terminal state).

Age uses `effectiveNow`, the greater of validated `now`, this read model's
process high-water mark and durable observer-run `last_known_alive_at`. A lower
`now` sets `clockRollback` and cannot rejuvenate expired data. Durable run time
protects reopen/restart too; the process-only read high-water is not persisted
by a read. Future-dated observations keep original timestamps and null age.
No fields merge across replies, reporters, layouts/evidence, permission masks
or neighbour page/order/prefix parameters. A newer failure/unsupported outcome
can accompany an older useful/decoded observation without erasing it. Latest
outcome means greatest original completion time, then request UUID; it does
not claim arrival order or successful/current delivery.

`queryTelemetryObservations` and `queryTelemetryOutcomes` require explicit
millisecond `{ start, end }` with **[start,end)** semantics; equality is an empty
range. Observations filter by original receipt, outcomes by original completion.
Optional filters are `observerPublicKey`, `targetPublicKey`, `runId`, `component`
and typed `variant`; only outcomes accept terminal `status`. Original shape is
strictly validated before SQL or defaults. `limit` defaults to 100, maximum 200;
`offset` defaults to 0, bounded to 2^31-1. Observation ties use stored ID;
outcome ties use request UUID, both descending after their own original time.
History records expose original times, quality and anomaly/eligibility flags;
they do not claim current freshness without a read time/window.

Each page returns `total` within the retained filtered range, `countScope:
'retained-range'`, range/page metadata and `coverage`. Latest coverage is its
exact observation scope. Page coverage describes all retained records under
its filters, independently of the selected range/page: `retainedRecords`,
nullable `earliestRetainedAt`/`latestRetainedAt`, `retainedHistoryOnly:true` and
`historyCompleteness:'unknown'`. Empty counts are evidence counts, never zero
measurements. Pruned history and protected snapshots are not complete lifetime
coverage or time-weighted averages.

SQL uses fixed columns and bound values. A materialized ID page precedes JSON
lookups, so count/coverage/deep-offset work never hydrates skipped observations.
The outcome join is deferred until after receipt paging unless a run filter
requires it. At most 200 closed normalized observations are decoded, each with
T1 byte/item bounds. Returned objects are detached; changing one cannot alter
the store. Invalid caller data uses `Invalid telemetry data`; invalid stored
JSON/context uses `Invalid stored telemetry data`, without exposing values.
Sensor validation uses shared AJV conditional dispatch to the same disjoint
closed type branches; equivalence tests preserve the former oneOf acceptance
contract while avoiding validation of every other sensor type per reading.

No new migration, endpoint, dashboard, aggregation, producer, credentials or RF
activation accompanies these internal reads. T5 verifies integrated entrypoint,
backup and final feature acceptance; #34/#35/#36/#37 keep their separate scopes.

## Offline operation, upgrade and recovery (#33 T5)

The dataset belongs to the always-on Observer store, independently of internet,
broker connections and the optional dashboard. A fresh installation and
synthetic upgrades from schema 13, 14 and 15 reach schema 16 without inventing
telemetry or losing saved capture/inventory/topology evidence. Existing schema
16 installations retain telemetry across clean shutdown and abrupt process
death. Restart creates a new run while saved request/run/reporter/target IDs,
receipt/completion times, variants, units, partial/empty/failure data and both
latest pointers remain original. Unclean runs describe observed lower bounds;
restart does not assert success for an interrupted remote request.

No telemetry producer runs in this feature. Supported normalized data is saved
only when submitted through the owned store seam; #34 will establish deployed
profile/permission/route context and collection policy. T5 tests use source
derived synthetic byte fixtures and test-only radio substitution around the
real entrypoint. They make no deployed firmware, RF reachability, guest access,
container performance or downstream ingestion claim; #37 retains that proof.

The normal sampler applies `PACKETCAPTURE_METRICS_UI_RETENTION_DAYS` regardless
of dashboard/broker state: **0 means indefinite**; positive values opt into
days-based historical pruning at its existing maintenance cadence. Code and
example defaults match. Protected latest useful and latest fully decoded
records, outcomes and source runs remain even when stale or empty. Pruning may
remove old unreferenced failures while preserving the snapshot's owning
outcome; consequently `latestOutcome` means latest **retained** outcome, not an
immutable last-attempt ledger or proof that no later failed attempts existed.
`historyCompleteness:'unknown'` remains honest after pruning. Additional exact
variants/reporters and both snapshot types can grow retained volume; monitor
free space. Pruning is synchronous maintenance and usually frees SQLite pages
for reuse rather than shrinking the database file. Unlimited save-first
retention and protected snapshots are not a global disk cap.

For an upgrade/backup, stop every Observer using the volume, confirm orderly
closure and preserve a consistent closed, checkpointed database with the
matching application version/configuration. Do not copy only the main database
while a live WAL may contain committed data, delete sidecars to force a backup,
lower `user_version` or remove tables. T5 proves a file copy only **after** the
synthetic Observer closed and its WAL disappeared; restore uses the real
entrypoint on an isolated temporary path and verifies original data/source
identity and foreign keys. Keep the upgraded data before any rollback/restore;
an older backup cannot contain observations accepted after it was taken. Start
only one writer against the restored volume, using SQLite-compatible local
locking/WAL storage. No online backup/export or production restore is added.

Explicit invalid freshness values fail configuration before database creation,
hardware or network startup; omission defaults to 72 hours. Unopenable/corrupt
storage and migration failure are fatal before radio/broker/HTTP lifecycle.
Migration failure rolls back the schema/version and releases ownership, so an
operator can preserve the database, diagnose the reported cause and retry
after repair. A competing writer gets the existing clear one-Observer/close
SQLite-tools/restart message. Do not purge saved data to resolve an ownership
lock; locks release when the owner exits. Normal passive capture/resource
sampling continues alongside retained telemetry. These checks introduce no
new configuration, storage migration, RF/auth/API, logging or deployment change.
