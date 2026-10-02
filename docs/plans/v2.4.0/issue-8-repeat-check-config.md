# Issue #8 — Repeat-check configuration consistency

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/8](https://github.com/Robotti-io/Meshcore-Observer/issues/8)

## Implementation Plan

### 1. Feature Summary

Make the repeat-confirmation timeout documented in examples and runtime configuration consistent, and define zero-value behavior.

### 2. Relevant Existing Architecture

- `src/config/index.js` reads `PACKETCAPTURE_BOT_REPLY_REPEAT_CHECK_MS` with a 30000 ms fallback.
- `src/config/schema.js` requires a non-negative integer for `botReplyQueue.repeatCheckTimeoutMs`.
- `.env.example` currently sets the value to 10000 ms.
- `test/config/config.test.js` asserts the 30000 ms runtime default and explicit parsing behavior.
- `README.md` describes operational settings but does not currently explain this timeout.

### 3. Proposed Approach

Choose one canonical value based on intended release behavior, then align the runtime fallback, `.env.example`, tests, and relevant README/config comments. Preserve `0` if intentionally supported and define whether it disables repeat tracking, expires immediately, or has another meaning before changing code. No new dependency or architecture is needed.

### 4. Impacted Areas

- `src/config/index.js`, `src/config/schema.js`, `.env.example`.
- `test/config/config.test.js`, plus tracker/ChannelBot tests if zero semantics affect runtime behavior.
- `README.md` and possibly `docs/project_plan.spec.md` for operator documentation.

### 5. Task Breakdown

#### T1: Decide the canonical default and zero semantics

- **Objective:** Establish a single supported contract.
- **Specific changes:** Record chosen default and define the meaning of zero, including its relation to periodic expiration.
- **Definition of done:** Contract matches issue acceptance criteria and remains compatible with existing explicit settings.
- **Expected tests / validation:** Review existing config validation and repeat-tracker behavior; no implementation test until the decision is recorded.

#### T2: Align runtime, examples, and tests

- **Objective:** Make no-env and fresh-example behavior equivalent.
- **Specific changes:** Update fallback, `.env.example`, test expectations, and comments/documentation together.
- **Definition of done:** Both startup paths yield the canonical value; zero behavior is covered.
- **Expected tests / validation:** Configuration tests for default, explicit positive value, zero, negative, and invalid integer.

### 6. Risks and Edge Cases

- Changing only the example can leave fresh deployments different from unset deployments.
- Setting zero may cause immediate expiration or disable confirmation; either behavior can materially alter metrics.
- Existing deployments with explicit values must retain their chosen behavior.

### 7. Open Questions / Assumptions

- Is 10 seconds or 30 seconds the intended canonical default?
- Should zero disable repeat confirmation, or mean immediate timeout?
- Assumption: this is a behavior/config clarification and does not require a breaking configuration change.

### 8. Suggested Execution Order

1. T1 — resolve product semantics.
2. T2 — update all representations and add boundary tests atomically.
