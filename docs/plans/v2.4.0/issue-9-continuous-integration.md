# Issue #9 — Continuous integration

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/9](https://github.com/Robotti-io/Meshcore-Observer/issues/9)

Issue #10's test and coverage tooling decision is complete. Issue #9 will use the Vitest scripts and thresholds established there.

## Implementation Plan

### 1. Feature Summary

Run deterministic lint, test, and threshold-enforced coverage checks on GitHub Actions for pull requests targeting `main` and pushes to `main`, using Ubuntu and Windows runners and retaining diagnostic reports on failure.

### 2. Relevant Existing Architecture

- `package.json` provides `npm run lint` (`eslint .`), `npm test` (Vitest without coverage), and `npm run test:ci` (Vitest with Istanbul coverage and thresholds). Node >=22.13.0 is required for `node:sqlite`.
- Tests are under `test/` and use Vitest with Node's built-in `node:assert/strict`.
- `vitest.config.js` includes every `src/**/*.js` file and enforces global minimums of 72% statements, 71% branches, 73% functions, and 73% lines. `reportOnFailure` generates JUnit and coverage reports when a test or threshold fails.
- `npm run test:ci` writes `artifacts/junit.xml` and reports under `coverage/` (Cobertura, LCOV, JSON, and HTML). Both directories are gitignored and can still be uploaded by a workflow.
- This repository currently has no CI workflow. The human has explicitly selected GitHub Actions for this project and overridden the conflicting GitLab-template instruction for this CI work.
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

#### T2: Add lint and test jobs

- [x] Add the main-only GitHub Actions workflow with read-only contents permission, an independent Ubuntu/Node 24.x lint job, and the four-entry Ubuntu/Windows × Node 22.x/24.x coverage-test matrix.
- [ ] Validate the workflow through a pull request targeting `main` and a push to `main`; confirm all matrix entries install and pass. GitHub execution is pending because this implementation has not been pushed.
- **Objective:** Make baseline quality checks automatic.
- **Specific changes:** Add `.github/workflows/ci.yml` for the agreed pull-request and push events. Run `npm ci` and `npm run lint` in an independent lint job. Run `npm ci` and `npm run test:ci` in a matrix of `ubuntu-latest` and `windows-latest` with Node 22.x and 24.x. Set `permissions: contents: read`; no secrets are required by the test suite. Report uploads remain in T3.
- **Definition of done:** Lint passes and the full coverage-enforcing test command passes in all four OS/Node combinations; failures are surfaced as distinct check results.
- **Expected tests / validation:** [x] Inspect the workflow structure and confirm the intended triggers, jobs, and matrix are declared. [ ] Review a main-targeting PR run plus a push-to-main run. [ ] Confirm all matrix combinations execute `npm ci` and pass `npm run test:ci`.

#### T3: Add coverage artifacts and required statuses

- [ ] Task pending implementation.
- **Objective:** Make test/coverage reports available to reviewers.
- **Specific changes:** Upload `artifacts/junit.xml`, `coverage/cobertura-coverage.xml`, `coverage/lcov.info`, `coverage/coverage-final.json`, and `coverage/index.html` using an unconditional upload step and unique names for each OS/Node matrix job. Use the repository's configured artifact-retention policy unless maintainers specify another duration. After the workflow is stable, require the lint and matrix checks for pull requests to `main`.
- **Definition of done:** Reports are downloadable from successful and intentionally failing workflow runs; required check names are stable and block merging to `main`.
- **Expected tests / validation:** Verify report files from one successful run and one run intentionally failing the coverage threshold. Then verify GitHub marks the chosen checks as required for a pull request to `main`.

#### T4: Document CI operation and maintenance

- [ ] Task pending implementation.
- **Objective:** Keep local and CI validation instructions aligned.
- **Specific changes:** Document workflow triggers, matrix, report paths, and required check names in README. Record how Node-line or runner changes should be reviewed and keep CI validation separate from application deployment behavior.
- **Definition of done:** README and Issue #9 plan match the committed workflow, with no obsolete `node:test` or `npm test`-only CI assumptions.
- **Expected tests / validation:** Review documentation against a completed workflow run and verify YAML/workflow checks pass.

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
2. [ ] T2 — add lint and coverage-enforcing Windows/Linux matrix jobs (workflow authored; GitHub run validation pending).
3. [ ] T3 — upload reports on success and failure; validate an intentionally failing threshold run and then require stable checks.
4. [ ] T4 — update README and plan documentation to match the workflow.
