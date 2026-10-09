# Pillar 1 implementation planning queue

Updated: 2026-10-09. Parent: [#18](https://github.com/Robotti-io/Meshcore-Observer/issues/18).

The first backend wave and passive topology are complete. There are **zero prerequisite questions before drafting the next plan**. Run/resource/topology semantics are settled; the remaining high-level #23 discussions concern telemetry/region behavior. Concrete storage/configuration/API decisions are recorded in their owning plan and reviewed when picked up.

## First planning wave

Five plans are approved, fully implemented and user-pushed: #28/#26/#24/#25/#27, with runtime baseline cae9a48/migration 13. Completed owning issues use project Done. #22 research is complete; #29's finalized plan is now approved, with T1 user-pushed at a2f3558 and T2 user-pushed at bc4d3a6 and T3 user-pushed at f4d09e5 and T4 implemented/phase-validated locally with 706 functional tests/lint passing. Coverage thresholds pass; CI topology timing gate remains open. Further queue entries still need their issue-local plans.

| Review order | Issue / plan | Current readiness | Local review gates |
| --- | --- | --- | --- |
| Complete | [#28 bot usage](https://github.com/Robotti-io/Meshcore-Observer/issues/28) / [plan](pillar-1-issues/p1-07.md#implementation-plan) | Approved, implemented locally and validated; new API/UI remains #35/#36 | BOT-PLAN-01/02/03 resolved; migration 9, acceptance/outcome reads, retention/recovery verified |
| Closed / project Done | [#26 node adverts/direct-heard](https://github.com/Robotti-io/Meshcore-Observer/issues/26) / [plan](pillar-1-issues/p1-05.md#implementation-plan) | All five tasks/acceptance complete; 544 tests, CI coverage and lint pass | Default indefinite fingerprints; optional save-first days-based cleanup preserves offline inventory/discovery; no unresolved gate |
| Closed / project Done | [#24 run history](https://github.com/Robotti-io/Meshcore-Observer/issues/24) / [plan](pillar-1-issues/p1-03.md#implementation-plan) | All five approved tasks/acceptance complete; 564 tests, CI coverage and lint pass | Database/run identity, exclusive ownership, monotonic lower-bound/recovery semantics, safe shutdown/retention settled; no open gate |
| Closed / project Done | [#25 resource samples/events](https://github.com/Robotti-io/Meshcore-Observer/issues/25) / [plan](pillar-1-issues/p1-04.md#implementation-plan) | All five tasks/acceptance complete; 591 tests, CI coverage and lint pass; user-pushed a903e0e | One-CPU/ELU units, typed/rate-bounded observations, atomic heartbeat/sample, unlimited shared retention and bounded reads settled; p95 3.781ms; no open gate |
| Closed / project Done | [#27 passive topology](https://github.com/Robotti-io/Meshcore-Observer/issues/27) / [plan](pillar-1-issues/p1-06.md#implementation-plan) | All five tasks/acceptance complete and pushed cae9a48; 620 tests, coverage thresholds and lint pass | Migration 13, reviewed config/query/retention scope; local write p95 4.019ms, maximum-path p95 3.954ms, proximity p95 85.790ms; no open gate |

Review order is a recommendation, not an artificial dependency. #28 and #26 need no anonymous-region library upgrade, telemetry credentials, or live-radio transmission. #24/#25 can be reviewed together while the earlier backend issues implement. Allocate sequential migration versions only when executing a reviewed task.

## Remaining planning queue

These are scoped queue entries, **not completed implementation plans**. Their existing issues remain queued unless actual research/decision work is already active. Each next draft must inspect its relevant code before becoming reviewable.

| Issue | Next plan deliverable | Issue-local decisions/evidence | Implementation prerequisite |
| --- | --- | --- | --- |
| [#22 capability assessment](https://github.com/Robotti-io/Meshcore-Observer/issues/22) — complete / Done | [Versioned assessment](remote-capability-notes.md) delivered 2026-10-09 | Installed 1.15.0/PR44 open, single pending ownership, fields/roles/contact risks, response fixtures, unknown deployment and future hardware gates | Research acceptance complete; no runtime change |
| [#23 reporting/data decisions](https://github.com/Robotti-io/Meshcore-Observer/issues/23) | Maintain [decision record](pillar-1-decisions.md), integrating each approved plan's contract | Track unresolved telemetry/region choices without re-asking agreed bot/node/run/resource/topology/default decisions | Decision work already active; relevant decision completion is enough for a consuming issue |
| [#29 remote request coordination](https://github.com/Robotti-io/Meshcore-Observer/issues/29) — implementation / In progress | [Approved five-task plan](pillar-1-issues/p1-08.md#implementation-plan); T1–T3 user-pushed; T4 implementation/phase validation complete locally | REMOTE-PLAN-01–04 approved; 20 T4 scenarios, 706 functional tests/lint pass; idle wiring, no polls; CI timing gate open | #22 complete; T5 integrated validation/performance gate/operator completion is next |
| [#30 durable region answers](https://github.com/Robotti-io/Meshcore-Observer/issues/30) | Latest successful answer plus approved attempt/publication state | Empty versus unknown/failure, partial/completeness indicators, answer freshness and history/latest retention | Relevant #22/#23 contract; can plan against fixtures before poller |
| [#31 direct region querying](https://github.com/Robotti-io/Meshcore-Observer/issues/31) | Opt-in query loop using approved 72-hour evidence window | Supported dependency/firmware, contacts/direct route handling, dispatch-time eligibility, cadence/retries, disconnect behavior | #26 evidence, #29 coordination, #30 answer seam and relevant #22/#23 findings |
| [#32 CoreScope publication](https://github.com/Robotti-io/Meshcore-Observer/issues/32) | Validated per-broker region publishing with truthful observation time | Verified exact public contract, broker opt-in/permissions, delayed/restart retry ownership and completeness mapping | #30 data contract and relevant #22/#23 findings; no need to wait for live poller to draft/test |
| [#33 telemetry storage](https://github.com/Robotti-io/Meshcore-Observer/issues/33) | Supported-field schemas/units and bounded latest/history reads | Firmware-supported fields, unavailable values, observation/remote time, freshness/retention, no credentials in history | Relevant #22/#23 findings |
| [#34 telemetry polling](https://github.com/Robotti-io/Meshcore-Observer/issues/34) | Opt-in radius-limited conservative polling | Telemetry-only secret references, verified contacts/routes, radius/freshness, cadence/timeout/backoff budgets | #27 evidence, #29 coordination, #33 storage and relevant #22/#23 findings |
| [#35 reporting APIs](https://github.com/Robotti-io/Meshcore-Observer/issues/35) | Endpoint-by-endpoint validated bounded read contracts | Sender aggregate exposure/privacy, units, dataset-specific retained coverage, compatibility, request logging/security gaps | Implemented dataset reads for each approved slice; no blanket wait for all datasets |
| [#36 dashboard integration](https://github.com/Robotti-io/Meshcore-Observer/issues/36) | Data views/states using shared Pillar 4 controls | Units/current-history labels, range/stale/empty/error handling, update cost, accessibility | Approved #35 slice and #41 shared-control seam; not completion of all Pillar 4 |
| [#37 integrated validation](https://github.com/Robotti-io/Meshcore-Observer/issues/37) | Reproducible baseline/soak/recovery/RF/operator checklist | Numeric budgets, duration, representative fixtures and explicitly authorized live actions | Required feature slices implemented; draft validation criteria alongside their plans |

## Per-issue delivery workflow

1. Draft the implementation plan from repository evidence and link it from the owning issue.
2. Resolve that plan's numbered local decisions; update #23/#22 when a reusable decision/finding is approved.
3. Review the concrete protected storage/API/authentication/dependency/logging/deployment boundary changes and record human approval in that plan.
4. Implement one approved task/phase at a time; no source-code changes are authorized merely by staging this queue.
5. Run the task's meaningful checks using repository scripts; record evidence and update task progress.
6. Close the issue only after its complete implementation/research/decision deliverable and validation are satisfied. Set project Status to Done, remove the progress label, and update the epic/register.

GitHub project Status and `status:in-progress` identify actual work. #28/#26/#24/#25/#27 are complete and pushed; #22 research is complete. Active work is #18/#23 and #29 implementation. The user approved #29's finalized plan on 2026-10-09; T1 is user-pushed at a2f3558 and T2 is user-pushed at bc4d3a6 and T3 is user-pushed at f4d09e5 and T4 implementation/phase validation is complete locally with 706 functional tests/lint passing. Next: T5 integrated validation and the open CI topology timing gate; OBS-02 storage/query/publication #30–#32 follow their own reviewed scopes. T1–T4 add internal contracts, recovery, ownership, conservative admission/configuration and idle runtime integration; polling/contact/auth/dependency integration remains pending. Offline asset/validation requirements remain #42/#83/#37.

Verification on 2026-10-08: all four draft plan bodies and the epic/decision summaries were synchronized to GitHub and read back, preserving existing labels and open state. Project #1 Status was changed and verified for #24/#25/#28; the temporary verification view showed all seven active items grouped In progress and was discarded afterward. Plan structure/local links and `git diff --check` passed. Runtime tests are not applicable to this documentation-only planning change; required implementation checks are specified per task.

Implementation update on 2026-10-08: human approval authorized #28's concrete storage contract and implementation. Migration 9, acceptance/outcome aggregates, optional identity evidence and stable IDs are implemented locally; all 508 tests and lint pass. Issue-local decisions are reflected into #23, which remains open. Other plans require their own review before implementation. No commit, push, dependency upgrade or live hardware/RF operation has occurred.

Completion synchronization: #28 is closed as completed, its progress label removed, and native project #1 Status Done verified. Updated #28/#23/#18 bodies were read back with scope labels preserved; the parent P1-07 child checkbox is checked. Existing Git ignore rules exclude the local release planning folder; no ignore rule was changed during implementation.
