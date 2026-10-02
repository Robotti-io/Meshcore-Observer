# Issue #11 — Test-suite structure and quality

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/11](https://github.com/Robotti-io/Meshcore-Observer/issues/11)

**Plan refinement (2026-10-02):** The user confirmed evidence-based fixes only, preserving the current Vitest runner and domain-based test organization. Implementation is tracked task by task below.

## Implementation Plan

### 1. Feature Summary

Improve the reliability, isolation, and diagnostic value of the existing test suite through small fixes supported by audit evidence. Preserve its Vitest runner, domain-based folders, and current test naming unless the audit demonstrates a concrete problem.

### 2. Relevant Existing Architecture

- Issue #10 selected Vitest with Istanbul; the migration is complete. `package.json` provides `npm test`, `npm run test:ci`, and `npm run lint`.
- The suite currently has 47 test files and 475 tests, organized under domain folders such as `test/bots/`, `test/metrics/`, `test/mqtt/`, `test/radio/`, and `test/web/`.
- `test/fixtures/packet-frames.js` provides shared packet fixtures. Tests also use local fakes, injected clocks, and temporary SQLite databases.
- `vitest.config.js` uses one Node test project with default execution settings and has no global setup file. Nine test files call native `setTimeout` or `setInterval`; fake timers are currently used in the reply-queue tests. These are audit candidates, not automatic rewrite targets.
- `test/index.test.js` already covers clean shutdown and failure to open the required store before network services start. Radio, MQTT, queue, and persistence tests already exercise several failure and restart paths; T1 must identify genuine gaps before T4 adds coverage.
- Tests that create stores, servers, sockets, MQTT clients, timers, listeners, temporary files, or modified globals must release them within the test or its owning test group.

### 3. Proposed Approach

Audit before changing the suite. Record findings with file/test references and prioritize only issues that can cause flakes, leaks, hidden coupling, or unclear failure reports. Keep the current domain layout and one Vitest project. Apply cleanup and deterministic-time improvements locally, and add behavioral tests only for uncovered high-risk cases. Do not add production seams solely to raise coverage; if a real gap requires a production change, stop and refine the plan before making it.

### 4. Impacted Areas

- `test/**/*.test.js` for audit-backed cleanup, timing, assertion, or failure-coverage changes.
- `test/helpers/**` only if T1 finds repeated setup with a clear, narrow shared concept.
- `vitest.config.js` or `package.json` only if the audit demonstrates a test-execution need; no new projects, categories, scripts, or dependencies are planned by default.
- Production modules are out of scope unless T1 identifies a concrete testability blocker; any such change requires a plan update before implementation.

### 5. Task Breakdown

#### T1: Audit suite reliability and diagnostics

- [x] Complete — cross-cutting audit recorded below (2026-10-02).
- **Objective:** Build an evidence-based list of improvements before changing tests.
- **Specific changes:** Review file/domain organization, test names and assertions, real waits and timer controls, shared mutable state, environment changes, order assumptions, resource ownership/cleanup, and representative JUnit output. Mark each finding as actionable, already covered, or style-only. Record file and test references for actionable findings. Do not rename or reorganize files during the audit.
- **Definition of done:** The plan identifies the highest-value cleanup/timing work and any actual missing high-risk behavior coverage; stylistic preferences and behavior already covered by Issues #7/#10 are excluded.
- **Expected tests / validation:** Read-only review of the 47-file suite and an existing JUnit report; confirm the baseline test count and current Vitest execution model from repository files. No code changes.

**T1 audit findings (2026-10-02):**

- **Organization and diagnostics — no change needed:** The existing domain folders and descriptive `test()` names are understandable. The local JUnit report parses as 47 suites / 475 tests with zero failures. No `.only`, `.skip`, or concurrent-test markers were found. No blanket rename, `describe()` wrapping, or category-specific runner settings are justified.
- **Timing candidates for T3:** Pure timer/polling tests use wall-clock waits in `test/radio/airtime-coordinator.test.js`, `test/radio/flood-advert-scheduler.test.js`, `test/radio/command-queue.test.js`, `test/radio/radio-manager.test.js`, `test/metrics/sampler.test.js`, `test/bots/reply-queue.test.js`, and `test/mqtt/token-refresh-loop.test.js`. Review these individually; preserve real-time waits that prove actual socket, HTTP/SSE, or child-process behavior in `test/radio/transports/tcp-transport.test.js`, `test/web/metrics-server.test.js`, and `test/index.test.js`. `test/bots/repeat-check-sweeper.test.js` already injects its interval callback, and serial transport tests use `setImmediate` to drain simulated events rather than wall-clock delays.
- **Cleanup candidates for T2:** `test/radio/flood-advert-scheduler.test.js` and `test/radio/radio-manager.test.js` stop active resources after assertions rather than in `finally`, so a failed assertion or timeout can skip teardown. `test/web/metrics-server.test.js` correctly cleans up the server, sampler, and store in `finally` around each test body, but its shared helper starts the sampler and server before entering that `try`. Review direct `MetricsStore` and `ReplyQueue` cleanup for the same failure-path risk before considering a shared helper.
- **Existing cleanup patterns to retain:** Temporary config files use `finally` or `afterAll`; TCP transport tests close sockets in `finally`; the metrics-server port-conflict test closes its server/store in `finally`. `test/index.test.js` restores `console.log` and prototype overrides in `finally` and removes its temporary directory in `finally`. Its environment changes are isolated to that Vitest file and the child test overrides the values it depends on, so the audit did not identify a demonstrated cross-file leak.
- **Failure coverage — no distinct new gap confirmed in this audit:** `test/index.test.js` covers shutdown and store-startup ordering; the radio manager and flood scheduler cover connection/send failures; MQTT, reply-queue, and persistence tests already exercise failure and restart paths. T4 is conditional: add tests only if a targeted review identifies a distinct missing behavior; otherwise record that no additional regression test is warranted.

#### T2: Fix audit-confirmed cleanup and isolation issues

- [x] Complete — cleanup now runs if assertions fail in the audited resource-owning tests.
- **Objective:** Ensure tests reliably release resources and do not contaminate other tests.
- **Specific changes:** Address only T1 findings involving leaked stores, servers, sockets, MQTT clients, timers, listeners, temporary paths, environment variables, globals, or shared state. Prefer local `try/finally` or test-file lifecycle hooks. Add a helper only when repeated setup expresses the same lifecycle concept and the helper keeps test conditions visible. Do not add global cleanup for resources owned by individual tests.
- **Definition of done:** Every addressed test releases resources it creates, including on assertion failure, and repeated runs show no resource leak or cross-test contamination.
- **Expected tests / validation:** [x] Affected test files passed together (52 tests). [x] `npm test` passed twice consecutively under Vitest defaults (47 files / 475 tests each). [x] `npm run lint` passed.
- **T2 changes (2026-10-02):** `test/radio/flood-advert-scheduler.test.js` now owns rig cleanup in a `finally`-backed helper. `test/radio/radio-manager.test.js` tracks managers and stops any remaining manager in a file-local `afterEach`, including after failed assertions. `test/web/metrics-server.test.js` now includes sampler/server startup inside the cleanup `try`, so a rejected startup still stops the sampler and closes the store.
- **Validation observation:** The first combined focused run had two `TypeError: fetch failed` / `bad port` failures in the metrics-server 404/405 tests. Those two tests passed in isolation, all three affected files passed on rerun, and both subsequent full-suite runs passed. No URL or assertion change was made; watch for recurrence in later CI runs.

#### T3: Make audit-confirmed timer tests deterministic

- [x] Complete — timer-only waits in the audited candidates now use injected clocks, fake timers, or explicit synchronization.
- **Objective:** Remove timing flakiness without hiding real I/O behavior.
- **Specific changes:** For waits that only advance JavaScript timers, prefer an injected clock or scoped Vitest fake timers. Keep real asynchronous waits where the test observes operating-system, socket, HTTP/SSE, or child-process behavior and cannot reasonably synchronize through an event. Do not apply fake timers across SQLite or real I/O paths without evidence that the combination is safe.
- **Definition of done:** Addressed tests assert the intended state transition or event instead of depending on an arbitrary elapsed delay, while integration tests still exercise their real I/O boundary.
- **Expected tests / validation:** [x] Seven affected files passed together (53 tests). [x] `npm test` passed twice consecutively under default concurrency (47 files / 475 tests each). [x] `npm run lint` passed.
- **T3 changes (2026-10-02):** `test/radio/airtime-coordinator.test.js` now checks quiet-window boundaries through its injected clock; command-queue ordering uses explicit deferred-task synchronization; radio-manager retry tests and the sampler, token-refresh, flood-advert, and reply-queue timer tests use fake timers. Per-test cleanup restores real timers and releases active resources. The reply-queue in-flight dispatch case retains a timer-driven delay to prove that a send can span multiple poll ticks; fake time controls that delay. Real socket, HTTP/SSE, and child-process waits remain unchanged.

#### T4: Add only missing high-risk failure coverage

- [x] Complete — targeted review found no distinct missing high-risk behavior; existing tests already cover the identified failure and recovery paths.
- **Objective:** Close failure-path gaps confirmed by T1 without duplicating existing coverage.
- **Specific changes:** Add focused regression tests only for distinct uncovered lifecycle, restart, radio/MQTT, queue, or persistence failures established by further targeted review. Treat existing startup-store failure ordering, clean shutdown, scheduler failure, and other demonstrated coverage as already addressed. If no gap is confirmed, record the evidence and close this task without adding tests. Tests should assert observable state, emitted events, persisted data, or externally visible effects.
- **Definition of done:** Every confirmed gap has a regression test that would fail if the behavior regressed, or the task is closed with evidence that existing coverage is sufficient. No production implementation is changed solely to improve coverage.
- **Expected tests / validation:** [x] Targeted review of existing lifecycle, restart, radio/MQTT, queue, and persistence tests found adequate coverage for the audited paths. [x] `npm run test:ci` passed (47 files / 475 tests; 72.67% statements, 72.04% branches, 74.08% functions, 73.17% lines). [x] `npm run lint` passed. PR-matrix confirmation remains dependent on the branch checks after push.
- **T4 decision (2026-10-02):** No additional test was added because the targeted review found no distinct uncovered high-risk behavior. Existing evidence includes startup-store failure ordering and shutdown (`test/index.test.js`), retry/reconnect/exhaustion behavior (`test/radio/radio-manager.test.js`), failed advert resolution and restart recovery (`test/radio/flood-advert-scheduler.test.js`, `test/metrics/store.test.js`), queue dispatch failure/expiration/restart and persisted resolution (`test/bots/reply-queue.test.js`, `test/metrics/store.test.js`), token refresh failure (`test/mqtt/token-refresh-loop.test.js`), and broker-isolated publish failure (`test/mqtt/mqtt-manager.test.js`).

### 6. Risks and Edge Cases

- Replacing a real wait with fake timers can invalidate tests that depend on operating-system scheduling, sockets, or SQLite I/O.
- Broad naming changes or `describe()` wrapping can create noisy diffs and may not improve JUnit diagnostics.
- Shared helpers can hide setup conditions or create lifecycle coupling; keep them small and resource-specific.
- Process environment and module state may be isolated by Vitest today, but tests must not rely on isolation when they mutate state within a worker or interact with external resources.
- Adding production seams or changing runtime behavior exceeds this test-quality plan; refine the plan before proceeding if an audit finding requires one.

### 7. Resolved Questions and Assumptions

- [x] **Runner:** Vitest with Istanbul is selected and implemented by Issue #10; do not preserve or introduce `node:test` or a second runner.
- [x] **Organization:** Preserve the existing domain folders and `*.test.js` convention. Do not perform a blanket rename or add unit/service/integration filename suffixes.
- [x] **Execution categories:** Keep one Vitest project and the current default execution settings. Revisit separate settings only if T1 finds a measurable environment, timeout, concurrency, or external-dependency need.
- [x] **Scope:** Make only evidence-backed reliability and diagnostic improvements. Do not duplicate behavior coverage already completed under Issues #7 and #10.
- [x] **Production code:** No production changes or new test seams are assumed. Stop and refine this plan if a demonstrated testing gap requires them.
- **Assumption:** The current domain organization remains understandable; T1 may recommend a narrow adjustment only when a concrete discovery demonstrates otherwise.

### 8. Suggested Execution Order

1. [x] T1 — establish concrete priorities and exclude already-covered behavior before editing tests.
2. [x] T2 — fix the confirmed cleanup risks in the radio-manager, flood-advert-scheduler, and metrics-server tests; focused and repeated full-suite checks passed.
3. [x] T3 — replace audit-confirmed timer waits with controlled time while preserving real I/O integration boundaries; seven affected files and two full-suite runs passed, and lint passed.
4. [x] T4 — targeted review confirmed the audited high-risk failure and recovery paths already have regression coverage; no duplicate tests were added.
