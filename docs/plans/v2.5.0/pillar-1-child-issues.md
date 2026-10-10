# Pillar 1 child-issue register

Captured: 2026-10-07. Parent: [epic #18](https://github.com/Robotti-io/Meshcore-Observer/issues/18). Updated: 2026-10-10. #32 is complete/user-pushed at bbe05f6. #33 T1/T2 are user-pushed at 0e40d81/f2fcabe and approved T3 owned telemetry storage is complete locally on 2026-10-10. Migration 16 adds three tables with strict transactional result saves, immutable idempotency, variant-scoped latest/useful and decoded pointers, deterministic receipt-time collision evidence, history-only clock safeguards and shared save-first retention/source-run protection. Full single-worker CI passes 90 files / 1,086 tests; coverage, lint and diff checks pass with unchanged gates. T4 reads and T5 integrated acceptance remain pending; collection is not enabled. #33 stays OPEN/native project In progress; #18/#23 remain active for polling/reporting choices, #34/#35/#36 stay queued and #37 retains live validation.

Progress on 2026-10-07: bot-reporting requirements, backend/history inclusion, identity limitations, and shared runtime-configurable retention have been resolved under #23 for #28. Node-advert recommendations are also agreed; #26 is in requirement resolution for direct-heard freshness and node-history retention, with implementation pending. No complete child issue is ready for closure. See [decision record](pillar-1-decisions.md) and the issue acceptance/progress checklists.

**Issue labels:** [v2.5.0 label guide](issue-label-guide.md), including work type, owning pillar, configuration/security scope, and the dedicated OBS-02 group.

Update on 2026-10-08: advert-event history uses shared runtime-configurable metrics retention; node inventory and first-discovery identity survive history pruning. These requirements are checked off in #23/#26. Direct-heard freshness is the remaining active node requirement discussion; implementation planning and implementation are pending.

Further update on 2026-10-08: direct-heard rules and the configurable **72-hour default** are agreed and checked off in #23/#26, with the consuming #31 policy synchronized. The window uses reception time and verified zero-hop repeater observations; expiry pauses region-query scheduling while retaining inventory/successful answers. Valid operator overrides take precedence, and example/config-code defaults must agree for omitted settings. Exact validation bounds remain implementation-plan details; #68/#74 also capture the shared configuration direction.

The 16 scoped issues cover Pillar 1 and OBS-02. Each includes outcome/scope, dependencies, acceptance criteria, validation expectations, existing seams, source requirements, and protected-boundary decisions. Issue numbering is a stable reference, not a requirement to finish unrelated features serially.

Planning started on 2026-10-08: code-grounded draft plans are appended to #24/#25/#26/#28's local records and GitHub descriptions. See the [implementation planning queue](pillar-1-implementation-queue.md) for readiness, review order, remaining plan work and scoped dependency gates. No further global question round is required before drafting; relevant issue-local choices and protected-boundary approval still precede coding. Draft completion does not mark a feature implemented or ready for closure.

Implementation completion on 2026-10-08: #28's reviewed plan was approved and all five tasks completed. 508 tests and lint pass; acceptance/outcome aggregates, identity evidence, migration/recovery and shared retention are verified. GitHub #28 is closed as completed with the progress label removed and native project Status Done; #18's child checklist and #23's reusable bot contract are synchronized. Other issues remain open. Changes are local and uncommitted; the release planning folder remains excluded by the existing Git ignore rule.

| Key | GitHub issue | Type | Implementation prerequisites | Local record |
| --- | --- | --- | --- | --- |
| P1-01 | [#22: Protocol, firmware, and library capability assessment](https://github.com/Robotti-io/Meshcore-Observer/issues/22) — complete / Done | Research | Source assessment complete; deployed support/hardware gates documented separately | [Record](pillar-1-issues/p1-01.md), [matrix](remote-capability-notes.md) |
| P1-02 | [#23: Reporting semantics, identity, retention, and data ownership](https://github.com/Robotti-io/Meshcore-Observer/issues/23) | Decision | None | [Record](pillar-1-issues/p1-02.md) |
| P1-03 | [#24: Persist Observer run and shutdown history](https://github.com/Robotti-io/Meshcore-Observer/issues/24) — closed, project Done, 2026-10-08 | Feature | Relevant #23 run decisions settled | [Record](pillar-1-issues/p1-03.md) |
| P1-04 | [#25: Sample process resources and selected runtime events](https://github.com/Robotti-io/Meshcore-Observer/issues/25) — closed, project Done, 2026-10-08 | Feature | Relevant #23 resource decisions settled; #24 pushed | [Record](pillar-1-issues/p1-04.md) |
| P1-05 | [#26: Persist verified node adverts and direct-heard evidence](https://github.com/Robotti-io/Meshcore-Observer/issues/26) — closed, project Done, 2026-10-08 | Feature | Relevant #23 decisions resolved | [Record](pillar-1-issues/p1-05.md) |
| P1-06 | [#27: Persist passive topology and path evidence](https://github.com/Robotti-io/Meshcore-Observer/issues/27) — pushed / Done | Feature | All five tasks approved, implemented, validated and pushed cae9a48; no open gate | [Record](pillar-1-issues/p1-06.md#implementation-plan) |
| P1-07 | [#28: Aggregate bot usage by sender and command](https://github.com/Robotti-io/Meshcore-Observer/issues/28) — closed, project Done, 2026-10-08 | Feature | Relevant #23 decisions resolved | [Record](pillar-1-issues/p1-07.md) |
| P1-08 | [#29: Coordinate remote requests and conservative radio scheduling](https://github.com/Robotti-io/Meshcore-Observer/issues/29) — complete / Done | Feature | All T1–T5/acceptance delivered and user-pushed bc27968; 711 tests, coverage/lint pass | [Plan](pillar-1-issues/p1-08.md#implementation-plan) |
| P1-09 | [#30: OBS-02: Persist region answers and freshness](https://github.com/Robotti-io/Meshcore-Observer/issues/30) — complete / Done | Feature | All T1–T5 user-pushed f2d567c / migration 14; 796 tests/coverage/lint pass | [Plan](pillar-1-issues/p1-09.md#implementation-plan) |
| P1-10 | [#31: OBS-02: Query recently direct-heard repeater regions](https://github.com/Robotti-io/Meshcore-Observer/issues/31) — complete / Done | Feature | T1–T4 user-pushed 4e7d92e; T5 complete locally; 975 tests/full single-worker coverage and lint pass; all six fixture criteria met | [Plan/evidence](pillar-1-issues/p1-10.md#implementation-plan) |
| P1-11 | [#32: OBS-02: Publish region declarations to CoreScope](https://github.com/Robotti-io/Meshcore-Observer/issues/32) | Feature | [#22](https://github.com/Robotti-io/Meshcore-Observer/issues/22), [#23](https://github.com/Robotti-io/Meshcore-Observer/issues/23), [#30](https://github.com/Robotti-io/Meshcore-Observer/issues/30) | [Record](pillar-1-issues/p1-11.md) |
| P1-12 | [#33: Persist supported repeater telemetry and range queries](https://github.com/Robotti-io/Meshcore-Observer/issues/33) | Feature | [#22](https://github.com/Robotti-io/Meshcore-Observer/issues/22), [#23](https://github.com/Robotti-io/Meshcore-Observer/issues/23) | [Record](pillar-1-issues/p1-12.md) |
| P1-13 | [#34: Poll repeater telemetry within a configured hop radius](https://github.com/Robotti-io/Meshcore-Observer/issues/34) | Feature | [#22](https://github.com/Robotti-io/Meshcore-Observer/issues/22), [#23](https://github.com/Robotti-io/Meshcore-Observer/issues/23), [#27](https://github.com/Robotti-io/Meshcore-Observer/issues/27), [#29](https://github.com/Robotti-io/Meshcore-Observer/issues/29), [#33](https://github.com/Robotti-io/Meshcore-Observer/issues/33) | [Record](pillar-1-issues/p1-13.md) |
| P1-14 | [#35: Integrate historical reporting APIs](https://github.com/Robotti-io/Meshcore-Observer/issues/35) | Feature | [#24](https://github.com/Robotti-io/Meshcore-Observer/issues/24), [#25](https://github.com/Robotti-io/Meshcore-Observer/issues/25), [#26](https://github.com/Robotti-io/Meshcore-Observer/issues/26), [#27](https://github.com/Robotti-io/Meshcore-Observer/issues/27), [#28](https://github.com/Robotti-io/Meshcore-Observer/issues/28), [#33](https://github.com/Robotti-io/Meshcore-Observer/issues/33) | [Record](pillar-1-issues/p1-14.md) |
| P1-15 | [#36: Connect telemetry, node, bot, and runtime dashboard reporting](https://github.com/Robotti-io/Meshcore-Observer/issues/36) | Feature | [#35](https://github.com/Robotti-io/Meshcore-Observer/issues/35), [P4-04 — #41](https://github.com/Robotti-io/Meshcore-Observer/issues/41) | [Record](pillar-1-issues/p1-15.md) |
| P1-16 | [#37: Validate Pillar 1 RF impact, recovery, performance, and operator guidance](https://github.com/Robotti-io/Meshcore-Observer/issues/37) | Validation | [#24](https://github.com/Robotti-io/Meshcore-Observer/issues/24), [#25](https://github.com/Robotti-io/Meshcore-Observer/issues/25), [#26](https://github.com/Robotti-io/Meshcore-Observer/issues/26), [#27](https://github.com/Robotti-io/Meshcore-Observer/issues/27), [#28](https://github.com/Robotti-io/Meshcore-Observer/issues/28), [#29](https://github.com/Robotti-io/Meshcore-Observer/issues/29), [#30](https://github.com/Robotti-io/Meshcore-Observer/issues/30), [#31](https://github.com/Robotti-io/Meshcore-Observer/issues/31), [#32](https://github.com/Robotti-io/Meshcore-Observer/issues/32), [#33](https://github.com/Robotti-io/Meshcore-Observer/issues/33), [#34](https://github.com/Robotti-io/Meshcore-Observer/issues/34), [#35](https://github.com/Robotti-io/Meshcore-Observer/issues/35), [#36](https://github.com/Robotti-io/Meshcore-Observer/issues/36) | [Record](pillar-1-issues/p1-16.md) |

## Recommended progression

1. Start with P1-01 capability research and P1-02 reporting/data decisions. These produce evidence and proposed decisions, without changing runtime behavior or dependencies.
2. Establish P1-03/P1-04 run and resource measurements early; add P1-05 advert observations, P1-06 path evidence, and P1-07 bot aggregates as their prerequisites settle.
3. Implement the shared P1-08 remote-request coordination seam, and P1-09 region-answer persistence. P1-10 adds direct-heard querying; P1-11 publication can be planned/tested against stored answers without waiting for a live poller.
4. P1-12 establishes supported telemetry persistence before P1-13 active polling. Discovery-specific upstream availability is not a blanket blocker for independent telemetry support.
5. P1-14 provides reporting APIs and P1-15 connects dashboard consumers, using the early Pillar 4 foundation. P1-16 validates the integrated result and documents operation.

These are dependency-aware delivery recommendations. Prepare and approve one child implementation plan at a time; approval to capture issues is not approval for concrete dependency, storage, authentication, public API/MQTT, logging-contract, CSP, or deployment changes.

## OBS-02 ownership

- P1-05 owns reusable verified direct-heard evidence.
- P1-08 owns reusable remote-request/radio coordination.
- P1-09 owns durable successful region answers and freshness.
- P1-10 owns opt-in direct-heard querying, contact prerequisites, request correlation, and bounded retries.
- P1-11 owns per-broker CoreScope-compatible publication and its approved retry behavior.
- P1-01/P1-02 settle capability, identity, freshness, retention, and contract assumptions; P1-16 collects authorized end-to-end evidence.

Initial OBS-02 remains zero-hop, anonymous, and MQTT-focused. Broader telemetry routing, bot response scopes, region dashboards, management commands, and GPS/RF uploads do not become part of discovery through these issues.

## Source and tracking notes

Sources: [Pillar 1 request](feat-improved_telemetry_and_reporting.md), [OBS-02](../feat-repeater_region_discovery.md), and [sequencing review](review-pillars-and-sequencing.md). Source documents/local records remain in the unpublished release working branch; the GitHub issues contain self-contained scope and acceptance details.

Native parent/child linking uses GitHub's [documented sub-issue API](https://docs.github.com/en/rest/issues/sub-issues). Dependency links inside each child refer to the actual created issue numbers. No runtime checks or live radio/broker operations were performed during issue capture; documentation/link verification is appropriate to this change.
