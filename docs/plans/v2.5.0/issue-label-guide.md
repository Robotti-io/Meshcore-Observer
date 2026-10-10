# v2.5.0 issue label guide

Reviewed/applied: 2026-10-07. Scope: the four epics (#18–#21) and all 62 children (#22–#83).

## Label conventions

All scoped issues carry `release:v2.5.0` and exactly one owning-pillar label. Cross-pillar consumers remain labeled with their owner; links and parent/child relationships describe dependencies.

Use `epic` for parent tracking issues, `research` for capability/evidence gathering, `decision` for resolving engineering/product choices, and `validation` when the main deliverable is verification. Implementation feature requests retain the existing `enhancement` label; the feature epics also retain it.

Apply the existing `configuration` label when settings, defaults, cadence, broker opt-in, or configuration editing are directly in scope. Apply `security` when credential/authentication, administrative access, broker permissions, or sensitive sender-data exposure/retention are substantive scope. A generic AJV or security-preservation requirement alone does not justify that label.

Use `documentation` when operator/contributor guidance is a central deliverable, such as #37. Research and decision records have their specific work-type labels. Reserve `question` for issues requesting further information; #22/#23 now use `research`/`decision`.

`workstream:obs-02` groups the three dedicated OBS-02 feature issues (#30–#32). Shared prerequisite issues and the broader epic remain classified by their own scope.

## Added labels

| Label | Purpose |
| --- | --- |
| `release:v2.5.0` | Scoped for the MeshCore Observer v2.5.0 release. |
| `pillar:telemetry-reporting` | Owned by Pillar 1: Improved Telemetry & Reporting, including OBS-02. |
| `pillar:simplified-setup` | Owned by Pillar 2: installation, onboarding, configuration, and service lifecycle. |
| `pillar:enhanced-bots` | Owned by Pillar 3: bot targeting, suppression, private delivery, and response scopes. |
| `pillar:ui-ux` | Owned by Pillar 4: shared UI patterns, design alignment, accessibility, and usability. |
| `epic` | Parent tracking issue grouping child features and acceptance outcomes. |
| `research` | Evidence gathering and capability assessment before implementation planning. |
| `decision` | Resolve and document product or engineering choices before implementation. |
| `validation` | Operational, regression, recovery, or performance validation as the main deliverable. |
| `workstream:obs-02` | Dedicated OBS-02 repeater-region discovery, answer persistence, or CoreScope publication. |
| `status:in-progress` | Work has started; the issue remains open until its full deliverable and validation are complete. |

Existing labels retain their repository definitions, colors, and use outside this release. Workflow status is tracked in the [release project](https://github.com/orgs/Robotti-io/projects/1) Status field (`Todo`, `In progress`, `Done`), alongside issue state and the supplemental `status:in-progress` label. Dependencies use parent/child relationships and explicit links. Label assignment does not authorize protected-boundary implementation changes.

## Progress and completion workflow

- Set the release project's Status to `In progress` and apply `status:in-progress` when research, decision resolution, planning, or implementation actually starts. Describe the active phase in the issue body so planning cannot be mistaken for implemented behavior. An epic can be in progress while only its prerequisites are active. Issue labels do not automatically replace the project Status field.
- Check off resolved discussion items and satisfied acceptance criteria as evidence is recorded. A partial decision resolution is progress on its owning decision issue, not completion of a dependent implementation feature.
- Close an issue as completed once its full deliverable and required validation are met; verify its project Status is `Done`, remove `status:in-progress`, and synchronize parent checklists and local records. Research/decision issues can close before dependent features are implemented when their own criteria are satisfied.
- Open issues without the progress label are queued for work. Do not mark all dependent features active solely because their requirements were discussed.
- Current active set, updated 2026-10-10: #18/#23 implementation; #30/#31 completed. #30 foundations remain complete/user-pushed at f2d567c / migration 14 and completed/project Done without a progress label. #31’s approved QUERY-PLAN-01–05 and all five tasks are delivered; T1–T4 are user-pushed at 4e7d92e, verified locally/remotely, and T5 is complete locally on 2026-10-10. T5 adds 26 scenarios; final full single-worker functional/coverage runs pass 78 files / 975 tests, lint and unchanged cost/coverage gates pass. All six #31 fixture acceptance criteria are checked; #31 is completed/native project Done with its progress label removed and classification labels preserved. The 20k-node/20k-pair coverage fixture visits every key; p95 is 2.410ms reservation, 2.525ms completion and 27.594ms slowest candidate read. The first T5 functional legacy topology timing failure and successful unchanged rerun are disclosed in #31, alongside earlier parallel limits; scripts, thresholds and CI are unchanged. Discovery stays disabled by default and works offline independently of UI/brokers, without contact mutation or region MQTT staging. No live hardware/RF, firmware change or publication activation occurs; #37 retains hardware/soak validation. #18/#23 remain OPEN/native project In progress; #22/#29/#30 remain completed/Done; #32 stays queued for its own publication plan. Preserve #30 configuration/enhancement/release/pillar/OBS-02 labels; its progress label is removed. Preserve #31 configuration/enhancement/release/pillar/OBS-02; remove status:in-progress on completed/Done delivery. #32/#68/#74 remain queued.
- Project verification on 2026-10-07: #18, #22, #23, and #26 changed from `Todo` to `In progress` in project #1 and verified in the signed-in GitHub browser. Current GitHub CLI credentials lack project scopes; use the authorized browser session for project changes unless that access changes. The project's saved view configuration was preserved; temporary verification filters/grouping were discarded.
- Planning-wave project updates on 2026-10-08: #24/#25/#28 changed to `In progress` and were verified individually in the authorized browser, alongside their supplemental progress labels. A temporary flat Status-grouped view verified the seven active issues (#18/#22/#23/#24/#25/#26/#28); verification filters/grouping were discarded. Issue bodies distinguish planning from implementation; no issue was closed.

The label mappings below describe classification labels. Apply the progress label in addition to those classifications as work transitions; retain the other labels on completion.

## Applied issue mapping

| Issue | Scope | Labels |
| --- | --- | --- |
| [#18](https://github.com/Robotti-io/Meshcore-Observer/issues/18) | Pillar 1: Improved Telemetry & Reporting | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting`, `epic`, `security`, `configuration` |
| [#19](https://github.com/Robotti-io/Meshcore-Observer/issues/19) | Pillar 2: Simplified Setup | `enhancement`, `release:v2.5.0`, `pillar:simplified-setup`, `epic`, `security`, `configuration` |
| [#20](https://github.com/Robotti-io/Meshcore-Observer/issues/20) | Pillar 3: Enhanced Bots | `enhancement`, `release:v2.5.0`, `pillar:enhanced-bots`, `epic`, `security`, `configuration` |
| [#21](https://github.com/Robotti-io/Meshcore-Observer/issues/21) | Pillar 4: UI/UX Refinement & Robotti Design-System Alignment | `enhancement`, `release:v2.5.0`, `pillar:ui-ux`, `epic` |
| [#22](https://github.com/Robotti-io/Meshcore-Observer/issues/22) | Protocol, firmware, and library capability assessment | `release:v2.5.0`, `pillar:telemetry-reporting`, `research`, `security` |
| [#23](https://github.com/Robotti-io/Meshcore-Observer/issues/23) | Reporting semantics, identity, retention, and data ownership | `release:v2.5.0`, `pillar:telemetry-reporting`, `decision`, `security`, `configuration` |
| [#24](https://github.com/Robotti-io/Meshcore-Observer/issues/24) | Persist Observer run and shutdown history | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting` |
| [#25](https://github.com/Robotti-io/Meshcore-Observer/issues/25) | Sample process resources and selected runtime events | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting`, `configuration` |
| [#26](https://github.com/Robotti-io/Meshcore-Observer/issues/26) | Persist verified node adverts and direct-heard evidence | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting`, `configuration` |
| [#27](https://github.com/Robotti-io/Meshcore-Observer/issues/27) | Persist passive topology and path evidence | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting`, `configuration` |
| [#28](https://github.com/Robotti-io/Meshcore-Observer/issues/28) | Aggregate bot usage by sender and command | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting`, `security` |
| [#29](https://github.com/Robotti-io/Meshcore-Observer/issues/29) | Coordinate remote requests and conservative radio scheduling | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting`, `configuration` |
| [#30](https://github.com/Robotti-io/Meshcore-Observer/issues/30) | OBS-02: Persist region answers and freshness | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting`, `workstream:obs-02`, `configuration` |
| [#31](https://github.com/Robotti-io/Meshcore-Observer/issues/31) | OBS-02: Query recently direct-heard repeater regions | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting`, `workstream:obs-02`, `configuration` |
| [#32](https://github.com/Robotti-io/Meshcore-Observer/issues/32) | OBS-02: Publish region declarations to CoreScope | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting`, `workstream:obs-02`, `security`, `configuration` |
| [#33](https://github.com/Robotti-io/Meshcore-Observer/issues/33) | Persist supported repeater telemetry and range queries | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting`, `configuration` |
| [#34](https://github.com/Robotti-io/Meshcore-Observer/issues/34) | Poll repeater telemetry within a configured hop radius | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting`, `security`, `configuration` |
| [#35](https://github.com/Robotti-io/Meshcore-Observer/issues/35) | Integrate historical reporting APIs | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting`, `security` |
| [#36](https://github.com/Robotti-io/Meshcore-Observer/issues/36) | Connect telemetry, node, bot, and runtime dashboard reporting | `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting` |
| [#37](https://github.com/Robotti-io/Meshcore-Observer/issues/37) | Validate Pillar 1 RF impact, recovery, performance, and operator guidance | `documentation`, `release:v2.5.0`, `pillar:telemetry-reporting`, `validation` |

## Pillars 2, 3, and 4 child issue mapping

The new issues use the same label definitions. Research, decisions, features, validation, and contributor documentation retain their own work-type labels; configuration/security tags reflect substantive scope. The dedicated OBS-02 label remains on #30–#32.

| Issue | Scope | Labels |
| --- | --- | --- |
| [#66](https://github.com/Robotti-io/Meshcore-Observer/issues/66) | Define setup architecture, local administration, secrets, and activation boundaries | `release:v2.5.0`, `pillar:simplified-setup`, `decision`, `configuration`, `security` |
| [#67](https://github.com/Robotti-io/Meshcore-Observer/issues/67) | Assess distribution, platform matrix, Node runtime, and service packaging | `release:v2.5.0`, `pillar:simplified-setup`, `research`, `configuration` |
| [#68](https://github.com/Robotti-io/Meshcore-Observer/issues/68) | Reuse authoritative configuration validation and provide a static doctor | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration`, `security` |
| [#69](https://github.com/Robotti-io/Meshcore-Observer/issues/69) | Launch secure local setup mode and configuration APIs | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration`, `security` |
| [#70](https://github.com/Robotti-io/Meshcore-Observer/issues/70) | Apply configuration safely with known-good recovery | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration`, `security` |
| [#71](https://github.com/Robotti-io/Meshcore-Observer/issues/71) | Build guided onboarding, review, and resumable setup | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration`, `security` |
| [#72](https://github.com/Robotti-io/Meshcore-Observer/issues/72) | Guide radio configuration and explicitly requested connection checks | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration` |
| [#73](https://github.com/Robotti-io/Meshcore-Observer/issues/73) | Guide MQTT broker configuration and secret-safe connectivity checks | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration`, `security` |
| [#74](https://github.com/Robotti-io/Meshcore-Observer/issues/74) | Guide bot and general Observer configuration including v2.5.0 options | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration`, `security` |
| [#75](https://github.com/Robotti-io/Meshcore-Observer/issues/75) | Reconfigure existing installations without reinstalling | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration`, `security` |
| [#76](https://github.com/Robotti-io/Meshcore-Observer/issues/76) | Export and import configuration with explicit secret handling | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration`, `security` |
| [#77](https://github.com/Robotti-io/Meshcore-Observer/issues/77) | Provide the approved Windows installation entry point | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration` |
| [#78](https://github.com/Robotti-io/Meshcore-Observer/issues/78) | Configure Windows automatic startup using the approved service mechanism | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration`, `security` |
| [#79](https://github.com/Robotti-io/Meshcore-Observer/issues/79) | Provide the approved Linux and Raspberry Pi installation entry point | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration` |
| [#80](https://github.com/Robotti-io/Meshcore-Observer/issues/80) | Configure supported Linux service operation with least privilege | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration`, `security` |
| [#81](https://github.com/Robotti-io/Meshcore-Observer/issues/81) | Expose service status and approved start-stop-restart controls | `release:v2.5.0`, `pillar:simplified-setup`, `enhancement`, `configuration`, `security` |
| [#82](https://github.com/Robotti-io/Meshcore-Observer/issues/82) | Validate setup, reconfiguration, upgrades, recovery, and operator guidance | `release:v2.5.0`, `pillar:simplified-setup`, `validation`, `documentation` |
| [#52](https://github.com/Robotti-io/Meshcore-Observer/issues/52) | Assess bot targeting, private messaging, ACK, and region-scope capabilities | `release:v2.5.0`, `pillar:enhanced-bots`, `research`, `security` |
| [#53](https://github.com/Robotti-io/Meshcore-Observer/issues/53) | Define targeting, response policy, suppression, and delivery lifecycle | `release:v2.5.0`, `pillar:enhanced-bots`, `decision`, `configuration`, `security` |
| [#54](https://github.com/Robotti-io/Meshcore-Observer/issues/54) | Discover and refresh the Companion bot identity | `release:v2.5.0`, `pillar:enhanced-bots`, `enhancement` |
| [#55](https://github.com/Robotti-io/Meshcore-Observer/issues/55) | Match Unicode bot tags and command-level targeting configuration | `release:v2.5.0`, `pillar:enhanced-bots`, `enhancement`, `configuration` |
| [#56](https://github.com/Robotti-io/Meshcore-Observer/issues/56) | Persist reply delivery policy and extended lifecycle state | `release:v2.5.0`, `pillar:enhanced-bots`, `enhancement` |
| [#57](https://github.com/Robotti-io/Meshcore-Observer/issues/57) | Suppress redundant pending replies using handler-aware response evidence | `release:v2.5.0`, `pillar:enhanced-bots`, `enhancement`, `configuration` |
| [#58](https://github.com/Robotti-io/Meshcore-Observer/issues/58) | Resolve per-command region scopes and explicit fallback policy | `release:v2.5.0`, `pillar:enhanced-bots`, `enhancement`, `configuration` |
| [#59](https://github.com/Robotti-io/Meshcore-Observer/issues/59) | Transmit scoped channel replies atomically and restore safe scope state | `release:v2.5.0`, `pillar:enhanced-bots`, `enhancement` |
| [#60](https://github.com/Robotti-io/Meshcore-Observer/issues/60) | Receive private contact commands through existing handlers | `release:v2.5.0`, `pillar:enhanced-bots`, `enhancement`, `configuration`, `security` |
| [#61](https://github.com/Robotti-io/Meshcore-Observer/issues/61) | Deliver private replies through valid contacts with bounded retry and fallback | `release:v2.5.0`, `pillar:enhanced-bots`, `enhancement`, `configuration`, `security` |
| [#62](https://github.com/Robotti-io/Meshcore-Observer/issues/62) | Track private destination ACKs and timeout outcomes | `release:v2.5.0`, `pillar:enhanced-bots`, `enhancement` |
| [#63](https://github.com/Robotti-io/Meshcore-Observer/issues/63) | Assess whether observed topology can safely assist private routing | `release:v2.5.0`, `pillar:enhanced-bots`, `research` |
| [#64](https://github.com/Robotti-io/Meshcore-Observer/issues/64) | Report targeting, suppression, private delivery, ACK, and scope outcomes | `release:v2.5.0`, `pillar:enhanced-bots`, `enhancement`, `security` |
| [#65](https://github.com/Robotti-io/Meshcore-Observer/issues/65) | Validate enhanced bots under multi-bot RF, failure, and recovery scenarios | `release:v2.5.0`, `pillar:enhanced-bots`, `validation`, `documentation` |
| [#38](https://github.com/Robotti-io/Meshcore-Observer/issues/38) | Audit frontend, canonical design references, and approved assets | `release:v2.5.0`, `pillar:ui-ux`, `research` |
| [#39](https://github.com/Robotti-io/Meshcore-Observer/issues/39) | Define product navigation, visualization, and accessibility standards | `release:v2.5.0`, `pillar:ui-ux`, `decision`, `documentation` |
| [#40](https://github.com/Robotti-io/Meshcore-Observer/issues/40) | Centralize Robotti design tokens and product typography | `release:v2.5.0`, `pillar:ui-ux`, `enhancement` |
| [#41](https://github.com/Robotti-io/Meshcore-Observer/issues/41) | Build shared dashboard and setup control patterns | `release:v2.5.0`, `pillar:ui-ux`, `enhancement` |
| [#42](https://github.com/Robotti-io/Meshcore-Observer/issues/42) | Integrate approved branding and offline asset behavior | `release:v2.5.0`, `pillar:ui-ux`, `enhancement`, `security` |
| [#43](https://github.com/Robotti-io/Meshcore-Observer/issues/43) | Refine navigation, overview hierarchy, and drill-down | `release:v2.5.0`, `pillar:ui-ux`, `enhancement` |
| [#44](https://github.com/Robotti-io/Meshcore-Observer/issues/44) | Standardize tables, filters, search, and long identifiers | `release:v2.5.0`, `pillar:ui-ux`, `enhancement` |
| [#45](https://github.com/Robotti-io/Meshcore-Observer/issues/45) | Standardize loading, empty, stale, error, and partial data states | `release:v2.5.0`, `pillar:ui-ux`, `enhancement` |
| [#46](https://github.com/Robotti-io/Meshcore-Observer/issues/46) | Refine chart styling, semantics, and accessible data alternatives | `release:v2.5.0`, `pillar:ui-ux`, `enhancement` |
| [#47](https://github.com/Robotti-io/Meshcore-Observer/issues/47) | Refine responsive layouts and touch interaction | `release:v2.5.0`, `pillar:ui-ux`, `enhancement` |
| [#48](https://github.com/Robotti-io/Meshcore-Observer/issues/48) | Refine keyboard, focus, and assistive-technology semantics | `release:v2.5.0`, `pillar:ui-ux`, `enhancement` |
| [#49](https://github.com/Robotti-io/Meshcore-Observer/issues/49) | Polish motion and interaction while respecting reduced motion | `release:v2.5.0`, `pillar:ui-ux`, `enhancement` |
| [#50](https://github.com/Robotti-io/Meshcore-Observer/issues/50) | Standardize product copy, metric help, and recovery guidance | `release:v2.5.0`, `pillar:ui-ux`, `enhancement`, `documentation` |
| [#83](https://github.com/Robotti-io/Meshcore-Observer/issues/83) | Validate integrated UI consistency, accessibility, and performance | `release:v2.5.0`, `pillar:ui-ux`, `validation`, `documentation` |
| [#51](https://github.com/Robotti-io/Meshcore-Observer/issues/51) | Publish contributor UI and visualization guidance | `release:v2.5.0`, `pillar:ui-ux`, `documentation` |

## Scope-specific review notes

For the initial epics/Pillar 1 group, security labels apply to the telemetry/setup/bot epics (#18–#20), protocol/authentication research (#22), data/privacy decisions (#23), sender aggregates (#28), CoreScope broker permissions/publication (#32), telemetry authentication (#34), and reporting API data exposure (#35). The additional mapping records the substantive setup administration/secrets and private-bot scope classifications.

For the initial epics/Pillar 1 group, configuration labels apply to the telemetry/setup/bot epics (#18–#20), shared override/default decisions (#23), process sampling cadence (#25), direct-heard eligibility configuration (#26), discovery settings (#31), per-broker publication opt-in (#32), and telemetry radius/cadence/credential references (#34). The additional mapping covers guided setup/service settings and bot policy configuration. #23/#26 gained the configuration label on 2026-10-08 as the explicit default/override requirements were settled.

The initial mapping covers the 20 epic/Pillar 1 issues; the additional table covers the 46 Pillar 2/3/4 children. Verification rereads all 66 label sets against these mappings. Runtime tests are not applicable to issue capture or label metadata changes.
- #26 completion update on 2026-10-08: all five tasks/acceptance complete with 544 tests, CI coverage and lint. Default indefinite fingerprints and optional save-first day-based cleanup preserve offline inventory/discovery. Issue closed as completed, `status:in-progress` removed, native project #1 Status Done verified; release/pillar/configuration/enhancement labels preserved. #37/#42/#83 gained offline/recovery acceptance requirements without changing their labels or queued status.
- #24 completion on 2026-10-08: approved run-history implementation passes 564 tests, CI coverage and lint; issue closed as completed, `status:in-progress` removed, native project #1 Status Done verified. `enhancement`, `release:v2.5.0` and `pillar:telemetry-reporting` preserved; no new configuration/API/dependency scope. #18/#23/#25 remain active for their unfinished work.
- #25 completion on 2026-10-08: all five resource/event tasks and acceptance criteria pass; 591 tests, CI coverage and lint pass. Issue closed as completed, `status:in-progress` removed, native project #1 Status Done verified. `enhancement`, `release:v2.5.0`, `pillar:telemetry-reporting` and `configuration` preserved. #18/#22/#23 retain their active status for unfinished work; no unrelated issue is advanced.

- #32 completion on 2026-10-10: T1–T5/code-fixture acceptance complete, 1,010 tests/CI coverage/lint pass. Close as completed, remove `status:in-progress`, verify native project #1 Done; preserve enhancement/configuration/security/release/pillar/OBS-02 labels. Live ACL/CoreScope/RF evidence stays in #37; #18/#23 remain active.

- #33 implementation on 2026-10-10: TELEMETRY-PLAN-01–05 approved; T1/T2 user-pushed 0e40d81/f2fcabe; T3 owned migration 16/history/retention complete locally, 1,086 tests/full CI coverage/lint pass. OPEN/native project In progress and status/configuration/enhancement/release/pillar labels preserved. No feature acceptance is checked for partial delivery; #34 owns authentication/polling.
