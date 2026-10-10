# Feature: Improved Telemetry & Reporting

**GitHub epic:** [#18](https://github.com/Robotti-io/Meshcore-Observer/issues/18)

**Child issue register:** [Pillar 1 breakdown — 16 issues](pillar-1-child-issues.md), updated 2026-10-10. #32 is complete/user-pushed at bbe05f6. #33 T1/T2/T3 are user-pushed at 0e40d81/f2fcabe/e2d63b8 and approved T4 bounded telemetry reads are complete locally on 2026-10-10. Latest useful/fully decoded observations have independent original times and freshness; retained scoped history/outcomes use strict bounded pages and parameterized indexed header-first reads. Full single-worker CI passes 92 files / 1,101 tests; coverage, lint and diff checks pass with unchanged gates. The 20k observations/20k failures fixture has coverage p95 3.603ms saves and 37.088ms slowest bounded read. Schema remains 16; T5 integrated acceptance awaits T4 review/push; collection is not enabled. #33 stays OPEN/native project In progress; #18/#23 remain active for polling/reporting choices, #34/#35/#36 stay queued and #37 retains live validation. See the [implementation queue](pillar-1-implementation-queue.md).

**Offline/reliability direction — 2026-10-08:** Core local observation, durable lookup and insight must work without internet/cloud forwarding. Retain learned data by default; deliberate operator cleanup preserves identity/discovery and documents reporting limits. Favor transactional migration/writes, fail-fast configuration, observable failures and meaningful recovery/outage/storage tests. Existing chart asset dependence remains #42/#83; integrated local backend outage/recovery validation belongs to #37. This direction guides the remaining reviewed implementation plans without claiming queued features complete.

## Summary

Expand MeshCore Observer's telemetry and reporting capabilities so that it provides a richer operational picture of:

1. The health and topology of nearby MeshCore repeaters.
2. How channel bots are being used and by whom.
3. Node-advert activity across additional MeshCore node types.
4. The runtime history and resource performance of the Observer service itself.
5. Declared flood-allowed regions of directly heard repeaters, including CoreScope-compatible publication through OBS-02.

The intent of this feature is to evolve the Observer from primarily capturing packets and reporting repeater presence into a broader source of operational intelligence about the local mesh, its users, its devices, and the Observer process itself.

This work should build on the persisted SQLite metrics architecture introduced in previous releases while minimizing unnecessary RF traffic and preserving the Observer's existing reliability and safety characteristics.

On 2026-10-07, explicit human direction included [OBS-02: Repeater Region Discovery for CoreScope](../feat-repeater_region_discovery.md) in v2.5.0 under this pillar. That document remains the detailed source for discovery eligibility, anonymous requests, answer semantics, persistence, and MQTT publication. Release inclusion authorizes planning; implementation and protected-boundary changes still require separate approval.

---

## Goals

- Periodically collect supported telemetry from nearby repeaters without indiscriminately querying the entire mesh.
- Learn usable repeater paths passively from traffic already observed by the Observer.
- Allow operators to define how many hops away a repeater may be before it becomes eligible for telemetry collection.
- Persist enough path history to make informed, low-impact routing decisions for telemetry polling.
- Store and report useful repeater telemetry such as battery state, temperature, neighbors, and other status information supported by MeshCore.
- Expand bot reporting so operators can understand who is using bot commands, which commands are being used, and how often.
- Expand node-advert reporting beyond repeaters, beginning with Companion nodes and distinguishing new discoveries from re-heard known nodes.
- Persist Observer process-session and performance information so operators can understand runtime duration, restart history, CPU use, memory use, and meaningful runtime events.
- Keep historical reporting compatible with the dashboard's existing reporting-range model where practical.
- Preserve strict validation, centralized configuration, structured logging, and SQLite ownership boundaries already established by the project.
- Discover declared regions from recently direct-heard verified repeaters without telemetry or management credentials, persist successful answers, and publish them to explicitly enabled CoreScope-compatible brokers as defined by OBS-02.

---

## Non-Goals

- Do not actively discover the entire mesh by flooding it with telemetry or management requests.
- Do not use repeater management credentials for telemetry collection.
- Do not assume every repeater uses the default telemetry password.
- Do not expose configured telemetry passwords, management passwords, tokens, or other secrets through logs, metrics, APIs, or the dashboard.
- Do not turn the Observer into a general-purpose repeater administration tool as part of this feature.
- Do not attempt to maintain a mathematically complete or authoritative representation of the entire mesh topology.
- Do not assume that one observed path is permanently valid or optimal.
- Do not treat an observed repeater in a packet path as proof that the repeater is currently reachable.
- Do not introduce unnecessary RF traffic merely to keep topology information fresh.
- Do not require new external persistence infrastructure; the existing local SQLite architecture remains the preferred storage mechanism.
- Do not define unsupported telemetry fields before confirming what the Companion protocol and `@liamcottle/meshcore.js` actually expose.

---

## Scope 1: Topology-Aware Repeater Telemetry Collection

### 1.1 Problem

MeshCore repeaters support a telemetry credential distinct from their management password.

Within the OKI Mesh community, repeater operators commonly configure their management password while leaving the telemetry password at its default. Repeater telemetry can expose useful operational information such as battery state, temperature, neighboring repeaters, and other status data.

MeshCore Observer currently observes repeater activity but does not periodically retrieve this richer telemetry.

Blindly querying every repeater known to the Observer would create unnecessary mesh traffic. Instead, the Observer should use paths already observed in normal packet traffic to determine which repeaters are reasonably local and how they can potentially be reached.

### 1.2 User Stories

#### 1.2.1 Telemetry radius

As an Observer operator, I want to configure how many hops away a repeater may be before the Observer polls it for telemetry so that I can collect useful local information without unnecessarily loading distant portions of the mesh.

Example observed path:

```text
AC01 -> 9905 -> E85C -> Observer
```

From the Observer's perspective:

- `E85C` is 1 hop away.
- `9905` is 2 hops away.
- `AC01` is 3 hops away.

If the configured telemetry radius is `2`, `E85C` and `9905` are eligible for telemetry collection while `AC01` is not.

#### 1.2.2 Passive topology learning

As an Observer operator, I want repeater reachability to be learned from traffic the Observer already receives so that topology discovery itself does not generate additional RF traffic.

#### 1.2.3 Path history

As an Observer operator, I want the Observer to retain useful historical information about paths in which repeaters have appeared so that it can make more informed routing decisions than simply using the last path observed.

#### 1.2.4 Controlled polling

As an Observer operator, I want telemetry requests to occur on a configurable cadence so that useful status information can be collected without repeatedly polling devices unnecessarily.

#### 1.2.5 Repeater health reporting

As an Observer operator, I want collected telemetry associated with the corresponding repeater so that I can inspect the health and status of known repeaters over time.

---

### 1.3 Functional Requirements

#### 1.3.1 Observed path persistence

The Observer should persist useful information about packet paths it sees during ordinary operation.

At minimum, path observations should make it possible to determine:

- Which repeater identifiers appeared in the path.
- The relative hop distance of each repeater from this Observer.
- How often a particular repeater/path relationship has been observed.
- When the relationship was first observed.
- When it was most recently observed.

The data model should support more than one historical path for a repeater.

A single `path` field on the existing node record is not sufficient because:

- A repeater may be observed through multiple routes.
- Routes may change over time.
- Frequency and recency may matter when choosing a route.
- A route observed once should not necessarily be treated the same as one observed repeatedly.

#### 1.3.2 Eligibility calculation

The Observer should determine telemetry eligibility using an operator-configured maximum hop distance.

A repeater should become eligible only when sufficient path evidence shows that it has appeared within the configured radius.

The exact path-selection and eligibility algorithm should be finalized during implementation planning after reviewing protocol behavior.

#### 1.3.3 Route selection

When multiple paths have been observed for an eligible repeater, the Observer should select a reasonable route using persisted observations.

Potential factors may include:

- Hop count.
- Observation frequency.
- Observation recency.
- Previous telemetry-request success or failure.
- Information learned through repeater telemetry itself.

The first implementation does not need sophisticated dynamic routing, but the storage model should not prevent future improvements.

#### 1.3.4 Telemetry scheduling

Telemetry collection should be periodic and configurable.

Polling should be designed to avoid:

- Large bursts of telemetry requests.
- Polling every known repeater simultaneously.
- Repeatedly querying unreachable nodes.
- Generating unnecessary RF traffic during busy-air periods.
- Aggressively retrying unsuccessful telemetry requests.

Existing radio command serialization and airtime coordination should be reused where appropriate rather than creating an independent transmission path.

#### 1.3.5 Credentials

Telemetry authentication must be treated separately from management authentication.

The implementation should support:

- A convenient default telemetry password for deployments where the community default is intentionally used.
- Operator override capability where individual repeaters or groups use a different telemetry password.
- Secret values supplied through an appropriate protected configuration path.
- No telemetry passwords persisted in plaintext metrics/history tables.
- No telemetry passwords included in structured logs, errors, dashboard APIs, or reports.

The exact credential configuration model should be designed separately after protocol requirements are understood.

#### 1.3.6 Collected telemetry

The exact telemetry fields must be determined from the MeshCore Companion protocol and supported `@liamcottle/meshcore.js` capabilities.

Candidate information includes:

- Battery percentage / battery state.
- Temperature.
- Neighbor repeater information.
- Device status information.
- Other telemetry fields exposed by the protocol.

Unsupported fields must not be invented or inferred.

#### 1.3.7 Historical telemetry

Where practical, telemetry should be timestamped and retained so that reporting can show changes over time rather than only the latest value.

Retention should integrate with the project's existing metrics-retention model where appropriate.

---

### 1.4 Required Research

This scope requires focused research before implementation.

Review:

- The installed and current upstream versions of `@liamcottle/meshcore.js`.
- MeshCore Companion Radio Protocol documentation.
- Telemetry login/authentication behavior.
- How routed remote commands identify a target path.
- Whether telemetry polling is already directly supported by the library.
- What telemetry fields are returned.
- How neighbor information is represented.
- Timeout/error behavior.
- Whether requests generate protocol responses that can be safely correlated.
- Whether an upstream library change is required.
- Whether newer library releases provide capabilities not present in the currently installed version.

Any required dependency change must be reviewed separately because dependencies are a protected project boundary.

---

## Scope 2: Bot Usage & Interaction Reporting

### 2.1 Problem

MeshCore Observer already persists significant information about bot reply lifecycle events, but current reporting is primarily command-centric.

Operators should be able to understand not only which commands are being used, but also who is using them and how usage changes over a selected reporting range.

### 2.2 User Stories

As an Observer operator, I want to know which users are interacting with my bots so that I can understand actual community usage.

As an Observer operator, I want to know how many times each user invoked each command over a selected reporting period.

As an Observer operator, I want to know how many unique users used a command so that I can distinguish broad adoption from repeated use by one person.

As an Observer operator, I want bot usage reporting to follow the same reporting-range model as other historical metrics so that I can compare activity over 1 hour, 24 hours, 7 days, custom periods, or all retained history.

As an Observer operator, I want to distinguish attempted interactions from successful replies where appropriate so that command usage and bot delivery effectiveness are not conflated.

---

### 2.3 Existing Leverage

The current persisted bot reply lifecycle already contains or is positioned to contain information including:

- Bot name.
- Command/trigger.
- Sender.
- Outcome.
- Enqueue time.
- Resolution time.
- Queue duration.
- Packet hash/reference.
- Persisted command-handler state.

This feature should reuse existing records wherever possible rather than introducing duplicate event storage.

---

### 2.4 Reporting Requirements

The reporting model should support views such as:

```text
User: SOMEUSER

!lookup    14
!stats      6
!echo       2
Total      22
```

and:

```text
Command: !lookup

Total uses:       43
Unique users:     12
Replies sent:     40
Replies expired:   2
Replies failed:    1
```

Useful reporting dimensions should include:

- Reporting range.
- Bot.
- Channel where appropriate.
- Sender.
- Command.
- Command count.
- Unique user count.
- Reply outcome.
- Queue duration where useful.

---

### 2.5 Detailed Interaction Drill-Down

The implementation should evaluate whether operators should be able to inspect individual historical interactions containing fields such as:

- Timestamp.
- Sender.
- Bot.
- Command.
- Reply outcome.
- Queue duration.
- Packet/hash reference.

If this level of drill-down is included, retention and privacy implications should be explicitly reviewed because it exposes more detailed user activity than aggregate reporting.

Aggregate reporting is required. By human direction on 2026-10-07, v2.5.0 also includes durable individual interaction records and backend support for future browsing; the browsing interface itself is deferred. Reuse or extend existing reply records where sufficient rather than introducing duplicate storage. Bot interaction history follows the same runtime-configurable retention duration as other key historical metrics, using shared metrics retention configuration. Pending replies must remain protected from history pruning. Concrete schema and cutoff details remain implementation-plan decisions.

Usage means an eligible command accepted after duplicate filtering, counted at acceptance time. Successful replies and other completed outcomes are separate measures counted at resolution time. Sender reporting uses original distinct sender names unless reliable message-to-sender identity evidence is available; ordinary channel messages provide no reliable sender public key, so duplicate names remain ambiguous. Do not attribute public keys through name-only advert/contact matching.

See [Pillar 1 decision record](pillar-1-decisions.md) for settled decisions, worked examples, protocol evidence, and remaining questions.

---

## Scope 3: Broader Node Advert Reporting

### 3.1 Problem

The Observer currently receives adverts from multiple MeshCore node types but operator-facing node reporting is primarily centered on repeaters.

Other adverts, particularly Companion adverts, provide useful information about mesh participation and activity.

The Observer should begin reporting on these additional node types.

### 3.2 User Stories

As an Observer operator, I want to know how many Companion nodes my Observer has heard so that I can better understand local mesh participation.

As an Observer operator, I want to know how many previously unseen Companion nodes were discovered during a reporting range.

As an Observer operator, I want to know how many adverts came from Companion nodes that were already known so that I can distinguish new-node discovery from continued activity.

As an Observer operator, I want this model to be extensible to other supported node types rather than permanently hard-coding reporting around repeaters and Companions only.

---

### 3.3 Reporting Semantics

Reporting should distinguish at least:

#### 3.3.1 New node

An advert from a node whose identity had not previously been stored by this Observer.

#### 3.3.2 Re-heard node

An advert from a node whose identity was already known by this Observer.

This distinction should support reporting such as:

```text
Selected range: 24h

Companion adverts heard:      187
New companions discovered:     11
Known companion re-hears:     176
```

Care must be taken to define whether these figures count:

- Individual advert events.
- Unique nodes.
- Or both.

Where useful, both should be available and clearly labeled.

For example:

```text
Companion advert events:       187
Unique companions observed:     42
New companions discovered:      11
Known companions observed:      31
```

---

### 3.3.3 Settled decisions — 2026-10-07

Human direction approves separate distinct advert-event and distinct-node counts, with nodes identified by full public key. Count the same signed advert once despite relayed copies, while preserving useful reception/path/direct-heard evidence separately. A fresh distinct advert from a known node counts as a re-hear; do not collapse every advert from that node into one sample-period event.

Include verified unnamed nodes by public key with an `Unnamed` display fallback. Malformed or unverified adverts remain outside trusted reporting and direct-discovery eligibility. Initial reporting begins with Companion and Repeater nodes. Renames do not create new public-key identities, and existing first/last-heard inventory must not be presented as complete historical advert records.

On 2026-10-08, human direction approved shared runtime-configurable retention for historical advert events while preserving full-public-key inventory, known name/type, and first/last-heard information across event pruning. Returning known nodes remain re-hears; inventory does not reconstruct pruned events or establish current reachability. Direct-heard eligibility rules are also agreed: a configured reception-time window refreshed only by verified zero-hop repeater observations; expiry stops region-query scheduling while preserving inventory/successful answers. The default is **72 hours**, with a validated operator override and matching example/central-code fallback when omitted. Exact validation bounds and concrete timestamp/cutoff/schema details remain implementation-plan work under #23/#26. See [decision record](pillar-1-decisions.md).

### 3.4 Persistence Requirements

The existing node registry should be reviewed to determine how additional node types should be represented.

The implementation should preserve:

- Node public key / identity.
- Node type.
- First heard time.
- Last heard time.
- Advert verification behavior where applicable.

Historical advert-event reporting may require an append-only observation/event record rather than relying exclusively on the current-state node table.

The current node table's `first_heard_at` and `last_heard_at` values are useful for current inventory, but they may not be sufficient to answer every historical question about how many adverts occurred inside an arbitrary reporting window.

The data model should distinguish current node inventory from historical advert activity.

---

## Scope 4: Process Performance & Runtime Reporting

### 4.1 Problem

The Observer currently provides application health information while running, but does not maintain a complete historical record of its own process sessions and resource use.

This makes long-running validation and performance analysis more manual than necessary.

For example, v2.4.0 operational soak testing required external observation to determine runtime duration, restart gaps, CPU usage, and memory behavior.

The Observer should collect enough telemetry about itself to make future operational analysis data-driven.

---

### 4.2 User Stories

As an Observer operator, I want to know how many times a particular Observer installation has run so that I can understand restart frequency.

As an Observer operator, I want to see when each process run began and ended so that I can reconstruct service availability.

As an Observer operator, I want to know how long each run lasted and the total accumulated runtime across runs.

As an Observer operator, I want historical CPU and memory data so that I can identify performance regressions, abnormal growth, or resource exhaustion.

As a developer, I want release soak testing to use persisted Observer performance data rather than relying entirely on manual sampling.

As an operator, I want notable runtime events associated with a specific run so that resource behavior can be correlated with reconnects, failures, or other service events.

---

### 4.3 Process Run Model

Each process invocation should receive a unique runtime/session identifier.

A persisted run should contain information such as:

- Run/session ID.
- Observer instance identity if an appropriate concept exists.
- Process start time.
- Process end time, when known.
- Last known alive/sample time.
- Runtime duration.
- Clean shutdown indicator where determinable.
- Application version.
- Node.js version.
- Platform/runtime information where useful and non-sensitive.

The design should account for abrupt termination.

If a process disappears without executing normal shutdown logic, the next startup should be able to identify that the previous run did not record a clean shutdown.

The implementation should not claim to know the exact termination time after an unclean stop if only the last persisted sample is available.

---

### 4.4 Resource Metrics

Periodically persist useful process resource measurements.

Candidate metrics include:

#### 4.4.1 Memory

- Resident Set Size (RSS).
- Heap total.
- Heap used.
- External memory where useful.

#### 4.4.2 CPU

- Process CPU usage.
- CPU utilization derived over the sampling interval.

CPU reporting must clearly define whether percentages represent:

- One logical CPU.
- Total host capacity.
- Or another normalization.

#### 4.4.3 Runtime

- Current run duration.
- Historical run duration.
- Cumulative runtime across retained runs.

#### 4.4.4 Event-loop / runtime health

Evaluate whether useful Node.js runtime indicators can be collected using built-in Node capabilities without introducing new dependencies.

Potential metrics may include:

- Event-loop delay.
- Event-loop utilization.
- Other meaningful Node runtime indicators.

These should only be included where the metric has a clear interpretation and reasonable collection overhead.

---

### 4.5 Runtime Events

The design should support associating meaningful operational events with a process run.

Potential examples include:

- Radio connected.
- Radio disconnected.
- Radio reconnected.
- MQTT broker connected.
- MQTT broker disconnected.
- Bot becoming ready.
- Bot becoming unavailable.
- Configuration/startup failure where persistence is available.
- Telemetry polling success/failure.
- Significant internal service errors.

This should not become a duplicate copy of every application log line.

Only events with long-term operational/reporting value should be persisted.

---

### 4.6 Sampling & Storage

Process telemetry should use a bounded, configurable sampling cadence.

The cadence should balance:

- Useful performance resolution.
- SQLite growth.
- CPU overhead.
- Disk I/O.
- Long-term retention.

Where practical, this should integrate with the existing metrics sampler instead of creating an unrelated high-frequency timer.

Historical process metrics should follow existing retention rules or a clearly documented related policy.

---

## Scope 5: Repeater Region Discovery for CoreScope (OBS-02)

The detailed requirements and acceptance criteria live in [OBS-02](../feat-repeater_region_discovery.md), which is included in this pillar for v2.5.0.

Initial discovery is opt-in and limited to recently verified zero-hop repeater adverts with a full public key. General registry presence, relayed path observations, and telemetry-radius eligibility do not establish direct-discovery eligibility.

Anonymous region requests must use supported Companion/library capabilities, an appropriate direct contact route, a zero-hop reply, and correlation through the request tag. Coordinate remote-request ownership through the complete response/timeout/disconnect lifecycle with telemetry and other radio work, reusing the existing command queue and airtime coordinator. Do not silently mutate operator-managed contacts or routes.

Persist successful declarations and their observation timestamps in the always-on `MetricsStore`. Preserve a successful empty list as a measured answer; failures must remain distinguishable from empty answers and must not replace prior successful declarations. Preserve region-name case and wildcard semantics, and document the possibility of incomplete answers without a wire truncation signal.

Publish strictly validated CoreScope-compatible answers to `meshcore/client/{PUBLIC_KEY}/regions` only for explicitly enabled brokers with the required permissions. Preserve observation timestamps when publication is delayed, and keep capture operating when discovery or publication fails.

Region discovery is separate from telemetry authentication and Pillar 3's outbound bot scope policy. Detailed contact handling, schema/migrations, dependency integration, MQTT contract, retry behavior, and retention are decisions for the approved child implementation plans.

---

## 5 Cross-Cutting Requirements

### 5.1 Reporting Range

Historical metrics introduced by this pillar should use the application's existing reporting-range semantics where appropriate.

This includes support for existing presets and custom ranges.

Different metrics must clearly distinguish:

- Current/live values.
- Historical values.
- Current inventory.
- Event counts.
- Unique entities.
- Cumulative lifetime values.

---

### 5.2 Data Integrity

All new persistent state must use the existing `MetricsStore` / SQLite ownership model unless a separately approved architectural change is made.

Schema changes must:

- Use forward-only transactional migrations.
- Preserve existing metrics.
- Preserve pending bot replies.
- Preserve node registry data.
- Preserve flood-advert state.
- Fail startup safely if migration cannot complete.

SQL queries must remain parameterized.

---

### 5.3 Configuration

All new configuration must continue to flow through the centralized configuration layer.

Feature modules must not read `process.env` directly.

Invalid configuration must fail before radio or network side effects occur.

Human direction on 2026-10-08: favor operator overrides for applicable operational settings. Approved optional defaults and units must be documented in example configuration and defined identically in central configuration code when values are omitted. Valid explicit values take precedence; invalid explicit values must not silently fall back. Required configuration and secrets retain their validation requirements. Implementation validation must cover missing values, overrides, invalid values, and example/code default agreement. Setup and doctor must share the authoritative interpretation. This includes the approved 72-hour direct-heard eligibility default; concrete names/units/bounds are selected during planning.

Likely configuration categories include:

- Repeater telemetry enabled/disabled.
- Maximum telemetry hop radius.
- Telemetry polling interval.
- Telemetry credential selection/default behavior.
- Process telemetry sampling configuration, if a distinct cadence is required.

Exact variable names should be selected during implementation planning rather than prematurely fixed in this feature request.

---

### 5.4 Security

This pillar introduces potentially sensitive information and must preserve existing security boundaries.

Requirements include:

- Never log telemetry passwords.
- Never expose telemetry passwords through dashboard APIs.
- Never persist management or telemetry passwords in metrics tables.
- Never infer or attempt management authentication as part of telemetry polling.
- Validate all data crossing protocol/API/configuration boundaries.
- Treat remote telemetry responses as untrusted structured input.
- Avoid persisting unnecessary personal/user information beyond what is required for approved bot reporting.
- Review detailed bot-interaction retention before exposing event-level history.

---

### 5.5 RF / Mesh Safety

Active telemetry collection must be deliberately conservative.

Requirements include:

- Passive path learning.
- Configurable polling scope.
- Configurable polling cadence.
- Reuse existing airtime coordination where possible.
- Avoid simultaneous bursts.
- Avoid immediate repeated retries.
- Respect radio disconnection.
- Do not allow polling work to starve normal packet capture or higher-priority bot/radio operations.
- Avoid querying distant repeaters outside the configured radius.
- Treat observed paths as historical evidence rather than guaranteed current routes.

The Observer should remain primarily an observer; active telemetry polling must not materially disrupt the mesh it is monitoring.

---

### 5.6 Performance

New metrics collection must not materially compromise packet capture.

Particular attention should be paid to:

- SQLite write frequency.
- Path-history growth.
- Node-advert event growth.
- Process-metric sample growth.
- Telemetry-response persistence.
- Dashboard query cost across long retention periods.

Indexes and aggregation strategies should be selected based on actual query patterns.

Do not prematurely introduce complex rollup architectures unless measurements show the existing SQLite model is insufficient.

---

## 6 Acceptance Criteria

This pillar is complete when the approved child features collectively satisfy the following.

### 6.1 Repeater telemetry

- The Observer can identify repeaters within a configured hop radius using passively observed packet paths.
- A path such as `AC01 -> 9905 -> E85C -> Observer` correctly treats:
  - `E85C` as 1 hop away.
  - `9905` as 2 hops away.
  - `AC01` as 3 hops away.
- A configured radius of `2` includes `E85C` and `9905` while excluding `AC01`.
- Path history is persisted with sufficient recency/frequency information to support route selection.
- Eligible repeaters can be periodically queried for telemetry using supported MeshCore protocol/library capabilities.
- Telemetry polling does not blindly probe every known node.
- Telemetry credentials are never logged or exposed in reporting.
- Supported telemetry values are stored with timestamps and associated with the correct repeater.
- Polling failures do not disrupt packet capture.

### 6.2 Bot usage reporting

- Historical bot usage can be queried by selected reporting range.
- Reporting can show command-use counts.
- Reporting can show unique-user counts.
- Reporting can show per-user command-use counts.
- Existing reply outcomes remain available for correlation.
- Existing bot behavior and reply delivery semantics remain unchanged.

### 6.3 Node advert reporting

- Companion adverts are represented in reporting.
- Reporting distinguishes newly discovered Companion nodes from known nodes that are re-heard.
- Historical advert activity can be queried for a selected reporting range.
- Current node inventory and historical advert-event counts are not conflated.
- The design can be extended to additional node types without another fundamental redesign.

### 6.4 Process telemetry

- Every process run receives a persistent session/run identity.
- Start time is recorded.
- Clean shutdown time is recorded when available.
- Abruptly terminated sessions can be distinguished from known clean shutdowns without fabricating an exact stop time.
- Per-run duration can be reported.
- Cumulative runtime can be reported.
- CPU usage can be sampled and historically queried.
- Memory usage can be sampled and historically queried.
- Selected meaningful runtime events can be associated with the run in which they occurred.
- Process telemetry collection does not materially affect Observer performance.

### 6.5 Repeater region discovery (OBS-02)

- OBS-02's acceptance criteria are satisfied for recently direct-heard verified repeaters, including direct routing, request-tag correlation, durable answers, CoreScope publication, and bounded scheduling.
- Successful empty answers, unknown/failure states, and possibly incomplete declarations retain their distinct meanings.
- Unsupported firmware, missing/full contacts, reconnects, and broker failures do not disrupt capture or silently broaden routing.
- Discovery and telemetry share coordinated radio/remote-request ownership while retaining separate eligibility and authentication semantics.

### 6.6 Quality

- All new configuration is centrally parsed and strictly validated.
- All new inbound structured data is validated at trust boundaries.
- SQLite migrations preserve existing installations.
- Automated tests cover storage, migration, range queries, protocol handling, configuration, and failure behavior.
- Full test and lint workflows pass.
- Operator documentation explains collection behavior, reporting semantics, credentials, RF impact, retention, and configuration.

---

## 7 Suggested Child Features

The concrete [child-issue breakdown](pillar-1-child-issues.md) is captured in GitHub epic #18. The thematic list below groups the source requirements; linked child issues track the scoped execution and dependencies.

Recommended breakdown:

1. **Topology & Path Observation Persistence**
2. **Repeater Telemetry Protocol / Library Research**
3. **Topology-Aware Repeater Telemetry Polling**
4. **Repeater Telemetry Persistence & Reporting**
5. **Bot User / Command Usage Reporting**
6. **Additional Node Advert Persistence & Reporting**
7. **Observer Run / Session History**
8. **Observer CPU, Memory & Runtime Performance Metrics**
9. **Dashboard / API Reporting Integration**
10. **Operational Validation & RF Impact Review**
11. **OBS-02: Repeater Region Discovery for CoreScope** — break down protocol/contact eligibility, shared scheduling, durable answer semantics, and per-broker publication after research.

Some of these may be combined after research clarifies the implementation boundaries.

---

## 8 Open Questions

These should be resolved during feature planning rather than guessed during implementation.

### 8.1 Repeater telemetry

- What telemetry commands and responses are supported by the current Companion protocol?
- Does the current `@liamcottle/meshcore.js` release expose all required functionality?
- If not, is support present upstream but unpublished, or will an upstream contribution be required?
- How is a path supplied when addressing a remote repeater?
- How does telemetry authentication operate for routed requests?
- What is the default telemetry credential and how should an operator override it safely?
- What telemetry fields are consistently available across repeater firmware versions?
- How should unsuccessful paths affect future path preference?
- How long should path observations remain useful before being considered stale?
- Should telemetry polling use one global cadence or distribute targets across the interval?
- Should a repeater that moves outside the configured hop radius immediately become ineligible, or should eligibility use a recency/grace period?
- Should previously successful telemetry routes receive preference over merely frequently observed paths?
- How should telemetry polling coordinate with bot replies, flood adverts, and other active radio operations?

### 8.2 Bot reporting

- Settled on 2026-10-07: aggregate sender/command/bot/range reporting is required. Individual interaction records/backend support are included, while the browsing interface is deferred.
- Settled: sender-level interaction history uses the same runtime-configurable retention duration as other key historical metrics. Exact cutoff/pruning semantics remain implementation-plan details.
- Settled: preserve original sender names; use reliable sender identifiers only when supported by actual attribution evidence. Ordinary channel messages cannot distinguish duplicate-name senders by public key.
- Settled: usage means an eligible command accepted after duplicate filtering, timed at acceptance. Successful replies and other completed outcomes are separate measures timed at resolution.
- Remaining: concrete schema/migrations/query design and any additional stored content beyond existing validated handler context. See [decision record](pillar-1-decisions.md).

### 8.3 Node adverts

- Which MeshCore node types should be included in v2.5.0 beyond Companion and Repeater?
- Settled on 2026-10-07: expose both distinct advert events and distinct full-public-key nodes, beginning with Companion and Repeater.
- Settled: include verified unnamed nodes by key with an `Unnamed` display fallback; malformed/unverified adverts do not enter trusted reporting.
- Settled: relayed copies of the same signed advert count once, retaining reception evidence separately; each fresh distinct advert from a known node is a re-hear, without sample-period collapsing.
- Settled on 2026-10-08: historical advert events use shared runtime-configurable metrics retention; full-key inventory, known name/type, and first/last-heard information survive pruning, without implying current reachability or fabricating expired event history.
- Settled on 2026-10-08: direct-heard freshness uses a runtime-configurable Observer-reception-time window refreshed only by verified zero-hop repeater adverts. Expiry stops scheduling region queries while preserving inventory and successful answers. Cadence varies; one-hour local and 47-hour flood intervals are supplied guidance, not fixed deployment assumptions.
- Settled on 2026-10-08: direct-heard default is 72 hours with an operator override and matching example/central-code fallback for omitted values. Remaining: exact units/window bounds and concrete timestamp/cutoff/schema/historical name/type handling in the implementation plan.
- Should current node inventory eventually expose all supported node types or remain separated into focused views?

### 8.4 Repeater region discovery

- Which released package or separately approved integration approach provides the anonymous-request API proposed in [MeshCore.js PR #44](https://github.com/meshcore-dev/meshcore.js/pull/44)?
- Can direct contact routing be guaranteed without changing operator-managed contact state?
- What are the direct-heard freshness window, refresh cadence, timeout/retry budget, answer-retention model, and publication retry policy?
- Which configured brokers support and permit CoreScope's client region contract?
- How should discovery and telemetry coordinate remote-request ownership without starving bot replies or other existing radio operations?
- Resolve the additional detailed questions in [OBS-02](../feat-repeater_region_discovery.md) during its child-feature planning.

### 8.5 Process telemetry

- What process-performance sampling interval provides sufficient resolution without unnecessary database growth?
- Which Node.js runtime metrics provide actionable information beyond CPU and memory?
- Which operational events deserve durable storage versus remaining only in logs?
- How should an Observer "instance" be identified across process runs?
- Should application upgrades preserve the same instance identity?
- How should runtime history interact with metrics retention?
- Should cumulative runtime represent all recorded runs or only runs still within the configured retention period?
- Should abnormal termination be inferred from the previous session remaining open when the next session starts?
- Should runtime events have severity/category fields or remain a deliberately small typed event vocabulary?

---

## 9 Release Intent

This pillar should make MeshCore Observer substantially better at answering five classes of operational questions.

### 9.1 What is happening on the mesh?

Which nodes are appearing, which are new, which are active, and how is local mesh participation changing?

### 9.2 How healthy are nearby repeaters?

Which repeaters are close enough to monitor, how can they be reached, and what are their battery, temperature, neighbor, and other supported telemetry states?

### 9.3 How are people using the Observer's bots?

Who is invoking commands, which commands are useful, and how frequently are they being used?

### 9.4 How healthy is the Observer itself?

How often has it restarted, how long has it run, what resources has it consumed, and what significant runtime events occurred?

### 9.5 Which regions do directly heard repeaters declare?

Which flood-allowed regions have eligible repeaters reported, how fresh are those answers, and can CoreScope receive them without disrupting normal observation?

Together, these capabilities move MeshCore Observer from packet observation toward a richer operational intelligence platform while preserving the project's core constraints around RF efficiency, local-first persistence, explicit configuration, and predictable runtime behavior.

## Implementation Plan

Implementation planning started on 2026-10-08 by human direction. Use the [Pillar 1 planning queue](pillar-1-implementation-queue.md) for readiness, sequencing, remaining plan work, and issue-local dependency gates. Concrete plans are maintained in the owning feature issue records so each can be reviewed, approved, implemented and validated independently.

The first four code-grounded plans are:

1. [P1-07 / #28 — bot usage and interaction history](pillar-1-issues/p1-07.md#implementation-plan) — approved and implemented locally, 2026-10-08; 508 tests and lint pass.
2. [P1-05 / #26 — advert history and direct-heard evidence](pillar-1-issues/p1-05.md#implementation-plan).
3. [P1-03 / #24 — run and shutdown history](pillar-1-issues/p1-03.md#implementation-plan).
4. [P1-04 / #25 — process resources and typed events](pillar-1-issues/p1-04.md#implementation-plan).

Each draft lists current architecture, proposed changes, impacted files, five small tasks with completion/validation criteria, risks, numbered review decisions and execution order. Draft proposals are not approved requirements. Relevant #23 decisions unlock their consuming issue without requiring closure of unrelated topics. These plans and public issue descriptions remain subject to concrete protected-boundary review before implementation; no source code is changed by staging them.

#28's acceptance/outcome reads and durable interaction evidence are now implemented in migration 9 with shared completion-time retention and pending protection. The other three plans remain drafts. Future API/dashboard exposure remains #35/#36; this backend slice adds no public browsing surface. See #28's implementation results for exact contracts and validation.
