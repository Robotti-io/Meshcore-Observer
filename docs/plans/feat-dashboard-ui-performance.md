# Feature: Dashboard UX and Performance Improvements

## Goals

- Reduce repeated browser requests and SQLite work caused by live dashboard refreshes.
- Prevent older, slower requests from overwriting data for a newer selected range.
- Make live values, selected-range values, loading, and stale-data states clear to users.
- Improve chart workload, accessibility, and narrow-screen usability while retaining the existing no-build-step browser architecture.
- Move from a single long dashboard to a high-level overview with dedicated detail sub-pages as the application grows.
- Keep one selected range consistent across all dashboard views during in-app navigation; reset it to the default only after a full page reload.
- Establish measurable validation for refresh behavior and representative browser rendering cost.

## Non-Goals

- Change metrics meaning, retention, sampling cadence, or the observer's packet-ingestion behavior.
- Redesign dashboard authentication, listener exposure, or other protected security boundaries.
- Add frontend frameworks, build tooling, or npm dependencies.
- Replace the dashboard or metrics storage architecture.

## Current State

- `src/web/client/dashboard.js` requests six range-scoped endpoints in `refreshRangeData()` and runs that refresh after every SSE message. The default sample interval is 10 seconds, so an open dashboard can make 36 range requests per minute (2,160 per hour), in addition to the SSE stream.
- The range requests are issued with `Promise.all`, but `MetricsServer` dispatch and `node:sqlite` `DatabaseSync` queries are synchronous on the Node event loop. Browser-side parallel requests therefore do not mean parallel database execution.
- Packet history already returns per-type counts by time bucket, while `/api/metrics/packet-types` performs another range query for packet-type totals. Bot command counts are queried once per configured bot.
- Refreshes have no cancellation, single-flight guard, or response-generation check. A slow refresh can overlap a later SSE refresh or a user-selected range change.
- `bootstrap()` waits for the initial snapshot, range queries, and repeater query before opening the EventSource connection.
- A Chart.js doughnut chart is created for every configured bot. Charts are updated and table bodies are rebuilt on range refreshes, including for offscreen sections.
- The page presents live gauges and range-scoped reports together. Notes describe their scopes, but there is no persistent selected-range context or last-updated/stale indicator. Range selection state is visual-only; charts have no text alternative. Tables do not have dedicated narrow-screen overflow containers.
- The dashboard is one long page. An in-page anchor menu would help short-term scanning but would not provide a structure that scales as new features are added.
- Existing validation lives in `test/web/metrics-server.test.js` and `test/web/client/dashboard-logic.test.js`; manual checks are documented in `docs/dashboard-manual-check.md`.

## Proposed Approach

1. Add dashboard-specific, range-scoped responses for overview data and view-specific detail data. Organize requests around the active view so the overview remains compact and inactive detail pages do not incur repeated query/render work. Reuse packet-type totals from data already retrieved for history where practical, and query bot counts grouped across configured bots rather than preparing one query per bot. Keep query construction and parameter binding in `MetricsStore`, and keep HTTP query validation in the centralized AJV schemas.
2. Make client refreshes latest-request-wins and single-flight. Cancel superseded range requests, ignore late responses, and avoid queuing redundant refreshes when SSE ticks arrive during a refresh.
3. Establish the live connection early and load the initial dashboard sections independently. Show loading, last-updated, and stale states so partial/slower sections do not make the whole page appear unresponsive.
4. Restructure the UI as a high-level metrics overview with dedicated sub-pages for detailed views. Keep the selected range in shared in-memory application state so in-app navigation preserves it and a full page reload resets it.
5. Reduce offscreen chart work, retain textual data as a usable fallback, and improve range-control semantics, scope labels, empty states, and mobile table handling.
6. Validate behavior with focused Node tests plus the existing manual browser checklist, expanded to cover request volume, range races, slow endpoints, cross-view range consistency, accessibility basics, and narrow viewports.

### Approved API direction

The user approved a dashboard summary endpoint for this feature in the plan feedback. The implementation may add the dashboard-specific range API described here. Preserve existing routes for compatibility unless a later decision explicitly approves deprecation or removal. Continue to follow strict AJV validation and parameterized SQL requirements.

### Range and navigation state decision

One selected range applies to every historical/aggregated metric across the overview and detail sub-pages. In-app navigation preserves the selected range; a full page reload returns to the default range. Keep this state in the running client application rather than persistent browser storage. Current operational status (for example, radio/broker/bot connectivity) and the current repeater inventory are point-in-time state, not historical aggregates; label these clearly as **Live** while applying the shared range to all count/history metrics.

## Impacted Areas

- `src/web/client/dashboard.js` — refresh coordination, startup sequencing, connection freshness, rendering.
- `src/web/client/dashboard-logic.js` — pure helpers for request generation/state or formatting if needed; avoid browser-specific behavior here.
- `src/web/dashboard-page.js` and `src/web/client/dashboard.css` - overview/detail view shell, accessible chart descriptions and controls, responsive table wrappers, empty/loading states, and sub-page navigation.
- `src/web/metrics-server.js` - approved dashboard summary/detail API routes, response assembly, and page-route handling if needed.
- `src/web/schemas.js` — strict AJV query validation for any new route, reusing existing range-query validators.
- `src/metrics/store.js` — grouped bot query and reuse/aggregation methods, using prepared parameterized statements.
- `test/web/metrics-server.test.js` - summary/detail route validation, response shape, and aggregate correctness.
- `test/web/client/dashboard-logic.test.js` and any focused client tests - latest-request-wins/coalescing helpers, in-app navigation, and shared range state.
- `docs/dashboard-manual-check.md` — repeatable checks for refresh behavior, accessibility, and responsive layout.

No configuration, persistence schema, dependency, logging-contract, authentication, or deployment changes are expected.

## Task Breakdown

### T1: Consolidate range queries around dashboard views

- **Objective:** Reduce per-sample browser requests and avoid redundant/group-by-bot query work.
- **Specific changes:** Add validated dashboard summary and detail responses, organized by active view and sharing existing range/custom-range semantics. The overview response contains overview-level aggregates; detail responses include the data required by their page. Reuse packet-type totals from history query results where correct, and replace per-bot count queries with one grouped query. Preserve existing routes for compatibility.
- **Definition of done:** The overview and each detail page load their required range data without issuing the existing six-request batch; response values match current endpoint results for empty, populated, custom, and `all` ranges; bot configuration ordering and zero-filled bots remain stable; all inbound query data passes strict AJV validation before queries run.
- **Expected tests / validation:** Add route tests for accepted/rejected range shapes and aggregate equivalence; add store tests for grouped bot totals, including zero-result configured bots. Confirm existing routes retain their current contract.

### T2: Make refreshes latest-request-wins and coalesce SSE triggers

- **Objective:** Prevent overlapping refresh batches and stale range responses from rendering.
- **Specific changes:** Track the active refresh with an `AbortController` or request generation token; cancel or disregard a prior range when the user selects another; coalesce SSE-triggered refreshes while a current refresh is running; ensure errors from an intentionally aborted request do not appear as dashboard failures.
- **Definition of done:** A slower response for a former range cannot replace current-range data; repeated SSE ticks during an in-flight refresh do not start an unbounded queue of work; selecting a new range promptly starts the latest query.
- **Expected tests / validation:** Add deterministic tests for stale response suppression, cancellation, and queued/coalesced refresh behavior using the existing test conventions.

### T3: Start live updates early and expose freshness

- **Objective:** Show live connection state promptly and make stale data recognizable.
- **Specific changes:** Open the EventSource during bootstrap without waiting for historical range or repeater requests; render its initial snapshot as the live source of truth; load range data and repeaters independently; display last successful update time and stale/loading/error states per relevant section; handle malformed SSE data without terminating the rest of the UI.
- **Definition of done:** A slow range or repeater query does not delay the live connection indicator or snapshot; disconnect and recovery states are understandable; sections can fail independently while other content remains usable.
- **Expected tests / validation:** Add focused client logic tests where pure helpers are introduced; extend manual checks to simulate a delayed/failing API response and an SSE disconnect/reconnect.

### T4: Create overview and scalable detail sub-pages

- **Objective:** Replace the long single-page layout with an overview landing page and a structure that can accommodate future capabilities.
- **Specific changes:** Create a high-level overview and dedicated detail sub-pages for packet activity/types, MQTT broker deliveries, bot/reply metrics, and repeaters. Use a small client-side navigation mechanism compatible with the no-build-step architecture. Keep range state in shared in-memory application state and preserve it across sub-page navigation; reset to the default on full document reload. Apply that single range to all historical/aggregated metric views. Label point-in-time connectivity and current inventory explicitly as Live.
- **Definition of done:** The landing view is a concise overview with clear paths to detail; each detail view has a focused hierarchy; navigating between views retains the current range and all range-aware metrics use it; reloading the page resets to the default range; live state is not presented as a selected-range aggregate.
- **Expected tests / validation:** Add client logic tests for navigation and range-state behavior. Update `docs/dashboard-manual-check.md` to verify range preservation across views, default reset after full reload, and correct live versus historical labels.

### T5: Reduce offscreen rendering work and improve chart alternatives

- **Objective:** Keep rendering cost proportional to visible content and preserve readable data without charts.
- **Specific changes:** Defer creating per-bot charts until their cards are visible, using browser-native visibility observation where suitable; avoid unnecessary chart/table updates when response values are unchanged; give each chart an accessible name and adjacent textual summary; retain tables as the exact-value fallback when Chart.js fails.
- **Definition of done:** Offscreen bot charts do not all initialize on page load; chart descriptions identify the represented metric and selected range; exact values remain available without Chart.js.
- **Expected tests / validation:** Manual browser inspection with many configured bots, with Chart.js unavailable, and with keyboard/screen-reader-oriented navigation. Avoid adding dependencies.

### T6: Improve accessible controls and responsive detail views

- **Objective:** Keep the new views usable with assistive technology and on narrow screens.
- **Specific changes:** Set `aria-pressed` on range controls, announce connection/freshness changes accessibly, add accessible chart descriptions and textual summaries, show explicit empty states for unconfigured brokers/bots, and wrap wide tables in locally scrollable containers. Review page navigation and focus behavior on view changes.
- **Definition of done:** Range selection and navigation state are accessible; chart meaning and exact values remain available without Chart.js; empty sections are explained; tables do not force whole-page horizontal scrolling at narrow widths.
- **Expected tests / validation:** Update the manual checklist with keyboard-only, screen-reader-oriented, empty-state, and narrow viewport checks; inspect light and dark color schemes.

### T7: Measure and document the improvement

- **Objective:** Verify the request and rendering improvements against the current behavior.
- **Specific changes:** Extend the manual checklist with a repeatable baseline/comparison for range requests per SSE tick, refresh overlap behavior, and representative chart rendering with multiple bots. Document the observed environment and counts rather than adding permanent telemetry or a new benchmark dependency.
- **Definition of done:** The checklist records the request reduction for the overview and active detail view, confirms bounded refresh behavior under delayed responses and range consistency across navigation, and includes browser checks at desktop and mobile viewport sizes.
- **Expected tests / validation:** Run the repository's existing test and lint scripts during implementation; complete the updated manual browser checklist. These are planned implementation validations and are not run as part of this planning task.

## Risks and Edge Cases

- **API compatibility:** The user approved the new dashboard summary/detail API direction for this feature. Preserve existing routes unless separately approved for deprecation or removal.
- **Range semantics:** `all`, custom date ranges, future/end clamping, and zero samples must retain current behavior and consistent boundaries across all included metrics and views.
- **Live versus historical data:** The SSE snapshot and persisted range samples update on related but distinct paths. The API and UI must not treat current gauges or current repeater inventory as historical totals. All count/history metrics must share the selected range and must not omit the latest persisted sample.
- **Synchronous query cost:** Reducing request count alone does not guarantee lower event-loop time. Verify SQL work is reduced and measure representative history sizes; keep aggregation queries indexed and parameterized.
- **Sub-page navigation:** Keep navigation client-side so it preserves shared range state and does not reset the page; browser back/forward must update the active view without duplicating chart instances or SSE listeners.
- **Bot list size:** Lazy charts reduce initial work, but range payload and table size still scale with configured bots and commands.
- **Visibility and lifecycle:** If chart creation is deferred, ensure charts resize correctly when cards become visible and do not create duplicate observers or chart instances.
- **SSE timing:** Coalescing should not make the visible range data remain stale indefinitely during sustained slow responses; always allow a follow-up refresh for the newest tick.
- **Accessibility:** Canvas summaries and status announcements should add information without producing repetitive screen-reader announcements on every frequent update.
- **Responsive behavior:** Horizontal table scrolling should remain keyboard reachable and should not clip focused controls.
- **Authentication/exposure:** This work does not change the existing no-auth metrics UI behavior or listener binding. Any such change remains separately approval-gated.

## Decisions and Remaining Assumptions

- **API approval:** Approved for this feature. Add the dashboard summary/detail API while preserving current endpoint contracts.
- **Information architecture:** Use a high-level metrics overview as the landing page, with dedicated sub-pages for detailed views. Do not use in-page anchors as the long-term navigation structure; the application is expected to grow.
- **Range behavior:** One range selection applies to every range-aware metric, including overview summaries and detail views. It updates as new samples arrive, persists across in-app navigation, and resets to the default only after a full page reload. The sampling interval does not change.
- **Live-state interpretation:** Point-in-time operational status (radio/broker/bot connectivity, current queue depth, and the current repeater inventory) remains live state and must be labeled **Live**. Historical/count metrics, including overview KPI values, follow the selected range.
- **Scope:** This plan applies to the existing metrics dashboard only.
- **Browser validation:** Use available local browser tooling; do not add a browser automation dependency.

## Suggested Execution Order

1. **T1** - implement the approved view-oriented API aggregation and reduce database query duplication.
2. **T2** — prevent stale results and repeated work during range changes and SSE bursts.
3. **T3** — make live data independent of slower initial loads and provide freshness feedback.
4. **T4** — create the scalable overview/detail navigation and shared range state.
5. **T5** - reduce hidden chart work after the detail views are established.
6. **T6** - improve accessible controls, empty states, focus behavior, and responsive tables.
7. **T7** - verify request, responsiveness, navigation, and usability outcomes and update the manual checklist.
