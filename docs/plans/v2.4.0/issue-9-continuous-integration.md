# Issue #9 — Continuous integration

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/9](https://github.com/Robotti-io/Meshcore-Observer/issues/9)

Issue #10's test and coverage tooling decision is complete. Issue #9 will use the Vitest scripts and thresholds established there.

## Implementation Plan

### 1. Feature Summary

Run deterministic lint, test, and threshold-enforced coverage checks on GitHub Actions for pull requests targeting `main` and pushes to `main`, using Ubuntu and Windows runners and retaining diagnostic reports on failure.

### 2. Relevant Existing Architecture

- `package.json` provides `npm run lint` (`eslint .`), `npm test` (Vitest without coverage), and `npm run test:ci` (Vitest with Istanbul coverage and thresholds). Node >=22.13.0 is required for `node:sqlite`.
- Tests are under `test/` and use Vitest with Node's built-in `node:assert/strict`.
- `vitest.config.js` includes every `src/**/*.js` file and enforces global minimums of 72% statements, 71% branches, 73% functions, and 70% lines. `reportOnFailure` generates JUnit and coverage reports when a test or threshold fails.
- `npm run test:ci` writes `artifacts/junit.xml` and reports under `coverage/` (Cobertura, LCOV, JSON, and HTML). Both directories are gitignored and can still be uploaded by a workflow.
- `.github/workflows/ci.yml` now runs the lint job and four-entry coverage-test matrix. T3 adds matrix-specific report artifact uploads. The human explicitly selected GitHub Actions and overrode the conflicting GitLab-template instruction for this CI work.
- The local branch refs include `main` and `release-v2_4_0`; there are no `development` or `production` branches. Checks are scoped to pull requests targeting `main` and pushes to `main` only.

### 3. Proposed Approach

Add a minimal GitHub Actions workflow with a lint job and a Windows/Linux test matrix on Node 22.x and 24.x. Run `npm ci` in each job, then use the repository's `npm run lint` and `npm run test:ci` scripts. Keep lint independent of the test matrix so a lint failure does not suppress coverage generation. Upload JUnit and all coverage reports with an unconditional artifact step, using matrix-specific artifact names. Request only read access to repository contents and do not expose secrets to pull-request jobs. After successful full-matrix and failure-artifact validation, make the stable check names required for pull requests targeting `main`.

### 4. Impacted Areas

- `.github/workflows/ci.yml` (new GitHub Actions workflow).
- `package.json`, `package-lock.json`, and `vitest.config.js` only if CI exposes a required script or report adjustment; Issue #10 currently provides the needed commands, thresholds, and reports.
- `README.md` and this plan for CI usage, triggers, matrix, and required check names.
- GitHub repository branch-protection settings after the workflow is stable; these settings are outside the repository files.

### 5. Task Breakdown

#### T1: Resolve CI platform, triggers, runner matrix, and gating — resolved

- [x] Decision: GitHub Actions is the CI platform for this repository, explicitly overriding the conflicting GitLab-template instruction for this work.
- [x] Decision: run on pull requests targeting `main` and direct pushes to `main` only.
- [x] Decision: use GitHub-hosted Ubuntu and Windows runners, with Node 22.x and 24.x for the test matrix.
- [x] Decision: make checks required for pull requests to `main` after the full matrix and artifact failure path are validated.
- **Objective:** Establish the CI contract before changing repository workflows.
- **Definition of done:** Platform, triggers, runner/Node matrix, and gating sequence are agreed.
- **Validation:** Confirmed against the human's explicit decisions and current local branch refs.

#### T2: Add lint and test jobs — PR matrix complete; push-to-main check pending

- [x] Add the main-only GitHub Actions workflow with read-only contents permission, an independent Ubuntu/Node 24.x lint job, and the four-entry Ubuntu/Windows × Node 22.x/24.x coverage-test matrix.
- [x] Initial temporary-PR run executed all four matrix entries; the 475 tests passed, but the jobs failed the 73% line-coverage floor at 72.96% in the reported run.
- [x] Rerun the PR matrix with the agreed 70% line floor; all four jobs and the 475-test suite passed.
- [ ] Validate the push-to-`main` trigger after merge.
- **Objective:** Make baseline quality checks automatic.
- **Specific changes:** Add `.github/workflows/ci.yml` for the agreed pull-request and push events. Run `npm ci` and `npm run lint` in an independent lint job. Run `npm ci` and `npm run test:ci` in a matrix of `ubuntu-latest` and `windows-latest` with Node 22.x and 24.x. Set `permissions: contents: read`; no secrets are required by the test suite. Report uploads remain in T3.
- **Definition of done:** Lint passes and the full coverage-enforcing test command passes in all four OS/Node combinations; failures are surfaced as distinct check results.
- **Expected tests / validation:** [x] Inspect the workflow structure and confirm the intended triggers, jobs, and matrix are declared. [x] Confirm all matrix entries execute `npm ci` and all 475 tests pass on the initial temporary-PR run. [x] Confirm the 70% line floor and all other coverage gates pass on every PR matrix entry. [ ] Validate the push-to-main run after merge.

#### T3: Add coverage artifacts and required statuses

- [x] Add an unconditional, uniquely named artifact upload to each test-matrix job for JUnit, Cobertura, LCOV, JSON, and HTML reports; use the configured retention period and ignore missing files when setup fails early.
- [x] Verify the successful PR run produced one matrix-specific artifact for each OS/Node combination.
- [x] Locally verify the intentional coverage-threshold failure occurs after all 475 tests pass and produces all five report files.
- [x] Verify reports are uploaded on an intentionally failing coverage run; GitHub run 37040249927 lists four non-empty matrix artifacts.
- [ ] Configure and verify the lint and matrix statuses as required for pull requests to `main` after both artifact paths are validated.
- **Objective:** Make test/coverage reports available to reviewers.
- **Specific changes:** Upload `artifacts/junit.xml`, `coverage/cobertura-coverage.xml`, `coverage/lcov.info`, `coverage/coverage-final.json`, and `coverage/index.html` using an unconditional upload step and unique names for each OS/Node matrix job. Use the repository's configured artifact-retention policy unless maintainers specify another duration. After successful-run and failure-run artifact validation, require the lint and matrix checks for pull requests to `main`.
- **Definition of done:** Reports are downloadable from successful and intentionally failing workflow runs; required check names are stable and block merging to `main`.
- **Expected tests / validation:** [x] Verify GitHub lists four non-empty report artifacts on the successful PR run. [x] Verify locally that a 100% statement threshold fails after all tests pass and JUnit, Cobertura, LCOV, JSON, and HTML reports are generated. [x] Verify GitHub run 37040249927 failed all four matrix jobs at the coverage gate and lists four non-empty report artifacts. [ ] Verify GitHub marks the chosen lint and matrix checks as required for a pull request to `main` after artifact validation.

#### T4: Document CI operation and maintenance

- [x] Document workflow triggers, runner/Node matrix, commands, report paths/artifact names, and planned required check names in README; record how matrix changes should be reviewed.
- [x] Review README and plan details against the workflow and successful PR run.
- **Objective:** Keep local and CI validation instructions aligned.
- **Specific changes:** Document workflow triggers, matrix, report paths, and required check names in README. Record how Node-line or runner changes should be reviewed and keep CI validation separate from application deployment behavior.
- **Definition of done:** README and Issue #9 plan match the committed workflow, with no obsolete `node:test` or `npm test`-only CI assumptions.
- **Expected tests / validation:** [x] Review documentation against the successful PR run and current workflow configuration. Required-check settings and failure-artifact validation remain with T3.

### 6. Risks and Edge Cases

- Windows serial-port transitive dependencies may install differently from Linux even though tests do not require hardware.
- Node's built-in SQLite availability and migrations must pass on both OS runners and both Node lines.
- GitHub-hosted runner images evolve; pin Node major lines and avoid assumptions about preinstalled tools beyond Node/npm.
- Required-status configuration can block merging if job names are changed or matrix jobs are skipped; finalize branch protection only after validation.
- Artifact upload must run after failed tests/thresholds, but tolerate missing files when dependency installation fails before reports exist.

### 7. Resolved Questions / Assumptions

- [x] GitHub Actions is authoritative for Issue #9 validation; this explicit human decision overrides the conflicting GitLab-template instruction for this repository.
- [x] Trigger on pull requests targeting `main` and pushes to `main` only; no `development` or `production` branch triggers are configured.
- [x] Use GitHub-hosted Ubuntu and Windows runners; run the test matrix on Node 22.x and 24.x.
- [x] Run the Vitest/Istanbul coverage command `npm run test:ci` so the Issue #10 thresholds are enforced in CI.
- [x] Make the checks required after the full matrix and failure artifact path are validated.
- Assume GitHub's repository-configured artifact retention period unless a maintainer requests a specific duration.
- No secrets, external services, deployment jobs, container builds, or image publishing are required for these checks.

### 8. Suggested Execution Order

1. [x] T1 — resolve GitHub Actions, main-only triggers, runner/Node matrix, and delayed required-check policy.
2. [x] T2 — add lint and coverage-enforcing Windows/Linux matrix jobs; the PR matrix passes, with push-to-main validation pending after merge.
3. [ ] T3 — upload reports on success and failure (validated); configure and verify stable required checks for PRs to `main`.
4. [x] T4 — document workflow operation and matrix maintenance; required-check configuration remains with T3.
