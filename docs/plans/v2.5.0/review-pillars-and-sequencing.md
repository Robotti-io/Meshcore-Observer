# v2.5.0 pillar review and recommended sequencing

Reviewed: 2026-10-07. Status: sequencing recommendation for discussion, not an approved implementation plan. OBS-02 release inclusion was explicitly approved on 2026-10-07.

Tracking update: [all four epics and 62 child issues](epics.md) are captured on GitHub. The issue registers record concrete dependencies; detailed implementation planning remains pending.

## Sources and scope

- [Pillar 1: Improved Telemetry & Reporting](feat-improved_telemetry_and_reporting.md)
- [Pillar 2: Simplified Setup](feat-simplified_setup.md)
- [Pillar 3: Enhanced Bots](feat-enhanced_bots.md)
- [Pillar 4: UI/UX Refinement & Robotti Design-System Alignment](feat-ui_ux_refinement_and_design_alignment.md)
- [MeshCore.js PR #44: anonymous repeater region discovery](https://github.com/meshcore-dev/meshcore.js/pull/44)
- [OBS-02: Repeater Region Discovery for CoreScope](../feat-repeater_region_discovery.md), included in v2.5.0 under Pillar 1 by explicit human direction on 2026-10-07.

This review also inspected the existing configuration, node registry, SQLite store, sampler, bot reply queue, radio command queue, airtime coordinator, and dashboard integration seams. The installed MeshCore.js version is 1.15.0; the Observer package version is 2.4.0. No application changes or hardware checks were performed.

## Recommendation

Use **Pillar 1 → Pillar 3 → Pillar 2 → Pillar 4** as the main delivery sequence, with a small Pillar 4 foundation step before new screens are built. Resolve setup architecture and packaging questions early, even though the complete setup experience is delivered later.

These are delivery priorities, not a requirement to finish an entire epic before starting every child feature in the next one. The dependency is between specific foundations and their consumers.

| Priority | Pillar | Reason |
| --- | --- | --- |
| 1 | Improved Telemetry & Reporting | Establish runtime measurements, reusable observations, reporting semantics, and conservative remote-request behavior. These give later work evidence and shared foundations. |
| 2 | Enhanced Bots | Extend the existing handler and durable reply seams once shared radio constraints and reporting ownership are understood. Finalize the bot configuration the setup UI must represent. |
| 3 | Simplified Setup | Build guided configuration against settled telemetry and bot schemas. Installer, administration, activation, and recovery work has the broadest platform and privilege scope. |
| 4 | UI/UX completion | Integrate the completed reporting, bot, and setup workflows; validate navigation, semantics, accessibility, responsiveness, and performance across the whole product. |

### Early foundation and decision work

Before substantial feature implementation:

1. Validate the protocol/library/firmware capabilities needed for telemetry, private messaging, ACKs, and flood scoping. Record verified support, unknowns, and external blockers separately.
2. Agree on invocation versus delivery metrics, historical event versus current-inventory semantics, and ownership of topology and reply lifecycle data.
3. Establish the shared UI tokens, form/status patterns, visualization conventions, and proposed navigation structure. Confirm the canonical design-system source and approved assets before claiming alignment.
4. Decide the supported installation matrix, configuration/data layout, setup-mode boundary, and initial apply/restart model. This prevents later packaging assumptions from forcing a redesign.

Proceed one approved child task at a time. This early work does not authorize dependency, storage, authentication, API, logging-contract, CSP, or deployment changes.

## Order within each pillar

### Pillar 1: Improved Telemetry & Reporting

Recommended sequence:

1. Protocol research and reporting/data semantics.
2. Observer run history and CPU/memory sampling, so later operational tests have a baseline.
3. Verified node-advert observations and passive path history, including freshness and ambiguous identifier handling.
4. Aggregate bot usage reporting using existing reply records where their meaning is sufficient.
5. Shared remote-request coordination and OBS-02's direct-heard region discovery, durable answer semantics, and CoreScope publication, once verified library/firmware/contact support is available.
6. Conservative telemetry authentication, eligibility, scheduling, response validation, and timestamped persistence, reusing the shared coordination established for discovery.
7. API/dashboard integration and measured RF, storage-growth, and capture-performance validation.

Runtime reporting, advert reporting, and existing bot aggregates do not depend on anonymous region discovery. They can progress while upstream or firmware questions remain open.

OBS-02's zero-hop anonymous discovery is a narrower first active polling feature than routed credentialed telemetry. Deliver it first when its prerequisites are available; a discovery-specific upstream blocker need not hold up telemetry whose own capability and coordination requirements are resolved. Reusable scheduling belongs to Pillar 1 and is shared with Pillar 3, without merging their distinct routing policies.

Important qualifications:

- Current command-count queries count **sent replies by resolution time**. They are not already counts of every received or accepted invocation. Define the new measures before changing queries, and avoid inventing missing historical data.
- The registry stores verified **named** adverts with first/last-heard state. Arbitrary historical re-hear counts need additional observation data; the current row cannot reconstruct them.
- Observed path identifiers and hop proximity are evidence, not proof of an outbound route. Resolve prefixes conservatively against full identities and validate protocol routing behavior before polling.
- Preserve the always-on single `MetricsStore` owner. Add incremental transactional migrations rather than a broad speculative store refactor.

### Pillar 3: Enhanced Bots

Recommended sequence:

1. Companion identity, Unicode/tag syntax, and command-level targeting.
2. Agree on the small delivery-policy and lifecycle model needed by suppression, private messages, and scoped sends.
3. Handler-aware cooperative suppression, with durable outcomes and reporting.
4. Region-name/key and firmware research, then atomic scope/apply/send/restore behavior and explicit failure policy.
5. Private command intake and private reply transport, then ACK correlation, bounded retries, and restart/reconnect behavior.
6. Integrated bot reporting and real multi-bot/RF validation.

Region scoping and private messaging are separate branches after shared delivery work. If scoping research is blocked, private messaging can proceed once its own prerequisites are satisfied. Private delivery through valid Companion contact state need not wait for all topology features; using observed topology is a separate integration decision.

Important qualifications:

- Companion names are not guaranteed unique. Define duplicate-name behavior before promising that a name tag always selects one physical bot.
- A reply currently remains `pending` in SQLite while dispatch runs. Suppression must respect the actual transmission-commit boundary, rather than treating every pending row as cancellable.
- Public repeat confirmation and private destination ACKs are different evidence. Preserve their meanings and avoid double-counting one reply as separate deliveries.
- A scoped send must hold shared radio ownership across the complete scope/send/restoration sequence. Individually serialized calls do not make the sequence atomic.

### Pillar 2: Simplified Setup

Recommended sequence:

1. Setup-mode architecture, local administration security, platform matrix, and installation layout decisions.
2. Reuse authoritative configuration validation; establish a static configuration doctor before active connectivity checks.
3. Candidate configuration, complete validation, safe apply, known-good preservation, and a defined activation/recovery model.
4. Guided radio, MQTT, bot, and general configuration forms using the early Pillar 4 foundation.
5. Existing-installation loading/reconfiguration, interrupted setup handling, and secret-safe export/import.
6. Windows installation and existing Scheduled Task integration, then Linux/Raspberry Pi installation and supported service integration.
7. Service controls, upgrade-preservation tests, accessibility checks, and operator documentation.

Important qualifications:

- The existing dashboard is an unauthenticated viewer. Adding configuration writes and service controls creates an administrative surface; loopback binding alone is not the complete security design.
- Replacing each file atomically is not an atomic change across environment, broker, and bot files. Specify recovery from partial multi-file activation before implementing writes.
- Prefer validated restart for the initial model, subject to approval, rather than adding live reload to the same release by default.
- Setup must be independently launchable when runtime configuration is incomplete. Preserve normal fail-fast startup and environment-driven container deployment.
- Packaging must account for the supported Node runtime and native serial components on Windows and Linux/ARM. Choose artifacts after research, within the JavaScript-only and dependency rules.

### Pillar 4: UI/UX Refinement

Split this pillar into an early foundation and a final integration phase.

Early sequence:

1. Current frontend audit and navigation/information hierarchy proposal.
2. Approved design tokens and shared controls/forms/status patterns.
3. Product-specific visualization rules, metric labels, keyboard/focus behavior, and responsive conventions.

Then apply those patterns as each feature's screens are implemented. Final sequence:

4. Integrate the final reporting, bot, runtime, node, and setup workflows.
5. Standardize loading, empty, unavailable, stale, error, and partial-data behavior across views.
6. Validate chart/table alternatives, long identifiers, search/filter behavior, responsive layouts, reduced motion, and escaping.
7. Measure rendering/update performance and document contributor guidance.

The current dashboard loads Chart.js from a CDN. Resolve the intended offline experience early; any asset/dependency or CSP change remains a separate approval boundary. Chart palettes are Observer product decisions, not new Robotti brand canon.

## What PR #44 changes about the plan

At review time, PR #44 was open and unmerged. It adds `sendAnonRequest()` and `getRegions(publicKey)` for repeater declarations; it does not add channel/message region support.

Its documented constraints include a minimum **verified** Companion version of v1.12.0, an existing contact with a direct route, caller serialization of remote requests, and possibly incomplete region lists without an explicit truncation signal. The PR reports hardware checks; this review did not independently repeat them.

Accordingly:

- A merge alone does not make these APIs available in the installed npm package. Observer integration needs a verified available artifact and a separately approved dependency change or other explicitly approved integration approach.
- Region discovery, telemetry authentication, and outbound flood scoping are distinct capabilities.
- Remote-request ownership must cover the response/timeout/disconnect lifecycle, not just the initial command acknowledgement. Also define scheduling priority and maximum waiting time so remote polling does not starve bot replies.
- Missing or possibly partial declarations must not silently become permission for broader transmission.
- OBS-02 is included in v2.5.0 under Pillar 1 by explicit human direction. Its reusable discovery/observation and CoreScope publication belong to Pillar 1; bot response policy remains in Pillar 3. Inclusion authorizes scope and planning; concrete dependency, persistence, and public MQTT-contract changes still require implementation-plan approval.

## Recommended epic and issue workflow

Create four parent tracking issues using the existing pillar numbers and titles. Link each source request instead of copying the full specification into an issue body. Include:

- Operator outcome and approved release scope.
- Dependencies and external blockers.
- Decisions still required, including protected-boundary approvals.
- Child issue checklist and pillar-level acceptance criteria.
- Validation and documentation expectations.

Assign shared work a single owner: observation/persistence to Pillar 1, setup/activation to Pillar 2, bot policy/delivery to Pillar 3, and shared visual/interaction patterns to Pillar 4. Link consumers rather than duplicate implementation issues.

The four original requests list **64 suggested child features** in total, with OBS-02 now added as a workstream under Pillar 1. Treat these as candidates to consolidate after research, not predetermined implementation tickets. Establish required versus optional scope before committing to a release date; any deferral must be explicit.

Then proceed through: four epics → scoped research/decision and feature issues → one approved implementation plan → implementation and validation → repeat. Finish with migration/recovery, hardware/RF, installation-platform, accessibility, performance, and operational-soak evidence covering the combined release.
