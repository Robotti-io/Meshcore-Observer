# Issue #14 — MetricsStore maintainability review

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/14](https://github.com/Robotti-io/Meshcore-Observer/issues/14)

## Implementation Plan

### 1. Feature Summary

Assess whether `MetricsStore`'s metrics, bot replies, node registry, flood-advert scheduler, migrations, and reporting methods have clear ownership boundaries; extract only where clarity or testability materially improves.

### 2. Relevant Existing Architecture

- `src/metrics/store.js` is the always-on `node:sqlite` owner and applies ordered, transactional schema migrations.
- Current schema stores metrics samples, reply lifecycle/pending state, nodes, and one durable flood-advert state row.
- Services receive the store through constructor arguments and use narrow purpose-built methods; there is no generic SQL passthrough.
- Persistence is a protected boundary. `AGENTS.md` says queryable feature state belongs in this store and forbids adding persistence dependencies.

### 3. Proposed Approach

Inventory responsibilities, method groups, transaction boundaries, migrations, and test seams. Keep one database owner and centralized migrations. Consider repository objects only as narrow facades over the existing connection if they clarify ownership without duplicating schema lifecycle or exposing arbitrary queries. Use issue #10 coverage results to find indirectly tested persistence behavior; avoid size-only extraction.

### 4. Impacted Areas

- Review: `src/metrics/store.js`, `src/metrics/sampler.js`, `src/metrics/stats-reporter.js`, `src/nodes/node-registry.js`, `src/bots/reply-queue.js`, `src/radio/flood-advert-scheduler.js`.
- Tests: `test/metrics/store.test.js`, plus service persistence tests.
- Any schema/migration change requires explicit approval and migration/restart coverage.

### 5. Task Breakdown

#### T1: Map persistence responsibilities and coupling

- **Objective:** Identify seams that improve ownership or testability.
- **Specific changes:** Group SQL methods/tables by consumer; inspect migration transactions, prepared statements, query/result contracts, and tests that reach behavior only indirectly.
- **Definition of done:** Candidate boundaries and reasons are recorded, including reasons to retain current shape.
- **Expected tests / validation:** Review source and migration/recovery coverage; no schema edits.

#### T2: Decide whether to extract

- **Objective:** Select the minimum useful change.
- **Specific changes:** Document keep/extract decisions per concern and ensure migrations remain centralized with one DB owner.
- **Definition of done:** Scope is limited to demonstrated clarity/testability benefits; no file-size-only refactor.
- **Expected tests / validation:** Decision review against maintainability and persistence constraints.

#### T3: If justified, extract a narrow persistence facade

- **Objective:** Separate a proven concern without changing persistence semantics.
- **Specific changes:** Move selected methods behind a focused module while sharing the store connection and migration lifecycle; preserve parameterized SQL and startup failure behavior.
- **Definition of done:** Callers retain the same observable behavior and no duplicated DB ownership is introduced.
- **Expected tests / validation:** Fresh DB, existing v2.3 DB migration, restart, transaction/error, and consumer tests.

### 6. Risks and Edge Cases

- A facade can accidentally create separate transactions or database ownership.
- Migration order and forward compatibility are sensitive for deployed SQLite files.
- Tests that use shared persistent files can mask upgrade defects.
- Node registry current-state semantics and pending reply durability must remain intact.

### 7. Open Questions / Assumptions

- Which responsibilities show actual ownership friction today?
- Do any proposed changes require a database schema change? If so, obtain explicit storage approval before implementation.
- Assumption: this review does not authorize a migration or data-model change.

### 8. Suggested Execution Order

1. T1 — map current seams and evidence.
2. T2 — record retain/extract decision.
3. T3 — implement a narrow extraction only if the decision supports it.
