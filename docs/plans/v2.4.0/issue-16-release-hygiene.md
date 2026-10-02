# Issue #16 — Repository and release hygiene

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/16](https://github.com/Robotti-io/Meshcore-Observer/issues/16)

Blocked by issues #7–#15 as stated in the release plan.

## Implementation Plan

### 1. Feature Summary

Complete the documentation, licensing, example/config consistency, contribution guidance, and v2.4.0 release preparation after the substantive release issues are resolved.

### 2. Relevant Existing Architecture

- `package.json` declares ISC; no root `LICENSE` file is present.
- `README.md` contains install, configuration, operational, and feature guidance; `.env.example`, `brokers.config.example.json`, and `bots.config.example.json` are operator-facing configuration examples.
- Existing detailed architecture documents live under `docs/`, including `docs/project_plan.spec.md`; feature plans are under `docs/plans/`.
- Release plan explicitly blocks this work on issues #7–#15; CI/deployment changes remain subject to the repository's GitLab/shared-template requirements.

### 3. Proposed Approach

Treat this as a final consistency and release-preparation pass after upstream behavior/tooling decisions settle. Verify every documented default and upgrade note against runtime config and the actual v2.4 changes. Add the ISC license text matching package metadata, concise contributor workflow guidance if it fills a real gap, stale-architecture corrections, test/coverage commands for the selected stack, and release notes with v2.3 compatibility guidance. Avoid unrelated documentation rewrites.

### 4. Impacted Areas

- New `LICENSE`; possible `CONTRIBUTING.md`.
- `README.md`, `.env.example`, broker/bot examples, `docs/project_plan.spec.md`, `package.json` version, and v2.4.0 release notes/changelog location.
- CI instructions only after issue #9 platform decision.

### 5. Task Breakdown

#### T1: Audit repository metadata and stale documentation

- **Objective:** Identify concrete release-hygiene gaps.
- **Specific changes:** Compare package license/version, current runtime defaults, examples, README setup/upgrade steps, and v1-to-v2 references.
- **Definition of done:** Findings are mapped to specific files and confirmed behavior.
- **Expected tests / validation:** Cross-check examples with AJV schemas and package scripts; search docs for stale commands/config names.

#### T2: Align license, contribution, examples, and developer docs

- **Objective:** Make repository guidance accurate and usable.
- **Specific changes:** Add ISC `LICENSE`; add lightweight `CONTRIBUTING.md` only if useful; update README, examples, and architecture docs for settled v2.4 behavior and test commands.
- **Definition of done:** Examples validate; docs agree with runtime and CI decisions; no secrets are added.
- **Expected tests / validation:** Parse example configs with existing loaders/tests; verify documented npm scripts exist.

#### T3: Prepare release metadata and notes

- **Objective:** Produce a reviewable upgrade path for v2.4.0.
- **Specific changes:** Update package version when release scope is complete; write release notes covering changes, migration/config compatibility, Node requirement, and known limitations.
- **Definition of done:** Version and release notes match merged functionality and release exit criteria.
- **Expected tests / validation:** Run approved release checks and inspect the final diff; confirm GitLab/container assumptions remain intact.

### 6. Risks and Edge Cases

- Updating examples before config semantics settle can leave them stale again.
- Version bumps or release files changed early can misrepresent incomplete work.
- An ISC license file must match the declared license and appropriate copyright holder/year.
- CI documentation must reflect the platform selected under repository governance.

### 7. Open Questions / Assumptions

- Where should release notes live: GitHub release draft, changelog file, or both?
- Is a `CONTRIBUTING.md` needed beyond concise guidance in the README?
- What copyright name/year should the ISC license use?
- Assumption: issue #16 remains sequenced after #7–#15; its blocked-by list is intentional.

### 8. Suggested Execution Order

1. T1 — audit after substantive decisions are stable.
2. T2 — align repository guidance, examples, and license.
3. T3 — bump version and prepare release notes at release-candidate time.
