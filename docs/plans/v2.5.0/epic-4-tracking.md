# [Epic][v2.5.0] Pillar 4: UI/UX Refinement & Robotti Design-System Alignment

**GitHub epic:** [#21](https://github.com/Robotti-io/Meshcore-Observer/issues/21)

## Operator outcome

Present increasingly rich mesh, bot, runtime, and setup information clearly and consistently, with accessible controls and disciplined Robotti visual identity.

## Scope and sources

- `docs/plans/v2.5.0/feat-ui_ux_refinement_and_design_alignment.md`
- `docs/plans/v2.5.0/review-pillars-and-sequencing.md`

Source requests currently live in the local `release-v_2_5_0` working branch; permanent source links should be added when those documents are published.

Own shared visual/interaction patterns and complete-product usability. Preserve existing functionality and the lightweight frontend. Observer chart/table conventions are product extensions; they do not redefine canonical Robotti brand standards.

## Child issues

Captured on 2026-10-07. The 15 children below have scoped outcomes, explicit dependencies, acceptance criteria, validation expectations, and labels.

- [ ] [P4-01: Audit frontend, canonical design references, and approved assets](https://github.com/Robotti-io/Meshcore-Observer/issues/38)
- [ ] [P4-02: Define product navigation, visualization, and accessibility standards](https://github.com/Robotti-io/Meshcore-Observer/issues/39)
- [ ] [P4-03: Centralize Robotti design tokens and product typography](https://github.com/Robotti-io/Meshcore-Observer/issues/40)
- [ ] [P4-04: Build shared dashboard and setup control patterns](https://github.com/Robotti-io/Meshcore-Observer/issues/41)
- [ ] [P4-05: Integrate approved branding and offline asset behavior](https://github.com/Robotti-io/Meshcore-Observer/issues/42)
- [ ] [P4-06: Refine navigation, overview hierarchy, and drill-down](https://github.com/Robotti-io/Meshcore-Observer/issues/43)
- [ ] [P4-07: Standardize tables, filters, search, and long identifiers](https://github.com/Robotti-io/Meshcore-Observer/issues/44)
- [ ] [P4-08: Standardize loading, empty, stale, error, and partial data states](https://github.com/Robotti-io/Meshcore-Observer/issues/45)
- [ ] [P4-09: Refine chart styling, semantics, and accessible data alternatives](https://github.com/Robotti-io/Meshcore-Observer/issues/46)
- [ ] [P4-10: Refine responsive layouts and touch interaction](https://github.com/Robotti-io/Meshcore-Observer/issues/47)
- [ ] [P4-11: Refine keyboard, focus, and assistive-technology semantics](https://github.com/Robotti-io/Meshcore-Observer/issues/48)
- [ ] [P4-12: Polish motion and interaction while respecting reduced motion](https://github.com/Robotti-io/Meshcore-Observer/issues/49)
- [ ] [P4-13: Standardize product copy, metric help, and recovery guidance](https://github.com/Robotti-io/Meshcore-Observer/issues/50)
- [ ] [P4-14: Validate integrated UI consistency, accessibility, and performance](https://github.com/Robotti-io/Meshcore-Observer/issues/83)
- [ ] [P4-15: Publish contributor UI and visualization guidance](https://github.com/Robotti-io/Meshcore-Observer/issues/51)

Start with P4-01 frontend/design evidence and P4-02 product standards, then P4-03 tokens and P4-04 shared controls. These foundations serve setup and reporting early; integrated validation P4-14 follows the completed pillar workflows.

## Dependencies and unresolved decisions

- Establish reusable UI foundations early for Pillars 1, 2, and 3; complete integration after their data and workflows settle.
- Confirm canonical design references and approved logo/font/icon assets before implementation.
- Decide supported browsers, viewport/accessibility targets, chart-series differentiation, and any proposed telemetry-health thresholds.
- The current Chart.js CDN strategy needs an explicit offline-experience decision; asset/dependency/CSP changes require separate approval.
- Preserve safe rendering of untrusted node/bot/message labels, existing security behavior, stale-request suppression, and update coalescing.

## Epic acceptance

- [ ] Navigation and overview prioritize operational state and make current versus selected-range/historical values clear.
- [ ] Existing workflows remain available, with consistent drill-down and controls across new views.
- [ ] Shared styles use approved Robotti tokens and readable product typography; brand presentation follows approved assets.
- [ ] Charts have clear range/unit/series semantics, accessible summaries and practical exact-value alternatives, with differentiation beyond color alone.
- [ ] Loading/empty/stale/error states are distinct; partial failures preserve unrelated healthy information.
- [ ] Keyboard access, visible focus, labels, heading/table semantics, touch usability, and reduced-motion preferences are supported.
- [ ] Narrow layouts, navigation, filters, charts, and long identifiers remain usable without uncontrolled page overflow.
- [ ] Setup and dashboard share recognizable controls, validation/status behavior, and practical language.
- [ ] Untrusted content stays escaped and rendering/update performance remains acceptable under representative datasets.
- [ ] Automated interaction checks, manual responsive/accessibility validation, and contributor guidance are complete.

## Delivery priority

Split delivery: shared tokens/components/accessibility conventions start early; final product integration follows Pillars 1, 3, and 2. A fourth-priority completion does not defer usability standards until the end.

## Related epics

- [Pillar 1: Improved Telemetry & Reporting](https://github.com/Robotti-io/Meshcore-Observer/issues/18)
- [Pillar 2: Simplified Setup](https://github.com/Robotti-io/Meshcore-Observer/issues/19)
- [Pillar 3: Enhanced Bots](https://github.com/Robotti-io/Meshcore-Observer/issues/20)

## Planning status and approval boundaries

This is a v2.5.0 parent tracking epic. Its 15 child issues are captured and linked; implementation planning remains pending. Issue capture does not indicate implementation progress.

Implement one approved child task at a time. Follow AGENTS.md: JavaScript ES modules, centralized strict AJV schemas, centralized configuration and structured logging, existing seams, and always-on MetricsStore ownership. Concrete authentication, storage, public API/MQTT, dependency, logging-contract, CSP, and deployment changes need explicit approval in the applicable implementation plan.

Use repository test/lint scripts for implementation validation.
