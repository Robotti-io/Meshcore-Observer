# MeshCore Observer — comprehensive engineering audit

Date: 2026-11-01 (America/New_York). Status: audit and proposed work only; **no remediation approved or implemented**.

Subsequent update: the user approved all cleanup batches after this audit. See the separate [implementation record](2026-11-01-cleanup.md) for changes and validation. The findings and audit baseline below describe the original reviewed state.

## Executive summary

The architecture remains appropriate. This is a deliberately partitioned, single-radio application with a shared command/remote-request owner, one always-on SQLite owner, strict AJV contracts, and explicit domain services. A rewrite, framework migration, or wholesale decomposition would increase risk without addressing the observed problems.

Maintainability is generally sound at module boundaries and uneven inside several lifecycle and presentation paths. The most consequential defects occur where individually reasonable operations compose incorrectly: channel enumeration and creation are separately serialized; token renewal outlives its owner; accepted inventory counts violate downstream contracts; and browser request/cached-data ownership is inconsistent. These are focused engineering problems rather than evidence that the architecture should be replaced.

Two High findings warrant early attention: concurrent bot-channel allocation and local companion commands without a connected-silence deadline. No Critical finding was established. Medium findings include confirmed lifecycle/recovery defects, rate-accounting and schema inconsistencies, dashboard correctness, and conditional resource-bound risks. Security-sensitive policy gaps are separated from demonstrated vulnerabilities.

Preserve signature verification, full-key/generation correlation, durable pre-send reservations, conservative time handling, independent useful/decoded observations, save-first publication, and transactional migration/retention ownership. Much of the apparent complexity protects these guarantees.

The five highest-value opportunities are:

1. Make channel allocation atomic within the existing command queue (F01).
2. Bound connected-but-silent companion operations while retiring uncertain generations safely (F02).
3. Give token renewal explicit cancellation, single-flight ownership, and initial-failure recovery (F03/F04, separately reviewed batches).
4. Repair telemetry capacity and physical trace-budget contract mismatches (F05/F06).
5. Make dashboard request ownership and range provenance explicit, with controller-level tests (F09/F10).

The smallest initial batch is **A: forward suppression sender metadata and add one behavioral regression test (F17)**. It is a concrete defect with a narrow existing seam, no schema/dependency/API change, and low regression risk. Highest urgency and smallest first diff are different criteria; channel allocation should follow promptly.

## Scope, repository identity, and limits

- Local repository: `R:/Code/github.com/Robotti-io/Meshcore-Observer`; target and actual branch `release-v_2_5_0`.
- Reviewed HEAD: `eb9ab9f3ca67d40d15d7b7ca0724b922f7c82827`; package version remains `2.4.0`. This release branch is work in progress; the package version alone is not a defect.
- Existing changes at intake: `src/bots/reply-queue.js`, `src/web/client/dashboard.js`, `test/bots/reply-queue.test.js`; existing untracked `Threat Model Review - 2026-11-01.md`. Those changes were preserved. F08 concerns the current dashboard edit, not committed HEAD. Existing queue error-handling fixes are not credited to this audit or reported as still unfixed.
- Environment verified before workflows: Windows 10.0.26300, PowerShell Core 7.6.5, Node 24.22.0, npm 11.19.1. PowerShell emits a filesystem-provider initialization warning, but repository reads, Node, npm, and Git work.
- All 136 application source assets (135 JavaScript files and one CSS file) were assigned and assessed. The companion [coverage inventory](2026-11-01-coverage-inventory.md) accounts for each file. All 115 test files and 18 fixtures were inventoried; reviewers assessed scenario organization and read critical test bodies in detail. This is not a claim that every assertion in every test received an individual line review.
- Excluded from quality metrics: dependencies, generated coverage/JUnit files, assets, local data/config/secrets, and historical plans. Historical decisions were read as design context. Installed SDK code was inspected only to verify specific missing-deadline behavior.
- No real radio operation, RF transmission, production broker contact, live database access, deployment, dependency installation, commit, push, or merge was performed. Tests use fake transports, temporary/in-memory databases and loopback HTTP; one startup test deliberately attempts loopback port 1. The coverage command does not load `.env.local`; inherited `PACKETCAPTURE_*` variables were cleared in its child shell, default broker/bot files replaced with an empty audit fixture, and the default DB set to `:memory:`.
- Offline reproductions used actual modules plus fake clocks/radios/clients or isolated temporary databases. They establish the specific stated behavior, not production incidence.
- Actual deployment topology, broker acknowledgement behavior, remote branch protection, production firmware, and live performance are UNKNOWN. No numeric security risk score or claim of live exploitability is inferred.
- The pre-existing threat-model document was read as context, not accepted as independently verified evidence. Its host-permission observations and broader attack scenarios were not reproduced here.

## Governing instructions and material conflicts

Read: repository `AGENTS.md`, supplied engineering constitution, package/scripts, ESLint/Vitest configuration, checked-in CI, contributor/runtime documentation, original architecture specification, prior MetricsStore/ChannelBot decisions, and relevant current protocol/pillar plans. The `secure-code-review` skill informed the security assessment; its required security companion is at the repository root.

1. **Native HTTP versus Express/Helmet:** this application deliberately uses `node:http`; repository instructions prohibit adding an HTTP framework/dependency without approval. The general constitution's Express/Helmet mandate cannot be satisfied by silently replacing this boundary. Actual missing CSP/hardening/request-log contracts remain a policy gap (F15), requiring an explicit native-header/logging decision or an approved dependency exception.
2. **GitLab deployment versus current CI:** the general constitution describes GitLab templates and container builds. `docs/plans/v2.4.0/issue-9-continuous-integration.md` records a human-approved GitHub Actions exception; `CONTRIBUTING.md` separates validation from future container deployment, and `docs/project_plan.spec.md:973–1005` explicitly defers GitLab/Kubernetes resources pending approval. Retain current CI and transport portability. Missing Docker/Kubernetes files are not an automatically authorized implementation task.
3. **Current plans versus current behavior:** future private-message/ACK/setup/UI features are not missing implementations merely because plans describe them. Source and executable tests take precedence. In particular, no automatic private retry, auth expansion, or new local raw-packet storage is proposed.
4. **Language rules versus existing management scripts:** the two existing PowerShell Scheduled Task scripts are a documented platform-management workflow. No new alternate-language implementation or rewrite is proposed.

## Architecture assessment

| Boundary | Current owner and flow | Assessment |
|---|---|---|
| Process lifecycle | `index.js`: config → store/run ownership → construct/wire services → start radio; shutdown stops producers, drains owners, closes transports, then finalizes run/store | Correct composition root. High import concentration is expected. Keep explicit shutdown order; local lifecycle defects belong to existing owners. |
| Configuration/validation/logging | `config/index.js` is sole environment reader; domain schemas compile through `validation/ajv.js`; `logging/logger.js` provides structured sources and metadata redaction | Coherent. Configuration fails before hardware/network. Timer bounds need tightening; native HTTP logging/header policy is unresolved. |
| Radio | transport open helpers → `RadioManager`/`CommandQueue`; shared `AirtimeCoordinator` and `RemoteRequestCoordinator` own RF admission, response correlation, generation retirement/recovery | Strong existing seams. Connected-silence gaps and trace accounting need targeted fixes, not another queue. |
| Passive capture | normalization/AJV → SDK decode → publish each reception; node registry verifies advert signatures; topology observer independently records bounded header evidence | Appropriate trust separation. Packet publication and bot reply deduplication intentionally differ. |
| Bots | `ChannelBot` owns shared channel/admission/send lifecycle; explicit handlers own command interpretation/actions; durable queue and suppression use store-owned claims | Retain. Fix channel setup transaction, sender forwarding, and stale setup completion. |
| Telemetry/regions | Separate policy schedulers choose eligible durable work; shared radio owner performs exchanges; parsers validate; store commits truthful terminal evidence | Essential separation of policy from RF mechanism. Preserve eligibility, clock fences, reservations, and stop/drain semantics. |
| MQTT | broker owns one client/generation; manager fans out; LetsMeshAuth signs on hardware; status/region publishers own payloads and lifecycle policy | Retain. Renewal/recovery ownership and ordinary packet backpressure are weaker than bounded region/status paths. |
| Persistence | `MetricsStore` owns one SQLite connection, ordered migrations, run ownership, cross-dataset transactions/retention; cohesive history/read/poll delegates use that connection | Retain existing delegation. No evidence justifies multiple databases or replacing native SQLite. Add future-version refusal after approval. |
| HTTP/browser | Optional read-only native HTTP server; static allowlist; schema-validated bounded queries; SSE; browser side effects beside pure dashboard logic | Preserve no-build architecture. Improve narrow request controllers and honest stale-data provenance. |

Import scan found no cycles among recognizable literal relative imports, including literal dynamic imports. This is a structural indicator, not proof against runtime/event coupling. No duplicated authoritative database owner or current feature-level environment access was found. One small existing inversion (`metrics/sampler.js` imports the pure `web/metrics-sample.js`) is naming/location coupling without demonstrated behavioral or testing harm; moving it is not a recommended batch.

### Priority-module decisions

| Module | Why its responsibilities belong together / essential complexity | Avoidable burden and proportionate decision |
|---|---|---|
| `metrics/store.js` | One connection, migration/run ownership, narrow service API, shared retention/transaction boundaries. Migrations preserve legacy and unknown evidence. Existing delegates are real seams. | Add future-schema guard (F07); retain store architecture. Query/migration size is not a split criterion. See prior issue #14 decision. |
| `radio/remote-request-coordinator.js` | Single lease, command write/ACK/remote response, contact preflight, generation checks, exchange credits, recovery fences; state must stay correlated. | Connected-silence and physical trace accounting (F02/F06). Later clarify named terminal construction inside `#finish`; do not distribute lease ownership across services. |
| `telemetry/polling-scheduler.js` | Candidate policy, durable reservation, owner call, original-time terminal save, auth/session eligibility, unsaved-result pause/drain | `#request` combines callback construction, completion checking, route invalidation, diagnostic building and data persistence. Local named completion/diagnostic steps can expose reserve → owner → terminal save. Preserve module and all transitions; measure comprehension benefit before extraction. |
| `web/client/dashboard.js` | Five views, DOM/charts, live versus historical data, generation cancellation, lazy rendering, fallback and partial evidence semantics | Inconsistent request ownership and duplicate unqualified caches (F08–F10). Test controller behavior rather than split by file size. |
| `web/metrics-server.js` | Listener/static assets, strict read-only routing, query-to-presentation composition, SSE ownership | Startup subscription cleanup (F19), streaming bounds (F11), protected HTTP policy (F15). Explicit dispatcher is understandable; no routing framework recommended. |
| `index.js` | Construct shared resources, wire domain services, register process signals, order teardown | Keep composition root. Token-stop integration changes only after loop contract is approved. A generic lifecycle registry would obscure deliberate ordering. Setup constructors after store acquisition currently lack a broad startup-unwind envelope; treat as investigation, not a reproduced shutdown defect. |

## Static and structural baseline

Existing scripts were inspected and used first. There is no repository structural-metrics script. A read-only JavaScript analysis used the installed ESLint API and literal-import scanning; it did not install dependencies, edit lint rules, or establish new gates. Raw results: `artifacts/audit/structure.json`; reproducible analysis: `artifacts/audit/structure.mjs` (ignored audit evidence).

| Indicator | Baseline |
|---|---:|
| Source assets / JavaScript files | 136 / 135 |
| Test files / fixture modules | 115 / 18 |
| Recognized local import cycles | 0 |
| `store.js` physical lines / local imports | 2,188 / 23 |
| `dashboard.js` physical lines / local imports | 1,443 / 1 |
| `remote-request-coordinator.js` physical lines / local imports | 1,203 / 17 |
| `metrics-server.js` physical lines / local imports | 994 / 7 |
| `polling-scheduler.js` physical lines / local imports | 453 / 5 |
| `index.js` physical lines / local imports | 434 / 33 |

Physical counts include comments/blanks and trailing split line. ESLint classic cyclomatic indicators: coordinator `#finish` 96 (`:1064`), telemetry `assertObservation` 75 (`telemetry-validation.js:30`), store `recordVerifiedAdvert` 65 (`:1600`), polling `#request` 63 (`:269`), coordinator `#sendPrepared` 60 (`:589`), topology `outboundRoute` 58 (`topology-history.js:249`), coordinator `#onFrame` 55 (`:970`), region `#pass` 48 (`region-discovery-scheduler.js:129`). These include default/optional branches and are **not cognitive-complexity scores**. They direct comprehension review; no arbitrary threshold is treated as a failure.

Validation's high branch count largely enforces cross-field invariants. Topology routing protects ambiguity, anchors and bounded paths. Neither warrants automatic simplification. The strongest pure-readability target is instead the smaller positional-boolean transition helper in F16.

## Findings register

Confidence: **Confirmed** means code and/or the stated isolated execution establishes the observation; **Supported** means strong code evidence with runtime impact still conditional; **Suspected** is reserved for open investigations. All recommendations below are proposals. Every implementation needs approval of its batch; “protected approval” identifies additional contract decisions.

### F01 — Concurrent channel setup can allocate the same empty slot

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **High / Confirmed** by actual modules with fake radio and real `CommandQueue` |
| Location | `src/bots/channel-setup.js:20–53`; `channel-bot.js:193–223`; `src/index.js:276–294` |
| Observation | Channel enumeration and creation are separate serialized callbacks. Two bot setups can both read the same empty slot before either writes it. Reproduction: `list,list,set:0:#one,set:0:#two`; both return index 0; actual slot contains `#two`. |
| Maintenance impact | Multi-bot readiness can refer to overwritten device state, leading to wrong-channel replies or failed delivery. Serialization of individual calls conceals the missing operation-level atomicity. |
| Recommendation | Perform enumerate/select/conditional-create in one existing `runCommand` callback. Do not nest queue calls or add a new lock. |
| Risk | Moderate: preserve existing-channel reuse, error classification, and queue ownership. |
| Validation | Deterministic two-absent-channel test with shared queue; existing/same-channel reuse; partial failure; no secret logging. |
| Approval | Batch approval; no dependency/storage/auth/public-API redesign needed. |

### F02 — Connected-silent companion commands can hold readiness or shared work indefinitely

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **High / Supported** operational consequence; absence of deadlines confirmed in code/installed SDK |
| Location | `src/radio/clock-sync.js:8–12`; `radio-manager.js:336–366`; `remote-request-coordinator.js:775` with timers cleared at `:859`/`:305`; `src/telemetry/telemetry-contact-manager.js:37,67–78`; `src/radio/flood-advert-scheduler.js:74,102` |
| Observation | SDK clock/device-query and contact add/remove helpers wait for response events without local timeout. Startup never reaches ready if a connected device remains silent. Contact mutation can hold the remote lease after the inventory/trace timer ends; flood advert can retain outbound work. External disconnect/stop is not normal connected-silence recovery. |
| Maintenance impact | A service appears connected yet silently stalls shared work. Operators need to know which phase owns the radio and whether reusing it is safe. |
| Recommendation | Introduce a bounded operation at the existing radio owner, one operation family per batch; on uncertain timeout retire/reset that generation before further commands. A bare `Promise.race` that releases the queue while SDK listeners survive is unsafe. |
| Risk | Moderate–high: late untagged frames must never satisfy a subsequent command; preserve recovery latching and foreground priority. |
| Validation | Fake connected device never answers; late response after timeout; queued foreground work; generation retirement; failed reset stays fail-closed; bounded stop. Existing tests cover explicit rejects/disconnect, not all silence paths. |
| Approval | Approve exact recovery/runtime behavior; separate auth approval if guest-contact/session behavior changes. No dependency change proposed. |

### F03 — Token refresh can reconnect after stop and overlap itself

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Confirmed** offline execution |
| Location | `src/mqtt/token-refresh-loop.js:24–48`; `mqtt-broker.js:92`; `src/index.js:414–424` |
| Observation | Stop only clears interval. `tick → stop → resolve signing` still produces one close and one connect. Two pending ticks start two refreshes. A fresh `connect()` resets broker stopping state. |
| Maintenance impact | Renewal and shutdown disagree about ownership; teardown can race new connection work. Global shutdown deadline limits the ultimate hang but does not make the loop's lifecycle correct. |
| Recommendation | Explicit stopped/in-flight ownership; fence each awaited continuation; define a bounded drain contract and integrate with shutdown. Keep existing auth/broker seams. |
| Risk | Moderate: accidental suppression of valid renewal or unbounded draining. |
| Validation | Stop during signing and close; concurrent ticks; late rejection; no client creation after stop; failure/recovery. |
| Approval | **Authentication lifecycle** approval. |

### F04 — First token-signing failure strands the broker

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Confirmed** offline execution |
| Location | `src/mqtt/mqtt-broker.js:99–115`; `token-refresh-loop.js:25–27`; `letsmesh-auth.js:89–107`; `src/index.js:235–262` |
| Observation | Credential failure sets failed with no retry; null expiration makes refresh skip; `mqttStarted` prevents reconnectAll on later radio events. Reproduction after three ticks: failed, expiration null, signing calls 1, clients created 0, although later signing would succeed. |
| Maintenance impact | Transient radio/signing failure becomes lasting publication outage requiring intervention. Individually tested policies compose into missing recovery. |
| Recommendation | One bounded cancellable credential-preparation retry owner. Preserve MQTT.js transport reconnect ownership. |
| Risk | Moderate: retry storms, radio contention, competing clients. |
| Validation | First sign fails then succeeds; no overlap; stop cancels retry; other brokers continue; radio unavailable then ready. |
| Approval | **Authentication lifecycle** approval; review separately from F03. |

### F05 — Contact inventory capacity disagrees with completion/diagnostic contracts

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Confirmed** schema and full-coordinator reproduction |
| Location | `src/telemetry/telemetry-radio-schemas.js:5`; `telemetry-owner-schemas.js:55`; `telemetry-schemas.js:186`; `src/radio/remote-request-coordinator.js:359,855,1149`; `src/telemetry/polling-scheduler.js:325–326` |
| Observation | Inventory accepts 1,024 contacts; completion and diagnostic schemas cap count at 350. Counts 351 and 1,024 fail both downstream schemas. Real coordinator with valid 351-contact fake inventory throws `Invalid telemetry owner data`; count 350 returns its terminal result. |
| Maintenance impact | Accepted input cannot complete the owner's contract. A reserved poll can remain unconfirmed and pause later collection; tests validate the inventory and completion boundaries separately. |
| Recommendation | Establish one supported capacity and reuse it across these contracts. Preserve wire/protocol limits; do not simply relax all bounds. |
| Risk | Low–moderate: diagnostic validation/persistence compatibility must be checked. |
| Validation | 350/351/1,024 across inventory → owner → scheduler → stored diagnostic; malformed/over-limit streams still reject; shutdown terminal is truthful. |
| Approval | **Diagnostic/public validation and storage contract** review; a migration is not automatically necessary. |

### F06 — Separate-request telemetry trace writes escape the RF budget

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Confirmed** full-coordinator fake-radio execution |
| Location | `src/radio/remote-request-coordinator.js:291–295`; ordinary charge at `:662` |
| Observation | Trace charges budget only when `current.exchange` exists. Approved `exchangeMaxRequests=1` creates no exchange. A physical trace followed by rejection produced `traceWrites:1,budgetCharges:0`. |
| Maintenance impact | Physical transmission accounting and pacing differ by mode; failed preflight attempts can avoid rate accounting. |
| Recommendation | Charge every physical trace while preserving a safely paced continuation for dependent login/data. Do not add one charge and leave the immediate next operation permanently inadmissible. |
| Risk | Moderate: lease, foreground priority, durable auth reservation and no-replay rules interact. |
| Validation | Separate/exchange modes, trace-only failure, successful continuation, exhausted budget, foreground arrival, generation change, no burst/replay. |
| Approval | Approve RF rate/recovery behavior; auth approval if continuation authority changes. |

### F07 — Newer database schemas are accepted for writable startup

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Confirmed** isolated temporary DB |
| Location | `src/metrics/store.js:744–775,879–907` |
| Observation | No `user_version > latest migration` refusal exists. Current schema 23 fixture changed to version 999 reopened; `beginObserverRun` wrote one run while version stayed 999. This demonstrates missing downgrade protection, not existing corruption. |
| Maintenance impact | Older binaries can write newer layouts without an explicit compatibility decision; rollback/recovery becomes uncertain. |
| Recommendation | Refuse unsupported future versions before migration/run mutation and as early as practicable before database configuration writes; close the connection on failure. Preserve one connection/migration owner. |
| Risk | Moderate compatibility change: previously accepted downgrades will refuse. |
| Validation | Supported old upgrades/current startup; structurally compatible future fixture rejected; no run/history mutations; actionable error; handle released. |
| Approval | **Storage/startup compatibility** approval. |

### F08 — Current dashboard sort does not support unnamed nodes

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Confirmed** code-contract contradiction in pre-existing uncommitted edit |
| Location | `src/web/client/dashboard.js:708–710`; contract test `test/web/metrics-server.test.js:357–367` |
| Observation | Timestamp ties call `left.name.localeCompare(...)`; valid unnamed nodes have null names. An unnamed left operand throws and list refresh reports failure. |
| Maintenance impact | Server-supported records cannot reliably render; server tests do not execute this renderer. |
| Recommendation | Prefer authoritative server ordering; otherwise define an explicit nullable-name tie rule. Preserve the user's surrounding edits. |
| Risk | Low: pagination/order expectations must remain consistent. |
| Validation | Equal timestamps, two unnamed nodes, mixed names, ordinary/empty lists. |
| Approval | Normal batch approval; no protected contract needed. |

### F09 — Repeater-list requests lack latest-request ownership

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Supported** race schedule; missing guard confirmed |
| Location | `src/web/client/dashboard.js:928–946,966–982`; mutable offset used at `:711,736–738` |
| Observation | Search/page/live-refresh requests may overlap and render unconditionally after await. Older rows can overwrite newer search results while labels use the newer offset. Range requests already have generation ownership, but this path does not. |
| Maintenance impact | Rows, filters and pagination can disagree; different async paths require different implicit lifecycle rules. |
| Recommendation | Existing generation primitive plus captured query/offset; suppress superseded successes/errors and invalidate dependent progress work. |
| Risk | Low–moderate: preserve live inventory versus historical-range independence and debounce. |
| Validation | Deferred old search resolves last; old page error arrives last; live refresh overlaps navigation; no stale progress render. |
| Approval | Normal batch approval. |

### F10 — Reporting orchestration obscures range provenance and couples independent failures

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Confirmed** control/data flow; browser race execution deferred |
| Location | `src/web/client/dashboard.js:91–93,531–541,1197–1257` |
| Observation | Endpoint-only cache can retain range A values under selected range B after partial failure. Aggregate rendering waits for all focused requests; failed aggregate discards successful focused results. Its rejection handler is attached only after focused settlement. |
| Maintenance impact | Mixed-range evidence can look current; one slow/failing endpoint masks unrelated success. Parallel maps and request state make ownership difficult to reconstruct. |
| Recommendation | Two small sub-batches: explicit range/stale provenance for retained data; then independent aggregate/focused settlement under current generation/abort owner. Keep last-good retention with honest labels. |
| Risk | Moderate: preserve coalescing, cancellation, navigation and last-good behavior. |
| Validation | A success → B partial failure; same-range failure/recovery; healthy aggregate + stalled focused request; failed aggregate + healthy focused reports; no stale renders/unhandled rejection. |
| Approval | Normal batches if HTTP response contracts remain unchanged. |

### F11 — SSE clients and buffered snapshots are unbounded

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Supported** exposure-dependent risk; missing bounds confirmed |
| Location | `src/web/metrics-server.js:228–242,967–986` |
| Observation | Sample broadcasts ignore `res.write()` backpressure; no client/buffer cap or slow-client policy. |
| Maintenance impact | Slow readers can retain buffers on the same process that handles capture; remote exposure multiplies risk. No exhaustion was measured. Default UI is disabled/loopback. |
| Recommendation | Approve minimal snapshot coalescing or bounded slow-client disconnect policy and an exposure-appropriate client limit. |
| Risk | Moderate: define reconnect/freshness semantics; avoid replay promises the viewer does not need. |
| Validation | Slow and healthy fake/loopback clients, sustained samples, bounded memory/work, healthy delivery, complete stop cleanup. |
| Approval | **Streaming/public-API policy** approval; no implicit auth addition. |

### F12 — Ordinary QoS packet publication lacks application-level completion/admission bounds

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Supported** QoS/configuration-dependent risk |
| Location | `src/mqtt/mqtt-broker.js:132–143`; `mqtt-manager.js:102–130`; `observer-publisher.js:23–25`; `src/index.js:315–321` |
| Observation | Packet callbacks can wait indefinitely; each event starts independent work. A withholding QoS 1/2 broker delays manager-wide outcome accounting even if another broker succeeds. Graceful close can also wait on outstanding work. |
| Maintenance impact | Resource/delivery policy is less explicit than status/region paths. Default QoS 0 and other bounded client-retirement activity reduce some scenarios; no production exhaustion claim. |
| Recommendation | First specify packet delivery/backpressure policy and test saturation. Then bound admitted work/completion with truthful loss/outcome reporting and independent broker progress. |
| Risk | Moderate–high: an arbitrary timeout/cap can discard raw packets, whose intended persistence is MQTT. Do not invent local raw-packet storage. |
| Validation | Never-ACK fake client, sustained packets, healthy second broker, bounded retained work, honest outcomes and bounded shutdown. |
| Approval | **MQTT delivery contract** approval; logging/config approval if policy changes those contracts. |

### F13 — Validated timer configuration can become a 1 ms loop

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Confirmed** config and runtime execution |
| Location | `src/config/schema.js:109`; `src/config/index.js:167` (sample interval read); `src/metrics/sampler.js:56`; reconnect delay schemas also lack maxima |
| Observation | `sampleIntervalMs=2147483648` passes config and is passed to `setInterval`. Node warns and uses 1 ms; offline no-store reproduction observed 20 callbacks in 30 ms. No application was started. |
| Maintenance impact | An operator's intended long interval can cause rapid metrics writes and event-loop/disk load rather than startup rejection. |
| Recommendation | Bound direct native timer inputs centrally to safe representable delays; inventory other timer settings and distinguish stored deadlines from timer durations. Use staged waits only where intentionally supported. |
| Risk | Low–moderate: reject formerly accepted invalid operational values without changing valid defaults or long durable deadlines. |
| Validation | Native timer boundary values, oversized/unsafe integers, normalized config, no hardware/network on rejection; preserve ordinary interval behavior. |
| Approval | Configuration behavior batch approval; public config contract review if treated as compatibility-sensitive. |

Runtime behavior is corroborated by the primary [Node 24 timer documentation](https://nodejs.org/download/release/v24.0.0/docs/api/timers.html#setintervalcallback-delay-args). The repository/config reproduction is the direct evidence for this application.

### F14 — Release branch has no dedicated push CI trigger

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Low / Confirmed**, intentionally configured scope; actual missing validation is unverified |
| Location | `.github/workflows/ci.yml:3–10`; `README.md:798–832`; prior decision `docs/plans/v2.4.0/issue-9-continuous-integration.md` |
| Observation | Only main pushes and PRs targeting main trigger. Release pushes lack a dedicated push trigger, but synchronize events on an existing main-targeted PR do run checks. Presence of such a PR was not verified. Documentation also says required checks remain pending; remote protection was not queried. |
| Maintenance impact | Release work without a qualifying PR may lack automatic feedback. This is a known policy limitation, not an established current validation outage or proof of a failed remote run. |
| Recommendation | Explicitly choose release-branch push/PR validation and required statuses; retain current OS/Node matrix and GitHub exception. |
| Risk | Low implementation, moderate policy impact: duplicate runs/cost and required-status names need attention. |
| Validation | Inspect event filters; verify an actual authorized release push/PR run and required checks separately. Local results cannot prove remote CI. |
| Approval | **CI/deployment policy** approval. |

### F15 — Native HTTP has unresolved hardening and request-log constitution gaps

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Confirmed** policy gap; no XSS/exploit established |
| Location | `src/web/metrics-server.js:258–307,967–991`; `dashboard-page.js:31–38`; `docs/project_plan.spec.md:907` |
| Observation | No CSP/security-header contract and no HTTP request UUID/record/application-event contract. Error path includes raw `req.url`. Native HTTP and no-framework/dependency rules conflict with blindly applying Express/Helmet. |
| Maintenance impact | Security expectations are unclear for the now-existing viewer; operators cannot rely on the supplied centralized request-ingest semantics. |
| Recommendation | Approve native header enforcement, exact CSP compatible with modules/Chart.js/SRI/styles, and request-log applicability/shape/redaction. Preserve viewer model; do not add a framework or auth implicitly. |
| Risk | Moderate: CSP can break rendering; request logging can expose queries or create noise. |
| Validation | Every route/error/static/SSE response header; real browser CSP compatibility; request UUID/order/valid-app-event/redaction if approved; no secrets/raw query logging. |
| Approval | **CSP and logging contracts**; dependency/framework only if explicitly selected. |

### F16 — Poll completion uses opaque positional boolean modes

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Supported** comprehension finding, not behavior defect |
| Location | `src/metrics/telemetry-poll-state.js:153–166,255,281–294` |
| Observation | `finish(state,end,policy,successful,unsupported=false,authFailure=false)` mixes reason precedence, cadence, mutation, write and high-water advance. Nested ternaries force callers/reviewers to reconstruct boolean combinations, including orphan recovery. |
| Maintenance impact | Small changes to conservative retry/auth scheduling are harder to review and easier to misclassify. This is a concrete readability cost independent of file length. |
| Recommendation | Named outcome input and explicit reason/deadline branches within the same module/transaction owner. No generic state framework. |
| Risk | Moderate: preserve every existing deadline, terminal reason, auth cooldown and write ordering. |
| Validation | Existing poll-state suite plus explicit success/auth-failure/unsupported/exhausted/retry/orphan/policy-change matrix; compare returned/persisted outcomes. |
| Approval | Normal behavior-preserving batch; separate storage-policy approval if any semantics change. |

### F17 — Suppression adapter drops response sender metadata

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Medium / Confirmed** offline actual-module execution |
| Location | `src/bots/channel-bot.js:253–263`; `reply-suppression.js:25–28`; `command-handlers/exact.js:24–42` |
| Observation | Coordinator supplies `responseSender`; bot adapter drops it. Exact handler needs it to reconstruct a sender-prefixed configured response. Template `{sender}: Ack`, pending sender Alice, decrypted `{responseSender:'Alice',responseText:'Ack'}` incorrectly fails satisfaction. |
| Maintenance impact | Tests of the handler/coordinator in isolation miss adapter data loss; extra avoidable replies use RF airtime. |
| Recommendation | Forward the existing metadata through the existing adapter. |
| Risk | Low; preserve own-reply exclusions and ambiguous-response refusal. |
| Validation | Packet-driven sender-prefix suppression regression plus ordinary bot-prefix, senderless, ambiguous, duplicate and own-reply cases. |
| Approval | Normal batch approval; no protected shape/schema/storage change. **Recommended first batch.** |

### F18 — Stopped bot can become ready when old setup resolves

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Low / Confirmed** deferred fake-device execution |
| Location | `src/bots/channel-bot.js:222–232,280–299` |
| Observation | Begin setup → stop → resolve channel setup changes readiness from false back to true. Stop removes listeners but does not invalidate pending setup. |
| Maintenance impact | Stopped-state/health invariant is misleading. This does not demonstrate post-stop RF transmission; stopped queue/listeners compensate in process shutdown. |
| Recommendation | Invalidate setup epoch on stop and check it before publishing readiness; preserve restart behavior. |
| Risk | Low–moderate around restart/generation semantics. |
| Validation | Stop/restart/disconnect during deferred setup; stale completion cannot publish current readiness. |
| Approval | Normal batch approval. |

### F19 — HTTP bind failure leaks the sampler subscription on retry

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Low / Confirmed** code; existing test does not use a sampler |
| Location | `src/web/metrics-server.js:153–184,208–210`; `test/web/metrics-server.test.js:896–940` |
| Observation | Subscription precedes listen; failure clears server but retains listener. Same-instance retry overwrites removal reference and can duplicate broadcasts/leak listeners. Current test retries a different instance without sampler. |
| Maintenance impact | Documented retryable/cleared-state invariant is false for the actual sampler integration. |
| Recommendation | Subscribe only on successful listen or unwind exact listener on failure. |
| Risk | Low: preserve stop idempotence and first sample delivery. |
| Validation | Occupied port + EventEmitter sampler; failed start leaves baseline listeners; same instance retry then stop also returns to baseline. |
| Approval | Normal batch approval; good separate low-risk alternative to Batch A. |

### F20 — Diagnostic replay equivalence depends on property insertion order

| Field | Evidence and proposed action |
|---|---|
| Severity / confidence | **Low / Confirmed** temporary-store execution |
| Location | `src/metrics/telemetry-diagnostics.js:11–23`; contrast `telemetry-history.js:5–11,64`; test `test/metrics/telemetry-diagnostics.test.js:42` |
| Observation | JSON string equality rejects otherwise identical reordered DTO entries as request-identity conflict. Existing replay test reuses the same object. |
| Maintenance impact | Reconstructed/replayed valid diagnostics can fail idempotency for representation-only differences. Ordinary same-object retry works. |
| Recommendation | Narrow order-insensitive equality for validated DTO objects; retain array order and real conflict rejection. No general canonicalization framework. |
| Risk | Low, but durable idempotency semantics are protected. |
| Validation | Reordered top-level/nested keys, real content change rejection, reopen replay, arrays retain order. |
| Approval | **Storage replay contract** approval. |

## Recommended remediation backlog

Effort: XS = hours; S = roughly one focused engineering day; M = several days including tests; L = policy/reproduction work before estimating implementation. These are relative estimates, not delivery promises.

| Group | Recommendation | Effort | Regression risk | Expected benefit |
|---|---|---|---|---|
| 1. Correctness/security | F01 atomic channel allocation | S | Moderate | Reliable multi-bot channel ownership |
| 1 | F02 bounded connected-silence recovery, one command family at a time | M per family | Moderate–high | Prevent indefinite shared-work stalls |
| 1 | F03 stopped/single-flight refresh; F04 initial credential recovery separately | S / M | Moderate | Reliable teardown and transient-failure recovery |
| 1 | F05 capacity alignment; F06 trace accounting separately | S / M | Low–moderate / moderate | Restore end-to-end validation and RF budget invariants |
| 1 | F07 future-schema refusal; F13 timer bounds separately | S / S | Moderate / low–moderate | Safer startup/operator configuration |
| 1 | F08 nullable-name edit correction; F17 suppression forwarding | XS / XS | Low | Fix concrete supported-data/metadata defects |
| 2. High-value maintainability | F09 request ownership; F10 provenance then independent settlement | S / M | Low–moderate / moderate | Traceable async state; truthful current data |
| 2 | F16 named poll completion outcomes | S | Moderate | Review scheduling decisions without decoding flags |
| 2 | Optional local polling `#request` completion/diagnostic steps | M | Moderate | Make reserve→owner→save flow visible; prove need before extracting |
| 3. Local readability | MQTT manager explicit per-broker outcome association (`mqtt-manager.js:107–129`) | XS–S | Low | Remove nested ternary plus filtered-array cursor bookkeeping while preserving concurrent dispatch/order |
| 3 | F18 setup epoch; F19 failed-bind unwind; F20 replay comparator | S / XS / S | Low–moderate / low / low | Accurate lifecycle/idempotency invariants |
| 3 | Correct stale ownership/privacy comments, listed below | XS | Very low | Future reviewers can trust documented invariants |
| 4. Testing/observability | Add missing composed-boundary/controller tests as part of the matching fixes | Included | Low | Test real handoffs, not only isolated helpers |
| 4 | F11 SSE bounds; F12 packet delivery policy/saturation | M / L | Moderate / moderate–high | Explicit resource/loss policy |
| 4 | F14 release CI policy and protection verification | S | Low implementation | Automatic feedback on release work |
| 4 | F15 native HTTP CSP/request-log decision | M + decision | Moderate | Resolve supplied security/ingestion expectations |
| 4 | Region failure phases (`region-discovery-scheduler.js:62,70–79,163,209`) | S | Low–moderate | Identify clock/snapshot/query/validation/save failures with fixed secret-free categories; retain deduplicated warnings |
| 5. Optional architecture | Measure 3 history calls per visible repeater (up to 75/page) before proposing a progress aggregate endpoint | S measurement; design TBD | Protected API | Evidence for an API only if event-loop load warrants it |
| 5 | Consider a small injected-fetch controller seam inside current browser boundary | Included in F09/F10 | Moderate | Deterministic orchestration tests without new browser dependencies |
| 6. Best unchanged | Store connection/delegates, shared radio owner, separate domain schedulers, handler map, static native web | None | Avoids unnecessary change | Preserves established contracts and comprehension |

### Low-priority observations and explicit investigations

- **Comments:** coordinator `:44–46` says no contact mutation, while `:775` reconciles contacts; telemetry adapter `:68` says names/coordinates discarded but `:89–94` retains validated metadata; `test/fixtures/telemetry-radio-wire.js:22` overstates non-retention; packet-deduplicator `:5–9` implies one shared consumer cache although publication/bot dedup differ. Correct claims to match deliberate behavior; do not alter behavior to match old comments.
- **Validation parser:** `web/schemas.js:234–244,270–280` uses `key in query` on `{}` and silently skips inherited names such as `constructor`; use own-property semantics only after public validation behavior is approved. Range union `:27–30` permits range plus one endpoint despite a stronger comment. Establish intended compatibility before tightening.
- **Logger:** key-name redaction is bounded at depth six and does not sanitize arbitrary message strings. No demonstrated current deep-metadata secret leak was found. Keep secret exclusion at callers; do not claim recursive redaction is a complete sanitizer. Prototype/cyclic/serialization failures are not established current production defects.
- **Sampling loss:** sampler advances its previous snapshot even after packet-delta persistence fails (`sampler.js:74–76,108–122`). This loses a failed interval rather than recovering it later. First define the loss/time-attribution contract; automatic accumulation would change interval semantics.
- **Migration evidence:** synthetic downgrade fixtures are useful but do not by themselves prove every real historical deployed schema. Several explicit old-table fixtures also exist. Before changing historic migration dependencies on current reason enums, test representative archived schemas; no present migration failure was demonstrated.
- **Accessibility/date policy:** chart `aria-hidden` handling differs between chart paths; text alternatives exist. Date-only custom inputs use UTC/fixed-day math as tests specify; changing DST/local-time semantics needs a product decision.
- **Availability/exposure:** unauthenticated viewer and optional non-TLS MQTT are explicitly operator-controlled configurations, not newly discovered authorization bugs. No Host/Origin enforcement was established; DNS-rebinding suitability and deployment controls require separate threat validation before asserting an exploit. Retention zero is documented unlimited retention, not accidental unboundedness to silently change.
- **Supply chain:** lockfile and `npm ci` exist; Actions uses version tags. No current vulnerability advisory lookup, dependency audit, clean install, native serial rebuild, SBOM or tag-integrity verification was performed. No CVE-free claim is made.

## Explicit non-recommendations

1. Do not split `MetricsStore` because it is large. Its single connection, ordered transactional migrations, run lock and reference-preserving retention are essential. Existing delegates already separate cohesive datasets.
2. Do not replace the radio coordinator with generic jobs or independent per-feature queues. Preserve full-key/generation matching, ACK versus remote-response distinction, recovery latches, late-frame drains, foreground priority and shared exchange credits. Repeated admission checks protect changes across async boundaries.
3. Do not merge region and telemetry schedulers. Their eligibility/authentication, evidence and completion policies differ despite similar timer/drain shapes.
4. Do not simplify clock high-water, original dispatch/receipt time, orphan recovery, unknown completeness or useful-versus-decoded latest pointers. They prevent invented certainty and unsafe replay.
5. Do not move shared RF/decryption/dedup/scope/send lifecycle into command handlers. Keep bounded serializable handler state; no plugin framework or command-specific database columns.
6. Do not collapse pending, dispatching, accepted, ACK, repeat, suppressed, or transport-publication outcomes into one status. They measure different evidence. Uncertain delivery must not trigger optimistic replay or scope broadening.
7. Do not unify raw packet and bot duplicate suppression. Each heard reception remains meaningful to MQTT capture; avoiding repeated bot replies is separate.
8. Do not add Express, React, TypeScript, another decoder, database library, logging framework, or new dependency to solve these findings. No-build browser modules and native HTTP are viable seams.
9. Do not remove meaningful restart, migration, concurrency, fairness, clock, recovery, retention or cost tests to shorten execution. Their domain guarantees are real.
10. Do not automatically replace the intentionally nonstandard LetsMesh token with JOSE, export private keys, or introduce a second MQTT transport reconnect loop.
11. Do not introduce authentication, local raw-packet storage, deployment resources, mass formatting, broad renames, or a repository-wide style campaign under this audit.

## Behavioral traces and testing assessment

| Representative path | Evidence/invariants and assessment |
|---|---|
| Startup failure | Configuration validation precedes store and hardware/network; SQLite/run ownership failure prevents operation. Child-process tests cover invalid config, unavailable/corrupt DB and ownership conflict. F13 adds native timer representability. |
| Reception to publication/registry | Raw normalization/AJV → SDK packet decode → each-reception publication; independently verify signed advert before inventory update. Genuine signed fixtures test tamper and out-of-order verification. Shutdown tracks pending registry work. F12 concerns broker completion policy, not ingest validation. |
| Command to reply | Decrypt/MAC → sender/command/scope/hop validation → per-bot duplicate filter → durable queue → shared quiet-window claim → apply/send/restore under command ownership → distinct delivery/repeat evidence. Preserve ordering; F01/F17 concern missing operation-level atomicity/metadata. |
| Telemetry collection | Bounded candidate page/clock checks → durable pre-send reservation → single coordinator lease/inventory/trace/auth → correlated response/decode → diagnostic/data terminal save. Unconfirmed save pauses later RF and retries locally. F02/F05/F06 expose handoff gaps, not a need to rewrite scheduling. |
| Region to broker | Direct-evidence eligibility → durable reservation → tagged/generation-correlated response → immutable answer/publication stage → per-broker claim → PUBACK result → durable resolution; unsaved completion blocks new work. Preserve measured-empty and unknown completeness. |
| Shutdown | Stop admission/producers; detach new persistence input; cancel/drain coordinator and schedulers while store remains open; stop bots/outbound queue; close HTTP, broker and radio; await pending adverts; finalize run. Existing timeout records conservative outcome. F03 must fence renewal against this order. |
| Browser reporting | Navigation/range generations and coalescing are intended safeguards; pure logic tests cover primitives. F09/F10 show untested integration of those primitives. Existing HTTP tests do not execute the browser controller. |

Tests are predominantly behavioral, using real temporary SQLite and protocol-shaped fake radios rather than mocks of all internals. Integration fixtures deliberately monkeypatch transport seams in child processes to test actual entrypoint wiring without live RF; that complexity is justified. Wall-clock cost gates deliberately disable file parallelism; measured results are host/load-sensitive, not deterministic algorithmic proofs. Do not turn one local pass into a production performance guarantee.

## Validation baseline

Baseline execution is recorded in `artifacts/audit/validation.log` and `artifacts/audit/loopback-recheck.log`; generated reports are ignored. No application source or test was changed between runs.

- `npm run lint`: executed successfully, no findings.
- `npm run test:ci`: completed the full 115-file / 1,623-test suite in 314.63 seconds. **113 files / 1,578 tests passed; 2 files / 45 tests failed.** All failures were in `test/web/metrics-server.test.js` (43) and `test/radio/transports/tcp-transport.test.js` (2), with loopback `connect EACCES` evidence. HTTP fetches were denied; TCP timeout/accepted-socket assertions consequently failed before the intended scenario could occur. This full run was not green.
- `npm test -- test/web/metrics-server.test.js test/radio/transports/tcp-transport.test.js`: rerun with local-connection permission after the environmental denial. **Both files / all 49 tests passed**, exit code 0, in 1.78 seconds. This clears the observed failures in the affected suites. No single all-green full coverage rerun is claimed; the remainder of the suite was not repeated without a code change or new concern.
- Coverage emitted by the full run: **80.60% statements (7,074/8,776), 80.54% branches (5,001/6,209), 81.62% functions (1,084/1,328), 80.97% lines (5,884/7,266)**. All percentages exceed configured global floors (72/71/73/70). They describe the environment-limited run, not a clean passing coverage run. The targeted retry did not recompute coverage.
- Priority-file statement/branch coverage in that run: store **91.27/88.83%**; remote coordinator **86.29/89.40%**; polling scheduler **87.53/88.15%**; index **64.60/17.65%**; HTTP server **13.24/5.28%** (affected by denied sockets); browser controller **0/0%**. Subprocess integration behavior and in-run coverage capture are different evidence; low entrypoint coverage alone does not establish that its child-process scenarios are untested. The browser-controller gap is real and acknowledged in README.
- Separate `npm test`/`test:coverage` were not redundantly run: `test:ci` uses the same Vitest suite with Istanbul coverage. No build script exists; no invented build workflow was used.
- Read-only installed-ESLint metrics pass: completed; no config edits/new lint gates.
- Offline reproductions: channel race, suppression metadata loss, setup-after-stop, refresh-after-stop/overlap, first-token failure, 350/351/1,024 contract boundary/full-owner rejection, separate-mode trace accounting, future-schema writable reopen, reordered diagnostic replay, and oversized native timer behavior.
- Not performed: live RF/firmware acceptance, browser visual/CSP execution, deployed MQTT acknowledgements, production/load data access, clean dependency installation, Linux/Node 22 matrix execution, remote CI/branch-protection verification, deployment.

The optional per-file summary initially attempted to resolve `istanbul-lib-coverage` directly; that package is not exposed at this repository's top level. Nothing was installed. The summary was instead calculated from existing `coverage-final.json` hit counters using standard JavaScript. This auxiliary resolution failure did not affect repository checks.

## Controlled cleanup roadmap — approval required

Before every batch: verify branch/worktree; inspect exact current code and relevant tests; preserve unrelated edits; agree observable expectations. Run documented focused tests via `npm test -- <file>` plus `npm run lint`; use `npm run test:ci` at the agreed integration gate. No commit/push/deployment is implicit.

| Batch / phase | Specific scope and intended improvement | Invariants / preservation strategy | Required validation / acceptance | Risk / approval |
|---|---|---|---|---|
| **A — smallest first** | F17 only: `channel-bot.js` adapter + suppression integration test | Forward existing metadata; retain matching, own-response and ambiguity rules | `Alice: Ack` satisfies the existing handler through the real bot adapter; negative cases still refuse; relevant tests/lint pass | Low; ordinary explicit approval |
| B — multi-bot correctness | F01 only: `channel-setup.js` + deterministic shared-queue tests | Existing one command owner; atomic enumerate/select/write; no nested queues or new locks | Two missing channels get separate correct slots; existing reuse/failures preserved | Moderate; ordinary approval |
| C1 / C2 — lifecycle | F03 stopped/single-flight refresh, then F04 initial-signing recovery as separate changes | One auth retry owner, MQTT.js transport reconnect, hardware key ownership; shutdown bounded | Deferred stop/overlap tests; initial fail→success; retries cease at stop; brokers independent | Moderate; explicit auth lifecycle approval |
| D1 / D2 / D3 — remote safety | F02 startup clock/query deadlines first; contact-mutation deadlines next; flood-advert deadline last | Uncertain generation retired before queue reuse; no late-frame cross-correlation; foreground wins | Connected silence and late reply tests per family; failed recovery remains latched; stop bounded | Moderate–high; approve exact runtime/auth recovery decisions |
| E1 / E2 — telemetry contracts | F05 shared supported capacity; separately F06 physical trace charge/continuation | Strict AJV, bounded inventory, truthful reservations, paced RF, no auto-replay | Boundary owner→scheduler→store tests; separate/exchange trace budget tests; no starvation/burst | Low–moderate / moderate; contract/RF decisions approved first |
| F1 / F2 — startup protection | F07 future-schema refusal; separately F13 timer bounds | One DB owner; supported upgrades; config before external side effects; valid defaults unchanged | No future-version mutation/handle leak; timer boundaries reject safely | Moderate / low–moderate; storage/config review |
| G0 / G1 — dashboard list | F08 correct current edit; separately F09 latest-request controller | Server ordering/nullability; captured query/page; live inventory independent of range | Tied null names; deferred response/error/navigation tests | Low / low–moderate; ordinary approval |
| G2 / G3 — dashboard reports | F10 provenance first; independent settlement second | Explicit stale last-good values; generation/abort/coalescing retained | No range-A values presented current under B; healthy sections render despite unrelated failure/hang | Moderate; ordinary approval without API changes |
| H — readability only | F16 named outcome transition; independent optional MQTT outcome-association cleanup | Exact reason/deadline/write and concurrent broker outcome order remain identical | Transition matrix; reverse broker completion; no new layer or behavioral change | Moderate / low; approve one at a time |
| I1 / I2 / I3 — small invariants | F18 setup epoch; F19 listener cleanup; F20 replay equivalence as separate reviews | Stop/restart semantics; listener ownership; real conflicts still reject | Focused lifecycle/idempotency tests; no incidental refactoring | Low–moderate / low / low; F20 storage approval |
| J — policy decisions | F11 streaming bounds, F12 packet admission/loss, F14 release CI, F15 CSP/logging: separate designs and changes | No silent packet loss, auth expansion, contract shifts, or deployment additions | Saturation/header/log tests and approved CI runs; document chosen policy | Varies; protected approval per contract |
| K1 — optional telemetry clarity | Local polling completion/diagnostic clarity only | Scheduler ownership, timing, terminal persistence and fail-closed RF unchanged | Reviewer can trace reserve→terminal save; existing failure/drain tests remain green | Moderate; no extraction absent demonstrated benefit |
| K2 — optional region diagnostics | Secret-free region failure phases only; independent approval/change | Deduplicated warnings, scheduling, persistence and fail-closed RF unchanged | Injected failures identify fixed phase without exposing secret strings or adding repeated noise | Low–moderate; logger-contract approval only if its shape changes |

Acceptance is behavioral and human-facing: a maintainer can identify the operation owner, relevant state, terminal outcomes and failure path without reconstructing boolean flags or unrelated async maps. Passing tests and lower scores alone are insufficient. Reject a proposed cleanup if it merely relocates complexity or adds indirection.

## Open questions and deferred decisions

1. Maintainer: should the local viewer implement the full centralized HTTP ingest contract, and what native CSP/header policy is approved?
2. Maintainer/operator: what packet loss/admission policy is acceptable for QoS 1/2 brokers, and what SSE exposure/client policy is intended?
3. Maintainer: should this release branch receive push CI and required statuses before main PR integration? Remote protections remain unverified.
4. Radio owner: what deadline and generation-retirement behavior is safe for clock/query/contact/flood commands on supported firmware? Confirm through fake-device tests before approved RF acceptance.
5. Data owner: should failed packet-sample intervals be explicitly lossy or recovered, and which historic schema fixtures must be retained before migration edits?
6. Product owner: how should prior-range last-good data be labeled? Preserve evidence rather than silently mixing it.

No application source cleanup has begun. Approval of one named batch is required before implementation; approval does not authorize the remaining roadmap.
