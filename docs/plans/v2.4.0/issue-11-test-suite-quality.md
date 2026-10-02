# Issue #11 — Test-suite structure and quality

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/11](https://github.com/Robotti-io/Meshcore-Observer/issues/11)

## Implementation Plan

### 1. Feature Summary

Improve test organization, determinism, cleanup, diagnostics, and isolation while preserving the current meaningful `node:test` behavior unless the separate issue #10 tooling decision explicitly approves a runner change.

### 2. Relevant Existing Architecture

- Tests mirror source domains under `test/` and use `node:test`.
- `test/fixtures/packet-frames.js` supplies packet fixtures; many tests already use injected clocks and temporary SQLite databases.
- Services own intervals, event listeners, MQTT clients, HTTP servers, sockets, and `MetricsStore`, all of which require deterministic lifecycle cleanup.
- Issue #10 proposes a Vitest migration, while issue #11 advises against runner fragmentation; issue #10's framework/dependency conflict must be resolved first.

### 3. Proposed Approach

Audit test boundaries and cleanup first. Add small composable helpers only where repeated setup obscures intent; preserve domain folders and introduce behavioral category suffixes incrementally. Use injected clocks for domain timestamps and fake timers only for timer APIs. Strengthen bootstrap and hardware-adjacent simulation coverage without creating a parallel test architecture.

### 4. Impacted Areas

- `test/**` and possibly `test/helpers/**` as concrete duplication is identified.
- Runner config and `package.json` only after issue #10 decision.
- `src/index.js` only if an application lifecycle seam is justified by testability and ownership clarity.

### 5. Task Breakdown

#### T1: Audit organization and assertions

- **Objective:** Identify structural problems with evidence.
- **Specific changes:** Inventory test categories, names, shared state, weak assertions, flaky sleeps, hidden setup, and order assumptions; record incremental naming guidance.
- **Definition of done:** Review findings distinguish high-value fixes from stylistic renames.
- **Expected tests / validation:** Review existing suite and sample reporter output; no wholesale file renaming.

#### T2: Standardize resource cleanup and isolation

- **Objective:** Ensure each test owns resources it creates.
- **Specific changes:** Address unclosed SQLite stores, timers, listeners, MQTT clients, servers, sockets, temp paths, and environment changes; add narrow helper functions only for repeated concepts.
- **Definition of done:** Repeated suite runs leave no active resources or cross-test state.
- **Expected tests / validation:** Run full suite repeatedly and under supported concurrency; check for leaked handles/flakes.

#### T3: Improve deterministic time and failure coverage

- **Objective:** Test lifecycle/state transitions at meaningful boundaries.
- **Specific changes:** Replace unnecessary real sleeps; cover bootstrap failure ordering, clean shutdown, restart, radio/MQTT failures, and realistic packet/reconnect simulations.
- **Definition of done:** High-risk behaviors have observable assertions and hardware-only assumptions are documented.
- **Expected tests / validation:** Targeted tests under the selected runner and repeated full-suite execution.

### 6. Risks and Edge Cases

- Broad renaming can create noisy diffs without improving proof quality.
- Excessive shared setup hides test conditions and introduces coupling.
- Global fake timers can disrupt `node:sqlite` or asynchronous I/O tests.
- Bootstrap extraction solely for coverage would violate the issue's maintainability intent.

### 7. Open Questions / Assumptions

- Which runner is selected by issue #10, and can existing tests migrate incrementally?
- Which test categories actually need separate execution settings, if any?
- Assumption: test naming can evolve incrementally and existing domain folders remain understandable.

### 8. Suggested Execution Order

1. T1 — audit evidence before reorganizing.
2. T2 — fix isolation and cleanup foundations.
3. T3 — add deterministic lifecycle and simulation coverage.
