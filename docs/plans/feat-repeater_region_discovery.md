# Feature: Repeater Region Discovery for CoreScope

- **Status:** Included in v2.5.0; #30 storage delivered/user-pushed f2d567c; #31 plan approved/T1–T2 user-pushed 3677f2e/T3 scheduling and migration 15 complete locally; #32 publication queued
- **Backlog ID:** OBS-02
- **Requested:** 2026-10-06
- **Release:** v2.5.0
- **Parent pillar:** [Pillar 1: Improved Telemetry & Reporting](v2.5.0/feat-improved_telemetry_and_reporting.md)
- **GitHub epic:** [#18](https://github.com/Robotti-io/Meshcore-Observer/issues/18)
- **Feature issues:** [#30: durable answers](https://github.com/Robotti-io/Meshcore-Observer/issues/30), [#31: direct-heard querying](https://github.com/Robotti-io/Meshcore-Observer/issues/31), [#32: CoreScope publication](https://github.com/Robotti-io/Meshcore-Observer/issues/32)
- **Shared prerequisites:** [Pillar 1 child issue register](v2.5.0/pillar-1-child-issues.md)
- **Scope decision:** Included in v2.5.0 by explicit human direction on 2026-10-07.
- **Approval scope:** Release inclusion; #30 delivered; #31 finalized plan and QUERY-PLAN-01–05 approved on 2026-10-10. #32 publication and separately scoped hardware/protected changes retain their own review.

## Summary

Add optional, conservative region discovery for repeaters the Observer hears directly. Query a repeater's declared flood-allowed regions through the Companion protocol, persist successful answers in the existing SQLite store, and publish CoreScope-compatible answers to `meshcore/client/{PUBLIC_KEY}/regions`.

The current raw packet feed preserves transport-scope evidence, which CoreScope can decode to determine what repeaters are observed forwarding. It does not provide their declared flood-allowed region lists. Collecting those answers would let CoreScope compare declared configuration with observed behavior and derive region keys from discovered names.

The observer `/neighbors` MQTT report is the built-in observer path used by repeaters running the gessaman observer firmware. This request targets the companion-based Observer and the client `/regions` contract, rather than implementing that firmware's `/neighbors` report.

## Goals

- Discover declared regions from verified repeaters currently heard directly.
- Use anonymous region requests without management or telemetry passwords.
- Limit RF traffic with configurable refresh cadence, bounded retries, and backoff.
- Preserve successful answers and freshness across process restarts.
- Publish validated answers using CoreScope's existing client region-discovery contract.
- Share the existing radio command queue and airtime coordinator with bot replies, flood adverts, and future telemetry polling.

## Initial Scope

### Target eligibility and routing

- Begin with verified, zero-hop repeater adverts carrying a full public key. A stored repeater name or its appearance in a relayed packet is not sufficient evidence of current direct reachability.
- Track direct-heard recency separately from the registry's general last-heard time, with an operator-configurable eligibility window.
- Agreed on 2026-10-08: measure that window from Observer reception time, refreshing it only for verified repeater adverts received with zero recorded relay hops. On expiry stop scheduling region queries until qualifying evidence returns, retaining inventory and previous successful answers. Actual advert cadence varies; the approved default is **72 hours**, with a validated operator override and matching example/central-code fallback when omitted, under #23/#26. Exact units/validation bounds remain implementation-plan details. A flood advert heard before any relay hops can qualify; later relayed copies do not refresh direct eligibility.
- Ensure outbound requests actually use a direct route and request a zero-hop reply. The repeater ignores flooded region requests.
- Inspect the Companion's send acknowledgement to detect an unexpectedly flooded request.
- Account for saved contact paths and contact-table capacity. Recent Companion firmware can create a contact for an unknown target, but this can still fail when the table is full.
- If a temporary contact-path override is necessary, define how the original state is preserved and restored on success, timeout, error, disconnect, and restart. Do not silently alter operator-managed routing or evict contacts.

### Protocol and library support

- Confirm the deployed Companion and target repeater firmware support anonymous region requests before selecting a minimum supported version.
- The researched command is `CMD_SEND_ANON_REQ` (`57`, `0x39`): destination public key, `ANON_REQ_TYPE_REGIONS` (`0x01`), then reply-path length and bytes. For the initial zero-hop reply, the reply-path length is `0`.
- The Companion supplies a request tag in its `Sent` acknowledgement; the reply arrives through `BinaryResponse` (`0x8C`). Match replies to that tag and target before processing.
- The installed `@liamcottle/meshcore.js` 1.15.0 exposes binary-response parsing but lacks an anonymous-request method. Evaluate upstream support or a small JavaScript adapter over the existing transport; do not add another protocol library or edit installed dependency files.
- Start with one remote request outstanding, coordinating with other remote request types. The researched Companion firmware maintains a pending request tag that subsequent remote requests can replace; serializing only command acknowledgements is insufficient.
- Keep serial and TCP Companion transports supported.

### Scheduling and response semantics

- Make active discovery opt-in. Parse configuration centrally and validate it before hardware or network activity.
- Document approved optional discovery defaults and units in example configuration and define matching fallbacks in central code. Valid explicit operator overrides take precedence; invalid explicit values fail instead of silently using defaults. Validate omitted/override/invalid cases and example/code agreement during implementation.
- Reuse `RadioManager.runCommand()` and `AirtimeCoordinator`; define scheduling priority so discovery cannot starve existing bot or radio work.
- Use bounded request timeouts, per-target backoff, refresh intervals, and bounded transient state. Pause on disconnection and discard pending correlation state when the connection changes.
- Parse the repeater clock and region-name CSV from a matched answer, removing trailing encryption NUL padding before validating normalized data.
- Validate inbound normalized responses and outbound MQTT objects through centralized strict AJV schemas with `additionalProperties: false`.
- Preserve region-name case, since it affects key derivation. Preserve `*` as the flood wildcard, rather than treating it as a named region.
- A successful empty region list is a measured answer. A timeout, malformed reply, unsupported command, or missing answer is unknown and must not overwrite a prior successful list with an empty one.
- The firmware's response budget can omit names without an explicit wire truncation marker. Document any truncation heuristic; do not promise that `truncated: false` proves completeness.

### Persistence and MQTT publication

- Store queryable answers, their timestamps, and freshness in the existing always-on `MetricsStore`, regardless of dashboard enablement. Define the migration, retention, and history-versus-latest representation during planning.
- Keep purely transient request tags and pending work in bounded runtime memory. Do not add local raw-packet persistence.
- Publish successful answers to `meshcore/client/{PUBLIC_KEY}/regions`, where `{PUBLIC_KEY}` identifies our reporting Companion. Use lowercase hexadecimal keys to match CoreScope's client contract.
- Payload fields: `type: "REGIONS"`, `timestamp`, `target` (the repeater's full 64-character public key), `regions` (an array of strings), `truncated`, and optional `repeater_clock`.
- GPS is optional and is not required for this stationary Observer feature. Do not fabricate a position.
- Define per-broker opt-in routing and publication retry behavior. Broker permissions for our existing observer topics do not necessarily authorize the client topic, and not every configured broker necessarily supports it.
- Preserve the answer's observation timestamp if publication is delayed. An MQTT failure must not lose a persisted successful answer or disrupt packet capture.
- CoreScope must enable `clientRegions.enabled`; its broker must authorize our identity to publish under our Companion key. This feature does not require `clientRxCoverage`, GPS reception uploads, or RF samples.

## Non-Goals

- Mesh-wide flood discovery or multi-hop region polling in the initial version.
- Repeater login, management commands, region configuration changes, or credential collection.
- Publishing the gessaman firmware's observer `/neighbors` object.
- GPS tracking, client coverage, or RF-environment sample uploads.
- A new storage engine, protocol dependency, dashboard API, or bot command. Reporting surfaces may be proposed separately.

## Existing Integration Points

- `src/nodes/advert-parser.js` and `src/nodes/node-registry.js`: advert parsing and signature verification; direct-heard eligibility is additional state.
- `src/radio/radio-manager.js` and `src/radio/command-queue.js`: Companion commands, connection lifecycle, and reply events.
- `src/radio/airtime-coordinator.js`: coordination with existing transmissions.
- `src/metrics/store.js`: persisted discovery data and any approved migration.
- `src/mqtt/observer-publisher.js`, `src/mqtt/mqtt-manager.js`, and `src/mqtt/topic-resolver.js`: validated region publication and broker routing.
- `src/config/index.js`, centralized schemas, and `src/validation/ajv.js`: strict configuration and payload validation.
- `src/index.js`: service startup, event wiring, and shutdown.

## Acceptance Criteria

- Only eligible, recently direct-heard verified repeaters are queried in the initial scope.
- Queries use the intended direct route; flooded acknowledgements are handled explicitly.
- Replies are attributed only through a matching request tag; unrelated binary replies are ignored.
- Valid answers, including empty lists, survive restart and publish in CoreScope's accepted shape.
- Timeouts and failures preserve prior successful declarations and remain distinguishable from empty answers.
- Padding and potentially truncated answers are handled without corrupting region names.
- Unsupported firmware, full contacts, contact-path restoration failures, radio disconnects, and broker failures remain observable without stopping normal capture.
- Scheduling remains bounded and compatible with bot replies, flood adverts, and remote telemetry requests.
- Tests cover protocol framing, strict validation, correlation, routing, scheduling, persistence/migration, publication failures, and connection lifecycle.
- Repository `npm test` and `npm run lint` checks pass during implementation, followed by authorized hardware verification of a real answer reaching CoreScope.

## Open Questions Before Implementation

- Which deployed Companion/repeater versions support the operation, and does current upstream JavaScript library support remove the need for an adapter?
- Can direct routing be guaranteed without changing saved contact state? If not, what recovery strategy is acceptable?
- What are the opt-in configuration, direct-heard window, refresh cadence, retry budget, timeout, and retention defaults for a stationary observer?
- Should persistence retain answer history, latest answers, or both? Should query outcomes also become queryable data?
- Which brokers should receive region objects, and should failed publications use a persisted retry record?
- How should discovery share remote-request ownership with the proposed telemetry poller?
- Is operator reporting needed in this feature or a separate follow-up?

## Relationship to Other Backlog Work

OBS-02 is included in v2.5.0 under [Pillar 1: Improved Telemetry & Reporting](v2.5.0/feat-improved_telemetry_and_reporting.md), following explicit human direction on 2026-10-07. Region discovery can share approved eligibility and scheduling infrastructure with passive topology learning and scheduled repeater telemetry, but uses an anonymous request and must remain independent of telemetry credentials. Its initial zero-hop eligibility also remains narrower than telemetry's configurable hop radius.

Pillar 1 owns declared-region discovery, persisted answers, and CoreScope-compatible publication. Pillar 3 owns outbound bot region policy and scoped transmission; discovery does not itself authorize a particular bot scope. CoreScope publication is included in the release feature intent, while its concrete MQTT contract, broker permissions, persistence changes, and dependency integration remain subject to implementation-plan approval.

[MeshCore.js PR #44](https://github.com/meshcore-dev/meshcore.js/pull/44) supplies the proposed upstream anonymous-request API. Validate the available package/artifact, required firmware, direct contact routing, remote-request serialization, and response limitations during planning. A merged PR alone does not guarantee the API is available in the installed dependency.

## Research References

Research captured on 2026-10-06; recheck upstream and deployed firmware when planning implementation.

- [CoreScope client region-discovery contract](https://github.com/OKI-Mesh/CoreScope/blob/6cab7d698d15f739dcaa0f04df70eaa80f5d13da/docs/client-regions.md)
- [CoreScope region-key derivation](https://github.com/OKI-Mesh/CoreScope/blob/6cab7d698d15f739dcaa0f04df70eaa80f5d13da/cmd/ingestor/region_keys.go)
- [MeshCore Companion command and reply handling](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/examples/companion_radio/MyMesh.cpp)
- [MeshCore repeater anonymous region handler](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/examples/simple_repeater/MyMesh.cpp)
- [CoreDrive RX region request/reply framing](https://github.com/efiten/coredrive-rx/blob/9b053d6537df78ae2d51e9ffec846807169575db/src/regionreq.js)

Backlog documentation does not authorize changes to dependencies, storage, public MQTT contracts, authentication, logging contracts, or deployment. Resolve those boundaries in a separately approved implementation plan.
