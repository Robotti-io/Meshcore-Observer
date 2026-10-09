# [Epic][v2.5.0] Pillar 2: Simplified Setup

**GitHub epic:** [#19](https://github.com/Robotti-io/Meshcore-Observer/issues/19)

## Operator outcome

Allow Windows and supported Linux/Raspberry Pi operators to install, configure, run, diagnose, and reconfigure Observer through guided local workflows without manually editing environment or JSON files.

## Scope and sources

- `docs/plans/v2.5.0/feat-simplified_setup.md`
- `docs/plans/v2.5.0/review-pillars-and-sequencing.md`

Source requests currently live in the local `release-v_2_5_0` working branch; permanent source links should be added when those documents are published.

Own installation, setup mode, configuration activation/recovery, and service lifecycle. Preserve the existing underlying configuration contracts, manual configuration support, fail-fast normal startup, and environment-driven container operation.

## Child issues

Captured on 2026-10-07. The 17 children below have scoped outcomes, explicit dependencies, acceptance criteria, validation expectations, and labels.

- [ ] [P2-01: Define setup architecture, local administration, secrets, and activation boundaries](https://github.com/Robotti-io/Meshcore-Observer/issues/66)
- [ ] [P2-02: Assess distribution, platform matrix, Node runtime, and service packaging](https://github.com/Robotti-io/Meshcore-Observer/issues/67)
- [ ] [P2-03: Reuse authoritative configuration validation and provide a static doctor](https://github.com/Robotti-io/Meshcore-Observer/issues/68)
- [ ] [P2-04: Launch secure local setup mode and configuration APIs](https://github.com/Robotti-io/Meshcore-Observer/issues/69)
- [ ] [P2-05: Apply configuration safely with known-good recovery](https://github.com/Robotti-io/Meshcore-Observer/issues/70)
- [ ] [P2-06: Build guided onboarding, review, and resumable setup](https://github.com/Robotti-io/Meshcore-Observer/issues/71)
- [ ] [P2-07: Guide radio configuration and explicitly requested connection checks](https://github.com/Robotti-io/Meshcore-Observer/issues/72)
- [ ] [P2-08: Guide MQTT broker configuration and secret-safe connectivity checks](https://github.com/Robotti-io/Meshcore-Observer/issues/73)
- [ ] [P2-09: Guide bot and general Observer configuration including v2.5.0 options](https://github.com/Robotti-io/Meshcore-Observer/issues/74)
- [ ] [P2-10: Reconfigure existing installations without reinstalling](https://github.com/Robotti-io/Meshcore-Observer/issues/75)
- [ ] [P2-11: Export and import configuration with explicit secret handling](https://github.com/Robotti-io/Meshcore-Observer/issues/76)
- [ ] [P2-12: Provide the approved Windows installation entry point](https://github.com/Robotti-io/Meshcore-Observer/issues/77)
- [ ] [P2-13: Configure Windows automatic startup using the approved service mechanism](https://github.com/Robotti-io/Meshcore-Observer/issues/78)
- [ ] [P2-14: Provide the approved Linux and Raspberry Pi installation entry point](https://github.com/Robotti-io/Meshcore-Observer/issues/79)
- [ ] [P2-15: Configure supported Linux service operation with least privilege](https://github.com/Robotti-io/Meshcore-Observer/issues/80)
- [ ] [P2-16: Expose service status and approved start-stop-restart controls](https://github.com/Robotti-io/Meshcore-Observer/issues/81)
- [ ] [P2-17: Validate setup, reconfiguration, upgrades, recovery, and operator guidance](https://github.com/Robotti-io/Meshcore-Observer/issues/82)

Start with P2-01 setup/security/activation decisions and P2-02 packaging research. Reuse P4-04 shared controls, Pillar 1 configuration, and Pillar 3 bot policy. Static validation and safe apply precede guided activation; installer/service work follows approved platform decisions.

## Dependencies and unresolved decisions

- Use the configuration produced by Pillars 1 and 3, including OBS-02's optional discovery/publication settings.
- Consume Pillar 4 shared controls, validation/status presentation, and accessibility patterns.
- Decide local request authorization, stored-secret handling, privilege separation, platform/runtime packaging, and installation paths.
- The current metrics dashboard is an unauthenticated viewer; adding write/service actions requires an approved administrative boundary.
- Define successful activation, offline configuration behavior, restart versus live reload, multi-file recovery, and backup/import semantics.
- Keep setup independently launchable without valid runtime settings or functioning radio/brokers. Avoid unnecessarily elevating the normal Observer runtime.

## Epic acceptance

- [ ] Supported Windows and Linux/Raspberry Pi users have guided installation paths without manually cloning the repository or creating configuration files.
- [ ] Setup works before complete runtime configuration and binds locally by default.
- [ ] Guided forms cover supported radio, MQTT, bot, and general settings with advanced options and safe secret handling.
- [ ] Setup, doctor, import, and startup reuse authoritative validation; invalid proposals cause no activation side effects.
- [ ] Apply/restart failures preserve a known-good recovery path, including interrupted changes spanning multiple files.
- [ ] Existing supported installations can reopen configuration and make changes without reinstalling.
- [ ] Configuration backup/import avoids unintended secret disclosure and validates the current configuration version.
- [ ] Supported automatic-startup/service operations report actual outcomes and respect least privilege.
- [ ] Updates preserve user configuration, secrets, metrics, and history; container/manual operation remains supported.
- [ ] Keyboard/responsive usability, failure/recovery, supported platform behavior, and upgrade preservation are validated and documented.

## Delivery priority

Recommended third main delivery pillar, after telemetry/bot configuration is settled. Resolve architecture, security, packaging, and layout decisions early. The initial apply/restart model is a planning decision, not an implicit commitment to live reload or a new service framework.

## Related epics

- [Pillar 1: Improved Telemetry & Reporting](https://github.com/Robotti-io/Meshcore-Observer/issues/18)
- [Pillar 3: Enhanced Bots](https://github.com/Robotti-io/Meshcore-Observer/issues/20)
- [Pillar 4: UI/UX Refinement & Robotti Design-System Alignment](https://github.com/Robotti-io/Meshcore-Observer/issues/21)

## Planning status and approval boundaries

This is a v2.5.0 parent tracking epic. Its 17 child issues are captured and linked; implementation planning remains pending. Issue capture does not indicate implementation progress.

Implement one approved child task at a time. Follow AGENTS.md: JavaScript ES modules, centralized strict AJV schemas, centralized configuration and structured logging, existing seams, and always-on MetricsStore ownership. Concrete authentication, storage, public API/MQTT, dependency, logging-contract, CSP, and deployment changes need explicit approval in the applicable implementation plan.

Use repository test/lint scripts for implementation validation.
