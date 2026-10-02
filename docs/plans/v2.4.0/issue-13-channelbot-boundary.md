# Issue #13 — ChannelBot command-kind boundary

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/13](https://github.com/Robotti-io/Meshcore-Observer/issues/13)

## Implementation Plan

### 1. Feature Summary

Review whether `ChannelBot` remains an appropriate boundary as exact-response, repeater-lookup, and stats commands coexist; document a decision to refactor or retain the current structure.

### 2. Relevant Existing Architecture

- `src/bots/channel-bot.js` owns raw packet normalization, hop filtering, decryption, deduplication, command resolution, response rendering, queueing, and repeat confirmation.
- Reusable seams already exist for command templates, lookup registry (`NodeRegistry`), stats (`StatsReporter`), reply queue/dispatcher, channel setup, and repeat tracking.
- Bot configuration uses strict schemas in `src/bots/schemas.js`; `test/bots/channel-bot.test.js` covers behavior.
- Issue #10 coverage findings can inform testability gaps but must not dictate abstractions by percentage alone.

### 3. Proposed Approach

Perform a responsibility and change-cost review, map command-specific versus shared RF lifecycle work, and inspect duplication and test coupling. If separation materially improves independent testing or command extension, extract only command parsing/resolution/render context behind a small interface while leaving radio decode, hop filtering, deduplication, queueing, and lifecycle ownership centralized. Otherwise record the no-refactor decision with revisit triggers.

### 4. Impacted Areas

- Review: `src/bots/channel-bot.js`, `src/bots/schemas.js`, `src/bots/response-template.js`, `src/bots/reply-dispatcher.js`, `src/nodes/node-registry.js`, `src/metrics/stats-reporter.js`.
- Tests: `test/bots/channel-bot.test.js` and focused tests for any justified extracted command handlers.
- Decision record in issue/PR or this plan's follow-up notes.

### 5. Task Breakdown

#### T1: Map responsibilities, coupling, and extension cost

- **Objective:** Ground the decision in current code and expected growth.
- **Specific changes:** Trace command kinds from config through matching/resolution/render/send; identify repeated branches, dependencies, and tests that require unrelated radio behavior.
- **Definition of done:** Evidence and concrete pressure points are recorded; coverage findings are considered.
- **Expected tests / validation:** Review existing tests and representative command paths; no production changes.

#### T2: Record decision and rationale

- **Objective:** Close investigation without presuming extraction.
- **Specific changes:** Choose refactor/no-refactor, document evidence, tradeoffs, deferred work, and conditions to revisit.
- **Definition of done:** Decision record covers acceptance criteria and is linked from the issue or PR.
- **Expected tests / validation:** Review decision against existing command behavior and config compatibility.

#### T3: If justified, perform focused extraction

- **Objective:** Improve command ownership/testability with minimal structural change.
- **Specific changes:** Extract only the justified command-specific behavior; keep radio/channel responsibilities centralized and configuration compatible.
- **Definition of done:** Existing observable behavior is preserved; new command logic is independently testable.
- **Expected tests / validation:** Regression tests for exact, lookup, and stats commands; full suite and lint.

### 6. Risks and Edge Cases

- Premature handler abstraction may add indirection without lowering change cost.
- Moving matching can alter exact-trigger semantics, byte limits, lookup responses, or stats range behavior.
- Coverage gaps may reflect missing tests rather than a flawed production boundary.

### 7. Open Questions / Assumptions

- Is another command kind expected soon, or is the investigation intentionally based on current growth only?
- Where should the decision record live: GitHub issue/PR, repository architecture note, or both?
- Assumption: refactoring is optional and is not required to close the issue.

### 8. Suggested Execution Order

1. T1 — collect code/test evidence.
2. T2 — decide and document.
3. T3 — execute only when evidence justifies extraction.
