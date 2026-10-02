# Issue #9 — Continuous integration

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/9](https://github.com/Robotti-io/Meshcore-Observer/issues/9)

Blocked by issue #10 (coverage workflow/tooling decision).

## Implementation Plan

### 1. Feature Summary

Run deterministic lint, test, and coverage checks for pull requests and relevant branch pushes, on Windows and Linux, with diagnostic reports retained on failure.

### 2. Relevant Existing Architecture

- `package.json` provides `npm test` (`node --test`) and `npm run lint` (`eslint .`). Node >=22.13.0 is required for `node:sqlite`.
- Tests are under `test/` and use built-in `node:test`.
- `.gitignore` excludes `coverage/`; the release plan also calls for CI report artifacts.
- Repository constitution requires container builds through shared GitLab CI/CD templates from main/development/production, while issue #9 proposes GitHub Actions for push/PR checks. This is a deployment/CI protected boundary and a repository-level instruction conflict to resolve before implementation.

### 3. Proposed Approach

After deciding the authoritative CI platform, add the smallest pipeline using repository scripts, pin the supported Node major/minor policy, run the agreed OS matrix, and upload JUnit/coverage artifacts even on failures when supported. Keep release/deployment container jobs separate from test validation unless the existing shared templates already provide the right seam.

### 4. Impacted Areas

- CI workflow/template files (location and platform pending decision).
- `package.json` scripts and lockfile only as required by issue #10.
- `.gitignore`, README status/documentation, and tests/artifact configuration.
- Container/GitLab templates only if the platform decision selects them.

### 5. Task Breakdown

#### T1: Resolve CI platform and branch policy

- **Objective:** Align requested CI with repository deployment governance.
- **Specific changes:** Decide GitHub Actions checks, GitLab shared templates, or an explicitly split validation/deployment arrangement; define trigger branches and PR source.
- **Definition of done:** Platform, branch triggers, Node version, and required status checks are agreed.
- **Expected tests / validation:** Review repository settings/template conventions; verify no pipeline is introduced before approval.

#### T2: Add lint and test jobs

- **Objective:** Make baseline quality checks automatic.
- **Specific changes:** Use `npm ci`, `npm run lint`, and `npm test` on Node >=22.13.0 across Windows and Linux, with platform-specific exclusions only when evidence supports them.
- **Definition of done:** Jobs run on PRs and configured branch pushes and report clear failures.
- **Expected tests / validation:** Execute the same scripts locally and inspect CI results on both operating systems.

#### T3: Add coverage artifacts and required statuses

- **Objective:** Make test/coverage reports available to reviewers.
- **Specific changes:** Integrate issue #10 scripts/report paths, upload reports with failure-tolerant conditions, and establish required checks after workflow stability.
- **Definition of done:** JUnit and agreed coverage files are retained; PR merge status reflects the checks.
- **Expected tests / validation:** Exercise passing and intentionally failing test/threshold runs in a branch pipeline.

### 6. Risks and Edge Cases

- Windows serial dependencies may differ from Linux even when tests are hardware-free.
- Node's built-in SQLite availability must be verified on both runners.
- Required-status configuration can block merging if jobs are renamed or skipped.
- GitHub Actions conflicts with the repository's stated GitLab build/deploy model.

### 7. Open Questions / Assumptions

- Which CI platform is authoritative for PR validation, given the project constitution's GitLab requirement?
- Which branches and fork PRs should receive checks, and should coverage be a required merge status immediately?
- Assumption: no deployment or image-build behavior changes are in scope for this issue.

### 8. Suggested Execution Order

1. T1 — resolve governance and triggers.
2. T2 — add stable OS-matrix checks.
3. T3 — wire reports and required-status policy after issue #10 is decided.
