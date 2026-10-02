# Issue #15 — Long-running operational soak validation

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/15](https://github.com/Robotti-io/Meshcore-Observer/issues/15)

## Implementation Plan

### 1. Feature Summary

Use an existing local deployment for a meaningful multi-day observation of memory, persistence, reconnects, queues, scheduling, metrics, dashboard, and recovery, then convert reproducible defects into automated regression tests.

### 2. Relevant Existing Architecture

- `src/index.js` coordinates startup, radio/MQTT services, SQLite, metrics, bots, scheduled flood adverts, and shutdown.
- `MetricsStore` persists metrics, bot reply lifecycle, nodes, and flood-advert state; raw packet data is intentionally published to MQTT rather than stored locally.
- Radio and MQTT managers expose lifecycle events; `ReplyQueue` and `FloodAdvertScheduler` own bounded persisted work and restart behavior.
- Existing tests simulate radio/MQTT behavior and reopen SQLite stores; physical hardware observation remains distinct from simulation.

### 3. Proposed Approach

Define a lightweight, repeatable observation record before the soak: deployment version/config fingerprint (excluding secrets), start/end times, periodic RSS/database size/queue/health snapshots, and a log-event summary. Observe a deployment the user already operates; do not interrupt another running instance or change hardware/runtime configuration as part of this plan. Capture clean restart and an approved unexpected-stop simulation only where it can be done without risking live state. Convert each reproducible issue to a deterministic test and assign follow-up fixes to the owning release item.

### 4. Impacted Areas

- Operational runbook/checklist under `docs/plans/v2.4.0/` or release notes.
- Existing observability surfaces: logger, `MetricsStore`, `MetricsSampler`, dashboard, MQTT/radio managers, reply queue, flood-advert scheduler.
- Regression tests in owning domains; likely `test/index.test.js`, `test/metrics/store.test.js`, `test/bots/reply-queue.test.js`, and `test/radio/flood-advert-scheduler.test.js`.

### 5. Task Breakdown

#### T1: Define observation protocol and baseline

- **Objective:** Make multi-day findings comparable and attributable.
- **Specific changes:** Record duration, sample cadence, metric sources, expected operating conditions, restart checkpoints, and sensitive-data exclusions.
- **Definition of done:** Checklist captures all issue #15 questions and avoids logging credentials/personal data.
- **Expected tests / validation:** Review monitoring fields against existing dashboard/SQLite/log capabilities.

#### T2: Conduct multi-day observation

- **Objective:** Gather evidence under normal operation.
- **Specific changes:** Track RSS, DB growth/query responsiveness, retention, queue depth/expiry, repeat counts, broker/radio reconnects, scheduler behavior, dashboard, and clean restart.
- **Definition of done:** Observations cover agreed duration and list unexplained regressions separately from expected behavior.
- **Expected tests / validation:** Compare start/end and time-series observations; document restart and any safely simulated failure/recovery.

#### T3: Reproduce findings and assign fixes

- **Objective:** Feed production evidence back into automated confidence.
- **Specific changes:** For each defect, capture trigger/state, reproduce without hardware where practical, add a regression test, and link remediation to the responsible issue.
- **Definition of done:** Each finding has evidence, disposition, and test/follow-up; hardware-only limitations are explicit.
- **Expected tests / validation:** Regression reproduction fails before fix and passes after; review applicable release exit criteria.

### 6. Risks and Edge Cases

- A multi-day observation can reveal trends but cannot prove rare failures never occur.
- Database growth may be expected under unlimited retention and must be interpreted with workload context.
- Simulated termination should not jeopardize the live database or running local instance.
- Logs and metrics must not expose broker passwords, JWTs, or unredacted personal data.

### 7. Open Questions / Assumptions

- What duration and observation cadence constitute a meaningful soak for this deployment?
- Which local instance and hardware are in scope, and may a restart be scheduled during the observation?
- Is there an approved way to simulate unexpected process termination against a disposable copy of the database?
- Assumption: this plan is observational and does not authorize changing live deployment or radio settings.

### 8. Suggested Execution Order

1. T1 — define safe scope and evidence format.
2. T2 — observe normal operation and planned restart.
3. T3 — turn findings into tests and issue-linked fixes.
