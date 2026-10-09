# v2.5.0 epic register

Created: 2026-10-07. Current stage: all four epics and all child-issue breakdowns captured; implementation planning remains pending.

**Issue labels:** [v2.5.0 conventions and verified mapping](issue-label-guide.md) for all four epics and 62 children.

| Pillar | GitHub tracking epic | Source request | Local epic record |
| --- | --- | --- | --- |
| 1 | [#18: Improved Telemetry & Reporting](https://github.com/Robotti-io/Meshcore-Observer/issues/18) | [Feature request](feat-improved_telemetry_and_reporting.md) | [Epic record](epic-1-tracking.md) |
| 2 | [#19: Simplified Setup](https://github.com/Robotti-io/Meshcore-Observer/issues/19) | [Feature request](feat-simplified_setup.md) | [Epic record](epic-2-tracking.md) |
| 3 | [#20: Enhanced Bots](https://github.com/Robotti-io/Meshcore-Observer/issues/20) | [Feature request](feat-enhanced_bots.md) | [Epic record](epic-3-tracking.md) |
| 4 | [#21: UI/UX Refinement & Robotti Design-System Alignment](https://github.com/Robotti-io/Meshcore-Observer/issues/21) | [Feature request](feat-ui_ux_refinement_and_design_alignment.md) | [Epic record](epic-4-tracking.md) |

## Scope decision

[OBS-02: Repeater Region Discovery for CoreScope](../feat-repeater_region_discovery.md) is included in v2.5.0 under Pillar 1 by explicit human direction on 2026-10-07. Its scope includes verified direct-heard eligibility, anonymous region requests, durable answers, and opt-in CoreScope-compatible publication. It remains independent of telemetry credentials and bot outbound scope policy.

Concrete dependency, storage, MQTT/API, authentication, logging-contract, CSP, and deployment choices require approval in their implementation plans. Epic creation and release inclusion do not authorize application implementation.

## Sequencing recommendation

The [pillar review](review-pillars-and-sequencing.md) recommends main delivery order **1 → 3 → 2 → 4**, with shared UI foundations and setup architecture decisions addressed early. This remains a recommendation for discussion.

Pillar 1's OBS-02 work can establish conservative zero-hop active discovery before broader telemetry when library/firmware/contact prerequisites are available. Unrelated reporting and otherwise supported telemetry need not wait on a discovery-specific upstream blocker.

## Next stage

All four breakdowns are captured: [Pillar 1 — 16 issues](pillar-1-child-issues.md), [Pillar 2 — 17 issues](pillar-2-child-issues.md), [Pillar 3 — 14 issues](pillar-3-child-issues.md), and [Pillar 4 — 15 issues](pillar-4-child-issues.md). Begin scoped research/decision planning and the early shared UI foundation, then approve one implementation plan at a time. OBS-02 retains dedicated persistence, direct-heard querying, and publication issues. Consumers link to shared owning issues rather than duplicating them.

The source requests and local records are maintained in the local `release-v_2_5_0` branch. At epic creation time, that branch and the feature documents were not published on GitHub, so the issues reference repository paths and include self-contained scope/acceptance details. Add permanent source links when those documents are published.
