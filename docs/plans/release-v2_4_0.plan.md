# v2.4.0 — Stabilization, Operational Hardening, and Test Confidence

## Summary

v2.4.0 will focus on improving the reliability, observability, configuration safety, test confidence, and maintainability of MeshCore Observer following the rapid feature development through v2.3.0.

The goal of this release is not to significantly expand the application's feature surface. Instead, it should validate and strengthen the systems already in place: reply handling, repeat confirmation, persisted state, metrics, MQTT configuration, automated testing, and long-running operation.

The application is currently operating successfully in local deployment. This release should use that real-world runtime experience to identify and remove edge cases before further major functionality is added.

---

## Goals

- Make bot reply repeat-confirmation metrics accurately reflect timeout behavior.
- Improve confidence in long-running observer operation.
- Establish automated CI for linting, testing, and coverage tracking.
- Establish a measurable test-coverage baseline and improve meaningful coverage.
- Strengthen testing around failure, recovery, migration, and lifecycle behavior.
- Reduce configuration risks around MQTT credentials.
- Establish cleaner internal seams before additional bot command kinds are introduced.
- Improve repository/release hygiene without introducing unnecessary breaking changes.
- Keep v2.4.0 backwards-compatible with existing v2.3.x deployments wherever practical.

---

## 1. Reply Repeat Confirmation — Timeout Semantics

**GitHub Issue Link:** [https://github.com/Robotti-io/Meshcore-Observer/issues/7](https://github.com/Robotti-io/Meshcore-Observer/issues/7)

In the v2.3.0 implementation, `RepeatCheckTracker` discovered expired repeat checks lazily when another tracker operation occurred, such as:

- registering another sent reply; or
- checking a newly received channel message for a matching repeat.

The issue #7 implementation now adds `sweepExpired()` and one application-wide, unreferenced timer with a fixed one-second cadence for all enabled bots. The configured timeout remains the full confirmation window; the sweep only bounds the additional delay before timeout accounting. Capacity-evicted checks are logged separately and do not increment `repeatsUnconfirmed`. Implementation and regression-test authoring are complete; `npm.cmd run lint` passed and `npm.cmd test` passed (469 tests, 0 failures), including an application-shutdown wiring assertion.

### 1.1 Proposed changes

- [x] Add `sweepExpired()` to `RepeatCheckTracker`.
- [x] Process expired checks independently of new channel traffic.
- [x] Invoke the sweep from one application-wide, unreferenced one-second timer; no per-reply timers are created.
- [x] Ensure expired checks increment `repeatsUnconfirmed` at most once.
- [x] Ensure confirmed checks cannot later become unconfirmed.
- [x] Review behavior at the tracker's maximum pending-entry count.
- [x] Decide capacity-evicted checks are excluded from `repeatsUnconfirmed` and reported through a separate warning.
- [x] Add regression tests for timeout expiration without another RF packet or outbound reply, confirmation, duplicate entries, and capacity eviction.
- [x] Run the affected tests and full test suite; `npm.cmd test` passed with 469 tests and 0 failures.
- [x] Verify the application shutdown path stops the sweeper; the `SIGINT` entrypoint test passed.

### 1.2 Acceptance criteria

- [x] A sent reply becomes `unconfirmed` shortly after its configured repeat-check timeout even if no additional channel traffic occurs.
- [x] A successfully confirmed reply is counted once and never expires afterward.
- [x] Pending repeat checks remain memory-bounded.
- [x] No per-reply timer explosion is introduced.
- [x] Repeat tracking remains diagnostic only and cannot block or delay reply transmission.
- [x] Automated regression tests pass; `npm.cmd test` passed with 469 tests and 0 failures.
- [x] Verify the application shutdown path stops the sweeper; the `SIGINT` entrypoint test passed.

---

## 2. Repeat-Check Configuration Consistency

**GitHub Issue Link:** [https://github.com/Robotti-io/Meshcore-Observer/issues/8](https://github.com/Robotti-io/Meshcore-Observer/issues/8)

The documented/example repeat-check value matches the application's 10-second default. The timeout starts after a reply is sent; it is separate from the 60-second TTL for replies waiting unsent in the queue. A configured value of `0` is valid and means immediate timeout, reported on the next tracker sweep or operation.

### 2.1 Proposed changes

- [x] Establish one canonical default for `PACKETCAPTURE_BOT_REPLY_REPEAT_CHECK_MS`: 10000 ms.
- [x] Update `.env.example`, runtime and `ChannelBot` fallbacks, tests, and README to agree.
- [x] Document that the timeout starts after a reply is sent and what zero means.
- [x] Confirm `0` remains valid and means immediate timeout.
- [x] Add configuration coverage for the default and zero; add tracker coverage for immediate expiration.

### 2.2 Acceptance criteria

Running with no explicit environment variable and running from a freshly copied `.env.example` should produce intentionally equivalent repeat-check behavior unless explicitly documented otherwise.

Implementation and validation are complete: the local coverage suite passed all 47 files / 475 tests, `npm.cmd run lint` passed, and the four-entry PR matrix passed on the agreed 70% line-coverage floor.

---

## 3. Continuous Integration

**GitHub Issue Link:** [https://github.com/Robotti-io/Meshcore-Observer/issues/9](https://github.com/Robotti-io/Meshcore-Observer/issues/9)

The Issue #10 test/coverage tooling dependency is complete. Issue #9 will use its `npm run test:ci` script and enforced thresholds.

The repository already has substantial automated test coverage. v2.4.0 should make those checks an enforced part of normal development.

### 3.1 GitHub Actions workflow

The CI platform and policy are resolved:

- [x] Use GitHub Actions for CI validation; the user explicitly overrode the conflicting GitLab-template instruction for this repository.
- [x] Trigger on pull requests targeting `main` and pushes to `main` only.
- [x] Use GitHub-hosted Ubuntu and Windows runners with Node 22.x and 24.x in the test matrix.
- [x] Make the checks required for pull requests to `main` after the matrix and failure-artifact path are validated.

Implement separate lint and coverage-test jobs so a lint failure does not prevent test reports from being generated. Keep deployment, image builds, and publishing out of this validation workflow.

For the agreed triggers (workflow implementation added in `.github/workflows/ci.yml`; the initial PR matrix ran all tests but exposed an overly high line threshold):

- [x] Define the lint job on Ubuntu with Node 24.x: install the selected Node line, run `npm ci`, then `npm run lint`.
- [x] Define the test job as a four-entry matrix: `ubuntu-latest` and `windows-latest`, each on Node 22.x and 24.x; each entry runs `npm ci` and `npm run test:ci` (tests plus threshold-enforced coverage).
- [x] Set workflow permissions to `contents: read`; the tests require no secrets or external service credentials.
- [x] Initial temporary-PR run executed all four matrix entries and all 475 tests passed; the reported 72.96% line coverage failed the 73% floor.
- [x] Confirm the agreed 70% line floor passes in all four PR matrix entries; all 475 tests pass in each entry.
- [ ] Validate the push-to-main run after merge.
- [x] Add an unconditional, uniquely named artifact upload for JUnit, Cobertura, LCOV, JSON, and HTML reports from each matrix entry.
- [x] Leave retention at GitHub's configured default.
- [x] Verify the successful PR run uploaded four non-empty matrix-specific report artifacts.
- [x] Verify locally that the intentional 100% statement-threshold failure occurs after all 475 tests pass and all five report files are generated.
- [x] Verify GitHub Actions uploaded four non-empty matrix artifacts on intentionally failing coverage run 37040249927.
- [ ] Configure the lint and matrix check statuses as required for PRs to `main` after artifact validation.
- [x] Document CI triggers, runner/Node matrix, commands, report paths, artifact naming, planned required check names, and matrix maintenance guidance in README.

### 3.2 Platform coverage

The test matrix covers both supported operating systems and both selected Node lines:

- [x] Run the core test suite on Windows; all 475 tests pass in the matrix.
- [x] Run the core test suite on Linux; all 475 tests pass in the matrix.
- [x] Run the core test suite on Node 22.x; all 475 tests pass in the matrix.
- [x] Run the core test suite on Node 24.x; all 475 tests pass in the matrix.
- [ ] Identify tests that are genuinely platform-specific rather than weakening the entire test matrix.
- [x] Confirm `node:sqlite` behavior under both CI environments through the passing full-suite matrix.

Optional:

- [ ] Add dependency caching if it provides a meaningful CI speed improvement.
- [ ] Add a visible build/test status badge to the README after the workflow is stable.
- [ ] Integrate an external coverage-reporting service later only if it provides useful history or pull-request feedback beyond the repository's own CI.

### 3.3 Acceptance criteria

Every pull request targeting `main` receives automated lint, test, and coverage status. After successful full-matrix and failure-artifact validation, configure those stable checks as required branch-protection statuses for `main`.

---

## 4. Test Coverage Tracking and Test-Suite Improvement

**GitHub Issue Link:** [https://github.com/Robotti-io/Meshcore-Observer/issues/10](https://github.com/Robotti-io/Meshcore-Observer/issues/10)

v2.4.0 should establish a mature, repeatable testing and coverage workflow that can be used locally and in CI.

The objective is not simply to maximize a repository-wide coverage percentage.

The objective is to make test quality measurable, identify operationally important code paths that are currently exercised only in production or manual testing, and produce standardized test and coverage artifacts that can be consumed by CI/CD and automated reporting systems.

Particular attention should be paid to error handling, restart recovery, migrations, persistence boundaries, scheduling, lifecycle transitions, and other behavior that becomes important during long-running unattended operation.

### 4.1 Testing and coverage stack

Adopt **Vitest** as the project's test runner and **Istanbul coverage through `@vitest/coverage-istanbul`** as the coverage provider.

This provides:

- a mature test runner with first-class Node.js and ESM support;
- deterministic unit and integration test execution;
- built-in JUnit test reporting;
- Istanbul-compatible line, function, statement, and branch coverage;
- HTML coverage reports for local inspection;
- standardized machine-readable coverage artifacts for CI;
- configurable coverage thresholds;
- room to add more advanced CI reporting later without changing the test framework again.

The Vitest migration and both development dependencies are explicitly approved for v2.4.0. This is the approved exception to the non-goal against framework changes made only to obtain coverage; the migration also standardizes test execution, JUnit reporting, and the coverage workflow.

**Issue #10 progress (2026-10-02):** The suite now runs under Vitest with Istanbul. `npm test`, `npm run test:watch`, `npm run test:coverage`, and `npm run test:ci` are configured and documented in the README. Windows T2 validation on Node v24.18.0 passed twice at 47 test files / 470 tests, with matching results: 69.74% statement, 69.22% branch, 71.09% function, and 70.23% line coverage. JUnit, HTML, LCOV, JSON, and Cobertura artifacts were generated; coverage includes all 56 source files, including the unimported dashboard entry point at zero coverage. Lint passed. T3 recorded the initial baseline against base commit `c5e5d88a141b959633c11aedae416930e8e5b845` before risk-driven test additions, then added regression tests for SQLite startup failure ordering and failed flood-advert handling. The entrypoint test runs in a child process for isolation, so the parent Vitest coverage counters do not include its startup lines even though the behavior is asserted. The post-improvement Windows run passed 47 files / 472 tests at 69.82% statement, 69.31% branch, 71.09% function, and 70.31% line coverage. The working tree was dirty for both baselines; the recorded SHA identifies the base commit, not a commit containing the T2/T3 work. Linux validation remains for the issue #9 CI matrix. **Pre-T4 web review and T3.5 result:** `dashboard-logic.js` is fully covered, while browser-side `dashboard.js` remains at 0% because no browser interaction harness runs in the Node suite; it remains included in measurement pending a separate harness decision. Added seeded-data HTTP tests for aggregate overview data and comparison trends, no-comparison all-time behavior, and each of the packets, brokers, bots, and repeaters views. Added coverage for sampler-driven SSE updates. The server-response `error` callback could not be triggered deterministically through the public HTTP seam without adding a production test hook; abrupt disconnect cleanup remains covered. `metrics-server.js` increased from 68.7% statements / 62.4% branches / 56.3% functions to 95.2% / 88.9% / 93.8%. The full Windows suite and lint pass: 47 test files / 475 tests; repository coverage is 72.67% statements, 72.04% branches, 74.08% functions, and 73.17% lines. Linux validation remains with the issue #9 CI matrix.

**Issue #9 T2/T3 follow-up (2026-10-02):** The temporary PR matrix passed all four Ubuntu/Windows × Node 22.x/24.x entries after setting the line threshold to 70%; all 475 tests passed in each entry. Successful run [37036741298](https://github.com/Robotti-io/Meshcore-Observer/actions/runs/37036741298) lists four matrix-specific report artifacts (109–110 KB each). The intentionally failing threshold run [37040249927](https://github.com/Robotti-io/Meshcore-Observer/actions/runs/37040249927) failed all four coverage jobs while preserving four non-empty matrix-specific artifacts. Both artifact paths are confirmed; configuring required PR statuses remains pending.

**T4 (2026-10-02):** `vitest.config.js` enforces global minimums of 72% statements, 71% branches, 73% functions, and 70% lines across all `src/**/*.js` files. The initial Issue #9 PR matrix ran all 475 tests in each entry, but its reported 72.96% line coverage missed the prior 73% floor. At the human's direction, the line floor is now 70%; the other floors and full source inclusion remain unchanged. The green four-entry CI rerun is recorded below. README documents the thresholds and review policy. A normal local `npm run test:ci` passed at 72.67% / 72.04% / 74.08% / 73.17%; an intentional 100% statement override failed as expected, and JUnit, HTML, LCOV, JSON, and Cobertura files remained available after the failure. Successful and intentionally failing GitHub runs both uploaded the expected four matrix artifacts; required PR statuses remain to be configured under Issue #9 T3.

**Issue #10 task status:**

- [x] T1 — select Vitest and Istanbul coverage tooling.
- [x] T2 — configure deterministic local tests and reports; the four-entry Linux/Windows × Node 22/24 CI matrix passed.
- [x] T3 — record baselines and add high-risk regression coverage.
- [x] T3.5 — add aggregate dashboard-route and sampler-driven SSE coverage.
- [x] T4 — enforce the measured coverage floors and verify report generation after threshold failure.
- [x] Validate the test and coverage suite on Linux through the Issue #9 PR matrix.
- [x] Verify successful-run and intentionally failing-run artifact uploads.
- [ ] Require and verify the stable CI checks for pull requests to `main` after artifact validation.

The approved `vitest` and `@vitest/coverage-istanbul` development dependencies are installed, and the existing suite has been migrated while preserving its test names and behavioral assertions. Issue #9 should reuse these scripts and should not add another test framework or coverage dependency.

### 4.2 Standard test artifacts

The automated test run should produce separate artifacts for test execution and source coverage.

#### 4.2.1 Test results

Produce:

```text
artifacts/junit.xml
```

This file should contain JUnit-compatible test execution results, including:

- test suites;
- individual test cases;
- failures;
- skipped tests;
- execution duration.

This artifact can be consumed by GitHub Actions or other CI/CD systems that understand JUnit XML.

#### 4.2.2 Coverage results

Produce coverage artifacts under:

```text
coverage/
```

At minimum:

```text
coverage/index.html
coverage/lcov.info
coverage/coverage-final.json
```

Also produce an XML coverage artifact suitable for automated coverage reporting where supported, preferably:

```text
coverage/cobertura-coverage.xml
```

Cobertura XML is the preferred CI coverage format where it integrates cleanly; it is not a release blocker if issue #9 can consume the required LCOV, JSON, and HTML coverage outputs. It remains distinct from the JUnit test-results XML.

JUnit XML and coverage XML serve different purposes and should remain separate:

```text
artifacts/junit.xml              test execution results
coverage/cobertura-coverage.xml source coverage results
coverage/lcov.info              source coverage interchange format
coverage/index.html             human-readable coverage report
```

CI should retain these files as build artifacts even when a test run fails, where the CI platform allows it.

### 4.3 Proposed package scripts

Establish explicit commands for local development and CI:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:ci": "vitest run --coverage"
  }
}
```

`npm test` should remain the normal deterministic one-shot test command rather than starting watch mode.

`npm run test:watch` should be available for interactive development.

`npm run test:coverage` should generate the complete local coverage report.

`npm run test:ci` should use the same underlying tests and coverage configuration used locally so CI does not exercise a materially different testing path.

### 4.4 Proposed Vitest configuration

Introduce a repository-level Vitest configuration, for example:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',

    reporters: [
      'default',
      ['junit', {
        outputFile: 'artifacts/junit.xml'
      }]
    ],

    coverage: {
      enabled: false,
      provider: 'istanbul',

      include: [
        'src/**/*.js'
      ],

      exclude: [
        'test/**',
        'coverage/**',
        'artifacts/**'
      ],

      reportsDirectory: 'coverage',

      reporter: [
        'text',
        'text-summary',
        'html',
        'lcov',
        'json',
        'cobertura'
      ]
    }
  }
});
```

The final configuration should also generate Cobertura-compatible XML if supported cleanly by the selected Istanbul reporter configuration.

Explicitly setting `coverage.include` is important so untested application files appear as uncovered rather than disappearing from the coverage calculation simply because no test imported them.

Do not exclude difficult application code merely to improve the reported percentage.

### 4.5 Migration from `node:test`

The project already has a substantial automated test suite. Migration to Vitest should preserve that investment rather than becoming a broad rewrite.

Work should include:

- [ ] Install Vitest and `@vitest/coverage-istanbul`.
- [ ] Add `vitest.config.js`.
- [ ] Migrate existing `node:test` imports and assertions where necessary.
- [ ] Preserve existing test names and behavioral assertions where practical.
- [ ] Verify temporary databases, timers, event emitters, sockets, and other resources still clean up correctly under Vitest.
- [ ] Verify tests remain independent of execution order.
- [ ] Verify no previously passing test is silently removed or skipped during migration.
- [ ] Compare pre-migration and post-migration test counts.
- [ ] Run the complete migrated suite repeatedly to identify concurrency or lifecycle assumptions exposed by the new runner.
- [ ] Avoid changing production behavior solely to make the framework migration easier.

The migration should be considered complete only when there is confidence that the new suite exercises at least the same behavior as the existing suite.

### 4.6 Establish the coverage baseline

After the Vitest migration and report configuration are stable:

- [ ] Run the complete suite with Istanbul coverage enabled and record an initial baseline before adding coverage-driven tests.
- [ ] Record the initial repository baseline.
- [ ] Record:
  - line coverage;
  - statement coverage;
  - function coverage;
  - branch coverage.
- [ ] Review coverage by source file rather than relying only on repository totals.
- [ ] Identify completely uncovered source files.
- [ ] Identify files with high line coverage but poor branch coverage.
- [ ] Identify error and recovery paths that remain untested.
- [ ] Preserve the initial coverage reports as CI artifacts.
- [ ] Document the baseline in the v2.4 development issue or associated pull request, including date, branch, exact commit SHA, Node version, command, and metric totals.

Record a second, post-improvement baseline before setting thresholds. Use the tested commit SHA as the stable reference; branch names alone are not durable.

### 4.7 Do not initially optimize for a headline percentage

Avoid immediately imposing an arbitrary target such as 90% repository-wide coverage.

Instead:

1. establish the real baseline;
2. inspect file and branch-level gaps;
3. identify operationally significant uncovered behavior;
4. add meaningful tests around those behaviors;
5. establish thresholds near the resulting baseline;
6. prevent regressions;
7. raise thresholds gradually as the suite improves.

Coverage should become a regression guard, not an incentive to create low-value tests.

A module with 95% line coverage but an untested recovery path may represent substantially more operational risk than a simple utility with 70% coverage.

### 4.8 Coverage enforcement

After the initial baseline and targeted improvement pass:

- [x] Establish minimum line coverage: 70%.
- [x] Establish minimum statement coverage: 72%.
- [x] Establish minimum function coverage: 73%.
- [x] Establish minimum branch coverage: 71%.
- [x] Configure Vitest/Istanbul to enforce those thresholds.
- [x] Ensure the `test:ci` command fails when coverage falls below the agreed thresholds; the GitHub Actions matrix is implemented and the PR matrix passes.
- [x] Prefer thresholds that prevent regression rather than arbitrary aspirational numbers; the human selected a 70% line floor after observing 72.96% in CI, retaining the other floors and all source files.
- [ ] Consider stricter thresholds for high-risk modules once their suites mature.
- [ ] Document intentionally unreachable or platform-specific code rather than silently excluding it.
- [x] Require a code-review rationale for any proposed coverage exclusion; no source files are excluded.

Thresholds should initially be set only after the actual v2.4 baseline has been measured.

### 4.9 CI artifact requirements

Each CI test execution should publish or preserve, where supported:

```text
artifacts/junit.xml
coverage/cobertura-coverage.xml
coverage/lcov.info
coverage/coverage-final.json
coverage/index.html
```

These artifacts provide different views of the same test execution:

| Artifact                 | Purpose                                  |
| ------------------------ | ---------------------------------------- |
| `junit.xml`              | Automated test-result reporting          |
| `cobertura-coverage.xml` | Machine-readable coverage reporting      |
| `lcov.info`              | Coverage interchange / external analysis |
| `coverage-final.json`    | Raw Istanbul coverage data               |
| HTML report              | Human investigation                      |

The CI workflow should upload reports even when coverage thresholds or tests fail where technically possible, so failed builds remain diagnosable.

**Current status:** The local runner is configured with `reportOnFailure`, and report generation after an intentional threshold failure was verified. The user selected GitHub Actions with pull-request-to-`main` and push-to-`main` triggers, an Ubuntu/Windows matrix on Node 22.x/24.x, and required checks after validation. Issue #9 T2 has implemented the workflow; the four-entry PR matrix passes with the agreed 70% line floor. T3's successful and intentionally failing runs both uploaded four matrix-specific artifact bundles; required-check configuration remains pending.

### 4.10 Pull-request reporting

Investigate presenting test and coverage information directly during pull-request review.

Possible future capabilities include:

- test failures summarized in the CI interface;
- overall coverage change;
- changed-file coverage;
- newly uncovered lines or branches;
- coverage regression warnings;
- links to downloadable HTML reports.

External reporting services should remain optional.

The repository should retain enough native artifacts that coverage information is not dependent on a third-party service remaining available.

### 4.11 Coverage priorities

Prioritize uncovered code according to operational risk.

#### 4.11.1 Highest priority — failure and recovery paths

- [ ] SQLite open/migration failures.
- [ ] Interrupted migration behavior.
- [ ] Reply persistence across restart.
- [ ] Reply expiry after downtime.
- [ ] Failed reply dispatch.
- [ ] Failed reply-state resolution.
- [ ] MQTT connection and reconnection failures.
- [ ] Individual broker failure while other brokers remain healthy.
- [ ] Radio disconnect/reconnect behavior.
- [ ] Failed radio commands.
- [ ] Flood-advert interrupted-attempt recovery.
- [ ] Shutdown while work is queued or in flight.
- [ ] Metrics server startup failure.
- [ ] Dashboard handler failure isolation.

Where possible, tests should reproduce the actual failure rather than only asserting that an error handler function can be called.

#### 4.11.2 High priority — state machines and lifecycle transitions

- [ ] `pending → sent`
- [ ] `pending → failed`
- [ ] `pending → expired`
- [ ] repeat `pending → confirmed`
- [ ] repeat `pending → unconfirmed`
- [ ] radio disconnected → connected
- [ ] MQTT disconnected → connected
- [ ] flood advert idle → pending → attempting → resolved
- [ ] clean shutdown and subsequent restart

Tests should verify both resulting state and significant side effects.

For state machines, branch coverage is particularly important because a high line-coverage figure can conceal untested transitions.

#### 4.11.3 High priority — boundaries and invariants

- [ ] Strict configuration parsing.
- [ ] AJV rejection of unknown or contradictory fields.
- [ ] Bot command-kind validation.
- [ ] MQTT auth-method invariants.
- [ ] Message byte limits and overflow behavior.
- [ ] Packet deduplication boundaries.
- [ ] `minHops` behavior before dedup acceptance.
- [ ] Verified vs. unverified node adverts.
- [ ] Prefix lookup ambiguity behavior.
- [ ] Stats range boundary behavior.

Tests should include both valid and invalid inputs where an invariant is enforced.

#### 4.11.4 Medium priority — time-dependent behavior

Time-dependent components should use injected clocks or fake timers wherever practical rather than real sleeps.

Review tests for:

- [ ] reply TTL;
- [ ] quiet-air windows;
- [ ] repeat-confirmation timeout;
- [ ] flood-advert interval;
- [ ] token refresh;
- [ ] metrics ranges;
- [ ] retention pruning;
- [ ] relative repeater age.

Prefer deterministic clock advancement over waiting for wall-clock time.

Use Vitest fake timers where they accurately represent the component being tested. Continue using explicitly injected clocks where doing so keeps domain behavior clearer and less coupled to the testing framework.

#### 4.11.5 edium priority — persistence/query correctness

Add focused boundary tests around:

- [ ] empty databases;
- [ ] single sample;
- [ ] exact start boundary;
- [ ] exact end boundary;
- [ ] large retained histories;
- [ ] custom time ranges;
- [ ] `"all"` ranges;
- [ ] newly discovered and subsequently re-heard nodes;
- [ ] zero-result aggregates;
- [ ] multiple bots with overlapping command names;
- [ ] multiple MQTT brokers with mixed outcomes.

Database tests should use isolated temporary stores and should not depend on test ordering or shared persistent files.

### 4.12 Test quality review

Coverage improvements should be accompanied by improvements to the quality of the suite itself.

Review tests for:

- [ ] assertions that test observable behavior rather than implementation details;
- [ ] meaningful negative/error cases;
- [ ] deterministic time handling;
- [ ] leaked event listeners;
- [ ] leaked timers;
- [ ] unclosed SQLite databases;
- [ ] unclosed sockets;
- [ ] shared mutable fixtures;
- [ ] execution-order dependencies;
- [ ] excessive mocking that prevents real integration behavior from being exercised;
- [ ] tests that execute code without asserting meaningful outcomes.

High coverage generated by weak assertions should not be considered sufficient.

### 4.13 Regression-test policy

Every reproducible production defect discovered during or after v2.4 development should receive a regression test whenever practical.

A bug fix should normally follow this sequence:

1. reproduce the incorrect behavior in an automated test;
2. verify the test fails against the affected implementation;
3. implement the fix;
4. verify the regression test passes;
5. retain the test permanently.

Operational soak testing should therefore feed directly back into the automated suite.

### 4.14 Acceptance criteria

This workstream is complete when:

- [ ] the existing suite has been successfully migrated to Vitest;
- [ ] `npm test` executes the deterministic full test suite;
- [ ] `npm run test:coverage` produces reproducible Istanbul coverage;
- [ ] `artifacts/junit.xml` is produced for automated test reporting;
- [ ] LCOV coverage output is produced;
- [ ] machine-readable XML coverage output is produced for automated coverage reporting;
- [ ] HTML coverage output is available for local inspection;
- [ ] all application source files are considered by the coverage calculation unless intentionally documented otherwise;
- [ ] the initial line, statement, function, and branch baseline is documented;
- [ ] high-risk uncovered paths have been reviewed and prioritized;
- [ ] meaningful additional tests have been added based on those findings;
- [ ] CI preserves test and coverage artifacts;
- [ ] coverage regression thresholds are enabled after the baseline/improvement phase, or their deferral is explicitly documented;
- [ ] tests remain deterministic and pass consistently across repeated runs.

---

## 5. Test-Suite Structure and Quality

**GitHub Issue Link:** [https://github.com/Robotti-io/Meshcore-Observer/issues/11](https://github.com/Robotti-io/Meshcore-Observer/issues/11)

**Planning decisions (2026-10-02):** Preserve the current Vitest runner, one-project execution, domain-based folders, and `*.test.js` names. Restrict changes to reliability or diagnostic issues supported by the Issue #11 audit; do not add test categories or rename files by default.

**Issue #11 task status:**

- [x] T1 — audit the suite and record evidence-based findings in the Issue #11 plan.
- [x] T2 — fix confirmed resource-cleanup and isolation risks; affected tests and two full-suite runs passed, and lint passed.
- [x] T3 — make confirmed timer tests deterministic while retaining real-I/O coverage; seven affected files passed (53 tests), two full-suite runs passed (47 files / 475 tests each), and lint passed.
- [x] T4 — targeted review found no distinct missing high-risk behavior; existing tests cover the audited failure and recovery paths. `npm run test:ci` passed (47 files / 475 tests) and lint passed.

**T1 audit findings (2026-10-02):** The 47-suite / 475-test JUnit report is readable, and the current organization needs no broad changes. T1 identified failure-path cleanup candidates in the flood-advert scheduler, radio-manager tests, and metrics-server test helper, plus timer/polling candidates in the airtime coordinator, scheduler, command queue, radio manager, sampler, reply queue, and MQTT token-refresh tests. Real socket, HTTP/SSE, and child-process waits remain integration behavior. No distinct missing high-risk failure case was confirmed; T4 is conditional on further targeted evidence.

**T2 result (2026-10-02):** Flood-advert test rigs now stop the scheduler and close their store in `finally`; a file-local `afterEach` stops radio managers left active by failed assertions; and the metrics-server helper protects startup with its cleanup `try/finally`. The affected tests passed (52 tests), two full-suite runs passed (47 files / 475 tests each), and lint passed. An initial focused run had two unrepeatable bad-port failures in the metrics-server 404/405 cases; isolation, rerun, and both full-suite runs passed, so the observation is recorded for monitoring.

**T3 result (2026-10-02):** The audited timer-only tests now use injected clocks, fake timers, or explicit synchronization in the airtime coordinator, command queue, radio manager, sampler, reply queue, token-refresh loop, and flood-advert scheduler. The in-flight reply dispatch assertion still models a delayed send across poll ticks, with fake time controlling its delay. Real socket, HTTP/SSE, and child-process waits remain intact. All seven affected files passed together (53 tests), the full suite passed twice (47 files / 475 tests each), and lint passed.

**T4 result (2026-10-02):** Targeted review of startup/shutdown, radio retries, flood-advert failure and recovery, persisted reply lifecycle, token refresh, and broker-isolated publish failures found existing regression coverage for the audited high-risk paths. No distinct gap justified adding another test. `npm run test:ci` passed (47 files / 475 tests; 72.67% statements, 72.04% branches, 74.08% functions, 73.17% lines); lint passed.

The migration to Vitest and the introduction of formal coverage reporting should also be used to improve the organization, determinism, diagnosability, and maintainability of the test suite itself.

Coverage data can identify where tests are missing, but this workstream should focus on whether the existing and newly-added tests clearly prove the intended behavior.

The suite should make failures easy to diagnose, make architectural assumptions visible, and remain reliable when executed repeatedly in local development and CI.

### 5.1 Preserve domain-based test organization

Keep the current `test/<domain>/<feature>.test.js` layout and `*.test.js` naming convention. The domain folders already make the suite navigable; do not add unit/service/integration suffixes or rename files as a standalone cleanup project.

During T1, classify tests by the boundary they prove when that helps identify ownership or a meaningful reliability issue. Add more specific names or a small organizational adjustment only when it materially improves a test's purpose or failure diagnostics.

### 5.2 Avoid premature test-runner fragmentation

Do not create separate Vitest projects or separate runners merely to label test categories.

Start with one Vitest configuration and one deterministic suite.

Consider separate Vitest projects later if different categories genuinely require different:

- environments;
- setup files;
- execution constraints;
- timeouts;
- worker/concurrency behavior;
- external dependencies.

For example, hardware-adjacent simulation or slower persistence integration tests may eventually warrant separate execution characteristics, but that should be driven by demonstrated need rather than taxonomy alone.

Coverage and JUnit reporting should continue to represent the complete test run unless intentionally separated.

### 5.3 Preserve meaningful JUnit test structure

Because CI will consume `artifacts/junit.xml`, test organization should also produce understandable machine-readable results.

Use descriptive Vitest `test()` names so failures identify:

- the component under test;
- the behavior or state transition being exercised;
- the expected outcome.

An optional `describe()` group is useful when it clarifies related cases, but do not wrap or rename existing tests solely to normalize style. Prefer:

```js
describe('ReplyQueue', () => {
  it('expires a persisted reply after its original TTL following restart', () => {
    // ...
  });
});
```

over names that describe internal implementation mechanics.

JUnit results should be useful without requiring someone to open the source file simply to understand what failed.

### 5.4 Test behavior rather than implementation details

- [ ] Prefer observable outputs, state transitions, persisted data, emitted events, and externally-visible side effects over assertions against internal implementation structure.
- [ ] Avoid tests that prevent harmless refactoring.
- [ ] Keep strict tests for architectural invariants where those invariants are intentional.
- [ ] Test error behavior as deliberately as success behavior.
- [ ] Prefer testing the public behavior of a service over directly testing private helper structure.
- [ ] Avoid excessive snapshots for behavior that is better expressed through explicit assertions.
- [ ] Verify important negative outcomes, not only that the happy path completed.

A test should answer:

> What contract or operational behavior does this prove?

rather than:

> Which lines of this implementation did this test execute?

### 5.5 Improve shared test infrastructure

Review repeated fakes, fixtures, and setup patterns for potential consolidation.

Candidates include:

- [ ] fake radio manager;
- [ ] fake MeshCore connection;
- [ ] deterministic/injected clock;
- [ ] temporary SQLite store/database;
- [ ] silent/capturing logger;
- [ ] MQTT broker/client fakes;
- [ ] packet/frame builders;
- [ ] bot configuration builders;
- [ ] temporary filesystem helpers;
- [ ] common service lifecycle helpers.

Prefer small composable test helpers over large opaque test harnesses.

Shared infrastructure should reduce irrelevant setup while keeping the important conditions of each test visible.

For example:

```js
const radio = createFakeRadio();
const store = createTestStore();
const clock = createTestClock();
```

is preferable to a single helper that silently creates and configures the entire application when the test only needs three components.

### 5.6 Use Vitest setup files conservatively

Introduce a shared Vitest setup file only for behavior that genuinely applies to nearly every test file.

Appropriate examples may include:

- registering custom matchers;
- common global cleanup hooks;
- consistent restoration of mocks/timers;
- lightweight test-environment safeguards.

Avoid placing substantial fixture construction, databases, servers, or mutable application state in global setup.

Individual test files should remain responsible for resources whose lifecycle is part of the behavior being tested.

### 5.7 Standardize cleanup

Use `afterEach()` / `afterAll()` consistently to restore test state and close resources.

Review the suite for deterministic cleanup of:

- [ ] fake timers;
- [ ] spies and mocks;
- [ ] event listeners;
- [ ] intervals and timeouts;
- [ ] SQLite connections;
- [ ] MQTT clients;
- [ ] HTTP servers;
- [ ] sockets;
- [ ] temporary files/directories;
- [ ] modified environment variables.

Tests should restore environment variables and globals they modify rather than relying on process termination to clean them up.

Where useful, shared cleanup helpers may enforce common invariants.

### 5.8 Make time-dependent tests deterministic

Vitest fake timers may be used for behavior driven directly by JavaScript timers.

Continue preferring explicitly injected clocks where time is part of domain behavior.

Use the mechanism that makes the test easiest to reason about.

Examples:

**Injected clock** - Useful for:

- persisted timestamps;
- metrics ranges;
- reply expiration calculations;
- relative repeater age;
- scheduler state stored in SQLite.

**Vitest fake timers** - Useful for:

- `setTimeout`;
- `setInterval`;
- polling loops;
- delayed callbacks;
- timer-driven cleanup.

Avoid real sleeps such as:

```js
await new Promise((resolve) => setTimeout(resolve, 500));
```

unless the test is explicitly validating real asynchronous I/O behavior that cannot reasonably be controlled.

### 5.9 Review concurrency assumptions

Migration to Vitest should be used to expose tests that accidentally rely on process-global or execution-order state.

Review tests for:

- [ ] shared environment-variable mutation;
- [ ] fixed TCP ports;
- [ ] shared SQLite filenames;
- [ ] shared temporary directories;
- [ ] singleton module state;
- [ ] global event emitters;
- [ ] mutable exported objects;
- [ ] assumptions about which test executes first;
- [ ] assumptions that another test cleaned something up.

Each test should own its resources wherever practical.

Tests that genuinely cannot execute concurrently should document why rather than silently relying on current runner behavior.

### 5.10 Isolate persistence tests

Persistence tests should use isolated temporary databases rather than shared repository-local database files.

Each test or logically-related test group should be able to create a known starting database state and clean it up afterward.

Provide helpers for:

- creating a fresh current-schema database;
- constructing databases at older schema versions for migration tests;
- reopening the same database to simulate restart;
- closing the database deterministically;
- inspecting persisted state without depending unnecessarily on internal implementation details.

Migration tests should verify both:

1. the final schema/data state; and
2. important application behavior after migration.

### 5.11 Strengthen application/bootstrap testing

Because `src/index.js` coordinates many service lifecycles, coverage alone may not provide meaningful confidence in bootstrap and shutdown behavior.

Review whether application construction can be tested without requiring physical radio hardware or external MQTT infrastructure.

Important scenarios include:

- configuration fails before hardware/network side effects occur;
- persistence opens before services that depend on it;
- bots stop accepting work before radio shutdown;
- an in-flight reply is allowed to settle during shutdown;
- metrics sampling stops cleanly;
- optional dashboard startup failure does not stop packet capture;
- MQTT and radio resources are closed in the intended order;
- repeated shutdown signals do not execute shutdown twice.

Where direct bootstrap testing is difficult, consider extracting orchestration behind a testable application lifecycle boundary rather than mocking the entire Node.js process.

Do not refactor solely for test coverage; extraction should also clarify lifecycle ownership.

### 5.12 Hardware-adjacent simulation tests

Continue building simulation-level tests around the raw inputs and outputs closest to real MeshCore behavior.

Useful simulation boundaries include:

- raw packet frames;
- repeated RF deliveries;
- path/hop changes;
- Companion reconnect events;
- channel encryption/decryption inputs;
- adverts with valid and invalid signatures;
- command failures;
- disconnects during queued operations.

Prefer realistic captured or constructed frames over mocks that skip packet parsing entirely when the behavior under test depends on packet semantics.

Maintain clear separation between:

- behavior proven through simulation; and
- behavior that still requires real radio/hardware verification.

### 5.13 Detect flaky or order-dependent tests

- [ ] Run the entire test suite repeatedly during v2.4 development.
- [ ] Run the suite under normal CI concurrency.
- [ ] Watch for leaked timers, listeners, sockets, database handles, and server handles.
- [ ] Verify tests do not depend on execution order.
- [ ] Review tests that use real timers.
- [ ] Review shared mutable module state.
- [ ] Review environment-variable mutation.
- [ ] Ensure temporary databases/files are cleaned up deterministically.
- [ ] Investigate intermittent failures rather than automatically adding retries.

Retries may eventually be appropriate for genuinely nondeterministic external integration tests, but they should not hide race conditions or lifecycle defects in unit/component tests.

### 5.14 Test helpers should remain testable concepts

Avoid building a second application architecture inside `test/helpers`.

A useful helper should normally represent one clear testing concept, such as:

```text
createFakeRadio()
createCapturingLogger()
createTestStore()
createPacketFrame()
createBotConfig()
createTestClock()
```

If understanding a test requires tracing through multiple layers of helper abstractions, the helper structure has become counterproductive.

### 5.15 Regression-test policy

Every reproducible production bug fixed during or after v2.4 development should receive a regression test whenever the behavior can reasonably be reproduced in automation.

A bug fix is not complete until:

1. the failing behavior is reproduced in an automated test;
2. the test is demonstrated to fail against the affected behavior;
3. the implementation is corrected;
4. the test passes afterward; and
5. the regression test remains part of the permanent suite.

Where a production issue depends on real RF hardware and cannot be reproduced directly, create the closest deterministic simulation possible and document the remaining hardware-only assumption.

### 5.16 Soak-testing feedback loop

Operational soak testing should feed the automated test suite.

When long-running deployment reveals an issue:

1. capture logs and observable state;
2. identify the responsible lifecycle or state transition;
3. reproduce it using a unit, integration, or simulation test where possible;
4. confirm the reproduction fails;
5. implement the correction;
6. retain the test as a regression guard.

This should progressively reduce the set of important behaviors that can only be validated manually.

### 5.17 Test-suite quality acceptance criteria

This workstream is complete when:

- [ ] the existing domain-based organization is retained, and any targeted naming change is justified by clearer test purpose or diagnostics;
- [ ] the Vitest migration preserves or increases the number of meaningful behavioral tests;
- [ ] JUnit output contains understandable suite and test names;
- [ ] common test helpers have been reviewed for consolidation;
- [ ] shared setup remains lightweight and intentional;
- [ ] timer-dependent tests are deterministic;
- [ ] temporary databases and files are isolated;
- [ ] environment-variable changes are restored deterministically;
- [ ] event listeners, timers, database connections, servers, and sockets are cleaned up;
- [ ] the full suite passes consistently across repeated runs;
- [ ] tests do not depend on execution order;
- [ ] CI concurrency does not expose unresolved shared-state assumptions;
- [ ] high-risk lifecycle behavior has tests at an appropriate boundary;
- [ ] hardware-dependent assumptions are clearly distinguished from simulated coverage;
- [ ] production defects receive regression tests whenever practical.

### 5.18 Regression-test policy

Every production bug fixed during or after v2.4 development should receive a regression test whenever the behavior can reasonably be reproduced in automation.

A bug fix is not complete until:

1. the failing behavior is reproducible;
2. the test fails against the old behavior;
3. the implementation is corrected; and
4. the test passes afterward.

---

## 6. MQTT Password Configuration Safety

**GitHub Issue Link:** [https://github.com/Robotti-io/Meshcore-Observer/issues/12](https://github.com/Robotti-io/Meshcore-Observer/issues/12)

**Planning decisions (2026-10-02):** A configured `auth.passwordEnv` is authoritative and fails startup if missing/empty; positional lookup is retained only when it is absent. Shared named variables are allowed. The selector must match `^[A-Z_][A-Z0-9_]*$` and is valid only with password auth. Preserve the existing credential requirement for disabled password-auth brokers. Secret values are not trimmed or exposed in errors/logs.

Password-authenticated MQTT brokers currently obtain their password from a positional environment variable:

```text
PACKETCAPTURE_MQTT<n>_PASSWORD
```

where `<n>` corresponds to the broker's array position in `brokers.config.json`.

This means reordering brokers may associate an existing secret with a different broker.

### 6.1 Resolved backwards-compatible design

Allow password-authenticated brokers to optionally specify the environment variable containing their password, for example:

```json
{
  "id": "example",
  "auth": {
    "method": "password",
    "username": "observer",
    "passwordEnv": "MQTT_EXAMPLE_PASSWORD"
  }
}
```

The JSON configuration would contain only the environment variable name, never the secret itself.

### 6.2 Work

- [x] Design a stable broker-to-secret mapping independent of array position; `auth.passwordEnv` is authoritative when configured, and positional mapping is used only when absent.
- [x] Preserve support for existing `PACKETCAPTURE_MQTT<n>_PASSWORD` configuration during v2.x when `passwordEnv` is absent.
- [x] Use the explicitly named variable exclusively when configured; fail startup if it is missing/empty, without falling back to positional lookup.
- [x] Validate `passwordEnv` with strict AJV schema rules: uppercase environment-variable syntax and password-auth only.
- [x] Permit intentional reuse of the same named variable by multiple brokers.
- [x] Ensure secrets remain redacted from logs and configuration error output.
- [x] Add tests for named-secret configuration.
- [x] Add tests proving broker reordering does not change named-secret association.
- [x] Document positional password variables as a legacy fallback that remains supported during v2.x.
- [x] Preserve the current requirement that disabled password-auth brokers also have a configured password.

**Implementation status (2026-10-02):** T2 and T3 are complete. At T2 completion, the focused config tests passed (54 tests), the full suite passed (47 files / 483 tests), `npm run test:ci` passed, and lint passed. T3's initial broker example loader test passed (16 tests); the full suite then passed (47 files / 484 tests), and lint passed. The final example expansion adds two TLS-enabled password-auth placeholders mapped to distinct variables; the updated loader test (16 tests), lint, and `git diff --check` passed. `brokers.config.example.json` now shows anonymous OKIMesh mqtt1/mqtt2 entries, MeshMapper and LetsMesh token-auth examples, and both password-auth placeholders. Positional fallback remains documented; token auth uses no static password variable.

### 6.3 Non-goal

Do not remove existing positional variables in v2.4.0 if doing so would create a breaking configuration change. Removal can be considered for a future major release.

---

## 7. ChannelBot Maintainability / Command-Kind Boundary

**GitHub Issue Link:** [https://github.com/Robotti-io/Meshcore-Observer/issues/13](https://github.com/Robotti-io/Meshcore-Observer/issues/13)

Future releases are expected to expand bot command kinds and capabilities. Issue #13 now targets a small, repeatable handler boundary that keeps common radio/reply lifecycle work centralized and avoids adding command-specific SQLite columns for each new command kind.

The detailed code findings, resolved assumptions, task breakdown, acceptance criteria, and implementation status are maintained in [the Issue #13 plan](v2.4.0/issue-13-channelbot-boundary.md).

The completed T1 evidence audit showed that `ChannelBot` dispatched exact, lookup, and stats behavior, while lookup/stats data already used `NodeRegistry` and `StatsReporter` seams. T3 extracted those command behaviors behind an explicit handler map and added SQLite migration 8 to replace lookup-specific columns with strictly validated, versioned JSON handler state. T4 verified current commands, migration, queue recovery, dashboard metrics, and a future handler context without adding database columns. Shared radio/reply lifecycle and dashboard fields remain in the common path. The user approved the finalized plan, including the migration.

The Issue #13 follow-up is complete: handlers own command-specific actions and return named result values for shared template rendering; required sender metadata is parsed and validated once at the shared decrypted-message boundary. Command input is validated early, while actions run after hop and duplicate checks at queued reply dispatch. Lookup's move from match-time snapshots to dispatch-time resolution is an intentional compatibility change, documented and covered by tests. Full validation passed with 48 test files / 498 tests and lint.

### 7.1 Current status

- [x] Resolved the expected-growth assumption: future command kinds are anticipated.
- [x] Approved the one-time generic-context SQLite migration in the finalized implementation plan.
- [x] Complete the responsibility and persistence evidence audit: a fourth kind currently crosses strict config validation, `ChannelBot` matching/rendering branches, queue item mapping, and SQLite fields/migration; the current queue contains lookup-specific state from migration 6.
- [x] Confirm that shared RF decode/channel/hop/dedup, queue/send, byte-budget rendering, and repeat-confirmation lifecycle should remain centralized; exact/lookup/stats match and response-state preparation are the command-specific seams.
- [x] Finalize the handler contract and migration decision: explicit handler map, versioned `{ kind, version, data }` state, and one SQLite migration to generic `handler_state_json`.
- [x] Obtain user approval of the finalized plan, including the one-time migration.
- [x] Implement the selected design.
- [x] T3 implementation validation: all 47 test files / 484 tests passed and lint passed.
- [x] Complete T4 verification: 48 test files / 492 tests and lint passed; a v7 migration fixture and a temporary copy of the local v7 store migrated to v8 with lifecycle counts preserved, while a custom handler context survived store/queue restart without schema changes.
- [x] Verify current commands and queued reply recovery; prove a new command context needs no new database columns.
- [x] Record the outcome and evidence in the Issue #13 plan.
- [ ] Link the eventual PR or GitHub issue update when available.

### 7.2 Follow-up: Command Action Results and Sender Handling

- [x] Resolve sender validity: require sender metadata on decrypted messages and reject prefixless or malformed messages before command matching; handlers may ignore the validated sender.
- [x] Resolve command-action timing: validate command input early, then run actions after hop and duplicate checks at queued reply dispatch.
- [x] Resolve the result contract: handlers return named, serializable values for shared response-template rendering, preserving existing placeholders.
- [x] Implement a structured, serializable command-result values contract for shared response-template rendering.
- [x] Keep sender parsing/validation at the shared decrypted-message boundary; verify sender attribution through queue persistence, logging, and metrics.
- [x] Move lookup resolution from match-time snapshots to dispatch-time action execution; document and test the changed timing alongside stats.
- [x] Verify current exact/lookup/stats behavior, queue restart recovery, UTF-8 byte-budget rendering, and future extension without command-specific schema changes; 48 test files / 498 tests and lint passed.

**T1 evidence record (2026-10-02):** `test/bots/channel-bot.test.js` contains 47 tests; command-kind paths are exercised with fake radio events and encrypted packet fixtures, while response templates, stats ranges, node registry, and stats reporter also have focused module tests. `ReplyQueue` persists plain data and resumes pending replies; MetricsStore migrations 4–6 added/consolidated reply persistence, with migration 6 adding lookup-specific fields. Dashboard counts/outcomes use shared bot/trigger/status/resolution fields. These findings justify reducing command-specific cross-layer changes while preserving the shared RF/reply path.

---

## 8. MetricsStore Maintainability Review

**GitHub Issue Link:** [https://github.com/Robotti-io/Meshcore-Observer/issues/14](https://github.com/Robotti-io/Meshcore-Observer/issues/14)

`MetricsStore` now provides several logically separate persistence responsibilities:

- historical metrics
- bot reply queue/lifecycle persistence
- node/repeater persistence
- flood-advert state
- migrations
- reporting queries

SQLite should remain a shared persistence mechanism, but the API surface should be reviewed for long-term maintainability.

### 8.1 Work

- [x] Inventory store responsibilities, consumers, migration/transaction seams, and direct versus indirect test coverage; record evidence of ownership friction or test limitations.
- [x] Retain the current `MetricsStore` design and schema: one SQLite connection and migration owner are clear, and no repository extraction is justified.
- [x] Report every configured bot command individually in the Channel bots chart and table, preserving config order and exact trigger counts without command-specific frontend mappings; keep the storage API/schema unchanged. `npm.cmd test` passed (48 files / 493 tests) and `npm.cmd run lint` passed.
- [x] Evaluate schema/data-model changes against the evidence; no change was justified. Any future storage change still requires separate explicit human approval.
- [x] Avoid refactoring solely to reduce file size; no repository extraction was justified by the ownership or testing evidence.
- [x] Use coverage results to identify persistence behavior currently exercised only indirectly; focused store and consumer tests cover the current persistence seams.

Potential boundaries include:

- metrics history/reporting
- bot reply persistence
- node registry persistence
- scheduler state

This is primarily a maintainability review; large structural changes are not required for the release.

---

## 9. Long-Running / Operational Soak Validation

**GitHub Issue Link:** [https://github.com/Robotti-io/Meshcore-Observer/issues/15](https://github.com/Robotti-io/Meshcore-Observer/issues/15)

v2.4.0 should use the current local deployment as a real-world validation environment.

### 9.1 Observe over multi-day runtime

- [ ] Process memory / RSS behavior.
- [ ] SQLite database growth.
- [ ] Metrics query responsiveness as history grows.
- [ ] Retention pruning behavior, if enabled.
- [ ] Reply queue depth and expiration behavior.
- [ ] Confirmed vs. unconfirmed bot repeats.
- [ ] MQTT reconnect behavior.
- [ ] Radio reconnect behavior.
- [ ] Flood-advert scheduler behavior across reconnects/restarts.
- [ ] Dashboard responsiveness after extended uptime.
- [ ] Clean shutdown/restart with pending replies.
- [ ] Recovery following unexpected termination.

### 9.2 Convert findings into tests

When soak testing exposes a reproducible software edge case:

- [ ] capture the observed failure;
- [ ] determine whether it can be simulated without hardware;
- [ ] add a regression test where practical;
- [ ] fix the behavior;
- [ ] verify the regression remains covered.

This creates a feedback loop between real operation and automated confidence.

### 9.3 Questions to answer

- Does memory remain stable over several days?
- Does the unlimited-retention default remain reasonable?
- Do synchronous SQLite queries ever produce noticeable event-loop stalls?
- Does any internal counter diverge from persisted history?
- Are there recurring warnings/errors that currently appear harmless but indicate an architectural edge case?
- Which important production behaviors are still impossible to reproduce in the automated suite?

Avoid redesigning persistence based purely on theoretical concerns. Changes in this area should be supported by observed runtime behavior.

---

## 10. Repository / Release Hygiene

**GitHub Issue Link:** [https://github.com/Robotti-io/Meshcore-Observer/issues/16](https://github.com/Robotti-io/Meshcore-Observer/issues/16)

Blocked by

- [https://github.com/Robotti-io/Meshcore-Observer/issues/7](https://github.com/Robotti-io/Meshcore-Observer/issues/7)
- [https://github.com/Robotti-io/Meshcore-Observer/issues/8](https://github.com/Robotti-io/Meshcore-Observer/issues/8)
- [https://github.com/Robotti-io/Meshcore-Observer/issues/9](https://github.com/Robotti-io/Meshcore-Observer/issues/9)
- [https://github.com/Robotti-io/Meshcore-Observer/issues/10](https://github.com/Robotti-io/Meshcore-Observer/issues/10)
- [https://github.com/Robotti-io/Meshcore-Observer/issues/11](https://github.com/Robotti-io/Meshcore-Observer/issues/11)
- [https://github.com/Robotti-io/Meshcore-Observer/issues/12](https://github.com/Robotti-io/Meshcore-Observer/issues/12)
- [https://github.com/Robotti-io/Meshcore-Observer/issues/13](https://github.com/Robotti-io/Meshcore-Observer/issues/13)
- [https://github.com/Robotti-io/Meshcore-Observer/issues/14](https://github.com/Robotti-io/Meshcore-Observer/issues/14)
- [https://github.com/Robotti-io/Meshcore-Observer/issues/15](https://github.com/Robotti-io/Meshcore-Observer/issues/15)

- [ ] Add a repository `LICENSE` file matching the package's declared ISC license.
- [ ] Review README installation and upgrade instructions for v2.4.0.
- [ ] Consider adding a lightweight `CONTRIBUTING.md`.
- [ ] Confirm example configuration files remain synchronized with runtime defaults.
- [ ] Run a documentation pass for stale references left by the v1 → v2 architecture changes.
- [ ] Document how to run the normal and coverage test suites.
- [ ] Prepare v2.4.0 release notes with clear upgrade guidance.

---

## Test Coverage Strategy

The project should treat coverage as an engineering signal rather than a scorecard.

### Phase 1 — Measure

- Add coverage tooling.
- Establish the existing baseline.
- Identify uncovered files, functions, and branches.
- Do not fail CI on coverage yet.

### Phase 2 — Improve

Focus on high-risk uncovered behavior, especially:

- failure paths
- lifecycle transitions
- persistence recovery
- migrations
- scheduler edge cases
- configuration rejection
- restart behavior

### Phase 3 — Protect

Once meaningful improvements are made:

- establish coverage thresholds;
- make CI enforce them;
- prevent regressions.

### Phase 4 — Ratchet

Increase thresholds gradually when normal feature development and regression testing naturally improve coverage.

Avoid increasing thresholds solely for the purpose of reaching a round number.

---

## Testing Expectations

New production behavior should include automated tests at the appropriate boundary.

At minimum, v2.4.0 should add or update tests for:

- [ ] proactive repeat-check expiration
- [ ] exact-once repeat timeout accounting
- [ ] repeat tracker capacity behavior
- [ ] repeat-check configuration defaults
- [ ] named MQTT password environment variables, if implemented
- [ ] backwards compatibility with positional MQTT password variables
- [ ] interrupted/recovered scheduler state
- [ ] persistence across clean restart
- [ ] persistence/recovery after simulated unexpected termination where practical
- [ ] important configuration rejection paths
- [ ] CI execution on supported runtimes
- [ ] coverage measurement
- [ ] any extracted command-handler or persistence boundaries

Existing tests should continue to pass without weakening assertions to accommodate architectural changes.

---

## Non-Goals

Unless operational testing exposes a concrete need, v2.4.0 should avoid:

- major new bot features
- new external service dependencies without a demonstrated need
- replacing SQLite
- introducing a frontend build framework
- large-scale TypeScript migration
- unapproved test-framework changes; the Vitest/Istanbul migration in this plan is explicitly approved
- chasing 100% coverage
- tests written solely to increase a coverage percentage
- redesigning the radio abstraction
- breaking existing broker or bot configuration
- changing MQTT topic/payload compatibility
- changing MeshCore transmission behavior without hardware-backed evidence

---

## Release Exit Criteria

v2.4.0 is ready when:

- [ ] all tests pass
- [x] lint passes — local `npm.cmd run lint` and the PR lint job passed.
- [ ] CI is green on the selected platform matrix
- [ ] a reproducible coverage report exists
- [ ] the project's baseline line/function/branch coverage is documented
- [ ] meaningful high-risk coverage gaps identified during the release have been addressed
- [ ] agreed coverage regression thresholds are enforced in CI, or a documented reason exists for deferring enforcement
- [ ] repeat confirmation timeout semantics are deterministic
- [ ] documented defaults match runtime defaults
- [ ] existing v2.3 configuration remains supported
- [ ] migrations have been tested against an existing v2.3 database
- [ ] the observer has completed a meaningful multi-day local soak without unexplained reliability regressions
- [ ] relevant bugs discovered during soak testing have regression tests where practical
- [ ] README and example configuration reflect the released behavior
- [ ] version is updated to `2.4.0`
- [ ] release notes include upgrade and compatibility information

---

## Release Theme

**Make the observer boring to operate and difficult to accidentally break.**

v2.3.0 established a substantial set of capabilities around persistent state, radio-aware scheduling, bot replies, repeat diagnostics, repeater discovery, MQTT delivery, and historical metrics.

v2.4.0 should strengthen confidence in those capabilities through operational hardening, measurable test coverage, deterministic testing, automated CI, and a tighter feedback loop between real-world observer behavior and regression tests before the next major expansion of functionality.
