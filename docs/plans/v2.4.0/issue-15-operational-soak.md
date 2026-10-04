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
- **Definition of done:** Checklist captures all issue #15 questions and avoids logging credentials/personal data. **Status: complete.**
- **Expected tests / validation:** Review monitoring fields against existing dashboard/SQLite/log capabilities.

#### T2: Conduct multi-day observation

- **Objective:** Gather evidence under normal operation.
- **Specific changes:** Track RSS, DB growth/query responsiveness, retention, queue depth/expiry, repeat counts, broker/radio reconnects, scheduler behavior, dashboard, and clean restart.
- **Definition of done:** Observations cover the performed soak window and list unexplained regressions separately from expected behavior. **Status: complete; see the results below.**
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

### 7. Completed Soak Results

- **Target instance:** Run the candidate from this project workspace using the copied, ignored configuration and database. The previous active instance was halted first, so only one process should own the radio and broker connections.
- **Actual duration:** Started Friday, October 2, 2026 at 17:59:20 EDT and stopped gracefully Sunday, October 4 at 09:38:07 EDT at the user's direction: **39 hours, 38 minutes, 47 seconds elapsed**. This is wall-clock duration and includes restart/recovery interruptions; it is not 39 hours of uninterrupted connectivity. The planned end-of-day Sunday stop was therefore not reached.
- **Manual cadence:** Observations were recorded about every 15 minutes. The copied environment configures internal health sampling at 1 second and retention at unlimited (`0`); interpret database growth with those settings in mind.
- **Observation log:** [Local working log](../../working_docs/issue-15-operational-soak-log.md), stored under Git-ignored `docs/working_docs/` so the detailed operational log is not committed.
- **Observation sources:** `/api/metrics`, application output, metrics-listener process RSS/CPU where available, and SQLite database/WAL/SHM sizes. Do not record secrets, broker addresses, packet payloads/hashes, or personal data.
- **Resource criteria:** No hard RAM/disk ceiling was provided. Report trends and workload context rather than inventing thresholds; unlimited-retention database growth is expected.
- **Performance assessment:** The observed steady-state results were within the expected operating window for this workload. During healthy intervals, all received packets were decoded, both brokers had matching delivery counts with no skips or failures, all 3 enabled bots were ready, the reply queue remained empty, and the radio had no reconnects. After startup, measured interval CPU use was generally about 0.1–0.2% of one logical CPU; measured process RSS declined from about 102 MiB to about 70 MiB after the forced-recovery restart. Earlier aggregate Node RSS samples fluctuated between 115.5 and 141.1 MiB without a sustained upward trend. Database growth was gradual under unlimited retention; WAL/SHM sizes remained stable. No end-to-end latency metric or pre-update benchmark was available, so these results support operational stability, not a comparative latency or speed claim.
- **Errors and findings:** No new functional application bug or material performance regression was identified. The recurring unhandled `0x8E` CONTROL_DATA frame produced console noise but did not coincide with capture, decode, delivery, readiness, or queue failures; the user reported that the dependency PR addressing it was merged upstream, but the running npm dependency did not yet contain the fix. The `0x90` CONTACTS_FULL frame indicates the companion radio's contact storage is full and showed no observer capture/forwarding impact. Initial MQTT `EACCES` failures were caused by sandbox/network approval restrictions, not application behavior.
- **Clean restart:** The October 3 20:00 EDT checkpoint initially launched in a restricted execution context and could not connect to either broker. That instance was stopped at the user's request; one network-enabled replacement was started at 20:15 EDT and connected successfully.
- **Forced process termination:** The authorized target was Sunday, October 4 at 08:00 EDT, but the termination was actually performed at 04:02 EDT (08:02 UTC), 3 hours 58 minutes early because the UTC automation timestamp was mistaken for local EDT. The listener-owning process was force-terminated and the metrics endpoint was confirmed down. The replacement start was delayed until 07:11 EDT while network-enabled execution approval was pending, creating a 3-hour 9-minute gap. Once started, it connected to the radio and both brokers, all bots became ready, and the queue was empty. This tested process-crash recovery, not power-loss resilience; the approval wait is not application startup time.
- **Final stop:** Graceful SIGINT shutdown completed at 09:38:07 EDT Sunday, October 4; the metrics endpoint and port 3000 listener were confirmed down.
- **Radio effect:** Every restart can request a startup flood advert and resets the 47-hour advert interval. Avoid testing during an active transmission or with queued replies that could expire or be resent unexpectedly.
- **Preflight note:** A sandboxed launch at 21:57:30 UTC was excluded from the soak after MQTT connections were denied. The authorized launch at 21:59:20 UTC connected the radio and both brokers.

T1 and T2 are complete. No live deployment settings were changed. T3 follow-up remains limited to tracking the `0x8E` console-noise fix through an npm release and considering a regression check when that version is available.

### 8. Suggested Execution Order

1. T1 — define safe scope and evidence format.
2. T2 — observe normal operation and planned restart.
3. T3 — turn findings into tests and issue-linked fixes.
