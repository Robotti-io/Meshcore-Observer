# Issue #10 — Coverage tracking and test-suite improvement

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/10](https://github.com/Robotti-io/Meshcore-Observer/issues/10)

## Implementation Plan

### 1. Feature Summary

Establish repeatable coverage reporting, a source-inclusive baseline, targeted tests for high-risk behavior, and regression thresholds grounded in measured results.

### 2. Relevant Existing Architecture

- The current suite uses `node:test` and `node:assert`; `npm test` is `node --test`.
- Application modules are ESM JavaScript and Node >=22.13.0 is needed for `node:sqlite`.
- Coverage tooling is not currently declared; no coverage script or report configuration exists.
- `AGENTS.md` permits ESLint as the dev dependency and requires explicit approval for other dependencies.
- The release plan specifically proposes Vitest plus `@vitest/coverage-istanbul`, but also lists changing test frameworks merely to obtain coverage as a non-goal. Resolve this contradiction before adopting that stack.

### 3. Proposed Approach

First compare the proposed Vitest/Istanbul stack with Node's built-in test and coverage capabilities, migration effort, requested JUnit/Cobertura outputs, platform support, and dependency policy. Obtain explicit approval for any additional packages or framework shift. Then measure all `src/**/*.js`, publish machine-readable and human-readable reports, review per-file/branch gaps, add behavior-driven tests for high-risk paths, and set conservative thresholds only after the baseline and improvement pass.

### 4. Impacted Areas

- `package.json`, `package-lock.json`, a runner/coverage config file (if selected), `.gitignore`.
- `test/**`, especially config rejection, lifecycle, migration/restart, repeat timeout, scheduler recovery, MQTT multi-broker failures.
- CI artifacts in issue #9 and documentation/coverage baseline record.

### 5. Task Breakdown

#### T1: Select and approve the measurement stack

- **Objective:** Choose a maintainable runner/coverage path consistent with policy.
- **Specific changes:** Compare built-in `node:test` coverage against the proposed Vitest stack and confirm whether runner migration is needed for reporting/JUnit requirements; seek dependency approval before planning package changes as approved work.
- **Definition of done:** Framework and dependencies are explicitly selected; contradiction with the release non-goal is resolved.
- **Expected tests / validation:** Prototype/compare supported output formats and cross-platform behavior without changing production code.

#### T2: Configure deterministic local reports

- **Objective:** Produce complete, reproducible results.
- **Specific changes:** Add package scripts/config for one-shot tests, optional watch mode, coverage, JUnit, LCOV, JSON, HTML, and Cobertura where supported; include every application source file by default.
- **Definition of done:** Documented commands create the agreed artifacts; no source exclusions are used to inflate coverage.
- **Expected tests / validation:** Run reports twice and compare stability; inspect representative JUnit and coverage outputs.

#### T3: Measure and improve high-risk coverage

- **Objective:** Turn reports into operational confidence.
- **Specific changes:** Record line/statement/function/branch baseline; inspect source-level gaps; prioritize error/recovery paths, config boundaries, persistence migrations, lifecycle transitions, scheduler and reply behavior.
- **Definition of done:** Baseline is documented and targeted behavioral tests close the agreed risk gaps.
- **Expected tests / validation:** Confirm selected regression tests fail before their associated fix when applicable, then pass; retain coverage output.

#### T4: Set regression thresholds and CI artifacts

- **Objective:** Prevent coverage regression without arbitrary targets.
- **Specific changes:** Choose thresholds at or near the improved baseline; configure CI uploads on failure; document justified exclusions and review requirements.
- **Definition of done:** CI enforces agreed line, statement, function, and branch minima, or records a specific deferral rationale.
- **Expected tests / validation:** Verify below-threshold failure and report retention in the issue #9 pipeline.

### 6. Risks and Edge Cases

- A runner migration can create churn and obscure behavior changes.
- Generated coverage for unimported modules depends on provider support and explicit include configuration.
- SQLite, hardware-adjacent simulations, and environment-mutating tests may reveal concurrency or platform constraints.
- JUnit and coverage XML are distinct outputs and must not be conflated.

### 7. Open Questions / Assumptions

- Is Vitest migration approved despite the release non-goal and dependency restrictions?
- Are all listed artifacts mandatory, including Cobertura XML and `coverage-final.json`, or can existing tooling meet the acceptance needs?
- Which baseline date/branch should be treated as the v2.4 reference?
- Assumption: no coverage target is selected before actual measurement.

### 8. Suggested Execution Order

1. T1 — decide tooling and dependency governance.
2. T2 — produce artifacts and establish repeatability.
3. T3 — measure, then add useful tests.
4. T4 — set thresholds and connect CI once reports are stable.
