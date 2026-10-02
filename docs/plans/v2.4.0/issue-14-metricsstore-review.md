# Issue #14 — MetricsStore maintainability review

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/14](https://github.com/Robotti-io/Meshcore-Observer/issues/14)

## Implementation Plan

### Planning Decisions (2026-10-02)

- Keep this review evidence-only: do not extract code unless the inventory identifies a concrete ownership or testing benefit.
- Preserve the current service-facing `MetricsStore` API if an extraction is justified. Any focused repositories must share its SQLite connection and migration lifecycle.
- Evaluate a schema or data-model change only if repository evidence supports it. Because storage changes are a protected boundary, obtain separate explicit human approval before implementing any such change.
- T1 and T2 concluded that the current persistence design should remain unchanged. T3 is scoped to the demonstrated dashboard reporting gap and does not change persistence.

### 1. Feature Summary

Assess whether `MetricsStore`'s metrics, bot replies, node registry, flood-advert scheduler, migrations, and reporting methods have clear ownership boundaries; extract only where clarity or testability materially improves.

### 2. Relevant Existing Architecture

- `src/metrics/store.js` is the always-on `node:sqlite` owner and applies ordered, transactional schema migrations.
- Current schema stores metrics samples, reply lifecycle/pending state, nodes, and one durable flood-advert state row.
- Services receive the store through constructor arguments and use narrow purpose-built methods; there is no generic SQL passthrough.
- Persistence is a protected boundary. `AGENTS.md` says queryable feature state belongs in this store and forbids adding persistence dependencies.

### 3. Proposed Approach

Inventory responsibilities, method groups, transaction boundaries, migrations, callers, and test seams. Keep one database owner and centralized migrations. Consider repository objects only as narrow facades over the existing connection if they clarify ownership without duplicating schema lifecycle or exposing arbitrary queries. Use issue #10 coverage results to identify indirectly tested persistence behavior; avoid size-only extraction. Do not assume that a schema change is needed.

### 4. Impacted Areas

- Review: `src/metrics/store.js`, `src/metrics/sampler.js`, `src/metrics/stats-reporter.js`, `src/nodes/node-registry.js`, `src/bots/reply-queue.js`, `src/radio/flood-advert-scheduler.js`, and the dashboard command-reporting path in `src/web/`.
- Tests: `test/metrics/store.test.js`, service persistence tests, and dashboard command-reporting tests.
- Any schema/migration change requires explicit approval and migration/restart coverage.

### 5. Task Breakdown

#### T1 [x]: Map persistence responsibilities and coupling

- **Objective:** Identify seams that improve ownership or testability.
- **Specific changes:** Group tables and SQL methods by consumer; map service calls, migration and transaction boundaries, prepared statements, query/result contracts, and direct versus indirect test coverage. Record any concrete ownership friction or test limitation.
- **Definition of done:** Evidence and candidate boundaries are recorded, including reasons to retain the current shape; no refactor is inferred from file size alone.
- **Expected tests / validation:** Review source and migration/recovery coverage; no schema edits.
- **Result (2026-10-02):** `MetricsStore` owns one SQLite connection and transactional migration lifecycle; consumer services use purpose-built methods and have focused persistence tests. Reply reporting persists and groups the literal `trigger`. The dashboard already builds rows from validated bot command configuration, but `bucketBotCommandCounts()` folds configured commands after the seventh into `Other`, which hides valid per-trigger data from operators. The issue is presentation bucketing, not missing store data or command-kind mapping.

#### T2 [x]: Decide whether to extract

- **Objective:** Select the minimum useful change.
- **Specific changes:** Decide retain/extract per concern using T1 evidence. If extraction is proposed, define the smallest facade boundary, preserve the `MetricsStore` API used by services, and keep one connection and migration owner. Evaluate a schema/data change only if evidence calls for it, documenting the migration impact and approval needed.
- **Definition of done:** A documented decision says either retain the existing structure or identifies a narrowly scoped extraction with demonstrated clarity/testability benefit. Any schema/data proposal is explicitly marked as requiring separate approval before implementation.
- **Expected tests / validation:** Decision review against maintainability and persistence constraints.
- **Result (2026-10-02):** Retain the current `MetricsStore` design and schema; no repository extraction or migration is justified. Improve the existing data-driven dashboard reporting path so every configured command remains individually visible. This matches the operator preference to manage chart density by disabling commands per channel.

#### T3 [x]: Report every configured bot command individually

- **Objective:** Make the dashboard report every configured bot command by its trigger in both the chart and table, with no per-command frontend coding as commands are added.
- **Specific changes:** Remove the seven-command `Other` aggregation while retaining config order and zero-fill; support distinct chart colors beyond the current eight-color palette without adding command-specific mappings. Keep the existing MetricsStore API, schema, and trigger-based queries unchanged.
- **Definition of done:** Any configured command, including `!stats` when it falls after the seventh position, appears as an individual row and pie-chart category with its exact sent-reply count. Tests cover more than seven commands and preserve config ordering; no schema or data migration is introduced.
- **Expected tests / validation:** Dashboard bucketing and endpoint tests for more than seven configured commands, plus the project's test and lint scripts.
- **Result (2026-10-02):** Removed the seven-command aggregation, so the server returns every configured trigger with its exact count or zero-fill. Added deterministic HSL colors for chart categories beyond the existing eight-color palette; configured command order remains stable. A regression test confirms `!stats` in the eighth slot is reported individually. `npm.cmd test` passed (48 files / 493 tests), and `npm.cmd run lint` passed. No MetricsStore or schema changes were needed.

### 6. Risks and Edge Cases

- A facade can accidentally create separate transactions or database ownership.
- Migration order and forward compatibility are sensitive for deployed SQLite files.
- Tests that use shared persistent files can mask upgrade defects.
- Node registry current-state semantics and pending reply durability must remain intact.

### 7. Resolved Questions / Guardrails

- **Review scope:** Evidence-only. The review may recommend no code change; extraction requires a concrete ownership or testing benefit.
- **Service API:** Retain the existing `MetricsStore` API and focused consumer boundaries; current evidence does not justify extracting repositories.
- **Schema/data model:** Changes may be considered if repository evidence supports them, but this plan does not authorize implementation. Obtain separate explicit human approval before any schema or data-model change.
- **Decision point:** T1/T2 are complete: retain the store/schema and address the observed reporting loss at the dashboard bucketing seam. T3 is the approved, narrowly scoped dashboard change; any future schema/data proposal still requires separate explicit human approval.

### 8. Suggested Execution Order

1. T1 — map current seams and evidence.
2. T2 — record retain/extract decision.
3. T3 — implement and validate complete config-driven dashboard command reporting without changing persistence.
