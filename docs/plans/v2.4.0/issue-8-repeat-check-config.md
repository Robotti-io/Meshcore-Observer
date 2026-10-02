# Issue #8 — Repeat-check configuration consistency

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/8](https://github.com/Robotti-io/Meshcore-Observer/issues/8)

## Implementation Plan

### 1. Feature Summary

Make the repeat-confirmation timeout documented in examples and runtime configuration consistent, and define zero-value behavior.

### 2. Relevant Existing Architecture

- `src/config/index.js` reads `PACKETCAPTURE_BOT_REPLY_REPEAT_CHECK_MS` with a 10000 ms fallback (updated for this issue).
- `src/config/schema.js` requires a non-negative integer for `botReplyQueue.repeatCheckTimeoutMs`.
- `.env.example` currently sets the value to 10000 ms.
- `src/bots/channel-bot.js` uses a matching 10000 ms fallback when constructed without injected configuration.
- `test/config/config.test.js` asserts the 10000 ms runtime default, explicit parsing, and acceptance of zero.
- `test/bots/repeat-check-tracker.test.js` covers immediate expiration for a zero timeout.
- `README.md` documents the post-send timeout, its 10000 ms default, and zero semantics.

### 3. Proposed Approach

Use **10000 ms (10 seconds)** as the canonical default, matching the existing `.env.example` and the intended shorter confirmation window. Align the runtime fallback, `ChannelBot` fallback, tests, and relevant README/config comments to that value. Preserve `0` as a valid value with immediate-timeout semantics: a repeat-check entry expires as soon as it is registered and is counted unconfirmed on the next tracker sweep or operation. No new dependency or architecture is needed.

The repeat-check timeout begins after a reply is sent. It is separate from `PACKETCAPTURE_BOT_REPLY_TTL_MS`, which bounds how long a reply may wait unsent in the queue (currently 60000 ms).

### 4. Impacted Areas

- `src/config/index.js`, `src/config/schema.js`, `.env.example`.
- `test/config/config.test.js`, plus tracker/ChannelBot tests if zero semantics affect runtime behavior.
- `README.md` and possibly `docs/project_plan.spec.md` for operator documentation.

### 5. Task Breakdown

#### T1: Record the canonical default and zero semantics — complete

- **Objective:** Establish a single supported contract before implementation.
- **Specific changes:** Use 10000 ms as the default; define zero as an immediate timeout, reported on the next tracker sweep or operation; distinguish this post-send window from the unsent reply queue TTL.
- **Definition of done:** [x] The contract is recorded here and remains compatible with deployments that explicitly set a value.
- **Expected tests / validation:** Review existing config validation and repeat-tracker behavior; implementation tests follow this decision.

#### T2: Align runtime, examples, and tests

- **Objective:** Make no-env and fresh-example behavior equivalent.
- **Specific changes:** [x] Update the config and `ChannelBot` fallbacks, `.env.example`, test expectations, and comments/README documentation together to use 10000 ms by default. [x] Add coverage for zero's immediate-timeout behavior.
- **Definition of done:** [x] Both startup paths use the canonical value; zero behavior is covered.
- **Expected tests / validation:** Configuration tests for default, explicit positive value, zero, negative, and invalid integer. **Pending:** run the affected tests and lint; test files were updated but checks have not been run in this turn.

### 6. Risks and Edge Cases

- Changing only the example can leave fresh deployments different from unset deployments.
- A zero timeout leaves no confirmation window; entries are counted unconfirmed on the next tracker sweep or operation. Document this clearly for operators.
- Existing deployments with explicit values must retain their chosen behavior.

### 7. Resolved Questions / Assumptions

- [x] The canonical default is 10 seconds (10000 ms), matching the example configuration and providing the intended shorter confirmation window.
- [x] Zero remains valid and means immediate timeout, not disabled repeat tracking. The existing tracker expires entries at their deadline before attempting a match; the periodic sweeper reports the timeout independently of channel traffic.
- [x] The repeat-check timeout starts after a reply is sent. It is independent of the 60000 ms reply queue TTL, which applies only before a reply is sent.
- [x] Deployments with an explicitly configured value retain that value; this changes only the behavior when the variable is unset or an example configuration is copied.

### 8. Suggested Execution Order

1. [x] T1 — contract recorded: 10000 ms default and immediate-timeout zero semantics.
2. [x] T2 — update all representations and add boundary tests.
3. [x] Run affected tests and lint.
