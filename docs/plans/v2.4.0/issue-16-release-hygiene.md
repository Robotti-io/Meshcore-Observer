# Issue #16 — Repository and release hygiene

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/16](https://github.com/Robotti-io/Meshcore-Observer/issues/16)

The release plan tracks Issues #7–#15 as release dependencies. Per the user's decision, Issue #16 preparation may proceed before merge so the release is ready for review. Prepare the release candidate in the PR; validate post-merge CI and required checks before creating the actual GitHub Release.

## Implementation Plan

### 1. Feature Summary

Complete the documentation, licensing, example/config consistency, contribution guidance, and v2.4.0 release preparation so the candidate is ready for merge and post-merge validation.

### 2. Relevant Existing Architecture

- `package.json` declares ISC and names Robotti Tech Services as the author; no root `LICENSE.txt` file is present. The dependency lockfile lists permissive runtime dependencies. Its MPL-2.0 packages are the development-only `lightningcss` dependency and optional platform variants; `caniuse-lite` is development-only under CC-BY-4.0. This inventory does not require relicensing the application, so retain ISC.
- `README.md` contains install, configuration, operational, and feature guidance; `.env.example`, `brokers.config.example.json`, and `bots.config.example.json` are operator-facing configuration examples.
- Existing detailed architecture documents live under `docs/`, including `docs/project_plan.spec.md`; feature plans are under `docs/plans/`.
- Issue #16 preparation can proceed before merge; post-merge CI validation and required-check confirmation gate creating the GitHub Release. GitHub Actions is the selected CI platform under Issue #9; keep container build/deployment concerns separate and aligned with repository governance.

### 3. Proposed Approach

Treat this as a focused consistency and release-preparation pass. Verify every documented default and upgrade note against runtime config and the actual v2.4 changes. Retain ISC and add a root `LICENSE.txt` containing the standard ISC license text with `Copyright (c) 2026 Robotti Tech Services`; add a lightweight `CONTRIBUTING.md`; correct stale architecture and CI guidance; and prepare v2.3 compatibility and upgrade notes for the GitHub Release draft only. Prepare version/release metadata in the PR, but do not create the actual GitHub Release until the PR is merged and post-merge CI and required checks pass. Avoid unrelated documentation rewrites.

### 4. Impacted Areas

- New ISC `LICENSE.txt` (`Copyright (c) 2026 Robotti Tech Services`) and `CONTRIBUTING.md`.
- `README.md`, `.env.example`, broker/bot examples, `docs/project_plan.spec.md`, and `package.json` version.
- GitHub Release draft content; no checked-in changelog.
- CI guidance follows the settled GitHub Actions decision. Container build/deployment guidance stays separate.

### 5. Task Breakdown

#### T1: Audit repository metadata and stale documentation — complete

- **Objective:** Identify concrete release-hygiene gaps.
- **Specific changes:** Compare package license/version, current runtime defaults, examples, README setup/upgrade steps, and v1-to-v2 references.
- **Definition of done:** Findings are mapped to specific files and confirmed behavior. **Complete (2026-10-04).**
- **Expected tests / validation:** Cross-check examples with AJV schemas and package scripts; search docs for stale commands/config names.
- **Result (2026-10-04):** Confirmed ISC remains appropriate for runtime dependencies; identified the development-only MPL tooling and CC-BY data dependency; confirmed README already documents the Node minimum, CI matrix, and npm scripts; found the README's `#echo` sample did not match `bots.config.example.json`; confirmed no upgrade procedure, `LICENSE.txt`, or contributor guide existed. Broker example fields and bot example fields align with the centralized schemas by inspection. GitHub Actions is authoritative for code CI; the old project specification is now labeled as historical context.

#### T2: Align license, contribution, examples, and developer docs — complete

- **Objective:** Make repository guidance accurate and usable.
- **Specific changes:** Add ISC `LICENSE.txt` with the confirmed holder/year and standard ISC text; add `CONTRIBUTING.md`; update README, examples, and architecture docs for settled v2.4 behavior and test commands.
- **Definition of done:** Examples and docs agree with runtime and CI decisions; no secrets are added. **Complete (2026-10-04).**
- **Expected tests / validation:** Parse example configs with existing loaders/tests; verify documented npm scripts exist.
- **Result (2026-10-04):** Added the standard ISC `LICENSE.txt`, a focused `CONTRIBUTING.md`, README v2.3.x upgrade guidance, and links to the contributor guide and license. Aligned the bot example channel with the README. Marked `docs/project_plan.spec.md` as historical and clarified the current CI/deployment boundary. The README-documented scripts were checked against `package.json`; examples were reviewed against their schemas. Automated tests were not run for this documentation/metadata change.

#### T3: Prepare release metadata and notes — version set; GitHub draft pending

- **Objective:** Produce a reviewable upgrade path for v2.4.0.
- **Specific changes:** Update package version when release scope is complete and prepare the notes in a GitHub Release draft. Cover changes, migration/config compatibility, Node requirement, and known limitations. Do not create the actual release until after merge and successful post-merge CI/required checks.
- **Definition of done:** Version and draft notes match the merge-ready functionality and release exit criteria; the release remains unpublished until post-merge validation passes.
- **Expected tests / validation:** Run approved release checks and inspect the final diff; confirm GitHub Actions guidance and container/deployment assumptions remain consistent.
- **Progress (2026-10-04):** Set `package.json` and `package-lock.json` to v2.4.0. The GitHub Release draft remains to be prepared because the GitHub CLI in this environment is not authenticated. Release-note content has not been copied into the repository; publication remains gated on merge and post-merge validation.

### 6. Risks and Edge Cases

- Updating examples before config semantics settle can leave them stale again.
- Version bumps or release files changed early can misrepresent incomplete work.
- An ISC license file must match the declared license and appropriate copyright holder/year.
- CI documentation must reflect the platform selected under repository governance.

### 7. Open Questions / Assumptions

- [x] Release notes live only in the GitHub Release; repository plans remain the detailed change record. Prepare a draft before merge, then create the actual release only after merge and passing post-merge checks.
- [x] Add a separate, lightweight `CONTRIBUTING.md`.
- [x] Retain ISC after reviewing the lockfile: runtime dependencies are permissively licensed; the MPL-2.0 packages are development-only and the CC-BY-4.0 package is development-only.
- [x] Add a formal root `LICENSE.txt` using the standard ISC text; its copyright line is `Copyright (c) 2026 Robotti Tech Services`, matching the `package.json` author and current release year.
- [x] Sequencing: Issue #16 preparation proceeds before merge to avoid a release-preparation/merge deadlock; post-merge CI and required-check validation gate the actual GitHub Release.

### 8. Suggested Execution Order

1. [x] T1 — audit repository metadata, examples, runtime documentation, and CI/deployment guidance.
2. [x] T2 — add license/contributor guidance and align README/examples.
3. T3 — prepare the GitHub Release draft; keep it unpublished until after merge and post-merge CI/required-check validation.
