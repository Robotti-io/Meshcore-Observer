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

Implementation updates are in place. The affected tests and lint still need to be run before this item is fully validated.

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

For the agreed triggers (workflow implementation added in `.github/workflows/ci.yml`; GitHub execution validation remains pending):

- [x] Define the lint job on Ubuntu with Node 24.x: install the selected Node line, run `npm ci`, then `npm run lint`.
- [x] Define the test job as a four-entry matrix: `ubuntu-latest` and `windows-latest`, each on Node 22.x and 24.x; each entry runs `npm ci` and `npm run test:ci` (tests plus threshold-enforced coverage).
- [x] Set workflow permissions to `contents: read`; the tests require no secrets or external service credentials.
- [ ] Validate the lint job and all four matrix entries on a pull request targeting `main` and a push to `main`.
- [ ] Upload JUnit, Cobertura, LCOV, JSON, and HTML reports from each matrix entry with an unconditional step and a distinct artifact name.
- [ ] Use GitHub's configured artifact retention unless a maintainer specifies another duration.

### 3.2 Platform coverage

The test matrix covers both supported operating systems and both selected Node lines:

- [ ] Run the core test suite on Windows.
- [ ] Run the core test suite on Linux.
- [ ] Run the core test suite on Node 22.x.
- [ ] Run the core test suite on Node 24.x.
- [ ] Identify tests that are genuinely platform-specific rather than weakening the entire test matrix.
- [ ] Confirm `node:sqlite` behavior under both CI environments.

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

**T4 (2026-10-02):** `vitest.config.js` enforces global minimums of 72% statements, 71% branches, 73% functions, and 73% lines, just below the T3.5 result. The floors cover all `src/**/*.js` files, and README documents the review rationale required for future exclusions or threshold changes. A normal `npm run test:ci` passed at 72.67% / 72.04% / 74.08% / 73.17%; an intentional 100% statement override failed as expected, and JUnit, HTML, LCOV, JSON, and Cobertura files remained available after the failure. CI artifact upload remains unimplemented and is assigned to Issue #9's workflow tasks; GitHub Actions, triggers, matrix, and gating sequence are now resolved. The `test:ci` script enforces the thresholds whenever invoked.

**Issue #10 task status:**

- [x] T1 — select Vitest and Istanbul coverage tooling.
- [x] T2 — configure deterministic local tests and reports; Linux CI validation remains pending.
- [x] T3 — record baselines and add high-risk regression coverage.
- [x] T3.5 — add aggregate dashboard-route and sampler-driven SSE coverage.
- [x] T4 — enforce the measured coverage floors and verify report generation after threshold failure.
- [ ] Validate coverage on Linux and upload reports from CI after issue #9 resolves the CI platform and branch policy.

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

- [x] Establish minimum line coverage: 73%.
- [x] Establish minimum statement coverage: 72%.
- [x] Establish minimum function coverage: 73%.
- [x] Establish minimum branch coverage: 71%.
- [x] Configure Vitest/Istanbul to enforce those thresholds.
- [x] Ensure the `test:ci` command fails when coverage falls below the agreed thresholds; CI platform integration remains pending issue #9 T1.
- [x] Prefer thresholds that prevent regression rather than arbitrary aspirational numbers; the floors sit just below T3.5's measured result.
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

**Current status:** The local runner is configured with `reportOnFailure`, and report generation after an intentional threshold failure was verified. The user has selected GitHub Actions with pull-request-to-`main` and push-to-`main` triggers, an Ubuntu/Windows matrix on Node 22.x/24.x, and required checks after validation. Workflow and CI artifact upload implementation is pending in Issue #9; no workflow exists yet.

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

The migration to Vitest and the introduction of formal coverage reporting should also be used to improve the organization, determinism, diagnosability, and maintainability of the test suite itself.

Coverage data can identify where tests are missing, but this workstream should focus on whether the existing and newly-added tests clearly prove the intended behavior.

The suite should make failures easy to diagnose, make architectural assumptions visible, and remain reliable when executed repeatedly in local development and CI.

### 5.1 Establish clear test categories

Conceptually distinguish between:

- unit tests;
- component/service tests;
- persistence integration tests;
- application/bootstrap tests;
- hardware-adjacent simulation tests.

The categories describe the boundary being proven rather than the importance of the test.

A possible naming convention is:

```text
*.unit.test.js
*.service.test.js
*.integration.test.js
*.bootstrap.test.js
*.simulation.test.js
```

Adopting new filenames should not require immediately renaming every existing test. The convention can be introduced incrementally as tests are added or substantially modified.

Tests may continue to live under the existing `test/` hierarchy where that structure remains understandable.

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

Use descriptive `describe()` and `test()` / `it()` names so failures identify:

- the component under test;
- the behavior or state transition being exercised;
- the expected outcome.

Prefer:

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

- [ ] test categories and naming conventions are documented;
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

Password-authenticated MQTT brokers currently obtain their password from a positional environment variable:

```text
PACKETCAPTURE_MQTT<n>_PASSWORD
```

where `<n>` corresponds to the broker's array position in `brokers.config.json`.

This means reordering brokers may associate an existing secret with a different broker.

### 6.1 Proposed backwards-compatible improvement

Investigate allowing password-authenticated brokers to optionally specify the environment variable containing their password, for example:

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

- [ ] Design a stable broker-to-secret mapping independent of array position.
- [ ] Preserve support for existing `PACKETCAPTURE_MQTT<n>_PASSWORD` configuration during v2.x.
- [ ] Prefer the explicitly named variable when configured.
- [ ] Validate `passwordEnv` strictly.
- [ ] Ensure secrets remain redacted from logs and configuration error output.
- [ ] Add tests for named-secret configuration.
- [ ] Add tests proving broker reordering does not change named-secret association.
- [ ] Document positional password variables as legacy/deprecated if the new mechanism is adopted.

### 6.3 Non-goal

Do not remove existing positional variables in v2.4.0 if doing so would create a breaking configuration change. Removal can be considered for a future major release.

---

## 7. ChannelBot Maintainability / Command-Kind Boundary

**GitHub Issue Link:** [https://github.com/Robotti-io/Meshcore-Observer/issues/13](https://github.com/Robotti-io/Meshcore-Observer/issues/13)

`ChannelBot` now supports several distinct command behaviors:

- exact-response commands
- repeater lookup commands
- stats commands

It also owns channel decoding, command matching, deduplication, reply enqueueing, response rendering, and repeat-confirmation bookkeeping.

The purpose of this issue is to evaluate whether the current command-handling boundary remains appropriate as the application grows.

**A refactor is not required for this issue to be completed.**

If the current structure remains the clearest and lowest-risk design after review, documenting that conclusion and the reasoning behind it is considered a successful outcome.

### 7.1 Investigation

- [ ] Identify the current responsibilities owned by `ChannelBot`.
- [ ] Identify which responsibilities are command-specific versus radio/channel lifecycle responsibilities.
- [ ] Review whether adding another command kind would require disproportionate modification to the core packet-handling path.
- [ ] Evaluate the minimum useful command-handler abstraction, if one is justified.
- [ ] Determine whether separating command parsing/resolution would materially improve:
  - testability;
  - ownership clarity;
  - extension cost;
  - failure isolation.
- [ ] Use coverage and test-suite findings to identify command-handling behavior that is difficult to exercise independently.
- [ ] Avoid introducing an abstraction solely to reduce file size or increase coverage.
- [ ] Preserve existing command configuration compatibility.

Possible conceptual interface, if extraction proves useful:

```text
match(message)
resolve(context)
renderContext(...)
```

The exact shape should follow the existing code rather than forcing a predetermined abstraction.

### 7.2 Decision outcomes

This investigation should conclude with one of the following documented outcomes:

#### 7.2.1 Outcome A — Refactor justified

Proceed with a focused extraction if the review shows that a command-handler boundary materially improves maintainability, testability, or extension cost.

Any refactor should:

- preserve existing command behavior and configuration;
- keep radio decoding, hop filtering, deduplication, and queueing centralized where appropriate;
- avoid unnecessary framework or plugin complexity;
- include regression coverage for existing command types;
- reduce coupling without introducing additional lifecycle ambiguity.

#### 7.2.2 Outcome B — No refactor required

If the existing `ChannelBot` structure remains appropriate:

- document why the current responsibility boundary is still acceptable;
- identify any known pressure points to monitor;
- document what future condition would justify revisiting the abstraction;
- avoid changing production structure solely to satisfy this issue;
- open separate follow-up work only if a concrete future need is identified.

Examples of future triggers might include:

- addition of several more command kinds;
- repeated duplication between command implementations;
- difficulty testing command behavior without exercising unrelated radio logic;
- changes to one command type frequently affecting others;
- lifecycle or dependency complexity becoming difficult to reason about.

### 7.3 Decision record

Before closing the issue, record the conclusion in the issue or associated pull request:

- **Decision:** Refactor / No refactor
- **Evidence considered:** coverage findings, existing tests, expected command growth, code ownership, observed duplication
- **Reasoning:** why the chosen direction is preferable
- **Follow-up:** any deferred work or conditions that should cause the decision to be revisited

### 7.4 Acceptance criteria

This issue is complete when:

- [ ] the current `ChannelBot` responsibility boundary has been reviewed;
- [ ] the cost of adding another command kind has been evaluated;
- [ ] relevant coverage/testability findings have been considered;
- [ ] a clear decision has been documented;
- [ ] if refactoring is justified, the extraction is implemented with regression coverage;
- [ ] if refactoring is not justified, the rationale and future revisit criteria are documented;
- [ ] existing command behavior and configuration remain compatible;
- [ ] no abstraction is introduced solely for stylistic reasons or file-size reduction.

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

- [ ] Identify logical store/repository boundaries.
- [ ] Determine whether selected concerns can be extracted without duplicating database ownership.
- [ ] Keep migrations centralized and transactional.
- [ ] Avoid refactoring solely to reduce file size.
- [ ] Prefer extraction only where ownership or testing becomes materially clearer.
- [ ] Use coverage results to identify persistence behavior currently exercised only indirectly.

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
- [ ] lint passes
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
