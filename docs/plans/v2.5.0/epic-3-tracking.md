# [Epic][v2.5.0] Pillar 3: Enhanced Bots

**GitHub epic:** [#20](https://github.com/Robotti-io/Meshcore-Observer/issues/20)

## Operator outcome

Make bots better mesh citizens by controlling who responds, whether a reply is still necessary, which transport delivers it, and how far flooded replies propagate.

## Scope and sources

- `docs/plans/v2.5.0/feat-enhanced_bots.md`
- `docs/plans/v2.5.0/review-pillars-and-sequencing.md`

Source requests currently live in the local `release-v_2_5_0` working branch; permanent source links should be added when those documents are published.

Own bot matching, response policy, and delivery lifecycle. Extend the existing command-handler/durable reply architecture with opt-in behavior and backward-compatible defaults.

## Child issues

Captured on 2026-10-07. The 14 children below have scoped outcomes, explicit dependencies, acceptance criteria, validation expectations, and labels.

- [ ] [P3-01: Assess bot targeting, private messaging, ACK, and region-scope capabilities](https://github.com/Robotti-io/Meshcore-Observer/issues/52)
- [ ] [P3-02: Define targeting, response policy, suppression, and delivery lifecycle](https://github.com/Robotti-io/Meshcore-Observer/issues/53)
- [ ] [P3-03: Discover and refresh the Companion bot identity](https://github.com/Robotti-io/Meshcore-Observer/issues/54)
- [ ] [P3-04: Match Unicode bot tags and command-level targeting configuration](https://github.com/Robotti-io/Meshcore-Observer/issues/55)
- [ ] [P3-05: Persist reply delivery policy and extended lifecycle state](https://github.com/Robotti-io/Meshcore-Observer/issues/56)
- [ ] [P3-06: Suppress redundant pending replies using handler-aware response evidence](https://github.com/Robotti-io/Meshcore-Observer/issues/57)
- [ ] [P3-07: Resolve per-command region scopes and explicit fallback policy](https://github.com/Robotti-io/Meshcore-Observer/issues/58)
- [ ] [P3-08: Transmit scoped channel replies atomically and restore safe scope state](https://github.com/Robotti-io/Meshcore-Observer/issues/59)
- [ ] [P3-09: Receive private contact commands through existing handlers](https://github.com/Robotti-io/Meshcore-Observer/issues/60)
- [ ] [P3-10: Deliver private replies through valid contacts with bounded retry and fallback](https://github.com/Robotti-io/Meshcore-Observer/issues/61)
- [ ] [P3-11: Track private destination ACKs and timeout outcomes](https://github.com/Robotti-io/Meshcore-Observer/issues/62)
- [ ] [P3-12: Assess whether observed topology can safely assist private routing](https://github.com/Robotti-io/Meshcore-Observer/issues/63)
- [ ] [P3-13: Report targeting, suppression, private delivery, ACK, and scope outcomes](https://github.com/Robotti-io/Meshcore-Observer/issues/64)
- [ ] [P3-14: Validate enhanced bots under multi-bot RF, failure, and recovery scenarios](https://github.com/Robotti-io/Meshcore-Observer/issues/65)

Start with P3-01 bot-specific capability research and P3-02 policy/lifecycle decisions. Reuse Pillar 1 protocol/reporting/remote-request foundations. Targeting, suppression, scoped delivery, and private/ACK work proceed through their explicit dependencies; topology assistance remains a research decision rather than an assumed route.

## Dependencies and unresolved decisions

- Consume Pillar 1 reusable observations and radio/remote-request coordination; do not infer outbound routes from arbitrary inbound paths.
- OBS-02 discovery belongs to Pillar 1; discovered declarations do not automatically determine or authorize bot response scope.
- Validate the OKI scoping source, region-name/key mapping, installed library capabilities, firmware scope persistence/restoration, private intake, and destination ACK semantics.
- Decide targeting syntax, Unicode normalization, duplicate Companion-name behavior, satisfactory-response criteria, and the exact transmission-commit boundary.
- Decide per-command transport/default/fallback settings, persisted policy after restart/configuration changes, ACK/retry budgets, and private metadata retention.
- Pillar 2 consumes the settled bot schema; Pillar 4 supplies shared operator-facing reporting patterns.

## Epic acceptance

- [ ] Target-required commands use the current Companion identity and handle Unicode safely; wrong/malformed tags are ignored and legacy untagged commands remain compatible.
- [ ] Only eligible replies not committed to transmission can be suppressed through handler-appropriate evidence; unrelated messages do not suppress replies.
- [ ] Suppression is durable and distinguishable from sent, failed, expired, and unrelated cancellation.
- [ ] Supported private intake reuses command semantics and produces private replies through valid contact routing.
- [ ] Destination ACKs correlate correctly; missing ACK and send failure remain distinct, without human read-receipt claims or double-counted deliveries.
- [ ] Retries are bounded and private/scoped failures do not silently become unrestricted public floods.
- [ ] Scoped sends preserve ownership across apply/send/restoration; concurrent bot/radio work cannot exchange scopes.
- [ ] Scope state, connection changes, and persisted reply recovery follow verified protocol behavior.
- [ ] Existing configuration, handler state, queue durability, and airtime coordination are preserved.
- [ ] Regression tests, authorized multi-bot/RF validation, metrics, and operator documentation cover the approved behavior.

## Delivery priority

Recommended second main delivery pillar. Targeting can start without all telemetry work completing. Region scoping and private messaging can proceed in the order their prerequisites become available after shared delivery decisions are settled.

## Related epics

- [Pillar 1: Improved Telemetry & Reporting](https://github.com/Robotti-io/Meshcore-Observer/issues/18)
- [Pillar 2: Simplified Setup](https://github.com/Robotti-io/Meshcore-Observer/issues/19)
- [Pillar 4: UI/UX Refinement & Robotti Design-System Alignment](https://github.com/Robotti-io/Meshcore-Observer/issues/21)

## Planning status and approval boundaries

This is a v2.5.0 parent tracking epic. Its 14 child issues are captured and linked; implementation planning remains pending. Issue capture does not indicate implementation progress.

Implement one approved child task at a time. Follow AGENTS.md: JavaScript ES modules, centralized strict AJV schemas, centralized configuration and structured logging, existing seams, and always-on MetricsStore ownership. Concrete authentication, storage, public API/MQTT, dependency, logging-contract, CSP, and deployment changes need explicit approval in the applicable implementation plan.

Use repository test/lint scripts for implementation validation.
