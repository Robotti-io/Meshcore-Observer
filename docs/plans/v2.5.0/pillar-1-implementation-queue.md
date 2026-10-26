# Pillar 1 implementation planning queue

**Latest follow-up — target exchanges:** The approved trace/login/collection
exchange is implemented locally. Roll out this newer source and the 90-second
local response ceiling to port 3003, then validate prompt collection and
post-exchange settling. The earlier neighbour-pivot restart is already evidenced;
it does not deploy this follow-up. Existing retry deadlines and databases are
preserved. #37/#18 remain open.

**Latest follow-up — 2026-10-26:** Neighbour-led inside-out polling is implemented
locally at the operator's request. Roll out the pivot to port 3003 without
resetting its database, then collect a complete soak cycle before closing #37.
The [runtime contract](../../telemetry-polling.md#neighbour-led-inside-out-polling--2026-10-26)
describes distance/key scans, due neighbour priority, next-layer eligibility and
unchanged owner checks. Earlier baseline and startup evidence predates the pivot.

**Current closeout — 2026-10-26:** Fifteen of sixteen Pillar 1 children are complete (#22–#36). #37 is now active final validation; #18 remains open. The live telemetry and publishing/bot soaks are stable, and the all-time diagnostics defect has a focused repair. The operator enabled region publication on `okimesh1` and restarted port 3000 at 10:05:37 EDT. Broker acceptance of saved answer #2 is verified at 10:05:47 EDT; `okimesh2` remains opted out. Exact CoreScope reporter/target/original-time ingestion correlation is still pending. Final comparison/fault/browser evidence remains explicit. See the [current closeout report](../../pillar-1-closeout.md). Earlier dated notes below describe their original delivery point, not the present runtime.

**Next closeout actions:** roll out neighbour-led polling to port 3003 and record a complete new soak cycle; correlate the broker-accepted region publication with downstream ingestion; finish comparable operational/fault/browser evidence; then close #37/#18. Pillar 3 begins with #52 research, followed by #53 decisions.

Updated: 2026-10-12. Parent: [#18](https://github.com/Robotti-io/Meshcore-Observer/issues/18).

The first backend wave and passive topology are complete. There are **zero prerequisite questions before drafting the next plan**. Run/resource/topology semantics are settled; the remaining high-level #23 discussions concern telemetry/region behavior. Concrete storage/configuration/API decisions are recorded in their owning plan and reviewed when picked up.

## First planning wave

Five backend plans and #29 coordination are approved/implemented/user-pushed, with #22 research complete. #33 remains complete/user-pushed at 5e5c372; #34 T1–T5 are reviewed/user-pushed through f7527e4. Approved T6 is complete locally: 46 new real-entrypoint offline scenarios cover all three components, guest/route failures, capture/bot compatibility, stop/crash/unclean recovery, both terminal-save failures and closed-backup restore. All five #34 code/fixture criteria are met; 104 files / 1,373 tests pass in both full functional and CI coverage runs, with lint/diff and unchanged coverage/latency gates passing. The initial sandbox transform-file failure is disclosed in the issue evidence. #34 is completed/project Done with its progress label removed; T6 changes await human review/push. #35 reporting APIs were pushed in `43d912d` and the issue is closed after 104 files / 1,386 tests passed. Polling stays default-off and no real credential/device/deployment is activated. #18 remains OPEN/In progress; #23 stays completed/Done. #36 T1–T5 are complete locally with dashboard integration and handoff evidence recorded; #37 retains manual browser, representative-load, and separately authorized device/RF/soak gates.

| Review order | Issue / plan | Current readiness | Local review gates |
| --- | --- | --- | --- |
| Complete | [#28 bot usage](https://github.com/Robotti-io/Meshcore-Observer/issues/28) / [plan](pillar-1-issues/p1-07.md#implementation-plan) | Approved, implemented locally and validated; new API/UI remains #35/#36 | BOT-PLAN-01/02/03 resolved; migration 9, acceptance/outcome reads, retention/recovery verified |
| Closed / project Done | [#26 node adverts/direct-heard](https://github.com/Robotti-io/Meshcore-Observer/issues/26) / [plan](pillar-1-issues/p1-05.md#implementation-plan) | All five tasks/acceptance complete; 544 tests, CI coverage and lint pass | Default indefinite fingerprints; optional save-first days-based cleanup preserves offline inventory/discovery; no unresolved gate |
| Closed / project Done | [#24 run history](https://github.com/Robotti-io/Meshcore-Observer/issues/24) / [plan](pillar-1-issues/p1-03.md#implementation-plan) | All five approved tasks/acceptance complete; 564 tests, CI coverage and lint pass | Database/run identity, exclusive ownership, monotonic lower-bound/recovery semantics, safe shutdown/retention settled; no open gate |
| Closed / project Done | [#25 resource samples/events](https://github.com/Robotti-io/Meshcore-Observer/issues/25) / [plan](pillar-1-issues/p1-04.md#implementation-plan) | All five tasks/acceptance complete; 591 tests, CI coverage and lint pass; user-pushed a903e0e | One-CPU/ELU units, typed/rate-bounded observations, atomic heartbeat/sample, unlimited shared retention and bounded reads settled; p95 3.781ms; no open gate |
| Closed / project Done | [#27 passive topology](https://github.com/Robotti-io/Meshcore-Observer/issues/27) / [plan](pillar-1-issues/p1-06.md#implementation-plan) | All five tasks/acceptance complete and pushed cae9a48; 620 tests, coverage thresholds and lint pass | Migration 13, reviewed config/query/retention scope; local write p95 4.019ms, maximum-path p95 3.954ms, proximity p95 85.790ms; no open gate |

Review order is a recommendation, not an artificial dependency. #28 and #26 need no anonymous-region library upgrade, telemetry credentials, or live-radio transmission. #24/#25 can be reviewed together while the earlier backend issues implement. Allocate sequential migration versions only when executing a reviewed task.

## Remaining planning queue

These entries distinguish completed foundations and #34’s completed T1–T6 from remaining queued work. Each owning plan requires repository evidence and concrete boundary review; planning is not implementation.

| Issue | Next plan deliverable | Issue-local decisions/evidence | Implementation prerequisite |
| --- | --- | --- | --- |
| [#22 capability assessment](https://github.com/Robotti-io/Meshcore-Observer/issues/22) — complete / Done | [Versioned assessment](remote-capability-notes.md) delivered 2026-10-09 | Installed 1.15.0/PR44 open, single pending ownership, fields/roles/contact risks, response fixtures, unknown deployment and future hardware gates | Research acceptance complete; no runtime change |
| [#23 reporting/data decisions](https://github.com/Robotti-io/Meshcore-Observer/issues/23) — complete / Done | [Reviewed consolidated decision record](pillar-1-decisions.md#consolidated-dataset-contracts-and-23-completion--2026-10-10) | All dataset/count/unit/time/retention/identity, region/publication and POLL-PLAN-01–06 choices are settled | No remaining scoped decision gate; owning implementation/API/live gates remain |
| [#29 remote request coordination](https://github.com/Robotti-io/Meshcore-Observer/issues/29) — complete / Done | [Approved five-task plan](pillar-1-issues/p1-08.md#implementation-plan); T1–T5 user-pushed at bc27968 | REMOTE-PLAN-01–04 approved; all 711 tests/coverage/lint pass; 1,000 mixed cycles, no automatic polls; proximity-only target 150ms | No open foundation gate; next #30 answer storage planning |
| [#30 durable region answers](https://github.com/Robotti-io/Meshcore-Observer/issues/30) — complete / Done | [Approved five-task plan](pillar-1-issues/p1-09.md#implementation-plan); T1–T5 user-pushed f2d567c | REGION-PLAN-01–05 delivered; 796 tests/coverage/lint pass; offline recovery/backup and 20k+20k cost/index/prune verified | No open storage-foundation gate; #31 fixture implementation complete |
| [#31 direct region querying](https://github.com/Robotti-io/Meshcore-Observer/issues/31) — complete / Done | [Approved five-task plan](pillar-1-issues/p1-10.md#implementation-plan); T1–T5 user-pushed 54a920d | Migration 15; 26 T5 scenarios; 975 tests/full single-worker coverage and lint pass; all six criteria met, unchanged gates | #32 publication complete locally; discovery stays disabled by default, no live RF |
| [#32 CoreScope publication](https://github.com/Robotti-io/Meshcore-Observer/issues/32) — complete / Done | [Five-task plan](pillar-1-issues/p1-11.md#implementation-plan) T1–T5 complete locally; 1,010 tests/CI coverage/lint pass | PUBLICATION-PLAN-01–05: strict default-off per-broker contract, save/stage transaction, safe bounded latest backfill, independent bounded QoS 1 delivery and durable retry/restart | No prerequisite question remains; live ACL/CoreScope/RF evidence stays in #37 |
| [#33 telemetry storage](https://github.com/Robotti-io/Meshcore-Observer/issues/33) — complete / Done | [Approved five-task plan](pillar-1-issues/p1-12.md#implementation-plan), T1–T5 user-pushed 5e5c372 | All four code/fixture criteria met; migration 16/strict saved semantics/bounded reads/retention/restart/backup proof; 1,122 functional/coverage tests and unchanged cost/lint gates pass | No storage-foundation gate; #34 plan is staged; auth/polling/public presentation/deployed RF remain separate |
| [#34 telemetry polling](https://github.com/Robotti-io/Meshcore-Observer/issues/34) — complete / Done | [Approved six-task plan; T1–T5 pushed / T6 complete locally](pillar-1-issues/p1-13.md#implementation-plan) | POLL-PLAN-01–06/T1–T6 and all five code/fixture criteria complete; 46 new T6 cases / 1,373 functional and CI tests, lint/diff and unchanged gates pass; sandbox transform failure disclosed | Review/push T6, then consume the implemented #35 reporting APIs. Default-off remains; #37 retains live proof |
| [#35 reporting APIs](https://github.com/Robotti-io/Meshcore-Observer/issues/35) — complete / closed | Endpoint-by-endpoint validated bounded read contracts | Sender aggregate exposure/privacy, units, dataset-specific retained coverage, compatibility, request logging/security gaps | Pushed in `43d912d`; 104 files / 1,386 tests pass in full functional and CI runs |
| [#36 dashboard integration](https://github.com/Robotti-io/Meshcore-Observer/issues/36) — T1–T5 complete / issue closed | Connected data views/states using shared Pillar 4 controls | Units/current-history labels, range/stale/empty/error handling, bounded request cost, accessibility | Consumes closed #35 slice; #37 retains manual browser, representative-load, and live RF validation |
| [#37 integrated validation](https://github.com/Robotti-io/Meshcore-Observer/issues/37) | Reproducible baseline/soak/recovery/RF/operator checklist | Numeric budgets, duration, representative fixtures and explicitly authorized live actions | Required feature slices implemented; draft validation criteria alongside their plans |

## Per-issue delivery workflow

1. Draft the implementation plan from repository evidence and link it from the owning issue.
2. Resolve that plan's numbered local decisions; update #23/#22 when a reusable decision/finding is approved.
3. Review the concrete protected storage/API/authentication/dependency/logging/deployment boundary changes and record human approval in that plan.
4. Implement one approved task/phase at a time; no source-code changes are authorized merely by staging this queue.
5. Run the task's meaningful checks using repository scripts; record evidence and update task progress.
6. Close the issue only after its complete implementation/research/decision deliverable and validation are satisfied. Set project Status to Done, remove the progress label, and update the epic/register.

GitHub project Status and `status:in-progress` identify actual work. #30/#31 remain complete/user-pushed through 54a920d (migration 15). #32 PUBLICATION-PLAN-01–05 and T1–T5 are complete locally under explicit 2026-10-10 planning/implementation authorization: 82 files / 1,010 tests, CI coverage and lint pass with unchanged gates. Strict default-off per-broker publication, atomic successful-answer staging, safe latest backfill, independent bounded QoS 1 delivery and durable retry/restart are delivered. #32 is completed/project Done; classification labels are preserved and its progress label is removed. Changes remain uncommitted for user review; no broker/ACL/CoreScope deployment or live RF is activated. #18/#23 remain open/In progress for remaining telemetry/reporting work; #37 retains separately authorized live/soak validation. Offline assets/release validation remain #42/#83/#37.

Verification on 2026-10-08: all four draft plan bodies and the epic/decision summaries were synchronized to GitHub and read back, preserving existing labels and open state. Project #1 Status was changed and verified for #24/#25/#28; the temporary verification view showed all seven active items grouped In progress and was discarded afterward. Plan structure/local links and `git diff --check` passed. Runtime tests are not applicable to this documentation-only planning change; required implementation checks are specified per task.

Implementation update on 2026-10-08: human approval authorized #28's concrete storage contract and implementation. Migration 9, acceptance/outcome aggregates, optional identity evidence and stable IDs are implemented locally; all 508 tests and lint pass. Issue-local decisions are reflected into #23, which remains open. Other plans require their own review before implementation. No commit, push, dependency upgrade or live hardware/RF operation has occurred.

Completion synchronization: #28 is closed as completed, its progress label removed, and native project #1 Status Done verified. Updated #28/#23/#18 bodies were read back with scope labels preserved; the parent P1-07 child checkbox is checked. Existing Git ignore rules exclude the local release planning folder; no ignore rule was changed during implementation.
