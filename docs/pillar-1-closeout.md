# Pillar 1 closeout evidence — 2026-10-26

## Latest follow-up: bounded target exchanges

The operator approved keeping trace, guest login and due collections together,
with a cooldown after those dependent requests. The local implementation now
uses target/Observer/generation/config-scoped pacing credit. It starts under
the shared budget, counts every exchange RF write (including trace and failed
writes), and permits short steps without the preceding 60–90-second login-to-data
rate-limit gap. Saved guest proof is still required for collection. Successful
due components run once each in neighbour/status/sensor order; failures finish
the exchange and retain the existing durable retry/backoff policy.

Default limits are six RF attempts, a five-minute exchange window, one-second
step spacing and a sixty-second rest floor. Each used RF attempt additionally
owes its configured ordinary interval after completion: three minutes for
trace/login/one query, five minutes for trace/login/three queries under the
one-per-minute policy. Waiting region discovery retains its next shared turn.
Foreground traffic, quiet-air, authentication, exact correlation and persistence
checks remain in force. A failed collection's later retry has its own saved
request identity; no deadline or attempt count is reset.

Collection replies request a sixty-second minimum, capped by the shared response
ceiling. The port 3003 local ceiling was explicitly changed from 45,000 to
90,000 ms for its **next startup**; the running instance has not been restarted
or changed by the agent. Thus the existing live neighbour-pivot snapshots below
predate this exchange implementation. No new live RF-success claim is made.
No migration, dependency or public HTTP/MQTT contract was introduced. The
[exchange operating contract](telemetry-polling.md#bounded-tracelogincollection-exchanges--2026-10-26)
records settings, debt repayment, process-local pacing and durable retry limits.

Remaining validation is operator rollout/restart of port 3003 and a complete
new soak of prompt collection, delayed replies, retries, network settling and
capture continuity. #37 and epic #18 remain open.

Final exchange validation: the last full CI run covers **111 files / 1,549
tests**, with **1,548 passing and one failure** in the existing region-storage
write-cost benchmark. The complete exchange/startup/retry/recovery/security
regressions pass. Coverage passes unchanged thresholds: **84.80% statements,
84.08% branches, 84.17% functions, 85.58% lines**. Lint and diff checks pass.
Full log: `artifacts/pillar-1-target-exchange-ci.log`.

The full-run region benchmark measured **11.295 ms p95** against its unchanged
**10 ms** two-broker synchronous-write gate. Its isolated rerun passed at
**3.673 ms p95** (`artifacts/telemetry-exchange-region-cost-isolated.log`). This
does not make the last complete CI run green; reproducible performance under
the agreed measurement conditions remains an open #37 item. No storage
durability, performance threshold or coverage gate was weakened. A preceding
full exchange run passed 1,547 tests before the last two regressions were added.
Earlier failed runs and their logs were retained. The final regression fixes
include correct transaction abort in a synthetic recovery fixture and exclusion
of accidental random target/relay prefix collisions in the relay-only fixture.

## Current follow-up: neighbour-led inside-out polling

The operator requested this pivot after the 13:36 port 3003 restart. The local
implementation now orders bounded candidate scans by minimum evidenced distance
and full key, prioritizes due neighbour queries within each target, and uses
fresh decoded neighbour reports to admit known repeaters in the next layer.
The same resolver governs discovery, final eligibility, atomic reservations
and neighbour route seeds. Independent trace, guest authentication, shared RF
budgets and durable component deadlines still apply. The radius includes the
destination, correcting an off-by-one in the prior neighbour route guard.
A valid shorter topology/neighbour alternative can bypass an over-radius
signed-advert path; suppressed alternatives remain excluded at preselection.

The operator subsequently restarted port 3003 at 14:25:30 EDT with the pivot;
the first live snapshot is recorded below. A complete new soak cycle remains pending.
Earlier live snapshots below describe the previous strategy and do not prove
the pivot's throughput or coverage. Existing port 3003 configuration is
sufficient and the retained neighbour history remains queryable. No agent-initiated
runtime restart, live database mutation, new migration or public contract
change was performed for this follow-up. The full
[runtime contract](telemetry-polling.md#neighbour-led-inside-out-polling--2026-10-26)
documents bounded coverage, ordering, freshness and retained SNR limitations.
#37 and epic #18 remain open for integrated acceptance.

Validation: final `npm run test:ci -- --maxWorkers=1` passes **110 files /
1,530 tests** in 282.78 seconds. Coverage is statements **84.77%**, branches
**83.86%**, functions **84.15%**, lines **85.48%**, above unchanged thresholds.
Lint and diff checks pass. Full log: `artifacts/pillar-1-neighbour-frontier-ci.log`.
The preceding complete run found two old end-to-end assertions expecting
status-first ordering; those now explicitly assert neighbour-first ordering,
and both focused startup scenarios and the final complete run pass.

The new 20,003-node / 513-saved-page fixture verifies the 512-page expansion
cap and indexed resolution of shorter retained prefixes. Maximum candidate
read in the final CI fixture was **29.209 ms**, below its 100 ms budget. The
existing 20,000-direct-marker / 10,000-path fixture reports candidate p95
53.957 ms, exact read 2.896 ms, reservation 5.551 ms and terminal write
4.030 ms, within its unchanged read/write budgets. These are synthetic local
cost measurements, not a new live RF or operational baseline.

GitHub #18, #34 and #37 were synchronized with this pivot and final validation
and read back successfully. #34 remains closed; #18/#37 remain open. Their
existing labels and earlier evidence were preserved. The existing CLI connection
was used because the connector's write access was previously rejected; no
account permissions or native project fields were changed.

### First pivot soak snapshot — 2026-10-26 14:58 EDT

Read-only snapshot of run `c65c4789-a54d-4896-828f-3a3ef470dd7d`, started at
14:25:30.561 EDT. At 14:58:47 EDT it had run 33m17s: radio connected, zero
reconnects/recovery failure, 118 packets received and all 118 decoded. The
1,995 process samples average about 2.02% of one CPU; latest RSS is 129.2 MiB.
There are no recorded sample failures. This short window does not prove
long-term memory or RF performance.

All four dispatched data queries were neighbour requests, demonstrating the
new component priority. Each followed a completed guest login, then timed out:
Emu_N. Camden Rpt 4 (93A0), OKI.O.WAR.AC20 okimesh (F0BC), Madison Township 2
(12B7), and WB8ZVL-R V4 (5CD7). Their selected paths contained two or three
relays through E85C/F3C3; response waits were 14 or 19 seconds. No new data
observation, status/sensor result or neighbour page completed in this run.
Eight trace responses succeeded and sixteen traces timed out; two guest login
exchanges also timed out. Deferrals are distinct from RF/data attempts.

E85C was the first selected target at 14:26:45, but its guest login was deferred
for quiet air. The two retained decoded E85C neighbour pages remain from
23:04 EDT on October 25 and 06:40 EDT on October 26. They are not new-run
successes. No route was recorded with evidence source `telemetry-neighbours`
in this snapshot, so neighbour-only outward expansion is not yet demonstrated
live. No over-radius preflight rejection was recorded; early skipped-target
counts are not exposed, so this is not a measured throughput saving.

The neighbour response failures need further investigation; this snapshot does
not distinguish firmware support, RF loss or insufficient response wait, and
does not establish a new application defect. Full-cycle comparison remains open.
Frozen local evidence: `artifacts/soak-neighbour-pivot-2026-10-26-1458.json` and
`artifacts/soak-neighbour-pivot-retained-2026-10-26.json`.

## Afternoon follow-up: radius rejections inflate polling rounds

The port 3003 snapshot at 13:08:29 EDT covers the run started at 09:29:25.
Among 1,732 diagnostic attempts and 94 selected targets, 222 guest-login
preparations across 54 targets ended with `route-exceeds-radius`. Those local
preflights total 468,398 ms (7.8 minutes), with no RF dispatch for those
rejections. The scheduler also waits ten seconds after each completed pass:
222 such waits represent another 37 minutes. Thus approximately 44.8 minutes
of serial scheduler time are associated with these rejected turns, not 222
over-the-air requests. Other waits/failures also affect rotation; this estimate
does not establish the sole cause of missing neighbour attempts.

Candidate selection already filters passive positional distance by radius.
That proximity is not a usable outbound path: a target can pass the passive
filter while its current signed-advert route exceeds the radius and is already
a terminal rejection in the owner's route provider. Previously that later
rejection still selected the target, read the contact inventory, then ended
the full tick. The repair performs the same known over-radius rejection while
scanning due candidates, continues within the existing 16-target page and
retains keyset cursor bounds. It reuses the route-provider read rather than
changing the meaning of distance or allowing longer routes.

Three scheduler regressions reproduce the original issue, dense-page delays
and recovery after a fresh shorter route. Two real-owner integration cases
verify no inventory/trace/login/data command for an early skip, normal
recovery after shorter evidence, and owner rejection when a route changes
after selection. Existing quiet-air, foreground, session, persistence,
expiry and rate-budget checks remain in place. Early filtering creates no
request diagnostic for an unadmitted candidate and does not purge history,
reset saved deadlines, or change storage/API/configuration contracts.

The new race fixture initially advanced only one second, before the existing
ten-second shared admission interval, and therefore had no inventory read to
hold. Advancing to the actual admission point corrected the fixture; all
eight owner integration tests pass. The premature full run was stopped and
restarted on the corrected fixture. Final full CI coverage passed **109 files / 1,507 tests** in 243.21 seconds:
statements 83.88%, branches 82.40%, functions 83.80%, lines 84.58%, all above
unchanged thresholds. Lint and diff checks pass. Full local log:
`artifacts/pillar-1-radius-prefilter-ci.log`. Port 3003 has since been restarted by the operator with this repair; see
the startup verification below. Full-cycle live improvement remains unproven.

**Current publication state:** The operator enabled region publication on `okimesh1` and restarted port 3000 at 10:05:37 EDT. Broker acceptance of saved answer #2 is verified at 10:05:47 EDT; `okimesh2` remains opted out. Exact CoreScope reporter/target/original-time ingestion correlation is still pending.

Pillar 1 has 15 completed children (#22–#36). Final integrated validation
[#37](https://github.com/Robotti-io/Meshcore-Observer/issues/37) and epic
[#18](https://github.com/Robotti-io/Meshcore-Observer/issues/18) remain open.
This report supersedes earlier tracking summaries that described the feature
implementation as unpushed or the live soak as not activated.

## Authorization and tested revision

The operator started the two live instances and authorized read-only inspection,
bug fixes, tracking updates and closeout work in this chat. This pass does not
restart either instance, change broker ACLs, activate an additional MQTT stream,
or interfere with the owned live databases.

Baseline checkout: `baf8d35499f546a67d3217cea5a0737cf7dc0446`, branch
`release-v_2_5_0`, package 2.4.0, installed MeshCore.js 1.15.0, Windows / Node
24.22.0 / PowerShell. The closeout adds one read-only dataset mapping repair
and its HTTP regression tests; no migration or wire contract changes.
Installed application/firmware versions of separate runtime copies are not
assumed identical merely because they use the same port or directory name.

## Reproducible automated checks

Run `npm run lint` and `npm run test:ci -- --maxWorkers=1` from the repository.
The complete pre-repair coverage pass on 2026-10-26 passed 109 files / 1,500
tests: statements 83.70%, branches 82.09%, functions 83.72%, lines 84.39%.
All configured thresholds (72/71/73/70 respectively) remain unchanged.
Post-repair final CI coverage passed **109 files / 1,502 tests** in 265.21 seconds:
statements **83.83%**, branches **82.25%**, functions **83.80%**, lines **84.56%**.
Lint and `git diff --check` pass. Complete local log:
`artifacts/pillar-1-closeout-ci.log`; JUnit: `artifacts/junit.xml`.
Cost gates still pass in the final run: region two-broker writes p95 **4.233 ms**,
telemetry writes p95 **4.060 ms**, poll reservation writes p95 **5.209 ms**
and atomic poll completion p95 **3.843 ms**, all below the existing 10 ms
write gate. Bounded read/proximity gates pass unchanged; complete measurements
are in the final log. These are fixture costs, not a controlled live RF A/B test.

The all-time diagnostics regression was reproduced against port 3003: HTTP
500 for `/api/metrics/telemetry/diagnostics?range=all&limit=1`. Both new empty
and populated HTTP tests failed before the fix. Adding the missing fixed
`telemetryDiagnostics` entry to the existing earliest-retained dataset map
restores range resolution without changing schema, response shape, validation
or pagination. All 49 focused HTTP/diagnostics tests and lint then passed.
Both live instances now serve the repaired endpoint after the operator
restart; see the verification below.

| Acceptance evidence | Repository scenarios |
| --- | --- |
| Owned collection, permissions, correlation, quiet air and backoff | `test/index-telemetry-polling.test.js`, `test/radio/telemetry-owner.test.js`, `test/telemetry/polling-owner-integration.test.js` |
| Post-login exact-component continuation and routed wait | `test/telemetry/polling-scheduler.test.js`, `test/radio/telemetry-owner.test.js` |
| Offline capture, duplicate-filtered bots, local reads, reconnect, stop/crash and backup | `test/index-telemetry-polling.test.js`, `test/index-region-discovery.test.js`, `test/index-telemetry.test.js`, `test/index-run-history.test.js` |
| Migration rollback, exclusive database ownership and retained evidence | `test/index-telemetry.test.js`, `test/metrics/telemetry-diagnostics.test.js`, `test/metrics/telemetry-poll-state.test.js`, `test/metrics/region-publication-state.test.js` |
| Write-failure atomicity, unsaved-terminal pause/retry and prune rollback | `test/metrics/process-history-store.test.js`, `test/metrics/telemetry-retention.test.js`, `test/metrics/sampler.test.js`, both producer entrypoint suites |
| Broker failure, delayed publication, original timestamps and restart | `test/index-region-discovery.test.js`, `test/mqtt/region-publisher.test.js`, `test/metrics/region-publication-state.test.js` |
| Bounded reporting, retention and query/write cost | `test/web/metrics-server.test.js`, `test/metrics/telemetry-cost.test.js`, `test/metrics/region-cost.test.js`, `test/metrics/topology-cost.test.js`, both poll-cost suites |

Write-full scenarios include injected SQLite insert failures and failed writes;
they do not establish real filesystem exhaustion. Interrupted migrations are
transaction rollback/crash fixtures, not a physical power-cut experiment.
These distinctions remain explicit rather than silently treating all fault
models as equivalent.

## Live observations

Frozen read-only snapshot: **2026-10-26 09:07:17 EDT**. Windows below start at
each process's reported startup; earlier rows in the reused SQLite databases
are excluded. Raw snapshots and local test logs are inspection artifacts, not
new application datasets or raw-packet persistence features.

| Measurement | Port 3003: telemetry soak | Port 3000: publishing/bots |
| --- | --- | --- |
| Started, EDT | Oct 25 21:25:39 | Oct 25 21:41:03 |
| Duration at snapshot | 11 h 41 m 37 s | 11 h 26 m 13 s |
| Radio | Connected; zero reconnects | Connected; zero reconnects |
| Received / decoded packets | 3,711 / 3,711 | 4,098 / 4,098 |
| Remote recovery failure | false | false |
| Mean sampled process CPU | 0.56% | 1.86% |
| Mean sampled RSS / used heap | 126.21 / 42.04 MiB | 133.03 / 53.18 MiB |
| Retained process samples in run window | 42,081 | 41,160 |
| Sampled failed runtime events | 0 | 0 |
| Brokers | None configured | Two connected; each 4,098 sends, zero failed/skipped |
| Bot replies | No bots configured | Six sent; zero repeat confirmations; queue empty |

The last partial 15-minute publishing-instance bucket has 11.58% CPU, compared
with its 1.86% run-wide average. Do not call this a proven regression or ignore
it: the window overlaps local CI work and lacks an equivalent unloaded baseline.
Mean CPU uses bucket sample weighting; it is a descriptive approximation, not
a controlled benchmark. Separate devices/workloads are not A/B controls.

### Telemetry and RF evidence

| Component | Replies saved | Response timeouts |
| --- | ---: | ---: |
| Status | 19 | 14 |
| Sensors | 6 | 4 |
| Neighbours | 2 | 1 |
| Total | 27 | 19 |

Replies represent ten distinct repeaters. Status and sensor replies retain
partial/unknown-profile interpretation instead of asserting unsupported fields.
Both fully decoded neighbour pages came from Fairfield Celado (E85C), each
reporting nine total neighbours and returning the configured first three:
Fairfield Repeater, East Hamilton Repeater and OKI.OH.HAM.Greenhills.

There are 5,694 diagnostic attempt records, including pre-dispatch deferrals;
they are not 5,694 over-the-air packets. Trace results include 104 responses,
122 timeouts and 38 quiet-air deferrals. Diagnostic dispatch timestamps can
refer to route traces as well as login/data commands; they cannot by themselves
reconstruct every RF transmission or prove the complete shared rate budget.
Routed data diagnostics show 9/14/19-second waits for one/two/three relays.
KC8DE's successful status reply took about 6.1 seconds inside a 19-second wait.

The telemetry database measured 61,349,888 bytes plus a 4,227,152-byte WAL near
the snapshot. It contains retained prior-run history and has no recorded
start-of-run byte baseline. Do not report this as overnight growth or a new
database measurement. No live SQLite connection, backup copy or checkpoint was
attempted against the running exclusive owner.

### CoreScope scope evidence and publication gap

Public APIs inspected read-only:

- [Seven-day scope audit](https://map.okimesh.org/api/scope-audit?window=7d)
- [E85C node details](https://map.okimesh.org/api/nodes/e85c3af54fd3d88e41c559093d0b04a4294e489725bbd79ee96fd9d542219a40)
- [Example unnamed scoped packet](https://map.okimesh.org/api/packets/599eb39009f6ceb3)

E85C declares `us-oh`, `cvg`, `us-midwest`, `oki`, `day`, `us-in`, `us-ky`,
`us-southeast` and wildcard `*`. The audit reports all named regions observed,
no undeclared scopes and no wildcard contradiction. Its declaration time is
2026-10-26T03:10:53Z. CoreScope's audit verifies declared names against raw
scoped traffic independently of the packet's saved scope label. In the bounded
67-packet sample, 58 packets match one of E85C's declared names while their
saved scope labels remain empty. Example `599eb39009f6ceb3` matches `#cvg`.
This is a CoreScope matching/configuration/backfill investigation, not evidence
that the Observer damaged the scope bytes. Proposed remedy: verify ingestor
region keys/automatic derivation, preserve ambiguity checks, then repair saved
unknown labels. No external CoreScope code or deployment was changed.

The operator identified the port 3000 runtime directory. Read-only inspection
confirms region discovery enabled, telemetry polling disabled, and
`regionPublication.enabled: false` on **both** `okimesh1` and `okimesh2`.
Port 3003 has discovery/polling enabled but no brokers. Thus neither inspected
configuration currently establishes our region-answer publication to CoreScope.
CoreScope merges declaration collectors; a matching list alone cannot establish
that our client-region publisher supplied it.

Prepared activation proposal: enable region publication on `okimesh1` only,
leave `okimesh2`, secrets, ACLs and packet publishing unchanged, then use the
operator's normal restart workflow. After approval/activation, correlate the
reporting Companion key, E85C full target key, original observation timestamp,
broker acknowledgement and CoreScope ingestion. Do not equate PUBACK with
downstream acceptance. The proposal is not applied by this closeout pass.

## Basic populated dashboard check

The in-app browser rendered the live overview, current connectivity/uptime,
selected-range counts and retained runtime-event table. On 2026-10-26 at
09:24 EDT, five sequential 24-hour HTTP reads per view had median/maximum
latencies: overview 36.10/60.81 ms; packets 31.87/32.03 ms; brokers
2.89/3.66 ms; bots 0.32/0.62 ms; repeaters 0.36/0.42 ms. All returned 200.
This is a small descriptive localhost sample, includes serialization and
transport, and does not measure browser rendering, keyboard use, responsive
layout, cold-cache offline charts or an A/B feature-overhead comparison.

## Remaining gates and next actions

1. **Live region publication:** opt-in, operator restart and broker acknowledgement
   are verified. Capture the exact CoreScope reporter/target/original-time
   correlation; do not identify answer #2 as E85C merely from its local ID.
2. **Measured integrated comparison:** record agreed acceptance duration/budgets,
   comparable load, start/end database sizes, request/trace costs and bot/advert
   waiting. Existing two-instance evidence does not prove one-radio contention
   under simultaneous live telemetry and bot load. Use the existing synthetic
   contention proof as such; do not relabel it as a hardware measurement.
3. **Finish the explicit fault/browser matrix:** determine remaining SQLite-full
   versus injected-failure evidence, and record representative keyboard,
   viewport and dashboard update-cost checks. Basic populated overview rendering,
   live state and retained-history labels were inspected in the in-app browser;
   this is not a complete accessibility/performance audit.
4. **Final tracking:** check off remaining #37/epic criteria only when supported,
   close #37 then #18, remove progress labels and verify native project Done.
   Native project status is currently unverified: GitHub CLI lacks `read:project`
   scope and the in-app browser is not signed in. Issue bodies and labels were updated and read back
   through the existing GitHub CLI authorization after the connector returned 403; no account scope expansion was attempted.

Cold-cache offline chart delivery belongs to #42 and integrated UI validation
to #83. Those existing owners remain open; they are not implemented or waived
by Pillar 1 tracking updates. Serve approved pinned assets locally under #42,
then verify cold-cache WAN-loss behavior under #83. No CDN/CSP/dependency change
is included here.

## Next pillar handoff

The agreed sequence is Pillar 1 → Pillar 3 → Pillar 2 → Pillar 4 completion.
The next ready research task is [#52](https://github.com/Robotti-io/Meshcore-Observer/issues/52),
whose #22 research dependency is complete. Then #53 defines bot targeting,
suppression, scope/private fallback and delivery semantics. #54/#55 cover
identity/targeting; #56 establishes the lifecycle used by suppression, scoped
sending and private/ACK branches. Research can use completed Pillar 1 seams;
no Pillar 3 implementation, permission change or live scoped send is authorized
merely by this handoff. #52 remains queued rather than falsely marked complete.

## Operator restart verification — 2026-10-26

The operator restarted both instances. Read-only verification at 09:32–09:33
EDT found port 3003 started at 09:29:25 and port 3000 at 09:29:58. Both
radios are connected with zero reconnects and no remote recovery failure.
Port 3000 has both brokers connected and all four bots ready; each broker
reported 16 sends and zero failures at the snapshot. Port 3003 had received
and decoded 19 packets. New-run telemetry outcomes were still zero.

All-time diagnostics now returns HTTP 200 on both ports (6,279 retained
records on port 3000; 10,705 on port 3003 at the snapshot). The inspected
port 3000 store module matches the repaired workspace copy. All **46**
outcomes from the frozen previous telemetry-run snapshot remain queryable
by their original run and request IDs; none is missing. These checks provide
new live restart/preservation evidence, not full outage/fault or load proof.

Both `okimesh1` and `okimesh2` still have region publication disabled. The
restart does not activate that opt-in, and it is not treated as approval to
change the configuration. #37 and #18 remain open for their recorded gates.

## Region publication activation and broker acknowledgement — 2026-10-26

The operator edited the configured `brokers.config.json`; read-only inspection
confirmed `okimesh1.regionPublication.enabled:true`, `okimesh2` omitted/off,
region discovery enabled, and the expected default broker-config file selected.
The file changed at 14:05:30.399Z and the new process started at
14:05:37.342Z (10:05:37 EDT), so this process started after the opt-in.
Both brokers connected, the radio remained connected and all four bots became
ready. No configuration or process change was made by the agent.

The operator supplied the startup log. At **14:05:47.375Z (10:05:47 EDT)**,
`services.regionPublication` logged “Region observation accepted by broker;
downstream ingestion is not confirmed.” Metadata identifies broker `okimesh1`,
outcome `broker-accepted`, and local `answerId:2`. The same log identifies
the reporting Companion as
`7caa3ca732111e8fac89e3090e51f8227fd8a5757d4d2d518ae6099249008368`.
This verifies the live worker reached broker acknowledgement. The supplied
publication line does not contain the target key, original observation time
or region list. It cannot alone identify answer #2 as E85C or certify
CoreScope ingestion. The running store is exclusively owned and the public
monitoring API does not expose publication rows; no live database copy or
extra database connection was attempted.

C5 activation and broker acknowledgement are complete. Final reporter/target/
original-time correlation remains open. Existing packet/status publication and
`okimesh2` remain enabled as before, but `okimesh2` region publication is off.

## Radius-prefilter soak restart — 2026-10-26 13:36 EDT

The operator restarted port 3003 at 17:36:02.367Z (13:36:02 EDT) after the
radius-prefilter repair. At 17:38:01Z the radio was connected, reconnect count
was zero, remote recovery failure was false, and all six received packets
were decoded. The first 119 seconds contained eight diagnostic records: five
status admissions deferred for unavailable guest sessions and three guest
logins deferred for quiet air. No new query outcomes or over-radius preflight
rejections were recorded. This short startup sample does not yet measure a
complete rotation, skipped-target count, improved throughput or neighbour
selection. Full-cycle live verification remains open; no additional restart,
configuration or RF action was initiated by the agent.
