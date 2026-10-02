# Issue #13 — ChannelBot command-kind boundary

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/13](https://github.com/Robotti-io/Meshcore-Observer/issues/13)

## Planning decisions (2026-10-02)

- Future releases are expected to add bot command kinds and capabilities.
- The goal is a small, repeatable command extension seam that keeps shared bot orchestration understandable and prevents every new command kind from requiring new SQLite columns.
- The user approved a one-time SQLite migration to generic, strictly validated command state as part of the finalized plan before T1 began.
- Record the decision and evidence in this plan and mirror the outcome in the v2.4.0 release plan. Link the eventual PR or GitHub issue update when available.

## 1. Feature Summary

Review and improve the boundary between shared `ChannelBot` lifecycle work and command-kind-specific matching, resolution, and response preparation. Keep the radio event/decode, hop filtering, deduplication, shared reply queue, send lifecycle, and repeat confirmation responsibilities centralized where they are common. Make future command kinds addable through a small handler contract without command-specific database columns or a command plug-in framework.

## 2. Codebase Findings

- `src/bots/channel-bot.js` normalizes and decrypts raw packets, performs channel and hop checks, deduplicates, dispatches exact/lookup/stats matches, queues replies, and sends/render replies. `#handleRawPacket()` contains the kind-selection path; `sendQueuedReply()` selects lookup/stats/exact render behavior.
- Shared path: raw event normalization and GRP_TXT decode → channel match/decrypt → own-repeat confirmation → sender check → command match → min-hop gate → duplicate check → enqueue plain data → quiet-window queue dispatch → byte-budget render/send → register repeat check. These are common RF/reply lifecycle concerns, not command-handler responsibilities.
- Exact behavior: `#commands` performs a full-text exact match; the response and optional overflow template are selected from current command config at dispatch. Lookup behavior: parse trigger/query and resolve the registry at match time, then persist outcome/name/prefix/time/count data so a queued reply is stable across delay/restart. Stats behavior: parse only the range token at match time, persist it as `query`, and calculate the requested range and metrics at dispatch time so the response reflects current data.
- `NodeRegistry` and `StatsReporter` already keep storage access out of `ChannelBot` for lookup and stats data. These are useful seams to preserve.
- `src/bots/schemas.js` defines command kinds and their template fields; `src/bots/bots-config-loader.js` applies kind-specific required/forbidden field checks after AJV validation. Any new handler contract must preserve centralized strict validation and existing config compatibility.
- `ReplyQueue` intentionally accepts plain serializable data and persists pending replies through `MetricsStore`, so queued replies survive restarts. Replacing this with closures or non-serializable handler instances would break that guarantee.
- `bot_replies` stores shared lifecycle/metrics columns plus command-specific lookup state. SQLite migration 6 added `last_heard_at`, `node_prefix`, and `repeater_count` for lookup replies. This is the concrete schema-growth pressure the work should address.
- Based on current code, another command kind would likely touch the command-kind enum and field rules in `schemas.js`/`bots-config-loader.js`, command match and render branches in `ChannelBot`, persisted item shape/store SQL, and command-specific regression tests. This scattered change path is the extension cost to reduce.
- Dashboard reply metrics query shared fields such as `bot_name`, `trigger`, `status`, `resolved_at`, and `queued_ms`; these queries should not depend on a command kind's private context representation.
- `test/bots/channel-bot.test.js` exercises exact, lookup, and stats behavior alongside shared radio and queue lifecycle behavior. `test/metrics/store.test.js` covers migrations and queued reply persistence/recovery.
- `test/bots/channel-bot.test.js` has 47 tests; command-kind tests use a fake radio/EventEmitter, channel setup, encrypted GRP_TXT packet construction, and frame fixtures. This gives strong end-to-end regression coverage but couples command match behavior to RF setup. `sendQueuedReply()` can be exercised directly for selected dispatch cases; `response-template`, stats-range, registry, and reporter behavior also have focused module tests.
- A fourth command kind currently implies changes across strict command-kind/config validation, constructor handler collections, the matching chain, queued item fields, dispatch rendering, store mapping/SQL and likely a migration, plus packet-driven integration tests. The schema/migration impact is the clearest avoidable cost; the RF/queue path should stay shared.
- Initial review supports extracting command-specific matching/resolution/render preparation behind a small handler contract. It does not justify a plug-in framework or moving shared RF lifecycle into handlers. T2 should finalize the contract and the generic-state migration shape before implementation.

## 3. Proposed Approach

Use a small explicit handler map injected into the shared bot orchestration. Each handler owns command-kind-specific matching, resolution, and response preparation/rendering; `ChannelBot` retains shared radio, channel, hop, deduplication, queue, send, and repeat-check lifecycle. Handlers enqueue only plain JSON state in a versioned envelope: `{ kind, version, data }`. The selected handler validates and interprets the state on dispatch/resume.

The approved persistence strategy is one generic `handler_state_json` field in `bot_replies`, replacing the lookup-specific state columns through one versioned SQLite migration. Migrate existing rows without changing common lifecycle fields. Convert lookup rows to a lookup state snapshot, stats rows to a range state, and exact rows to empty exact state. Run the table rebuild and row conversion inside the existing per-version migration transaction; update `PRAGMA user_version` only on commit, so a failed migration rolls back and prevents startup on a partially transformed store. Dashboard queries remain based on shared fields such as bot, trigger, status, resolution time, and queue duration. New command kinds may extend centrally AJV-validated command configuration and add handler code/tests, but do not add command-specific database columns or migrations.

Handler contract:

- `match({ command, text })` returns `null` or a command-specific match result; command-specific lookup can resolve and snapshot data here, while stats captures its range for send-time calculation.
- The handler encodes a JSON-serializable `{ kind, version, data }` state. It does not enqueue callbacks, class instances, secrets, or radio lifecycle work.
- The selected handler validates the envelope and its kind/version-specific `data` with strict AJV schemas before using persisted state.
- `render({ command, data, sharedReply })` selects a template and supplies command-specific values. Shared `ChannelBot` rendering still applies the byte budget and sends the message.
- Unknown kinds, unsupported versions, malformed JSON, and invalid state fail dispatch through the existing queue failure path; they must not create a radio side effect or log state contents.

Do not add a new framework, implicit self-registration, per-handler timers, or handler-owned radio lifecycle. New command kinds still require centralized strict configuration validation and handler tests; this plan removes per-command database schema changes, not necessary config/schema code.

## 4. Scope and Constraints

- Preserve exact, lookup, and stats command behavior, configuration compatibility, byte-budget rendering, queue semantics, and restart recovery.
- Keep shared radio decoding, channel filtering, hop filtering, deduplication, enqueue/send lifecycle, and repeat confirmation in shared infrastructure.
- Keep command-specific dependencies behind handler/service seams; do not let the bot orchestration query `MetricsStore` directly.
- Keep queued handler state plain JSON data, bounded and validated; never persist functions, class instances, or radio secrets.
- Retain AJV strict validation for external bot configuration and add strict validation for persisted handler context before using it.
- No new dependencies, broad command redesign, or unrelated persistence refactor.

## 5. Implementation Plan

### T1: Audit command responsibilities and persistence coupling

- [x] Trace exact, lookup, and stats command paths from validated config through match, resolution, enqueue, persistence, dispatch, and rendering.
- [x] Record behavior that must remain common and command-specific.
- [x] Identify current coupling, duplicated logic, lifecycle risks, and tests that require unrelated radio setup.
- [x] Inspect migration/recovery behavior for pending rows and the dashboard queries that depend on common reply fields.
- **Definition of done:** A concise evidence map shows the cost of adding a fourth command kind and whether an extraction is justified.
- **Validation:** Code/test review only; no production edits.
- **T1 result (2026-10-02):** Evidence supports a focused command-handler extraction. The fourth-kind path currently crosses command schema/loading, matching, queue payload, dispatch rendering, and SQLite persistence. Current lookup state has dedicated fields added in migration 6. Existing shared packet, hop, dedup, queue, send, and repeat behavior is coherent and should remain centralized. Command behavior is covered, but matching tests run through raw encrypted radio fixtures; extracted handlers can add focused tests while integration tests retain RF lifecycle coverage.

### T2: Choose the handler contract and persistence strategy

- [x] Confirm the explicit handler map targets the observed `ChannelBot` kind-specific matching/rendering branches without adding a framework or lifecycle complexity.
- [x] Select one generic serialized `handler_state_json` field and one table migration as the smallest persistence change meeting the no-per-command-column goal.
- [x] Define the handler contract for matching, resolution timing, JSON state, strict validation, and dispatch-time rendering.
- [x] Keep shared event, RF, queue, send, and repeat lifecycle behavior outside handlers; keep metrics queries on common lifecycle columns.
- [x] Record migration conversion, pending-reply recovery, compatibility requirements, and failure behavior in this plan.
- **Definition of done:** The evidence audit confirms or revises the proposed design, and the plan specifies the schema/context contract and migration scope.
- **Approval:** User approved the finalized plan, including the one-time SQLite migration, before T1 began.
- **T2 result (2026-10-02):** The explicit handler map and generic versioned JSON state are selected. SQLite migration 8 will replace per-command lookup state columns with `handler_state_json`; existing reply lifecycle fields and dashboard queries remain stable. Existing pending and resolved rows will be converted based on their current markers (`lookup_outcome`, stats `query`, or exact default). The conversion runs transactionally; migration failure rolls back and leaves the prior database version intact. T3 can now implement this approved contract.

### T3: Implement the generic command boundary and one-time persistence migration

- [x] Extract current exact, lookup, and stats command-specific behavior behind the approved handler contract.
- [x] Keep `ChannelBot` as the shared radio/lifecycle orchestrator with a small, explicit handler dispatch path.
- [x] Add SQLite migration 8 to replace command-specific lookup state columns with `handler_state_json`; migrate existing pending and resolved row state while preserving reply lifecycle fields and metrics.
- [x] Strictly validate restored handler context before dispatch; reject unsupported context versions safely and observably without logging sensitive data.
- [x] Keep bot configuration backward compatible and preserve existing field validation.
- **Definition of done:** A command kind can be added with handler/config/tests and no new SQLite columns or migration; existing commands and persisted replies retain their behavior.
- **T3 result (2026-10-02):** Added exact, lookup, and stats handler modules with strict AJV validation of versioned state and a 4 KiB serialized-state bound. `ChannelBot` selects handlers from an explicit map while keeping shared RF and reply lifecycle work centralized. Migration 8 transactionally rebuilds `bot_replies`, converts legacy lookup/stats/exact rows to versioned JSON state, preserves IDs and lifecycle fields, and recreates dashboard indexes. Existing bot and store tests were updated for the generic state shape. Validation at T3 completion: all 47 test files / 484 tests passed and lint passed. T4 regression evidence is recorded below.

### T4: Add regression coverage and record the outcome

- [x] Preserve and test exact, lookup, and stats matching/resolution/rendering behavior.
- [x] Test generic context serialization, strict restoration validation, and queued reply recovery across restart.
- [x] Test migration 8 from the current database version with pending and resolved replies and verify common dashboard metrics.
- [x] Add a test demonstrating an additional handler context can be queued/restored without changing the database schema.
- [x] Run the full test suite and lint; update this plan and the v2.4.0 release plan with the decision and evidence.
- **Definition of done:** Acceptance criteria below pass and the decision record is complete.
- **T4 result (2026-10-02):** Added tests for all three built-in handler state codecs, malformed JSON, kind/version mismatch, extra properties, and the no-radio-send failure path. A custom `survey` handler codec is strictly validated and its queued context survives a store close/reopen without changing the table columns. ReplyQueue now has a close/reopen recovery test that dispatches the restored custom context. A v7 fixture migration preserves pending lookup state, resolved stats state, common lifecycle values, dashboard reply totals, and command counts. Additionally, a temporary copy of the ignored local `data/metrics.sqlite3` store was migrated: it began at `user_version=7` with 445 resolved `sent` rows and ended at version 8 with all 445 rows/statuses preserved, the generic state column present, and lookup-specific columns removed. The original store was not modified. Final validation: 48 test files / 492 tests passed; lint passed.

## 6. Acceptance Criteria

- [x] The boundary and extension cost are documented from repository evidence.
- [x] A minimal handler contract is implemented without adding a framework or making shared bot lifecycle harder to follow.
- [x] Adding a command kind does not require command-specific SQLite columns or a migration.
- [x] Exact, lookup, and stats observable behavior and bot config compatibility are preserved.
- [x] Pending replies remain restart-safe; any persisted command context is strictly validated before dispatch.
- [x] Shared reply lifecycle metrics continue to use common reply fields and existing dashboards remain compatible.
- [x] Tests cover existing kinds, shared lifecycle interactions, persistence/migration as applicable, and a future handler extension without schema change.
- [x] The decision, evidence, tradeoffs, and revisit triggers are recorded here and mirrored in the release plan.

## 7. Risks and Edge Cases

- A generic context can become an unvalidated catch-all. Keep common state separate, apply strict handler-owned schemas, version persisted context, and bound serialized size.
- A queued reply can outlive a deployment/config change. Preserve enough stable handler identity/version to safely restore it; define an observable failure path for removed or incompatible handlers.
- Handler-specific work must not bypass min-hop filtering, deduplication, queue timing, response byte limits, or repeat confirmation.
- Migration must preserve pending and resolved reply history and keep dashboard queries based on common fields.
- A registry that adds indirection without reducing per-command changes would miss the goal; reject the design if it is not simpler to extend and test.

## 8. Resolved Questions and Assumptions

- [x] **Expected growth:** Future versions will likely add command kinds and bot capabilities; this issue should prepare a modular, repeatable boundary.
- [x] **Storage direction:** Implement one one-time generic-context migration; do not add columns for each new command kind. The user approved this migration in the finalized plan.
- [x] **Decision record:** This issue plan is the detailed decision record; mirror its outcome in `docs/plans/release-v2_4_0.plan.md` and link the eventual PR/issue update when available.
- **Approved design:** An explicit handler map plus a one-time migration to generic versioned JSON handler state; retain common queue/metrics columns and validate restored state through the selected handler.
- **Assumption:** The current user-facing commands and bot configuration remain compatible; new command kinds may add centrally validated config fields where needed, but must not require command-specific persistence columns.
- **Assumption:** The generic context stores only bounded JSON data. Each handler owns validation and interpretation; no callback or handler object is stored in SQLite.

## 9. Suggested Execution Order

1. [x] T1 — complete the evidence audit.
2. [x] T2 — finalize handler contract and migration strategy; user approval recorded.
3. [x] T3 — implement only the approved boundary and persistence design.
4. [x] T4 — verify regressions, persistence, and extension without schema changes; document results.
