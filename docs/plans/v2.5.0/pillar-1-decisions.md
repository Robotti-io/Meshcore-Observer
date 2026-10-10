# Pillar 1 decisions and open questions

**Owning issue:** [P1-02 — #23](https://github.com/Robotti-io/Meshcore-Observer/issues/23)
**Status:** Discussion in progress; only the decisions explicitly recorded below are settled.

**Current delivery — 2026-10-09:** #30’s finalized five-task plan and REGION-PLAN-01–05 are approved on 2026-10-09 by “Plan pushed and approved. Clear to proceed with implementation.” The planning baseline is user-pushed at 820ec209 / migration 13. T1 strict region parser/data contracts are complete locally: 16 new scenarios, full 68 files / 727 tests, coverage thresholds and lint pass. T2–T5 are approved pending tasks; T2 adds migration 14 and atomic durable results next. #18/#23/#30 stay OPEN/project In progress; #22/#29 stay completed/Done. Whole-feature #30 acceptance stays unchecked, and #31/#32 activation remains separately scoped.

## Remote source findings and proposed coordination — 2026-10-09

Source findings, not new implementation-policy approvals: the Companion clears all remote pending slots when a new request is accepted; legacy prefix/one-shot helpers cannot establish robust request ownership; installed 1.15.0 supports low-level tagged binary reads but lacks anonymous APIs, and [upstream PR #44](https://github.com/meshcore-dev/meshcore.js/pull/44) is still open. Anonymous non-contact requests can create a contact and existing contacts use saved routes. Status/LPP/neighbour fields have version/unit/permission limitations. Region CSV can omit names without a truncation marker. The completed assessment records permanent primary references, proposed fixtures and separately authorized hardware checks (none performed).

REMOTE-PLAN-01–04 are approved for #29: one remote owner beyond ACK, exact listeners/generation guards, bounded recovery and clear warning on ambiguous ACK, foreground priority/no backlog, bounded tag bookkeeping and idle wiring. Shared default/override limits are ACK 5000ms (1000–30000), response cap 30000ms (1000–120000), spacing 60000ms (10000–3600000), attempts/minute 1 (1–6), all whole numbers. T4 implements central defaults/overrides, shared priority/airtime and idle runtime integration; failed physical attempts consume the budget and reconnect cannot reset it. T1 implements only strict bounded read contracts and fixtures. Future #31 must review the conservative existing-zero-hop-contact-only recommendation; #30/#32 still own empty/unknown/partial/latest/history/publication state, and #34 owns guest-only authentication. Those remaining protected integrations are not authorized by #29 approval.

T2 delivery: generation-checked execution and cancellation races release abandoned queue transactions; obsolete handshake/packet/channel callbacks cannot update a replacement connection. Recovery requires observed disconnection within a 5000ms infrastructure close bound, since installed serial `close()` can return early. Unconfirmed close halts replacement/restart attempts, logs a stable operator instruction and rejects stop; existing run shutdown retains unclean evidence/force-exit behavior. No public status shape, dependency, storage or logging contract changes. T3 now implements the actual remote lease and acknowledgement timers; T2 adds no polling.

T3 delivery: one remote lease persists beyond Sent while local commands proceed; exact listener/timer cleanup, monotonic phase deadlines and a 32-entry retired-tag map prevent known stale correlation. Uncertain write/ACK or pre-ACK cancellation uses targeted T2 recovery; a failed reset blocks further remote dispatch. A truthful internal `request-cancelled` recovery reason supports shutdown without changing event/log contracts. T4 now implements priority/airtime/configuration/budget/runtime wiring; T5 integrated validation is complete; see final evidence below.

T4 delivery: initial-delay/minimum-spacing/sliding-minute budget counts physical attempts including failures and survives reconnect. Pending durable replies/adverts win admission and dispatch; airtime is reserved only inside the command callback and released at ACK/termination. Strict AJV settings match code/example defaults; idle startup adds no polls and shutdown drains ownership before radio/storage. Its historical 706-test functional baseline passed; T5 resolves the coverage timing gate below.

## Bot reporting — settled on 2026-10-07

Human direction establishes these requirements for [P1-07 — #28](https://github.com/Robotti-io/Meshcore-Observer/issues/28).

### Usage and outcomes

- Usage means an eligible command accepted after duplicate filtering. Repeated copies of the same message do not increase usage.
- Count usage at Observer acceptance time, not the sender-supplied message timestamp or reply completion time.
- Count successful replies and other terminal outcomes separately at their completion/resolution time. Pending work is not a completed outcome.
- Keep the interaction's acceptance and outcome associated so later detailed reporting can correlate them. A reply completing in a later reporting range does not move its invocation into that later range.
- Reporting collection must preserve existing command eligibility, duplicate filtering, scheduling, and delivery behavior. Queue resumption or retry must not create a new invocation merely because processing resumes.
- Existing sent-reply counts remain delivery measures. Do not fabricate missing sender or acceptance timestamps for legacy records; report unavailable historical evidence explicitly.

Example: ten accepted commands followed by seven sent replies, two expirations, and one failure produce ten uses and separate outcome counts of seven, two, and one. If a command is accepted just before midnight and resolved just after midnight, usage belongs to the earlier day and the completed outcome to the later day. Duplicate receptions add neither another invocation nor another outcome.

### Sender identity

- Use distinct sender names unless a reliable message-to-sender identifier becomes available. Preserve the original received name rather than silently normalizing case, whitespace, or Unicode.
- Ordinary channel-message counts must be labeled as distinct sender names, not verified unique people or public-key identities.
- Duplicate names can represent different senders; a changed name can represent the same sender. Name-only reporting cannot distinguish these cases.
- Do not attach an advert/contact public key based only on a matching name, timing, or repeater path. Those observations do not prove message authorship.
- Backend planning must allow an optional reliable sender identifier and its evidence/source to coexist with the original name. Unknown identity stays unknown; do not invent keys or backfill speculative associations.
- Whether a future supported message type can supply a reliable identity is a capability assessment, not an assumption that current channel messages provide one.

### Backend history and presentation

- v2.5.0 requires aggregate counts by sender, command, bot, and reporting range, retaining channel context where applicable.
- A browsable individual-interaction interface is deferred. Individual interaction data collection and durable backend support are included now so future browsing has historical data to use.
- Plan individual records with a stable interaction reference, acceptance timestamp, original sender name, bot/channel context, command/trigger, packet hash/reference, and associated lifecycle outcome, resolution timestamp, and queue duration where available. Allow reliable identity evidence where available.
- Reuse or extend existing durable reply records in the always-on MetricsStore where sufficient. Do not assume new parallel tables are necessary before reviewing the existing model.
- This is structured interaction history, not a local raw-packet archive. Complete message/reply bodies and additional command arguments are not implicitly required; settle any extra content beyond existing validated handler context during schema planning.
- Pending interactions must survive restart; completed history must survive normal queue resolution and remain available according to the shared metrics retention policy.

### Shared retention — settled on 2026-10-07

- Human direction: bot interaction history is retained for the same configured duration as other key historical metrics. The duration must be customizable in runtime configuration; do not introduce an independent bot-history retention duration.
- The existing centrally validated configuration setting, `PACKETCAPTURE_METRICS_UI_RETENTION_DAYS`, currently supplies this duration. Despite its legacy UI name, collection/persistence and retention must remain independent of dashboard enablement.
- Preserve the existing `0` (unlimited) default unless a separate default change is agreed. The human decision settles shared duration and configurability, not a new numeric default or automatic expiry period.
- Pending operational work is not historical data eligible for expiry. Retention must not delete pending replies or disrupt restart recovery.
- Future individual-interaction browsing covers retained history. Pruned records are not promised to be reconstructable from aggregates.
- The implementation plan must specify cutoff timestamps and test acceptance/completion range boundaries; this decision does not change the existing pruning behavior yet.

### Bot implementation contract — approved on 2026-10-08

Human direction, "Approved. Proceed with implementation," approves #28's reviewed plan and BOT-PLAN-01/02/03. Successful durable enqueue is acceptance; rejected/stopped/failed enqueues add no usage. Migration 9 retains existing interaction IDs and adds all-null or complete identifier/kind/source evidence; current channel messages supply none. IDs are database-local and are not reused after pruning from this migration onward.

Completed interactions retain the existing whole-row completion-time cutoff under the shared runtime-configurable metrics duration. Pending rows are protected. Recent completions may retain older acceptance timestamps; retained coverage is not a completeness guarantee. Unknown legacy acceptance cannot be assigned to a requested range and is exposed separately as retained-history availability metadata. Names use exact/BINARY grouping, with unavailable names excluded from distinct-known-name totals.

The existing bot-local transient duplicate filter is preserved. Recovery resumes the original pending interaction without another usage record; persistence does not promise permanent RF deduplication or exactly-once over-air delivery across restart. Strict validated backend aggregates and coverage reads are implemented with bounded pages. Public API/dashboard integration stays with #35/#36, and individual browsing is deferred. #28 validation passes: 508 tests and lint; 20,000-row local indexed aggregate fixture approximately 6 ms. See the owning plan for exact return fields and task evidence.

## Node advert reporting — settled on 2026-10-07

Human direction agrees the presented recommendations for [P1-05 — #26](https://github.com/Robotti-io/Meshcore-Observer/issues/26), beginning with Companion and Repeater reporting.

- Report both distinct advert-event counts and distinct nodes in the selected reporting range. Identify nodes by their full public key, not their display name.
- Count the same signed advert once even if received through multiple repeaters. Preserve the receptions' useful path/direct-heard evidence separately; excluding a duplicate from event totals must not discard that evidence.
- A fresh, distinct advert from an already known public key counts as a re-hear. Multiple distinct adverts from one node are not collapsed to one event per sampling interval.
- Include verified adverts without names, identify those nodes by public key, and display an explicit `Unnamed` fallback. The fallback is presentation, not a fabricated received name.
- Malformed or unverified adverts do not enter trusted inventory, trusted advert counts, or direct-discovery eligibility.
- Distinguish current inventory from historical event reporting. Existing first/last-heard inventory cannot reconstruct every prior advert or every node active in an arbitrary past range. Historical event counts begin with actual collected evidence; do not manufacture legacy events.
- A rename does not create a new node when the full public key is unchanged. Concrete historical handling of names/types, deduplication identifiers, and migrations remains implementation-plan work.

Worked example: one previously unknown node emits three distinct adverts. The report shows three advert events, one distinct node, one newly discovered node, and two re-hears. Relayed copies of those adverts do not increase the event total. Two nodes with the same name and different public keys remain two nodes. A verified unnamed node is included by its key.

### Node-history retention — settled on 2026-10-08

Human direction approves the following approach for #26:

- Historical advert events follow the same centrally validated, runtime-configurable retention duration as other key historical metrics; reuse shared metrics retention configuration.
- Preserve the full-public-key node inventory, known name/type, and first/last-heard information across historical-event pruning. A returning known key remains a re-hear; expiring event history must not turn it into a new discovery.
- Historical range queries reflect retained event evidence. Inventory cannot reconstruct pruned events or establish every node active in an arbitrary past range.
- An inventory entry does not establish current reachability or indefinite polling eligibility. Direct-heard freshness expires separately.
- Preserve the existing unlimited retention default unless separately changed. Concrete event timestamp/cutoff rules, schema/migrations, indexes, and tests remain implementation-plan work; this decision does not implement the feature.

Example: with 30 days of event retention, a node first discovered 60 days ago keeps its inventory identity after older adverts are pruned. Today's fresh advert is a re-hear, not a new discovery. Reports must not claim a complete reconstructed event history for pruned ranges.

### Direct-heard freshness rules — settled on 2026-10-08

Human direction approves these rules for #26 and the consuming OBS-02 poller #31:

- Use a runtime-configurable eligibility window measured from the Observer's reception time, not the repeater's supplied clock or general inventory last-heard time.
- Only verified repeater adverts received with zero recorded relay hops refresh direct-heard eligibility. A relayed reception does not refresh it, and a duplicate excluded from event totals must still be considered for useful qualifying reception evidence.
- When the window expires, stop scheduling region queries until qualifying evidence returns. Preserve the inventory and previous successful answers; expiry is not an empty region declaration or a reason to erase a successful answer.
- Treat advertisement cadence as variable. Operator-provided guidance is one-hour zero-hop adverts and 47-hour flood adverts, but many deployed repeaters use shorter flood intervals and somewhat longer zero-hop intervals. This is supplied operating context, not a guaranteed schedule or a wire-protocol minimum.
- The criterion is zero recorded hops on the received advert, not whether the broadcaster labels its timer as local or flood. A flood advert heard before any relay hops can qualify; a relayed copy cannot establish direct-heard eligibility. Confirm decoding and trust-boundary fixtures in the implementation plan.

**Default duration settled on 2026-10-08:** human direction approves **72 hours**, with an operator configuration override, to avoid eligibility gaps across the cited 47-hour advert interval. This accommodates that interval but does not guarantee direct reachability or uninterrupted coverage after missed adverts. A longer eligibility window can keep older targets in the query rotation; query frequency, retry limits, and RF budgets remain separate decisions. No runtime change has been made.

### Configuration overrides and defaults — settled on 2026-10-08

- Across the release's applicable operational settings, favor operator configuration overrides over fixed feature-module values. Required identity/connection settings and secrets do not acquire invented fallback values.
- Document each approved optional setting's default and units in the relevant example configuration, and define the same fallback in central configuration code when the operator omits that value. For direct-heard eligibility, both must specify 72 hours. An example file documents the default; runtime must not depend on that file being copied or present.
- A valid explicit operator value takes precedence over the fallback. Preserve existing central handling of empty environment values where applicable; invalid explicit values must fail validation before side effects rather than silently falling back.
- Keep defaults authoritative in the centralized configuration layer and pass validated configuration to feature modules. Startup, doctor, and setup must share that interpretation; setup must preserve valid operator overrides.
- Implementation validation must cover omitted-value fallback, explicit overrides, invalid values, and agreement between documented example defaults and code defaults. Exact setting names, units, numeric bounds, and any special-value semantics remain concrete implementation-plan details; no hot reload or new configuration format is approved by this decision.

### Remaining direct-heard and implementation questions

- Direct-heard eligibility rules and the configurable 72-hour default are settled above. Exact units/window bounds, expiry/cutoff, and clock-change/restart handling require implementation-plan fixtures.
- Historical advert-event duration and inventory preservation are settled above. Exact timestamp/cutoff rules and schema/migration/index design remain implementation-plan details.
- Initial reporting starts with Companion and Repeater. Explicitly adding other node types to reporting and choosing their presentation remain separately scoped; preserve existing registry compatibility.

## Evidence checked on 2026-10-07

- [MeshCore payload specification, Group text message](https://github.com/meshcore-dev/MeshCore/blob/727fc0512ce08bfd7b499e46daa7fca6eeec730d/docs/payloads.md#group-text-message): normal group messages carry channel hash/MAC and encrypted timestamp, flags, and name-prefixed text. The sender name is unverified and there is no sender signature.
- Installed `@liamcottle/meshcore.js` 1.15.0, `src/connection/connection.js`, `onChannelMsgRecvResponse`: channel receive events provide channel/path/type/time/text/SNR, without the public-key prefix provided by the separate contact-message receive event. That contact-message field cannot be assumed present for channel bots.
- `src/bots/group-text-crypto.js`, `decryptGroupText`: returns timestamp, flags, sender name, and text after validation; no sender public key.
- `src/bots/channel-bot.js`: matches commands and checks eligibility/duplicates before enqueueing the reply context.
- `src/metrics/store.js`: durable `bot_replies` already retains per-interaction context and lifecycle fields. Current command counts filter sent replies using `resolved_at`; legacy migrated records can lack sender/acceptance evidence.
- `src/config/index.js`: existing metrics retention setting defaults to `0` (unlimited). `MetricsStore.pruneOlderThan` prunes completed replies by resolution time and preserves pending records. Human direction now requires bot history to use the same configurable duration as other key historical metrics.
- `src/nodes/node-registry.js`: current collection requires a named advert and verifies its signature before upserting a full-key inventory record. Unnamed inclusion and historical event collection are approved requirements, not existing behavior.
- `src/metrics/store.js`: `nodes` retains first/last-heard inventory; existing range counts do not provide a complete advert event history.

## Remaining bot-reporting decisions

- Concrete retention cutoff/pruning semantics, including acceptance-versus-completion boundary cases, remain implementation-plan details. Shared duration and runtime configurability are settled above.
- Any extra stored content beyond the existing validated command context, and concrete migration/index/query design, remain implementation-plan decisions.
- Future reliable identity support remains conditional on protocol evidence; current name-only ambiguity cannot be removed by a database schema.

## Other P1 discussion still open

On 2026-10-08, human direction moves remaining choices into issue-local implementation planning. First-wave draft plans are staged for #28/#26/#24/#25, with a [planning queue](pillar-1-implementation-queue.md) for the remaining issues. There are no additional prerequisite questions before plan drafting. A feature needs its relevant settled decisions and concrete plan approval; unrelated unresolved #23 topics do not block it. Draft proposals in those plans are not approved decisions and must not be silently promoted into this settled record.

Additional node types, other datasets' retention, telemetry field support and credential handling, RF budgets, region answer freshness/completeness, and publication retries remain in their owning issues. Run/resource identity, units, events and retained reporting are settled under #24/#25; topology ambiguity/freshness/retention are now settled under #27. #23 remains open for unrelated telemetry/region choices.

This record captures requirements and research evidence. Concrete protected-boundary implementation changes remain subject to their reviewed implementation plans.
- #26 retention finalized — 2026-10-08: the user delegates best judgment, prioritizing offline operation, save first/purge later and enterprise reliability. Inventory, known names/types, first/last-heard and direct evidence remain indefinite. Optional `PACKETCAPTURE_REPEATER_FINGERPRINT_PRUNE_AFTER_DAYS` defaults to 0/off; whole-day 0–36500 overrides select repeaters unheard for at least N days, counting verified duplicates as activity. Local maintenance removes only fingerprints whose detailed event has already expired and always protects the original discovery fingerprint. Returning known keys remain known. After opt-in cleanup, an expired non-discovery payload may count again as a re-hear; retained history still deduplicates. Cleanup releases reusable SQLite pages without automatic file shrinking. All #26 decisions/tasks are complete locally.
- Validation: 544 tests across 51 files pass, CI coverage thresholds and lint pass, including protected cleanup, failure isolation, invalid settings before startup and real-store offline fixtures. A 20,000-fingerprint fixture measured 43.008 bytes per identity in SQLite pages; no raw frame/message body is retained. Concrete hours setting, bounds, expiry equality and clock policy are approved and implemented under #26.

## Offline operation and save-first delivery direction — 2026-10-08

Apply the user's delegated judgment to local technical choices rather than prolonging resolved feature discussions. Core radio observation, durable inventory/history, lookup and local insight must remain useful when internet/cloud services are unavailable. Optional cloud forwarding cannot gate local persistence. Default to retaining learned information; purges require explicit operator settings, preserve identity/discovery and state their effect on reporting. Favor fail-fast configuration, transactional migration/writes, observable failures, meaningful restart/outage/clock/storage tests and documented limits. This is a reliability direction, not a certification claim or permission to rewrite framework canon.

Existing offline gap: pinned Chart.js is loaded from jsDelivr by `src/web/dashboard-page.js`; missing-chart guards preserve other views but cannot draw charts. #42 owns a local asset delivery plan and #83 cold-cache/WAN-loss validation; #37 owns integrated local backend/recovery checks. Recording these requirements does not silently implement the queued features or change their status.

## Resource/event history delivery — 2026-10-08

The user's next-task go-ahead after pushing #24 approves #25's concrete storage/configuration scope, with the prior offline/save-first delegated judgment. Migration 12 adds run-linked process samples/events. CPU uses actual monotonic elapsed intervals, user/system microseconds and one-logical-CPU percentages (including >100%); byte gauges record RSS/heap total/heap used/external memory. First/reset/unavailable utilization is null rather than zero. Built-in ELU active/idle millisecond deltas and 0–1 fraction are included after deterministic tests and overhead evaluation, without a histogram, extra timer, host/quota guess or dependency.

The existing always-on configurable sampler cadence owns collection and atomic process/heartbeat persistence, independent of UI/internet. Optional failures remain observable and preserve packet/SSE behavior with ordinary checkpoint fallback. Strict schemas admit only selected radio connected/disconnected/connect-error and sampled broker/bot readiness observations. Sampled events declare their actual observation window; stable states do not repeat and first snapshots establish a baseline. No raw radio error, credentials, configuration dump or message payload enters history.

`PACKETCAPTURE_RUNTIME_EVENT_MAX_PER_MINUTE` defaults to 60 with whole 1–600 overrides and example/code agreement. A sliding monotonic minute bounds attempts, including failed writes. Suppressed and failed counts remain pending until successful process persistence; orderly shutdown detaches collectors and flushes a final count/resource sample before teardown/clean end/store close. Unpersisted abrupt/final-failure counts cannot be recovered and coverage is documented as a lower bound. Shared day-based metrics retention stays unlimited by default, expires children first and protects active/referenced runs. Internal pages cap at 200 and history at 1000 buckets, with weighted valid CPU/ELU intervals, per-gauge measurement counts, empty gaps and explicit mixed-run scope/run filters. #35/#36 own presentation.

All 57 files / 591 tests, CI coverage thresholds and lint passed at #25 delivery. On Windows / Node v24.21.0, collection/write p95 was 3.781ms with 20,500 retained samples, below the established 10ms local target; broader soak/RF validation stays under #37. #25 is closed as completed, progress label removed, native project Done verified and changes user-pushed in a903e0e; #24 is user-pushed in 5199e52. Subsequent #27 delivery settles topology and raises the verified suite to 620 tests. #23 retains its telemetry/region scope.
- #24 run-history implementation — 2026-10-08: user "Clear to proceed" approves the next run-history plan under delegated offline/save-first judgment. Migration 11 adds database-local instance UUID and startup UUID; bootstrap evidence is saved after validated startup/store and before hardware/network. Enforce one Observer with exclusive SQLite connection ownership, released by OS death (no lease/sidecar/network/host identity); external SQLite readers need the Observer stopped. Reuse sampler cadence for monotonic elapsed checkpoints, flag wall-clock discontinuities, retain last successful evidence on failure. Recovery marks prior unclosed runs unclean with null end, excluding downtime. Clean end follows successful bounded teardown and advert drain, before closing storage. Shared retention defaults unlimited, protecting active/referenced runs and instance identity. Summary is retained observed runtime with lower-bound/clock flags; pages select starts without proration. All 564 tests, CI coverage and lint pass; no public API/health/dependency/CI change. #25 still owns resource/event semantics and #35/#36 presentation.

### Remote T5 completion and proximity budget — 2026-10-09

#29 T1–T4 are user-pushed at 0b18be4; T5 is complete locally on 2026-10-09. All 66 files / 711 tests pass in both functional and coverage CI runs; coverage thresholds and lint pass. Integrated serial/TCP mixed workloads, 1,000 terminal cycles and 1,000 busy-air deferrals pass. The user-authorized proximity-only p95 target is 150ms (latest coverage result 83.275ms); other reads remain <100ms and writes <10ms. #29 is completed/project Done without its progress label. Remaining telemetry/region decisions #23 stay open/In progress; #18 stays open/In progress. Next: draft #30 durable region-answer planning, then #31/#32 under their own reviewed boundaries. Human direction permits extending the 100ms target; the concrete change is proximity-only <150ms after T4 coverage measurements of 115–124ms. This changes no store/query/index or CI configuration, and retains <100ms other reads/<10ms writes, fixture volumes, result bounds and coverage thresholds. README documents defaults, recovery, attribution and activation limitations. No live hardware/RF, later polling or protected storage/auth/publication integration occurs.

### Region storage plan proposed — 2026-10-09

#29 is complete and user-pushed at bc27968 (migration 13; 66 files / 711 tests, coverage/lint passing). #30 planning is In progress following explicit user authorization on 2026-10-09. Its [five-task plan](pillar-1-issues/p1-09.md#implementation-plan) proposes strict region parsing, migration 14, successful history/latest snapshots, terminal query outcomes, durable per-broker publication bookkeeping, protected shared retention and independent 72-hour answer freshness. REGION-PLAN-01–05 await finalized-plan approval; no #30 runtime work has begun. #18/#23/#30 remain OPEN/project In progress; #22/#29 remain completed/Done. #31/#32 remain queued under their own scopes. The prior delegated offline/save-first judgment informs these recommendations; it does not record the new REGION-PLAN choices as approved before the finalized plan is reviewed. Pending #30 questions are the single concrete contract approval, not a repeated general requirements round. No remaining region-data decision box is checked solely for planning. #32 retains public completeness/truncation mapping, broker opt-in/transport success/cadence/backfill; #31 retains actual RF/contact/library integration.

### Region plan approval and T1 delivery — 2026-10-09

#30’s finalized five-task plan and REGION-PLAN-01–05 are approved on 2026-10-09 by “Plan pushed and approved. Clear to proceed with implementation.” The planning baseline is user-pushed at 820ec209 / migration 13. T1 strict region parser/data contracts are complete locally: 16 new scenarios, full 68 files / 727 tests, coverage thresholds and lint pass. T2–T5 are approved pending tasks; T2 adds migration 14 and atomic durable results next. #18/#23/#30 stay OPEN/project In progress; #22/#29 stay completed/Done. Whole-feature #30 acceptance stays unchecked, and #31/#32 activation remains separately scoped. REGION-PLAN-01–05 are now approved: four-table owned migration/history/latest/terminal outcomes, unknown-completeness strict parsing, per-broker token bookkeeping/recovery, save-first shared history with latest/pending protection and independent configurable 72-hour answer freshness. Only pure T1 schemas/validation/parser are implemented; storage/runtime defaults/retention/bookkeeping remain later tasks. #31 owns RF/contact/library integration and #32 still owns public payload, truncation mapping, broker opt-in/QoS/cadence/backfill. Remaining telemetry/publication decisions keep #23 open.
