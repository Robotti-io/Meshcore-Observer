# Feature: UI/UX Refinement & Robotti Design-System Alignment

## Summary

Refine the MeshCore Observer frontend so that the dashboard is easier to understand, more consistent to operate, more accessible across devices, and visually aligned with the established Robotti Design System.

The goal of this pillar is not to redesign the dashboard merely for aesthetic reasons.

MeshCore Observer is becoming a more capable operational tool. v2.5.0 introduces substantially richer telemetry, bot behavior, configuration workflows, and runtime reporting. The frontend must be able to present this increasing amount of information without becoming cluttered, inconsistent, or difficult to navigate.

The user experience should prioritize:

1. Clarity.
2. Trust.
3. Technical sharpness.
4. Human accessibility.

The dashboard should feel like a purpose-built operational console rather than a collection of independently implemented metrics pages.

At the same time, the product should adopt the established Robotti visual language consistently across:

- The existing operational dashboard.
- New telemetry and reporting interfaces.
- Bot reporting.
- Node and repeater views.
- Service/runtime reporting.
- Setup and onboarding experiences introduced by the Simplified Setup pillar.
- Error, loading, empty, warning, and success states.
- Forms and configuration interfaces.

The visual system should use the Robotti Design System as the source of truth for established brand decisions while explicitly treating MeshCore Observer-specific data-visualization patterns as a product extension rather than inventing unsupported Robotti brand canon.

---

## Goals

- Improve overall dashboard usability without unnecessarily rewriting working functionality.
- Establish clearer information hierarchy across overview and detail views.
- Make important operational state understandable at a glance.
- Reduce visual inconsistency between dashboard sections.
- Align frontend styling with the Robotti Design System.
- Adopt the documented Robotti color tokens consistently.
- Use appropriate typography for product UI rather than treating branded fonts as general-purpose interface fonts.
- Use consistent cards, buttons, inputs, tables, navigation, badges, and other reusable components.
- Apply consistent spacing, border radius, elevation, and interaction behavior.
- Use motion deliberately and sparingly.
- Improve responsive behavior for smaller displays.
- Improve keyboard accessibility, focus behavior, and screen-reader semantics.
- Improve loading, empty, stale, error, warning, and success states.
- Make tables and dense operational data easier to scan and interact with.
- Establish product-specific data-visualization guidance compatible with the Robotti visual language.
- Keep charts readable without introducing unnecessary color or visual noise.
- Make dashboard language clear, practical, technically accurate, and approachable.
- Ensure new Pillar 1 telemetry/reporting features fit naturally into the dashboard.
- Ensure the Pillar 2 onboarding experience and operational dashboard share the same frontend design language.
- Preserve dashboard performance as additional views and data are introduced.

---

## Non-Goals

- Do not redesign the dashboard solely to make it more decorative.
- Do not convert MeshCore Observer into a marketing-style website.
- Do not allow branding elements to compete with operational information.
- Do not introduce rainbow chart palettes or excessive decorative color.
- Do not invent new canonical Robotti brand rules where the design system is intentionally silent.
- Do not use semantic success/warning/error colors merely to create visual variety.
- Do not use branded display fonts as the general-purpose dashboard UI font.
- Do not mix unrelated icon families.
- Do not use excessive animation, glow, gradients, or motion.
- Do not require animation to understand application state.
- Do not reduce data density so aggressively that operational information becomes harder to access.
- Do not prioritize desktop appearance at the expense of mobile or narrow-screen usability.
- Do not break keyboard navigation while improving visual presentation.
- Do not hide important operational state exclusively behind hover interactions.
- Do not make cosmetic changes that materially degrade dashboard rendering or query performance.
- Do not introduce a new frontend framework or major dependency solely for visual refinement without explicit architectural approval.
- Do not treat product-specific visualization decisions as canonical Robotti brand standards.
- Do not rewrite stable backend APIs merely to accommodate cosmetic frontend changes.

---

## Scope 1: Dashboard Usability Refinement

### 1.1 Problem

MeshCore Observer's dashboard has grown considerably as metrics and operational capabilities have expanded.

The current dashboard already contains useful functionality including:

- Overview metrics.
- Packet activity.
- MQTT broker reporting.
- Bot reporting.
- Repeater reporting.
- Historical reporting ranges.
- Charts.
- Tables.
- Search.
- Live updates.

As v2.5.0 adds additional telemetry and reporting, simply adding more cards and tables will eventually make the interface harder to use.

The dashboard should be reviewed as one complete operational experience.

---

### 1.2 User Stories

#### 1.2.1 Understand system health quickly

As an Observer operator, I want to understand the current state of the Observer and mesh at a glance so that I can quickly determine whether something requires attention.

#### 1.2.2 Navigate to details naturally

As an Observer operator, I want summary information to lead naturally into more detailed views so that I do not need to search through unrelated screens.

#### 1.2.3 Understand unusual metrics

As an Observer operator, I want metrics to have clear labels, context, and supporting descriptions so that I understand what an unusual number actually means.

#### 1.2.4 Use the dashboard on different screens

As an Observer operator, I want the dashboard to remain usable on a desktop, laptop, tablet, or smaller browser window.

#### 1.2.5 Understand application state

As an Observer operator, I want loading, stale, unavailable, empty, and error states to be visually distinct so that I do not mistake missing data for healthy zero values.

---

### 1.3 Information Hierarchy

Each view should clearly distinguish:

- Page/view title.
- Current operational state.
- Reporting range.
- Primary metrics.
- Secondary metrics.
- Filters.
- Detailed charts.
- Detailed tables.
- Supporting context.
- Error/status information.

The interface should not present every value with equal visual importance.

High-priority operational state should remain visible without requiring deep navigation.

---

### 1.4 Navigation

Existing top-level dashboard views should be reviewed for:

- Clear naming.
- Predictable ordering.
- Active-state visibility.
- Keyboard navigation.
- Small-screen behavior.
- Ability to add new v2.5.0 views without overcrowding navigation.

Potential new capabilities from other pillars may require additional views or subdivisions.

The navigation model should scale deliberately rather than adding one top-level tab for every new metric category.

---

### 1.5 Overview Experience

The Overview should function as an operational summary rather than a duplicate of every detailed page.

It should answer questions such as:

```text
Is the Observer healthy?

Is the radio connected?

Are brokers connected?

Are bots operational?

Is packet activity normal?

Are there significant delivery failures?

Has something changed during the selected reporting range?
```

Overview metrics should provide clear drill-down paths where additional detail exists.

---

### 1.6 Metric Context

Metrics should clearly communicate whether they represent:

- Current state.
- Point-in-time gauge.
- Selected-range total.
- Unique count.
- Event count.
- Percentage.
- Trend.
- Historical average.
- Lifetime/cumulative value.

Avoid labels where the operator must infer semantics from context.

---

## Scope 2: Robotti Visual-System Alignment

### 2.1 Problem

MeshCore Observer should visually belong to the broader Robotti product ecosystem rather than using independent styling decisions.

The Robotti Design System already defines the preferred:

- Color model.
- Typography hierarchy.
- Logo usage.
- Shape language.
- Surface treatment.
- Motion grammar.
- Component styling.
- Iconography.
- Voice.

MeshCore Observer should implement those established decisions consistently where they apply to product UI.

---

### 2.2 Design Principle

When visual or interaction decisions conflict, the product should follow the design-system priority:

```text
Clarity
   ↓
Trust
   ↓
Technical sharpness
   ↓
Human accessibility
```

Branding should support those priorities rather than override them.

---

### 2.3 Color System

The dashboard should adopt the documented Robotti color tokens.

Core brand colors include:

```text
Primary
#71e987

Surface
#353542

Background
#23232e

OS-dark Background
#121217

Ink
#ffffff

Accent / Supporting Text
#d5eae0

OS-dark Supporting Text
#a2cbb6

Secondary / Muted
#5c5c7a
```

Semantic colors include:

```text
Success
#4ade80

Warning
#facc15

Error
#ef4444

Info
#38bdf8
```

These semantic colors should primarily communicate actual state.

For example:

```text
Green
Healthy / successful

Yellow
Attention / degraded

Red
Failure / unavailable

Blue
Informational state
```

They should not be used merely to decorate charts or cards.

---

### 2.4 One-Accent Principle

Robotti green should remain the primary identity and interaction accent.

It may be used for:

- Primary controls.
- Selected navigation.
- Links.
- Focus indicators.
- Important borders.
- Active states.
- Key chart emphasis.
- Brand elements.

The dashboard should avoid unnecessary multi-color visual treatment.

---

### 2.5 Typography

Normal application UI should use a neutral system sans-serif stack.

The branded Robota treatment should remain limited to appropriate ROBOTTI wordmark usage.

Montserrat should remain reserved for console/technical presentation where appropriate.

For example:

```text
Dashboard navigation
System sans

Tables
System sans

Forms
System sans

Metric labels
System sans

ROBotti wordmark
Robota where approved/available

Console-style diagnostic element
Montserrat/appropriate fallback
```

Typography must prioritize readability over branding.

---

### 2.6 Logo Usage

Where MeshCore Observer displays Robotti branding, it should use an approved logo variant.

The preferred visual treatment on dark application surfaces should follow the documented green-on-dark direction.

Logo usage should preserve:

- Correct proportions.
- Appropriate clear space.
- Correct variant.
- Correct contrast.

The logomark must not be reinterpreted or described as a robot character.

---

### 2.7 Shape & Surface Language

Frontend components should adopt a consistent rounded design language.

Representative tokens include:

```text
Small radius
0.25rem

Medium radius
0.5rem

Large/input radius
1rem

Card radius
1.5rem

Pill
9999px
```

Sharp-cornered components should not appear arbitrarily alongside rounded components.

---

### 2.8 Cards

Cards should follow a consistent product treatment.

Typical cards may use:

- Surface background.
- Large/card radius.
- Restrained border treatment.
- Consistent internal spacing.
- Resting shadow.
- Optional hover lift only when the card is actually interactive.

Static information cards should not imply clickability through unnecessary hover motion.

---

### 2.9 Controls

Buttons, filters, range selectors, and similar controls should use consistent styling.

Controls should clearly distinguish:

- Primary action.
- Secondary action.
- Selected state.
- Disabled state.
- Dangerous action where applicable.

Pill treatment may be appropriate for:

- Buttons.
- Range selectors.
- Filter chips.
- Compact toggles.

Interaction state must remain readable without relying solely on color.

---

### 2.10 Inputs

Inputs used by search, filtering, setup, and configuration should follow a shared visual language.

Inputs should provide clear:

- Labels.
- Focus state.
- Validation state.
- Disabled state.
- Helper text.
- Error text.

Placeholder text must not substitute for field labels.

---

### 2.11 Iconography

Where icons are used, the product should follow the Robotti iconography direction:

- Filled icons.
- Consistent visual weight.
- Robotti green where appropriate.
- One icon family rather than mixing styles.
- Typed Unicode arrows where documented rather than unrelated icon glyphs.

If Font Awesome Solid or another icon implementation requires adding a new dependency, that dependency must go through the project's normal approval boundary.

The design requirement should not silently override dependency governance.

---

## Scope 3: Product Data-Visualization Standards

### 3.1 Problem

The Robotti Design System defines brand and semantic colors but does not define a complete canonical palette for operational charts.

MeshCore Observer requires data visualization for:

- Packet activity.
- Packet-type breakdowns.
- Broker delivery.
- Bot usage.
- Node activity.
- Repeater telemetry.
- Process performance.
- Future operational data.

A product-specific visualization standard is therefore required.

This standard should complement the Robotti Design System without pretending to extend canonical Robotti branding beyond what has been approved.

---

### 3.2 Visualization Principles

Charts should prioritize:

1. Correct interpretation.
2. Readability.
3. Comparison.
4. Accessibility.
5. Brand consistency.
6. Decoration last.

Charts should not use many colors merely because multiple series exist.

---

### 3.3 Color Strategy

Where possible, charts should use:

- Robotti green for the primary series or point of emphasis.
- Neutral light/dark variations for secondary series.
- Supporting accent tones compatible with the dark interface.
- Semantic colors only where the data actually represents success, warning, error, or informational state.

For example:

```text
Packets received
Primary green

Packets decoded
Supporting neutral/accent

Failed deliveries
Semantic red

Degraded state
Semantic yellow
```

Color choices must preserve sufficient contrast against dashboard surfaces.

---

### 3.4 Multi-Series Charts

When several series must appear simultaneously, differentiation should not rely exclusively on hue.

Potential techniques include:

- Line style.
- Point markers.
- Opacity.
- Direct labels.
- Pattern/shape where supported.
- Clear legends.

The product-specific visualization palette should be documented before widespread use.

---

### 3.5 Chart Semantics

Every chart should have:

- Clear title.
- Reporting range.
- Axis meaning where applicable.
- Unit.
- Legend where multiple series exist.
- Accessible summary.
- Meaningful empty state.
- Meaningful unavailable state.

Avoid displaying charts with unexplained axes or unlabeled values.

---

### 3.6 Tables as Data Alternatives

Where a chart communicates operationally important information, tabular or textual alternatives should remain available where practical.

Users should not need to interpret a visualization to obtain exact values.

---

### 3.7 Chart Interaction

Interactive charts should provide useful behavior such as:

- Hover/focus values.
- Clear timestamps.
- Series labels.
- Responsive resizing.

Chart interaction should not depend solely on precise pointer movement.

Keyboard accessibility should be supported where technically practical.

---

## Scope 4: Responsive & Accessible Product Experience

### 4.1 Problem

MeshCore Observer may be viewed on:

- Desktop systems.
- Laptops.
- Raspberry Pi-connected displays.
- Tablets.
- Mobile devices used for quick operational checks.

The dashboard should remain usable when screen space is constrained.

Accessibility should also be part of the baseline product quality rather than a later cosmetic pass.

---

### 4.2 Responsive Layout

Views should adapt deliberately across width ranges.

Potential behaviors include:

- Card grids collapsing cleanly.
- Navigation adapting to narrow screens.
- Tables using local horizontal scrolling rather than forcing page overflow.
- Filters wrapping without losing logical grouping.
- Charts preserving readable height.
- Metric cards avoiding clipped values.
- Long node names or identifiers truncating safely with access to the complete value.

Responsive behavior should be validated with real dashboard content rather than only empty mockups.

---

### 4.3 Keyboard Accessibility

All interactive dashboard controls should be operable without a mouse.

This includes:

- Navigation.
- Range controls.
- Filters.
- Search.
- Tabs.
- Buttons.
- Forms.
- Expand/collapse controls.
- Modals where introduced.

Focus order should follow visual/logical order.

---

### 4.4 Focus Indicators

Interactive controls should provide a clearly visible focus state.

Robotti green is appropriate for focus emphasis where contrast requirements are satisfied.

Focus styling must not be disabled simply for visual cleanliness.

---

### 4.5 Screen-Reader Semantics

The interface should use appropriate semantic HTML and ARIA only where necessary.

Requirements include:

- Correct heading hierarchy.
- Labeled controls.
- Meaningful button names.
- Table headers.
- Status announcements where useful.
- Accessible chart summaries.
- No important information communicated only through CSS visual treatment.

---

### 4.6 Reduced Motion

Users who request reduced motion through operating-system/browser preferences should not receive unnecessary entrance animations, hover movement, or ambient animation.

Functional transitions may remain where required, but decorative motion should be reduced or removed.

---

### 4.7 Touch Targets

Interactive controls should remain practical on touch devices.

Small icon-only controls should not require extremely precise taps.

---

## Scope 5: Loading, Empty, Stale & Error States

### 5.1 Problem

Operational dashboards frequently operate under imperfect conditions.

Data may be:

- Loading.
- Temporarily unavailable.
- Empty because nothing occurred.
- Stale because updates stopped.
- Partially available.
- Failed because an API request failed.

These states must not look identical.

---

### 5.2 Loading State

Loading indicators should communicate that the system is working without causing major layout shifts.

Avoid flashing between empty and populated states during normal refreshes.

---

### 5.3 Empty State

An empty state should explain what zero data means.

For example:

```text
No bot commands were observed during this reporting range.
```

is preferable to:

```text
No data.
```

Where appropriate, empty states may explain what would cause data to appear.

---

### 5.4 Stale State

If data was previously available but has stopped updating, the interface should distinguish stale data from a healthy zero value.

Potential information includes:

```text
Last updated 8 minutes ago
```

or an equivalent freshness indicator.

---

### 5.5 Error State

Errors should explain:

- What failed.
- Whether existing data is still being displayed.
- Whether retry is automatic.
- What the operator can do.

Avoid exposing raw backend exceptions directly to normal users.

---

### 5.6 Partial Availability

Failure of one dashboard dataset should not unnecessarily blank unrelated healthy views.

Where practical, the dashboard should degrade at the component/view level rather than presenting an all-or-nothing failure.

---

## Scope 6: Tables, Search & Dense Operational Data

### 6.1 Problem

Tables are essential to an operational dashboard but become difficult to use as the amount of node, bot, telemetry, and runtime information grows.

v2.5.0 should establish consistent table behavior.

---

### 6.2 Table Requirements

Tables should support, where relevant:

- Clear headers.
- Consistent alignment.
- Readable spacing.
- Sticky headers where useful.
- Local scrolling.
- Responsive behavior.
- Search.
- Filtering.
- Sorting.
- Empty states.
- Result counts.
- Accessible header relationships.

Not every table must implement every feature, but similar tables should behave similarly.

---

### 6.3 Long Identifiers

MeshCore data may contain:

- Public keys.
- Node names.
- Companion names.
- Bot names.
- Broker names.
- Paths.
- Hashes.

Long values should not destroy layout.

Potential handling includes:

- Safe truncation.
- Full value on focus/explicit reveal.
- Copy controls where genuinely useful.
- Monospace presentation where appropriate for machine identifiers.

Human-readable node names should remain visually preferred over raw identifiers where both are available.

---

### 6.4 Filtering

Filters should be explicit about whether they operate on:

- Current page.
- Current dataset.
- Selected reporting range.
- Server-side query.

Filter behavior should remain consistent between views.

---

## Scope 7: Product Voice & UI Copy

### 7.1 Problem

A technically correct interface can still be frustrating if labels, errors, and help text feel like internal developer terminology.

MeshCore Observer should use the Robotti voice principles throughout product UI.

---

### 7.2 Voice Principles

UI copy should feel:

- Clear.
- Secure.
- Trusted.
- Practical.
- Thoughtful.
- Structured.
- Modern.
- Reliable.
- Grounded.

The product should avoid unnecessary hype, slang, or exaggerated claims.

---

### 7.3 Error Messages

Errors should combine technical accuracy with useful guidance.

Prefer:

```text
The Observer could not reach this MQTT broker.

The current configuration has been preserved.
Check the broker address, network connection, and credentials before trying again.
```

over:

```text
MQTT connection ECONNREFUSED
```

Technical details may still be available for advanced troubleshooting.

---

### 7.4 Labels

Labels should use operator-facing terminology rather than internal implementation terminology wherever possible.

For example:

```text
Replies waiting to send
```

may be clearer in a general dashboard context than:

```text
reply_queue_size
```

Internal field names may still appear in developer diagnostics.

---

### 7.5 Tooltips & Help

Help text should explain meaning, not merely restate the label.

For example:

```text
Unique companions

The number of distinct Companion nodes observed during the selected reporting range.
```

---

## Scope 8: Shared UI Foundation for Setup & Dashboard

### 8.1 Problem

Pillar 2 introduces a new web-based setup and reconfiguration experience.

If setup and the dashboard evolve independently, v2.5.0 could ship two interfaces that appear unrelated despite belonging to the same product.

---

### 8.2 Shared Design Language

The dashboard and setup experience should share:

- Color tokens.
- Typography.
- Buttons.
- Inputs.
- Cards.
- Validation states.
- Navigation principles.
- Focus treatment.
- Spacing.
- Border radius.
- Icon treatment.
- Error states.
- Product voice.

They do not need identical layouts because their workflows differ.

---

### 8.3 Shared Components

Where practical, reusable frontend styles/components should be extracted for common controls such as:

- Buttons.
- Form fields.
- Cards.
- Pills/badges.
- Alerts.
- Status indicators.
- Modal/dialog treatment.
- Navigation elements.
- Loading indicators.

The implementation should remain appropriately lightweight for the project's existing frontend architecture.

Do not introduce a heavy component framework solely to obtain reusable styling.

---

### 8.4 Setup-Specific Considerations

The onboarding interface should particularly prioritize:

- Readability.
- Large clear controls.
- Step progress.
- Plain-language help.
- Validation.
- Recovery from mistakes.
- Visible focus.
- Minimal cognitive load.

This aligns with the target audience defined in the Simplified Setup pillar.

---

## Scope 9: Motion & Interaction Polish

### 9.1 Problem

Motion can improve comprehension when it explains relationships or state changes, but excessive motion makes operational software distracting.

The Robotti Design System provides a motion grammar that should be applied conservatively.

---

### 9.2 Motion Principles

Potential supported patterns include:

- Section entrance.
- Card reveal.
- Hover lift.
- Limited ambient effects in appropriate non-operational contexts.

Motion should never delay access to operational information.

---

### 9.3 Hover Lift

Hover lift should be used only on genuinely interactive surfaces.

Static metric cards should not move merely because the pointer passes over them unless the movement communicates clickability.

---

### 9.4 Glow

Glow should be used sparingly.

It may be appropriate for:

- Focus.
- A deliberate welcome/setup moment.
- Rare high-value emphasis.

It should not be used across normal operational cards or charts.

---

### 9.5 Animation Duration

Animations should remain short enough that frequent dashboard interaction feels immediate.

Long decorative animation should not occur during normal metrics navigation.

---

## 10 Cross-Cutting Requirements

### 10.1 Design Tokens

Frontend styling should centralize reusable design values rather than scattering raw values throughout CSS.

At minimum, reusable tokens should cover:

- Brand colors.
- Semantic colors.
- Surface/background colors.
- Text colors.
- Border radius.
- Shadows.
- Motion/easing.
- Common spacing where appropriate.

Representative tokens may resemble:

```css
--color-primary: #71e987;
--color-surface: #353542;
--color-background: #23232e;
--color-secondary: #5c5c7a;
--color-accent: #d5eae0;

--radius-pill: 9999px;
--radius-xl: 1.5rem;
```

Exact implementation should align with the source design system and project frontend architecture.

---

### 10.2 Canonical vs Product-Specific Rules

The implementation must distinguish between:

#### Canonical Robotti decisions

Examples:

- Brand green.
- Background/surface direction.
- Typography roles.
- Logo usage.
- Rounded shape language.
- Product voice.

#### MeshCore Observer product extensions

Examples:

- Chart-series differentiation.
- Telemetry visualization.
- Node-health presentation.
- Network topology visualization.
- Dense operational table behavior.

Product-specific decisions should be documented as Observer UI standards rather than silently declared canonical Robotti standards.

---

### 10.3 Performance

Visual refinement must not materially degrade dashboard performance.

Particular attention should be paid to:

- Chart rendering.
- Large tables.
- Repeated DOM updates.
- SSE-triggered refreshes.
- Responsive resize behavior.
- Animation.
- Expensive shadows/effects on large repeated collections.

Existing stale-request suppression and update-coalescing behavior should remain intact.

---

### 10.4 External Assets

The dashboard should minimize reliance on externally hosted assets where practical.

Any proposed change involving:

- New frontend dependencies.
- Icon packages.
- Font packages.
- Chart libraries.
- External CDN assets.

must respect existing project dependency governance.

The design-system requirement alone does not authorize new dependencies.

---

### 10.5 Security

UI changes must preserve current security boundaries.

Requirements include:

- Do not render untrusted node/bot/message content as HTML.
- Escape user-controlled names and labels.
- Preserve CSP/security behavior where applicable.
- Do not expose secrets through setup/configuration UI.
- Do not leak protected configuration into browser state.
- Treat imported branding/assets as static trusted project resources.

---

### 10.6 Browser Compatibility

The supported browser matrix should be explicitly documented.

The dashboard should use progressive enhancement where practical.

Core metrics and administrative functionality should remain available even when optional visual enhancements are unavailable.

---

### 10.7 Testing

UI work should include appropriate automated and manual validation.

Areas should include:

- Navigation.
- Range controls.
- Search/filter behavior.
- Responsive layout.
- Keyboard navigation.
- Focus behavior.
- Empty/loading/error states.
- Chart lifecycle.
- New shared component behavior.
- Setup/dashboard visual consistency.
- Escaping of untrusted displayed values.

---

## 11 Acceptance Criteria

This pillar is complete when the approved child features collectively satisfy the following.

### 11.1 Dashboard Usability

- Existing dashboard functionality remains available after refinement.
- Overview information has a clear visual hierarchy.
- Current state and historical selected-range values are visually distinguishable.
- Important summary metrics provide understandable routes to deeper detail where applicable.
- Navigation remains usable as new v2.5.0 views are added.
- Similar controls behave consistently across views.
- Loading, empty, stale, and error states are visually distinguishable.
- Partial API failure does not unnecessarily hide healthy unrelated data.

### 11.2 Brand Alignment

- The dashboard uses the approved Robotti primary, surface, background, and supporting color direction.
- Robotti green is the primary brand accent.
- Semantic colors are primarily used for semantic state.
- Normal product UI uses a readable system sans-serif stack.
- Branded typography is limited to its approved roles.
- Robotti logo usage follows the approved logo system.
- Cards, controls, inputs, and navigation use a consistent rounded shape language.
- Iconography does not arbitrarily mix incompatible visual styles.
- Glow and decorative motion are used sparingly.

### 11.3 Data Visualization

- Charts follow a documented MeshCore Observer visualization standard.
- Primary data emphasis aligns with the Robotti visual system.
- Semantic colors are not used merely for decoration.
- Multi-series charts remain distinguishable without depending solely on color.
- Charts include clear titles, units, legends/labels where required, and reporting-range context.
- Important chart values are also accessible through text or tabular representation where practical.
- Empty/unavailable charts clearly explain their state.

### 11.4 Accessibility

- Primary dashboard workflows are keyboard accessible.
- Visible focus states are retained.
- Inputs have explicit labels.
- Tables use appropriate headers.
- Heading hierarchy is logical.
- Important status information is not communicated through color alone.
- Reduced-motion preferences are respected.
- Charts provide meaningful accessible summaries.
- Touch targets remain practical on smaller devices.

### 11.5 Responsive Behavior

- Overview metrics remain usable on narrow screens.
- Navigation has a defined small-screen behavior.
- Tables do not force uncontrolled page-level horizontal overflow.
- Charts resize without becoming unreadable.
- Filters and reporting controls remain operable on smaller screens.
- Long identifiers and node names do not break layouts.

### 11.6 Product Voice

- Error messages are understandable and actionable.
- Empty states explain what the absence of data means.
- Labels use operator-facing terminology where practical.
- Tooltips/help text explain metric meaning.
- Product copy is technically precise, practical, and approachable.
- UI copy avoids unnecessary hype or jargon.

### 11.7 Shared Setup Experience

- Pillar 2 onboarding uses the same core design tokens as the dashboard.
- Setup and dashboard controls share recognizable styling.
- Validation and status states are consistent between setup and normal operation.
- The two interfaces feel like different workflows within one product rather than separate applications.

### 11.8 Quality

- Existing dashboard tests remain passing.
- New interaction logic has appropriate automated coverage.
- Responsive behavior is manually validated at representative widths.
- Accessibility is reviewed with keyboard-only navigation.
- Untrusted content remains safely escaped.
- New visual effects do not materially degrade dashboard performance.
- Full test and lint workflows pass.
- Product UI guidance is documented for future contributors.

---

## 12 Suggested Child Features

This feature request should be implemented through separate child issues rather than as one large visual rewrite.

Recommended breakdown:

1. **Robotti Design Token Integration**
2. **Shared Dashboard Component Styling**
3. **Dashboard Information Hierarchy & Navigation Review**
4. **Overview Usability & Drill-Down Refinement**
5. **Responsive Dashboard Layout Refinement**
6. **Table / Search / Filter Interaction Standardization**
7. **Loading / Empty / Stale / Error State Standardization**
8. **MeshCore Observer Data-Visualization Standard**
9. **Chart Styling & Accessibility Refinement**
10. **Keyboard / Focus / Accessibility Audit**
11. **Reduced Motion & Interaction Polish**
12. **Product Voice / Dashboard Copy Review**
13. **Robotti Logo & Brand Presentation Review**
14. **Shared Setup / Dashboard UI Foundation**
15. **Cross-View Visual Consistency Review**
16. **Dashboard Performance Validation**
17. **Responsive / Accessibility Regression Validation**
18. **Contributor UI Guidelines**

Some of these may be combined after the frontend audit establishes the most practical implementation boundaries.

---

## 13 Open Questions

These should be resolved during feature planning rather than guessed during implementation.

### 13.1 Dashboard Structure

- Does the existing five-view navigation remain appropriate after v2.5.0?
- Which new Pillar 1 information belongs in existing views?
- Which telemetry requires a dedicated detail view?
- Should "Repeaters" evolve into a broader "Nodes" section?
- Should Companion reporting remain separate from repeater reporting?
- Where should process/runtime performance live?
- How much information belongs on Overview before it becomes overloaded?
- Which overview cards should support direct drill-down?

### 13.2 Robotti Design System

- Which design-system assets are already licensed/approved for inclusion in the repository?
- Should product UI use bundled logo SVG assets or another approved representation?
- Is Robota required anywhere in the application other than branded wordmark treatment?
- Is Montserrat necessary for any product console treatment?
- Can system fallbacks satisfy those roles without adding font assets?
- Should OS dark preference change only the page background or additional surface tokens?
- Should users be able to manually select appearance in the future?

### 13.3 Data Visualization

- What neutral/supporting chart colors should become the official MeshCore Observer visualization palette?
- How many simultaneous series should a chart support before another visualization becomes more appropriate?
- Should packet-type charts continue using pie/doughnut forms or move to another visualization?
- How should battery, temperature, CPU, memory, and route telemetry be visualized?
- Should repeater health use semantic color thresholds?
- If so, who defines those thresholds?
- How should unknown/missing telemetry be visually distinguished from unhealthy telemetry?
- How should chart colors behave for color-vision deficiencies?
- Should data-series styling be documented in a dedicated frontend reference?
- How should the current browser-loaded Chart.js asset strategy interact with offline/local-only installations?

### 13.4 Accessibility

- What accessibility target should MeshCore Observer explicitly document?
- Which chart interactions can realistically be keyboard accessible with the current chart library?
- Should highly interactive charts always include a nearby data table?
- How should live SSE updates be announced without creating excessive screen-reader noise?
- Which status changes warrant an ARIA live announcement?
- How should very long MeshCore identifiers be exposed to assistive technology when visually truncated?

### 13.5 Responsive Design

- What minimum viewport width should be supported?
- Should mobile layouts prioritize summary-only views or expose all dashboard functionality?
- How should top-level navigation behave on very narrow screens?
- Should complex tables convert to cards or retain horizontal scrolling?
- Which charts require different layouts at smaller widths?
- Should long reporting-range controls collapse into a dropdown on mobile?

### 13.6 Components

- How much reusable component structure is appropriate within the project's existing vanilla frontend architecture?
- Should components remain primarily CSS conventions plus small JavaScript helpers?
- Is introducing a component framework explicitly out of scope for v2.5.0?
- Which repeated patterns currently deserve shared abstractions?
- How can setup/onboarding reuse these patterns without tightly coupling its workflow to the dashboard?

### 13.7 Motion

- Which existing interactions benefit from hover lift?
- Which surfaces should remain completely static?
- Should page transitions use the documented 600ms entrance pattern, or is that too slow for an operational dashboard?
- Should the product define a shorter operational motion duration than marketing surfaces?
- Which animations should be disabled under `prefers-reduced-motion`?
- Is ambient/breathing motion appropriate anywhere in MeshCore Observer outside initial onboarding?

### 13.8 Product Voice

- Which existing labels are overly implementation-specific?
- Should metric definitions be available through tooltips, inline help, or a dedicated glossary?
- How much technical detail should normal error states expose?
- Should advanced diagnostics be expandable separately from the friendly error message?
- Which terminology should be standardized across dashboard, setup, logs, and documentation?

### 13.9 External Assets & Offline Operation

- Should all required dashboard assets be locally bundled for isolated installations?
- Is the current externally loaded chart asset acceptable for the target deployment model?
- Can approved logo/icon resources be bundled without adding runtime dependencies?
- Should the dashboard continue functioning fully when Internet access is unavailable?
- Which third-party assets, if any, are currently required for core dashboard functionality?

---

## 14 Release Intent

This pillar should make MeshCore Observer feel like a coherent, trustworthy operational product rather than a collection of independently developed dashboard features.

### 14.1 Can I understand what is happening quickly?

The dashboard should prioritize the information that matters most and make deeper detail easy to reach without forcing every metric onto the same screen.

### 14.2 Does the interface feel consistent?

Navigation, cards, tables, charts, buttons, filters, status indicators, forms, and error states should follow the same interaction and visual language.

The operator should not need to relearn the interface when moving between Packet Activity, Brokers, Bots, Nodes, Telemetry, Runtime Performance, or Setup.

### 14.3 Does it look and feel like Robotti?

MeshCore Observer should clearly belong to the Robotti product ecosystem through disciplined use of:

```text
Green as identity and emphasis

Dark surfaces for seriousness and focus

High contrast for readability and trust

Rounded components

Restrained elevation

Consistent typography

Minimal, purposeful motion

Clear and technically precise language
```

Branding should reinforce usability rather than overwhelm the operational experience.

### 14.4 Can I use it comfortably wherever I am?

The product should remain practical across common screen sizes, keyboard navigation, touch interaction, reduced-motion preferences, and assistive technologies.

### 14.5 Can the interface grow with the product?

v2.5.0 introduces richer telemetry, setup workflows, bot behavior, and reporting.

The frontend should establish reusable product patterns so that future features can be added consistently rather than requiring another visual redesign.

Together, these improvements should evolve MeshCore Observer from a functional dashboard into a polished operational interface that is:

```text
Clear
   +
Trustworthy
   +
Technically sharp
   +
Human and accessible
```

The guiding principle for this pillar is:

> **MeshCore Observer should present complex mesh and service information with clarity, consistency, and restraint while expressing the established Robotti visual identity without allowing branding to compete with operational usability.**

The implementation should achieve this through refinement rather than unnecessary reinvention, preserving the dashboard's existing functionality and performance while establishing a stronger shared UI foundation for the rest of v2.5.0 and future releases.
