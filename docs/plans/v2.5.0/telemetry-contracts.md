# Telemetry contracts, decoding and owned storage — #33 T1–T3

These internal contracts define the inputs to the pure decoders and owned
telemetry store. T1 supplies contracts/configuration, T2 the pure parsers, and
T3 migration 16 and owned writes/retention. No poller or public API is installed.
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

The internal range/latest read contracts remain T4, and integrated entrypoint
backup/restart/operational acceptance remains T5. T3 fixtures prove isolated
fresh/older-schema upgrades, transaction failures, reopen ownership, source-run
protection and prune behavior; they do not complete #33 or establish live RF.

Primary-source pins, protected storage/retention decisions and remaining task
boundaries are recorded in the [approved #33 plan](pillar-1-issues/p1-12.md).
