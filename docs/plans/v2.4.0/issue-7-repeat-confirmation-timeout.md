# Issue #7 — Reply repeat-confirmation timeout semantics

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/7](https://github.com/Robotti-io/Meshcore-Observer/issues/7)

## Implementation Plan

### 1. Feature Summary

Make every sent reply transition to unconfirmed shortly after its configured repeat-check timeout, even on a quiet channel. Preserve exact-once accounting, confirmation precedence, bounded pending state, and diagnostic-only behavior.

### 2. Relevant Existing Architecture

- `RepeatCheckTracker` holds a bounded, in-memory map; it now also exposes `sweepExpired()` and reports timeout expiration separately from capacity eviction.
- `ChannelBot` registers after a successful radio send, increments `repeatsConfirmed` on a matching packet, and increments `repeatsUnconfirmed` only when the configured timeout expires. Capacity evictions are logged separately.
- `RepeatCheckSweeper` owns one unreferenced, one-second timer for all enabled bots. `src/index.js` starts it with the bots and stops it during shutdown.
- Tests use injected clocks for deterministic timing.

### 3. Proposed Approach

An explicit tracker sweep operation is wired through one lifecycle-managed periodic sweep across all enabled bots. The configured repeat-check timeout remains the full interval in which a repeat may confirm the reply; the sweep cadence only bounds how late the unconfirmed counter is updated after that timeout has elapsed. The application uses one unreferenced timer with a fixed one-second cadence, never one timer per entry. Capacity evictions are logged separately so they do not inflate `repeatsUnconfirmed`. Pending checks and counters remain process-local and are discarded/reset on restart.

### 4. Impacted Areas

- `src/bots/repeat-check-tracker.js`, `src/bots/channel-bot.js`, and `src/bots/repeat-check-sweeper.js` implement tracking, accounting, and the shared timer.
- `src/index.js` starts and stops the sweeper as part of application lifecycle.
- `test/bots/repeat-check-tracker.test.js`, `test/bots/channel-bot.test.js`, and `test/bots/repeat-check-sweeper.test.js` cover tracker, bot, and timer behavior.

### 5. Task Breakdown

Implementation and regression-test authoring are complete. The full automated suite passed, including the application-shutdown wiring assertion.

- [x] `npm.cmd run lint` passed.
- [x] `npm.cmd test` passed: 469 tests, 0 failures.

#### T1: [x] Define expiration and overflow outcomes — implementation, tests, and validation complete

- **Objective:** Make timeout and capacity-removal accounting unambiguous.
- **Specific changes:**
  - [x] Add `sweepExpired()` returning expired metadata.
  - [x] Return capacity-evicted metadata separately from timeout-expired metadata.
  - [x] Keep capacity evictions out of `repeatsUnconfirmed` and report them through a separate warning.
  - [x] Preserve oldest-first handling for duplicate plaintext entries.
- **Definition of done:**
  - [x] A confirmed entry is consumed and cannot later expire.
  - [x] Timeout and capacity outcomes are distinct.
  - [x] The tracker remains bounded by its maximum entry count.
- **Expected tests / validation:**
  - [x] Add tracker tests for timeout boundaries, duplicate entries, overflow, and confirmation before expiry.
  - [x] Run tracker tests as part of the full suite; passed.

#### T2: [x] Connect one periodic sweep to bot lifecycle — implementation, tests, and validation complete

- **Objective:** Process timeouts without RF or reply activity.
- **Specific changes:**
  - [x] Add one application-wide, unreferenced timer with a fixed one-second cadence to sweep all enabled bots.
  - [x] Stop the timer idempotently during application shutdown; do not create per-reply timers.
  - [x] Keep one bot's sweep failure from preventing other enabled bots from being swept.
  - [x] Preserve the configured repeat-check timeout as the full confirmation window; the sweep adds at most roughly one second plus event-loop delay to timeout reporting.
- **Definition of done:**
  - [x] The application wiring starts and stops the sweeper.
  - [x] Tests cover the one-second cadence, unreferenced timer, disabled bots, error isolation, and idempotent stop.
  - [x] Verify through the application entrypoint test that shutdown calls `RepeatCheckSweeper.stop()` after the enabled bot starts the sweeper.
- **Expected tests / validation:**
  - [x] Add fake-time/channel tests for expiration without another packet and sweeper timer lifecycle.
  - [x] Run the affected tests as part of the full suite; passed.

#### T3: [x] Verify end-to-end repeat lifecycle — regression tests and full-suite validation complete

- **Objective:** Prove sent replies resolve once as confirmed or unconfirmed.
- **Specific changes:**
  - [x] Add ChannelBot coverage for quiet-channel timeout sweeps and separate capacity-eviction reporting.
  - [x] Retain coverage that a later matching packet confirms a reply only once.
- **Definition of done:**
  - [x] The implementation removes each resolved tracker entry, preventing it from being counted as both confirmed and unconfirmed.
  - [x] Execute focused ChannelBot coverage through the full test suite; passed.
- **Expected tests / validation:**
  - [x] Add or update focused ChannelBot regression tests.
  - [x] Run the full suite; passed.

### 6. Risks and Edge Cases

- A sweep timer cannot compensate for a confirmation window that is shorter than real RF relay delays; the configured timeout must remain long enough for the intended behavior.
- Identical plaintexts can have multiple pending entries and must resolve oldest-first.
- A clock moving backward must not cause double counting; expiration remains a one-way removal.
- Capacity eviction is currently reported through a warning and is not added to the health snapshot.

### 7. Resolved Questions and Assumptions

- [x] Capacity-evicted checks stay out of `repeatsUnconfirmed` and are reported through a separate warning.
- [x] One application-wide, unreferenced timer with a fixed one-second cadence sweeps all enabled bots. This bounds reporting delay after the configured repeat-check timeout; it is not the confirmation window.
- [x] Pending checks and repeat counters remain transient and are discarded or reset on process restart; no SQLite persistence is added.
- [x] The configured timeout remains the confirmation window. Its canonical default and the semantics of a configured zero belong to issue #8.

### 8. Validation Status

1. [x] Tracker, ChannelBot, and sweeper regression tests passed in the full suite.
2. [x] `npm.cmd test` passed with 469 tests and 0 failures.
3. [x] The application shutdown test verifies that SIGINT shutdown stops the sweeper; passed in the full suite.
