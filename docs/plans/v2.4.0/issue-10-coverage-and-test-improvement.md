# Issue #10 — Coverage tracking and test-suite improvement

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/10](https://github.com/Robotti-io/Meshcore-Observer/issues/10)

## Implementation Plan

### 1. Feature Summary

Establish repeatable coverage reporting, a source-inclusive baseline, targeted tests for high-risk behavior, and regression thresholds grounded in measured results.

### 2. Relevant Existing Architecture

- The current suite uses `node:test` and `node:assert`; `npm test` is `node --test`.
- Application modules are ESM JavaScript and Node >=22.13.0 is needed for `node:sqlite`.
- Coverage tooling is not currently declared; no coverage script or report configuration exists.
- Explicit human approval has now been given to add Vitest and `@vitest/coverage-istanbul` as development dependencies and migrate the test suite.
- The release plan's non-goal against changing frameworks merely to obtain coverage is resolved: this migration is approved as the selected v2.4.0 test and coverage stack, with the goals and acceptance criteria below.

### 3. Proposed Approach

Migrate the existing suite to Vitest and use `@vitest/coverage-istanbul` for Istanbul coverage. Configure explicit inclusion of every `src/**/*.js` file so unimported application files appear at zero coverage. Require JUnit, HTML, LCOV, and JSON artifacts; produce Cobertura XML as the preferred CI coverage format, subject to a clean integration in issue #9. Preserve test names and assertions where practical, verify migration parity, and support the repository's Windows and Linux CI matrix on Node >=22.13.0. Measure the initial baseline before adding coverage-driven tests, review risk-level gaps, then set thresholds after the improvement pass.

### 4. Impacted Areas

- `package.json`, `package-lock.json`, a runner/coverage config file (if selected), `.gitignore`.
- `test/**`, especially config rejection, lifecycle, migration/restart, repeat timeout, scheduler recovery, MQTT multi-broker failures.
- CI artifacts in issue #9 and documentation/coverage baseline record.

### 5. Task Breakdown

#### T1: Select and approve the measurement stack — resolved

- [x] Task complete.

- **Objective:** Choose a maintainable runner/coverage path consistent with policy.
- **Specific changes:** Use Vitest as the test runner and `@vitest/coverage-istanbul` as the provider; both dependency additions and the framework migration are approved.
- **Definition of done:** [x] Framework, provider, and dependency governance are explicitly selected; the release non-goal is scoped to prohibit unapproved framework changes and no longer conflicts with this approved migration.
- **Expected tests / validation:** Validate the selected versions and report outputs during T2; no separate tool comparison is required.

#### T2: Configure deterministic local reports — implemented; Linux CI validation pending

- [x] Local tooling, reports, and Windows validation complete.

- **Objective:** Produce complete, reproducible results.
- **Specific changes:** Add compatible, matching Vitest and `@vitest/coverage-istanbul` versions plus package scripts/config for one-shot tests, watch mode, coverage, JUnit, LCOV, JSON, and HTML; explicitly include every `src/**/*.js` file. Configure Cobertura XML if it integrates cleanly with CI.
- **Definition of done:** [x] Documented commands create the agreed artifacts; all `src/**/*.js` files are included without source exclusions.
- **Expected tests / validation:** [x] Windows report runs completed twice with identical test counts and coverage totals; representative JUnit, JSON, HTML, LCOV, and Cobertura outputs were inspected, including an unimported source file. [ ] Repeat on Linux in the issue #9 CI matrix.
- **Progress:** Migrated all 47 test files to Vitest while preserving test names and assertions; configured `npm test`, `npm run test:watch`, `npm run test:coverage`, and `npm run test:ci`. Added local artifact guidance to the README. Windows validation on 2026-10-02 with Node v24.18.0: 47 files / 470 tests passed; lint passed; both coverage runs reported 69.74% statements, 69.22% branches, 71.09% functions, and 70.23% lines. JUnit contains 470 test cases. Coverage JSON includes all 56 source files; `src/web/client/dashboard.js` appears at 0% as expected. The initial baseline remains T3 work and these verification totals are not yet recorded as the official baseline.

#### T3: Measure and improve high-risk coverage — completed

- [x] Task complete.

- **Objective:** Turn reports into operational confidence.
- **Specific changes:** Record line/statement/function/branch baseline; inspect source-level gaps; prioritize error/recovery paths, config boundaries, persistence migrations, lifecycle transitions, scheduler and reply behavior.
- **Definition of done:** Baseline is documented and targeted behavioral tests close the agreed risk gaps.
- **Expected tests / validation:** Confirm selected regression tests fail before their associated fix when applicable, then pass; retain coverage output.
- **Initial baseline (pre-improvement):** Captured 2026-10-02 at 11:04 America/New_York with `npm run test:coverage`, Node v24.18.0, branch `release-v2_4_0`, HEAD `c5e5d88a141b959633c11aedae416930e8e5b845`. Results: 69.74% statements (1715/2459), 69.22% branches (785/1134), 71.09% functions (332/467), and 70.23% lines (1647/2345); 47 test files / 470 tests passed. The working tree was dirty with T2 implementation and documentation changes; HEAD is recorded as the base commit, and the baseline includes those working-tree changes. No risk-driven tests had been added.
- **Progress:** Coverage review found two high-risk gaps selected for targeted tests: startup must stop before radio/network activity when the required SQLite store cannot open, and failed scheduled flood adverts must be resolved and logged without being counted as sent. The reply-queue quiet-window assertion was made deterministic with Vitest fake timers after a pre-baseline run intermittently observed 29 ms against its 30 ms boundary; no production code changed for that stabilization.
- **Targeted tests:** Added an isolated entrypoint test proving an unopenable SQLite store exits before the TCP radio transport starts, and a scheduler test proving a failed flood-advert command is logged, resolved as idle/unsent, and does not enter an immediate retry loop. No production behavior change was needed. The entrypoint check runs in a child process to isolate startup side effects, so its source execution is not included in Vitest's parent-process coverage counters; it provides behavioral protection while those lines remain uncovered in the report.
- **Post-improvement baseline:** Captured 2026-10-02 at 11:09 America/New_York with `npm run test:ci`, Node v24.18.0, branch `release-v2_4_0`, HEAD `c5e5d88a141b959633c11aedae416930e8e5b845`. Results: 69.82% statements (1717/2459), 69.31% branches (786/1134), 71.09% functions (332/467), and 70.31% lines (1649/2345); 47 test files / 472 tests passed. The working tree remained dirty with T2/T3 changes, so HEAD is the base commit rather than a commit containing the measured changes. Linux validation remains pending in issue #9 CI.

#### Pre-T4 review — `src/web` and `src/web/client` coverage

- `src/web/client/dashboard-logic.js` is fully covered (55/55 statements, 41/41 branches, 17/17 functions). Existing tests focus on its DOM-free formatting, range, and response-shaping functions.
- `src/web/client/dashboard.js` is 0% covered (553 statements, 222 branches, 87 functions). It is a browser ES module; current tests verify that the server serves it and that the HTML references it, but do not execute its DOM, fetch, chart, navigation, or SSE interactions. README already documents this limitation.
- `src/web/metrics-server.js` is the main server-side gap: 173/252 statements (68.7%), 73/117 branches (62.4%), and 18/32 functions (56.3%). No test directly exercises `/api/metrics/dashboard`, whose overview/comparison path aggregates packet, reply, broker, and repeater data. The route's packets, brokers, bots, and repeaters views also lack direct endpoint coverage. Existing tests cover separate legacy endpoints, not this aggregate orchestration.
- The SSE tests verify the initial snapshot and abrupt client disconnect. They do not verify sampler-driven snapshot broadcasts or server-side cleanup after a client write error. Other web helpers are at or near full statement coverage; the remaining missed branches in `metrics-sample.js`, `packet-type-buckets.js`, and `schemas.js` are narrower follow-ups.
- **Recommendation:** Add focused HTTP tests for the aggregate dashboard route, especially overview trends/comparison and each supported view. Then test sampler-driven SSE updates and client error cleanup. Treat browser interaction coverage as a separate test-design decision: select a browser/DOM harness only after confirming it fits the no-unapproved-dependencies rule and supported CI matrix. Do not exclude `dashboard.js` from measurement merely to improve the headline percentage.

#### T3.5: Cover aggregate dashboard routes and live SSE updates — completed

- [x] Task complete.

- **Objective:** Improve meaningful coverage of the dashboard server orchestration paths identified in the pre-T4 review, using the existing Node/Vitest stack and without adding dependencies.
- **Specific changes:** Add HTTP tests for the overview route's persisted-data aggregation and prior-period trends, the no-comparison case, and each supported dashboard view (`packets`, `brokers`, `bots`, and `repeaters`). Add an SSE test proving a sampler `sample` event is broadcast to a connected client; cover client error cleanup if it can be reproduced deterministically through the existing HTTP seam without production-only test hooks.
- **Definition of done:** Aggregate dashboard response shapes and window/trend behavior are asserted against seeded `MetricsStore` data; all supported views have direct endpoint coverage; sampler-driven SSE updates are verified; plans record the resulting validation and coverage change. Keep `dashboard.js` included in measurement and defer selecting a browser interaction harness.
- **Expected tests / validation:** [x] Focused `test/web/metrics-server.test.js` passed (40 tests); full `npm run test:ci` passed (47 files / 475 tests); `npm run lint` passed.
- **Progress:** Added seeded-data HTTP coverage for overview packet/reply/broker/repeater aggregation and previous-period trends, the all-time no-comparison case, and the packets, brokers, bots, and repeaters views. Added an SSE test that emits a sampler `sample` event and verifies the connected client receives the follow-up snapshot. The existing abrupt-disconnect test continues to verify close cleanup. The separate server-response `error` handler was not forced: the public HTTP seam does not expose the server-side response object, and adding a production test hook solely to emit that internal event would expand scope without improving the real connection-level contract. T3.5 raises `metrics-server.js` from 173/252 statements (68.7%), 73/117 branches (62.4%), and 18/32 functions (56.3%) to 240/252 statements (95.2%), 104/117 branches (88.9%), and 30/32 functions (93.8%). Full-suite coverage is now 72.67% statements, 72.04% branches, 74.08% functions, and 73.17% lines (1787/2459, 817/1134, 346/467, and 1716/2345 respectively). `dashboard.js` remains included at 0% pending a separately scoped browser-harness decision.

#### T4: Set regression thresholds and CI artifacts — completed; upload pending Issue #9 implementation

- [x] Threshold enforcement and failure-report generation complete; CI artifact upload is deferred to issue #9.

- **Objective:** Prevent coverage regression without arbitrary targets.
- **Specific changes:** Set global thresholds at 72% statements, 71% branches, 73% functions, and 70% lines. The human selected a 70% line floor after the first four-entry CI matrix reported 72.96%; the other floors remain unchanged. Keep every `src/**/*.js` file included. Document that exclusions and threshold changes need a code-review rationale based on measured coverage and meaningful tests. Configure `reportOnFailure` so JUnit and coverage reports are generated when tests or thresholds fail.
- **Definition of done:** `npm run test:ci` enforces all four floors and a below-threshold run fails while retaining the configured reports. Local behavior is verified; uploading those reports from CI is assigned to Issue #9's workflow implementation.
- **Expected tests / validation:** [x] Normal `npm run test:ci` passed locally at 72.67% statements, 72.04% branches, 74.08% functions, and 73.17% lines. [x] After setting the line floor to 70%, `npm run test:ci` passed locally again; `npm run lint` passed. [x] An intentional 100% statement override failed with the expected threshold error; JUnit, HTML, LCOV, JSON, and Cobertura files remained present. [x] Initial Issue #9 PR matrix completed all tests but exposed the 73% line floor as too high at 72.96%. [ ] Verify the agreed floor in a green CI matrix. [ ] Verify CI artifact upload after Issue #9 implements it.
- **Progress:** `vitest.config.js` enforces 72% statements, 71% branches, 73% functions, and the human-selected 70% line floor, retaining `reportOnFailure`; README records the thresholds. The initial Issue #9 PR matrix reported 72.96% lines; the line floor was set to 70% while retaining all source files and the other three floors. Local `npm run test:ci` and lint pass; a green CI rerun remains pending. CI artifact upload remains assigned to Issue #9 T3.

### 6. Risks and Edge Cases

- A runner migration can create churn or obscure behavior changes; preserve assertions and compare test counts and names to control that risk.
- Generated coverage for unimported modules depends on provider support and explicit include configuration.
- SQLite, hardware-adjacent simulations, and environment-mutating tests may reveal concurrency or platform constraints.
- JUnit and coverage XML are distinct outputs and must not be conflated.

### 7. Resolved Questions / Assumptions

- [x] Vitest migration and the `vitest` plus `@vitest/coverage-istanbul` development dependencies are explicitly approved by the human. The release non-goal is narrowed to avoid unapproved runner changes; issue #10 is the approved exception.
- [x] Required outputs are `artifacts/junit.xml`, `coverage/index.html`, `coverage/lcov.info`, and `coverage/coverage-final.json`. Cobertura XML is preferred for CI interoperability but is not a release blocker if issue #9 uses the required reports successfully. Test-result XML and coverage XML remain separate artifacts.
- [x] Capture the initial baseline after the migration/configuration is stable and before risk-driven test additions. Record date, branch, exact commit SHA, Node version, command, and line/statement/function/branch totals. Record a second post-improvement baseline; use that commit as the reference for threshold selection.
- [x] Do not choose numeric thresholds before the post-improvement baseline. Establish minima at or near measured results, based on useful regression protection rather than a round target.
- [x] Run the same test and coverage configuration on supported Windows and Linux CI jobs; keep Node >=22.13.0 as the runtime floor.

### 8. Suggested Execution Order

1. [x] T1 — Vitest/Istanbul stack and dependency approval resolved.
2. [x] T2 — migrate/configure the suite and produce repeatable artifacts on Windows; Linux confirmation remains with the issue #9 CI matrix.
3. [x] T3 — record pre- and post-improvement baselines; add tests for startup store-failure ordering and flood-advert send failure.
4. [x] T3.5 — cover aggregate dashboard routes and live SSE updates.
5. [x] T4 — record the improved baseline and enforce coverage floors; CI artifact upload is assigned to Issue #9 workflow implementation.
