# [Epic][v2.5.0] Pillar 1: Improved Telemetry & Reporting

**GitHub epic:** [#18](https://github.com/Robotti-io/Meshcore-Observer/issues/18)

**Stage:** In progress — first-wave backend/coordination features and research are complete. #30 T1–T5 are complete; REGION-PLAN-01–05 are delivered. T1–T4 are user-pushed at 0f46233 / migration 14, verified locally/remotely with a clean starting tree. T5 is complete locally on 2026-10-09: five new integrated/cost scenarios; full 72 files / 796 tests pass in functional and coverage runs, with lint and coverage thresholds passing. Coverage-run region p95: normal two-broker writes 4.096ms (<10ms), slowest bounded read 56.931ms (<100ms); offline migration, pruning, clean/abrupt restart and closed-backup restore pass. #30 is completed/project Done with its progress label removed and all four acceptance items checked. #18/#23 stay OPEN/In progress; #22/#29 stay completed/Done. Next is #31 implementation planning; #31/#32 retain actual RF/publication activation.
Research records versioned capabilities and deployment limits. #29 delivers the validated shared internal seam with configurable limits, bounded ACK recovery, priority and idle lifecycle; startup schedules no polls. Public reporting/dashboard and active discovery/telemetry remain in their owning issues.

## Operator outcome

Provide a durable operational picture of nearby repeaters, verified node activity, bot usage, and Observer runtime health while keeping active RF traffic conservative.

## Scope and sources

- `docs/plans/v2.5.0/feat-improved_telemetry_and_reporting.md`
- **OBS-02 is included in v2.5.0 under this epic by explicit human direction on 2026-10-07:** `docs/plans/feat-repeater_region_discovery.md`.
- Sequencing review: `docs/plans/v2.5.0/review-pillars-and-sequencing.md`.

Source requests currently live in the local `release-v_2_5_0` working branch; permanent source links should be added when those documents are published.

Own reusable observation/persistence, reporting semantics, and shared remote-request coordination. OBS-02 includes opt-in discovery of declared regions from recently direct-heard verified repeaters, durable answers, and CoreScope-compatible MQTT publication. Anonymous discovery stays independent of telemetry credentials and has a narrower zero-hop eligibility rule than routed telemetry.

## Child issues

Captured on 2026-10-07. All 16 children have scoped outcomes, dependencies, acceptance criteria, validation expectations, and implementation-plan approval decisions.

- [x] [P1-01: Protocol, firmware, and library capability assessment](https://github.com/Robotti-io/Meshcore-Observer/issues/22)
- [ ] [P1-02: Reporting semantics, identity, retention, and data ownership](https://github.com/Robotti-io/Meshcore-Observer/issues/23)
- [x] [P1-03: Persist Observer run and shutdown history](https://github.com/Robotti-io/Meshcore-Observer/issues/24)
- [x] [P1-04: Sample process resources and selected runtime events](https://github.com/Robotti-io/Meshcore-Observer/issues/25)
- [x] [P1-05: Persist verified node adverts and direct-heard evidence](https://github.com/Robotti-io/Meshcore-Observer/issues/26)
- [x] [P1-06: Persist passive topology and path evidence](https://github.com/Robotti-io/Meshcore-Observer/issues/27)
- [x] [P1-07: Aggregate bot usage by sender and command](https://github.com/Robotti-io/Meshcore-Observer/issues/28)
- [x] [P1-08: Coordinate remote requests and conservative radio scheduling](https://github.com/Robotti-io/Meshcore-Observer/issues/29)
- [x] [P1-09: OBS-02: Persist region answers and freshness](https://github.com/Robotti-io/Meshcore-Observer/issues/30)
- [ ] [P1-10: OBS-02: Query recently direct-heard repeater regions](https://github.com/Robotti-io/Meshcore-Observer/issues/31)
- [ ] [P1-11: OBS-02: Publish region declarations to CoreScope](https://github.com/Robotti-io/Meshcore-Observer/issues/32)
- [ ] [P1-12: Persist supported repeater telemetry and range queries](https://github.com/Robotti-io/Meshcore-Observer/issues/33)
- [ ] [P1-13: Poll repeater telemetry within a configured hop radius](https://github.com/Robotti-io/Meshcore-Observer/issues/34)
- [ ] [P1-14: Integrate historical reporting APIs](https://github.com/Robotti-io/Meshcore-Observer/issues/35)
- [ ] [P1-15: Connect telemetry, node, bot, and runtime dashboard reporting](https://github.com/Robotti-io/Meshcore-Observer/issues/36)
- [ ] [P1-16: Validate Pillar 1 RF impact, recovery, performance, and operator guidance](https://github.com/Robotti-io/Meshcore-Observer/issues/37)

Start with P1-01 protocol research and P1-02 reporting/data decisions. Runtime and aggregate reporting need not wait for discovery-specific upstream availability. OBS-02 is split into P1-09 durable answers, P1-10 direct-heard querying, and P1-11 CoreScope publication; shared observations/scheduling have their own owning issues.

## Dependencies and unresolved decisions

- Update 2026-10-09: #30 T1–T5 are complete; REGION-PLAN-01–05 are delivered. T1–T4 are user-pushed at 0f46233 / migration 14, verified locally/remotely with a clean starting tree. T5 is complete locally on 2026-10-09: five new integrated/cost scenarios; full 72 files / 796 tests pass in functional and coverage runs, with lint and coverage thresholds passing. Coverage-run region p95: normal two-broker writes 4.096ms (<10ms), slowest bounded read 56.931ms (<100ms); offline migration, pruning, clean/abrupt restart and closed-backup restore pass. #30 is completed/project Done with its progress label removed and all four acceptance items checked. #18/#23 stay OPEN/In progress; #22/#29 stay completed/Done. Next is #31 implementation planning; #31/#32 retain actual RF/publication activation.

- Planning wave started on 2026-10-08: `docs/plans/v2.5.0/pillar-1-implementation-queue.md` links the four code-grounded draft plans and maps remaining issue-local gates. Review recommendation is #28, #26, #24, then #25. Relevant approved decisions unlock each issue; completion of all #23 discussions is not a global prerequisite for planning or an otherwise-ready approved implementation slice.

- [MeshCore.js PR #44](https://github.com/meshcore-dev/meshcore.js/pull/44) proposes the anonymous-request APIs. Verify an available dependency artifact and supported deployed firmware; merge alone does not provide the installed API.
- Define safe direct contact handling without silently changing operator-managed routes or evicting contacts.
- Decide telemetry credential references, polling budgets, topology/answer freshness, retention, and CoreScope broker permissions/publication retries.
- Bot decisions settled on 2026-10-07: usage is eligible deduplicated acceptance, timed at acceptance; completed outcomes are separate and timed at resolution. Name-only channel sender attribution remains ambiguous. See `pillar-1-decisions.md` and #23/#28.
- Node advert decisions settled: distinct events and full-key nodes are separate; relayed copies of a signed advert count once, with reception evidence preserved; verified unnamed nodes are included. Initial reporting covers Companion and Repeater. On 2026-10-08, shared runtime-configurable advert-event retention and preservation of full-key inventory across pruning were agreed. Direct-heard eligibility rules and the configurable 72-hour default are agreed under #23/#26.
- Individual bot interaction persistence and backend aggregates are implemented in #28; public presentation remains #35/#36 and individual browsing is deferred. Approved migration 9 preserves existing records and adds optional identity evidence. Shared retention prunes whole completed rows by completion time, protecting pending rows. Supported telemetry fields still require research.
- Coordinate with Pillar 3 radio consumers and Pillar 4 reporting presentation. Pillar 2 consumes the resulting validated configuration.
- Direct-heard policy agreed on 2026-10-08: runtime-configurable eligibility from Observer reception time, refreshed only by verified zero-hop repeater observations. Expiry stops scheduling queries without erasing inventory or successful answers. Default is 72 hours with an operator override, consumed by #31. Exact validation bounds remain implementation-plan details.
- Configuration direction agreed on 2026-10-08: applicable operational settings favor validated operator overrides; approved optional defaults must match between example configuration and central code and apply when omitted. Invalid explicit values fail before side effects. #68/#74 carry this direction into setup/doctor; concrete names/units/bounds and example/code agreement checks belong in implementation plans.

## Epic acceptance

- [ ] Supported telemetry is collected only for eligible repeaters with bounded scheduling and secure credential handling.
- [x] Passive path evidence is persisted without treating observed paths as guaranteed outbound routes.
- [ ] Aggregate bot reporting distinguishes usage and delivery, follows reporting ranges, and exposes approved sender-level information.
- [ ] Historical advert events and unique-node/current-inventory counts retain distinct meanings.
- [x] Run history and resource samples survive restart; abrupt shutdown reporting does not invent an exact stop time.
- [ ] OBS-02 satisfies its documented acceptance criteria: verified direct-heard eligibility, direct request/zero-hop reply, matched tags, durable successful answers, and validated CoreScope publication.
- [x] Empty successful region answers remain distinct from unknown/failure; failures preserve prior successful answers and possibly incomplete declarations do not imply completeness.
- [ ] Discovery and telemetry failures, full/missing contacts, disconnects, and broker failures do not disrupt packet capture or silently broaden routing.
- [ ] Existing persisted metrics, pending replies, registry, and advert state survive migrations.
- [ ] Automated checks, authorized hardware/RF validation, retention/query-performance measurements, and operator documentation are complete.

## Delivery priority

Recommended first main delivery pillar. Establish runtime measurements and observations early; implement OBS-02 before broader active telemetry when its prerequisites are available. A discovery-specific upstream blocker need not stop independent reporting or otherwise supported telemetry.

## Related epics

- [Pillar 2: Simplified Setup](https://github.com/Robotti-io/Meshcore-Observer/issues/19)
- [Pillar 3: Enhanced Bots](https://github.com/Robotti-io/Meshcore-Observer/issues/20)
- [Pillar 4: UI/UX Refinement & Robotti Design-System Alignment](https://github.com/Robotti-io/Meshcore-Observer/issues/21)

## Planning status and approval boundaries

This v2.5.0 epic has 16 children; #28/#26/#24/#25/#27 and #22/#29/#30 are complete. #30 T1–T5 are complete; REGION-PLAN-01–05 are delivered. T1–T4 are user-pushed at 0f46233 / migration 14, verified locally/remotely with a clean starting tree. T5 is complete locally on 2026-10-09: five new integrated/cost scenarios; full 72 files / 796 tests pass in functional and coverage runs, with lint and coverage thresholds passing. Coverage-run region p95: normal two-broker writes 4.096ms (<10ms), slowest bounded read 56.931ms (<100ms); offline migration, pruning, clean/abrupt restart and closed-backup restore pass. #30 is completed/project Done with its progress label removed and all four acceptance items checked. #18/#23 stay OPEN/In progress; #22/#29 stay completed/Done. Next is #31 implementation planning; #31/#32 retain actual RF/publication activation. Presentation/offline assets/release validation remain in their owning issues.

Set active work to `In progress` in the [release project's Status field](https://github.com/orgs/Robotti-io/projects/1), alongside the supplemental `status:in-progress` issue label. Project #1 statuses for #18, #22, #23, and #26 were updated and verified on 2026-10-07. Check off completed decision/research acceptance items as evidence is recorded, and close each issue as completed only when its full deliverable and validation are satisfied. Verify project Status is `Done`, remove the progress label on closure, and synchronize this epic's child checklist and local register. Epic completion requires completion of its required children and epic acceptance outcomes.

Implement one approved child task at a time. Follow AGENTS.md: JavaScript ES modules, centralized strict AJV schemas, centralized configuration and structured logging, existing seams, and always-on MetricsStore ownership. Concrete authentication, storage, public API/MQTT, dependency, logging-contract, CSP, and deployment changes need explicit approval in the applicable implementation plan.

Use repository test/lint scripts for implementation validation.
