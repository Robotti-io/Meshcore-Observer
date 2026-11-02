# Engineering audit coverage inventory — 2026-11-01

Companion to [the consolidated report](2026-11-01-engineering-audit.md). Branch `release-v_2_5_0`, HEAD `eb9ab9f3ca67d40d15d7b7ca0724b922f7c82827`, plus the pre-existing working-tree edits documented there.

All 136 source assets were assessed by the named review area; all 135 JavaScript files entered structural analysis. Assessment means code responsibility, relevant control/data flow, trust/lifecycle concerns and associated test scenarios were reviewed. It does not imply exhaustive formal verification or live operational testing. CSS was reviewed structurally; visual/browser accessibility was not executed.

| File | Physical lines | Local imports | Review owner | Assessment focus |
|---|---:|---:|---|---|
| [src/bots/bots-config-loader.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/bots-config-loader.js) | 163 | 3 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/channel-bot.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/channel-bot.js) | 832 | 12 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/channel-key.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/channel-key.js) | 20 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/channel-setup.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/channel-setup.js) | 53 | 1 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/command-handlers/exact.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/command-handlers/exact.js) | 46 | 2 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/command-handlers/handler-state.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/command-handlers/handler-state.js) | 59 | 1 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/command-handlers/index.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/command-handlers/index.js) | 13 | 3 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/command-handlers/lookup.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/command-handlers/lookup.js) | 118 | 1 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/command-handlers/stats.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/command-handlers/stats.js) | 43 | 2 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/command-target.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/command-target.js) | 37 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/group-text-crypto.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/group-text-crypto.js) | 69 | 2 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/region-scope.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/region-scope.js) | 53 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/repeat-check-sweeper.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/repeat-check-sweeper.js) | 67 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/repeat-check-tracker.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/repeat-check-tracker.js) | 118 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/reply-dispatcher.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/reply-dispatcher.js) | 25 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/reply-queue.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/reply-queue.js) | 298 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/reply-scope-policy.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/reply-scope-policy.js) | 98 | 1 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/reply-suppression.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/reply-suppression.js) | 54 | 3 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/response-template.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/response-template.js) | 83 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/schemas.js) | 155 | 1 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/bots/stats-range.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/bots/stats-range.js) | 41 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/config/index.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/config/index.js) | 379 | 11 | Principal reviewer | Process composition, configuration, validation, logging, health, tooling/test integration |
| [src/config/schema.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/config/schema.js) | 176 | 9 | Principal reviewer | Process composition, configuration, validation, logging, health, tooling/test integration |
| [src/health/service-health.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/health/service-health.js) | 145 | 0 | Principal reviewer | Process composition, configuration, validation, logging, health, tooling/test integration |
| [src/index.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/index.js) | 434 | 33 | Principal reviewer | Process composition, configuration, validation, logging, health, tooling/test integration |
| [src/logging/logger.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/logging/logger.js) | 74 | 0 | Principal reviewer | Process composition, configuration, validation, logging, health, tooling/test integration |
| [src/metrics/bot-reply-lifecycle-migration.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/bot-reply-lifecycle-migration.js) | 50 | 0 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/bot-reply-suppression-migration.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/bot-reply-suppression-migration.js) | 7 | 0 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/process-measurements.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/process-measurements.js) | 60 | 2 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/process-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/process-schemas.js) | 101 | 0 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/region-history.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/region-history.js) | 192 | 2 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/region-migration.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/region-migration.js) | 67 | 0 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/region-poll-migration.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/region-poll-migration.js) | 38 | 0 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/region-poll-state.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/region-poll-state.js) | 214 | 2 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/region-reads.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/region-reads.js) | 112 | 3 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/run-history.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/run-history.js) | 71 | 0 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/run-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/run-schemas.js) | 38 | 0 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/runtime-events.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/runtime-events.js) | 95 | 2 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/sampler.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/sampler.js) | 159 | 1 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/schemas.js) | 159 | 0 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/stats-reporter.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/stats-reporter.js) | 30 | 0 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/store.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/store.js) | 2188 | 23 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/telemetry-diagnostics.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/telemetry-diagnostics.js) | 57 | 2 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/telemetry-history.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/telemetry-history.js) | 107 | 1 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/telemetry-migration.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/telemetry-migration.js) | 75 | 0 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/telemetry-neighbour-frontier.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/telemetry-neighbour-frontier.js) | 119 | 4 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/telemetry-owner-info-migration.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/telemetry-owner-info-migration.js) | 93 | 1 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/telemetry-poll-migration.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/telemetry-poll-migration.js) | 63 | 1 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/telemetry-poll-state.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/telemetry-poll-state.js) | 317 | 3 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/telemetry-reads.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/telemetry-reads.js) | 118 | 2 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/topology-history.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/topology-history.js) | 420 | 4 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/metrics/topology-migration.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/metrics/topology-migration.js) | 38 | 0 | Persistence reviewer | Connection, migrations, data integrity, reads, scheduling state, retention, tests |
| [src/mqtt/brokers-config-loader.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/brokers-config-loader.js) | 118 | 3 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/letsmesh-auth.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/letsmesh-auth.js) | 117 | 0 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/mqtt-broker.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/mqtt-broker.js) | 250 | 0 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/mqtt-manager.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/mqtt-manager.js) | 133 | 4 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/observer-publisher.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/observer-publisher.js) | 40 | 2 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/observer-status-scheduler.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/observer-status-scheduler.js) | 72 | 2 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/observer-status-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/observer-status-schemas.js) | 23 | 1 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/observer-status.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/observer-status.js) | 31 | 2 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/region-payload.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/region-payload.js) | 19 | 4 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/region-publication-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/region-publication-schemas.js) | 23 | 1 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/region-publisher.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/region-publisher.js) | 129 | 7 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/schemas.js) | 52 | 1 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/token-refresh-loop.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/token-refresh-loop.js) | 50 | 0 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/mqtt/topic-resolver.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/mqtt/topic-resolver.js) | 25 | 0 | MQTT reviewer | Credential and client lifecycle, publication, bounds, durable resolution, tests |
| [src/nodes/advert-parser.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/nodes/advert-parser.js) | 68 | 2 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/nodes/node-registry.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/nodes/node-registry.js) | 155 | 4 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/nodes/schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/nodes/schemas.js) | 81 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/nodes/topology-observer.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/nodes/topology-observer.js) | 73 | 3 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/nodes/topology-parser.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/nodes/topology-parser.js) | 47 | 2 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/nodes/topology-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/nodes/topology-schemas.js) | 59 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/packets/packet-decoder.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/packets/packet-decoder.js) | 60 | 1 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/packets/packet-deduplicator.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/packets/packet-deduplicator.js) | 66 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/packets/packet-hash.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/packets/packet-hash.js) | 23 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/packets/packet-normalizer.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/packets/packet-normalizer.js) | 33 | 2 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/packets/packet-pipeline.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/packets/packet-pipeline.js) | 63 | 2 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/packets/schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/packets/schemas.js) | 15 | 0 | Bots/capture/nodes reviewer | Inbound trust, command handlers, reply lifecycle, signed inventory, topology, tests |
| [src/radio/airtime-coordinator.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/airtime-coordinator.js) | 56 | 0 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/background-admissions.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/background-admissions.js) | 29 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/backoff.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/backoff.js) | 10 | 0 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/clock-sync.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/clock-sync.js) | 27 | 0 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/command-queue.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/command-queue.js) | 26 | 0 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/connection-lifecycle.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/connection-lifecycle.js) | 56 | 0 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/flood-advert-scheduler.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/flood-advert-scheduler.js) | 123 | 0 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/lifecycle-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/lifecycle-schemas.js) | 20 | 0 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/observer-status-reader.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/observer-status-reader.js) | 86 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/observer-status-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/observer-status-schemas.js) | 19 | 0 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/radio-manager.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/radio-manager.js) | 429 | 10 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/remote-coordinator-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/remote-coordinator-schemas.js) | 71 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/remote-request-budget.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/remote-request-budget.js) | 83 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/remote-request-coordinator.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/remote-request-coordinator.js) | 1203 | 17 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/remote-request-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/remote-request-schemas.js) | 65 | 0 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/remote-request.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/remote-request.js) | 44 | 3 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/remote-response-parser.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/remote-response-parser.js) | 41 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/trace-decoder.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/trace-decoder.js) | 27 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/transports/connect-helpers.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/transports/connect-helpers.js) | 35 | 0 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/transports/serial-transport.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/transports/serial-transport.js) | 49 | 1 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/radio/transports/tcp-transport.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/radio/transports/tcp-transport.js) | 44 | 1 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/regions/region-discovery-scheduler.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/regions/region-discovery-scheduler.js) | 216 | 5 | Regions reviewer | Eligibility, reservation, parsing, terminal persistence, lifecycle, tests |
| [src/regions/region-query-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/regions/region-query-schemas.js) | 107 | 2 | Regions reviewer | Eligibility, reservation, parsing, terminal persistence, lifecycle, tests |
| [src/regions/region-query-validation.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/regions/region-query-validation.js) | 30 | 3 | Regions reviewer | Eligibility, reservation, parsing, terminal persistence, lifecycle, tests |
| [src/regions/region-radio-adapter.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/regions/region-radio-adapter.js) | 37 | 3 | Regions reviewer | Eligibility, reservation, parsing, terminal persistence, lifecycle, tests |
| [src/regions/region-response-parser.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/regions/region-response-parser.js) | 29 | 2 | Regions reviewer | Eligibility, reservation, parsing, terminal persistence, lifecycle, tests |
| [src/regions/region-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/regions/region-schemas.js) | 99 | 1 | Regions reviewer | Eligibility, reservation, parsing, terminal persistence, lifecycle, tests |
| [src/regions/region-validation.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/regions/region-validation.js) | 40 | 2 | Regions reviewer | Eligibility, reservation, parsing, terminal persistence, lifecycle, tests |
| [src/telemetry/decoder-helpers.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/decoder-helpers.js) | 30 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/neighbour-parser.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/neighbour-parser.js) | 27 | 1 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/owner-info-parser.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/owner-info-parser.js) | 25 | 1 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/poll-state-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/poll-state-schemas.js) | 54 | 4 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/polling-config.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/polling-config.js) | 147 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/polling-result.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/polling-result.js) | 42 | 8 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/polling-scheduler.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/polling-scheduler.js) | 453 | 5 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/polling-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/polling-schemas.js) | 113 | 0 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/sensor-parser.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/sensor-parser.js) | 54 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/status-parser.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/status-parser.js) | 28 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/telemetry-contact-inventory.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/telemetry-contact-inventory.js) | 110 | 3 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/telemetry-contact-manager.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/telemetry-contact-manager.js) | 83 | 1 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/telemetry-guest-sessions.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/telemetry-guest-sessions.js) | 44 | 0 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/telemetry-owner-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/telemetry-owner-schemas.js) | 79 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/telemetry-radio-adapter.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/telemetry-radio-adapter.js) | 143 | 4 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/telemetry-radio-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/telemetry-radio-schemas.js) | 109 | 1 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/telemetry-radio-validation.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/telemetry-radio-validation.js) | 17 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/telemetry-schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/telemetry-schemas.js) | 202 | 1 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/telemetry/telemetry-validation.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/telemetry/telemetry-validation.js) | 118 | 2 | Radio/telemetry reviewer | Admission, correlation, recovery, parsing, auth/session ownership, scheduling, tests |
| [src/validation/ajv.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/validation/ajv.js) | 24 | 0 | Principal reviewer | Process composition, configuration, validation, logging, health, tooling/test integration |
| [src/web/bot-command-buckets.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/web/bot-command-buckets.js) | 18 | 0 | Web reviewer | Read-only HTTP, strict query schemas, request/UI state, rendering, tests |
| [src/web/client/dashboard-logic.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/web/client/dashboard-logic.js) | 318 | 0 | Web reviewer | Read-only HTTP, strict query schemas, request/UI state, rendering, tests |
| [src/web/client/dashboard.css](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/web/client/dashboard.css) | 165 | 0 | Web reviewer | Read-only HTTP, strict query schemas, request/UI state, rendering, tests |
| [src/web/client/dashboard.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/web/client/dashboard.js) | 1443 | 1 | Web reviewer | Read-only HTTP, strict query schemas, request/UI state, rendering, tests |
| [src/web/dashboard-page.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/web/dashboard-page.js) | 250 | 0 | Web reviewer | Read-only HTTP, strict query schemas, request/UI state, rendering, tests |
| [src/web/metrics-range.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/web/metrics-range.js) | 55 | 0 | Web reviewer | Read-only HTTP, strict query schemas, request/UI state, rendering, tests |
| [src/web/metrics-sample.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/web/metrics-sample.js) | 69 | 1 | Web reviewer | Read-only HTTP, strict query schemas, request/UI state, rendering, tests |
| [src/web/metrics-server.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/web/metrics-server.js) | 994 | 7 | Web reviewer | Read-only HTTP, strict query schemas, request/UI state, rendering, tests |
| [src/web/packet-type-buckets.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/web/packet-type-buckets.js) | 55 | 0 | Web reviewer | Read-only HTTP, strict query schemas, request/UI state, rendering, tests |
| [src/web/schemas.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/src/web/schemas.js) | 253 | 2 | Web reviewer | Read-only HTTP, strict query schemas, request/UI state, rendering, tests |

## Test and fixture inventory

All 115 test files and 18 fixtures were accounted for through scenario inventory and targeted detailed test reads. Critical lifecycle, schema/migration, concurrency and integration bodies received detailed attention; no claim is made that every assertion was independently line-reviewed. The full executable baseline is reported separately in the main report.

- [test/bots/bots-config-loader.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/bots-config-loader.test.js)
- [test/bots/channel-bot.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/channel-bot.test.js)
- [test/bots/channel-setup.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/channel-setup.test.js)
- [test/bots/command-target.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/command-target.test.js)
- [test/bots/group-text-crypto.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/group-text-crypto.test.js)
- [test/bots/handler-state.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/handler-state.test.js)
- [test/bots/repeat-check-sweeper.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/repeat-check-sweeper.test.js)
- [test/bots/repeat-check-tracker.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/repeat-check-tracker.test.js)
- [test/bots/reply-dispatcher.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/reply-dispatcher.test.js)
- [test/bots/reply-queue.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/reply-queue.test.js)
- [test/bots/reply-scope-policy.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/reply-scope-policy.test.js)
- [test/bots/reply-suppression.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/reply-suppression.test.js)
- [test/bots/response-template.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/response-template.test.js)
- [test/bots/stats-range.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/bots/stats-range.test.js)
- [test/config/config.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/config/config.test.js)
- [test/config/telemetry-polling.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/config/telemetry-polling.test.js)
- [test/fixtures/neighbour-frontier.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/neighbour-frontier.js)
- [test/fixtures/observer-status-wire.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/observer-status-wire.js)
- [test/fixtures/packet-frames.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/packet-frames.js)
- [test/fixtures/region-discovery-child.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/region-discovery-child.js)
- [test/fixtures/region-downgrade.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/region-downgrade.js)
- [test/fixtures/region-poll.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/region-poll.js)
- [test/fixtures/region-publication-child.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/region-publication-child.js)
- [test/fixtures/remote-frames.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/remote-frames.js)
- [test/fixtures/run-lifecycle-child.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/run-lifecycle-child.js)
- [test/fixtures/signed-advert.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/signed-advert.js)
- [test/fixtures/telemetry-downgrade.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/telemetry-downgrade.js)
- [test/fixtures/telemetry-lifecycle-child.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/telemetry-lifecycle-child.js)
- [test/fixtures/telemetry-poll.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/telemetry-poll.js)
- [test/fixtures/telemetry-polling-child.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/telemetry-polling-child.js)
- [test/fixtures/telemetry-radio-wire.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/telemetry-radio-wire.js)
- [test/fixtures/telemetry-store.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/telemetry-store.js)
- [test/fixtures/telemetry-wire.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/telemetry-wire.js)
- [test/fixtures/topology-downgrade.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/fixtures/topology-downgrade.js)
- [test/health/service-health.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/health/service-health.test.js)
- [test/index-region-discovery.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/index-region-discovery.test.js)
- [test/index-run-history.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/index-run-history.test.js)
- [test/index-telemetry-polling.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/index-telemetry-polling.test.js)
- [test/index-telemetry.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/index-telemetry.test.js)
- [test/index.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/index.test.js)
- [test/logging/logger.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/logging/logger.test.js)
- [test/metrics/advert-history.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/advert-history.test.js)
- [test/metrics/bot-reply-lifecycle.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/bot-reply-lifecycle.test.js)
- [test/metrics/bot-usage.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/bot-usage.test.js)
- [test/metrics/process-history-store.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/process-history-store.test.js)
- [test/metrics/process-measurements.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/process-measurements.test.js)
- [test/metrics/region-cost.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/region-cost.test.js)
- [test/metrics/region-history.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/region-history.test.js)
- [test/metrics/region-poll-cost.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/region-poll-cost.test.js)
- [test/metrics/region-poll-state.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/region-poll-state.test.js)
- [test/metrics/region-publication-selection.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/region-publication-selection.test.js)
- [test/metrics/region-publication-state.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/region-publication-state.test.js)
- [test/metrics/region-reads.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/region-reads.test.js)
- [test/metrics/run-history-store.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/run-history-store.test.js)
- [test/metrics/run-history.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/run-history.test.js)
- [test/metrics/runtime-events.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/runtime-events.test.js)
- [test/metrics/sampler.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/sampler.test.js)
- [test/metrics/stats-reporter.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/stats-reporter.test.js)
- [test/metrics/store.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/store.test.js)
- [test/metrics/telemetry-cost.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/telemetry-cost.test.js)
- [test/metrics/telemetry-diagnostics.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/telemetry-diagnostics.test.js)
- [test/metrics/telemetry-history.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/telemetry-history.test.js)
- [test/metrics/telemetry-migration.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/telemetry-migration.test.js)
- [test/metrics/telemetry-neighbour-frontier.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/telemetry-neighbour-frontier.test.js)
- [test/metrics/telemetry-poll-cost.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/telemetry-poll-cost.test.js)
- [test/metrics/telemetry-poll-state.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/telemetry-poll-state.test.js)
- [test/metrics/telemetry-reads.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/telemetry-reads.test.js)
- [test/metrics/telemetry-retention.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/telemetry-retention.test.js)
- [test/metrics/topology-cost.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/topology-cost.test.js)
- [test/metrics/topology-history.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/metrics/topology-history.test.js)
- [test/mqtt/brokers-config-loader.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/mqtt/brokers-config-loader.test.js)
- [test/mqtt/letsmesh-auth.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/mqtt/letsmesh-auth.test.js)
- [test/mqtt/mqtt-broker.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/mqtt/mqtt-broker.test.js)
- [test/mqtt/mqtt-manager.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/mqtt/mqtt-manager.test.js)
- [test/mqtt/observer-publisher.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/mqtt/observer-publisher.test.js)
- [test/mqtt/observer-status-scheduler.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/mqtt/observer-status-scheduler.test.js)
- [test/mqtt/observer-status.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/mqtt/observer-status.test.js)
- [test/mqtt/region-payload.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/mqtt/region-payload.test.js)
- [test/mqtt/region-publisher.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/mqtt/region-publisher.test.js)
- [test/mqtt/region-transport.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/mqtt/region-transport.test.js)
- [test/mqtt/token-refresh-loop.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/mqtt/token-refresh-loop.test.js)
- [test/mqtt/topic-resolver.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/mqtt/topic-resolver.test.js)
- [test/nodes/advert-parser.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/nodes/advert-parser.test.js)
- [test/nodes/node-registry.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/nodes/node-registry.test.js)
- [test/nodes/telemetry-direct-evidence.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/nodes/telemetry-direct-evidence.test.js)
- [test/nodes/topology-observer.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/nodes/topology-observer.test.js)
- [test/nodes/topology-parser.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/nodes/topology-parser.test.js)
- [test/nodes/verified-reception.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/nodes/verified-reception.test.js)
- [test/packets/packet-decoder.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/packets/packet-decoder.test.js)
- [test/packets/packet-deduplicator.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/packets/packet-deduplicator.test.js)
- [test/packets/packet-hash.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/packets/packet-hash.test.js)
- [test/packets/packet-normalizer.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/packets/packet-normalizer.test.js)
- [test/packets/packet-pipeline.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/packets/packet-pipeline.test.js)
- [test/radio/airtime-coordinator.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/airtime-coordinator.test.js)
- [test/radio/background-admissions.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/background-admissions.test.js)
- [test/radio/backoff.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/backoff.test.js)
- [test/radio/clock-sync.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/clock-sync.test.js)
- [test/radio/command-queue.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/command-queue.test.js)
- [test/radio/flood-advert-scheduler.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/flood-advert-scheduler.test.js)
- [test/radio/observer-status-reader.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/observer-status-reader.test.js)
- [test/radio/radio-manager.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/radio-manager.test.js)
- [test/radio/remote-request-admission.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/remote-request-admission.test.js)
- [test/radio/remote-request-coordinator.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/remote-request-coordinator.test.js)
- [test/radio/remote-request-integration.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/remote-request-integration.test.js)
- [test/radio/remote-request.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/remote-request.test.js)
- [test/radio/remote-response-parser.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/remote-response-parser.test.js)
- [test/radio/telemetry-exchange-budget.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/telemetry-exchange-budget.test.js)
- [test/radio/telemetry-owner.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/telemetry-owner.test.js)
- [test/radio/trace-decoder.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/trace-decoder.test.js)
- [test/radio/transports/connect-helpers.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/transports/connect-helpers.test.js)
- [test/radio/transports/serial-transport.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/transports/serial-transport.test.js)
- [test/radio/transports/tcp-transport.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/radio/transports/tcp-transport.test.js)
- [test/regions/region-discovery-scheduler.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/regions/region-discovery-scheduler.test.js)
- [test/regions/region-query-schemas.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/regions/region-query-schemas.test.js)
- [test/regions/region-radio-adapter.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/regions/region-radio-adapter.test.js)
- [test/regions/region-response-parser.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/regions/region-response-parser.test.js)
- [test/regions/region-schemas.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/regions/region-schemas.test.js)
- [test/telemetry/decoder-boundaries.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/telemetry/decoder-boundaries.test.js)
- [test/telemetry/neighbour-parser.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/telemetry/neighbour-parser.test.js)
- [test/telemetry/polling-owner-integration.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/telemetry/polling-owner-integration.test.js)
- [test/telemetry/polling-scheduler.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/telemetry/polling-scheduler.test.js)
- [test/telemetry/sensor-parser.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/telemetry/sensor-parser.test.js)
- [test/telemetry/status-parser.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/telemetry/status-parser.test.js)
- [test/telemetry/telemetry-contact-inventory.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/telemetry/telemetry-contact-inventory.test.js)
- [test/telemetry/telemetry-contact-manager.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/telemetry/telemetry-contact-manager.test.js)
- [test/telemetry/telemetry-radio-adapter.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/telemetry/telemetry-radio-adapter.test.js)
- [test/telemetry/telemetry-schemas.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/telemetry/telemetry-schemas.test.js)
- [test/web/bot-command-buckets.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/web/bot-command-buckets.test.js)
- [test/web/client/dashboard-logic.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/web/client/dashboard-logic.test.js)
- [test/web/metrics-range.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/web/metrics-range.test.js)
- [test/web/metrics-sample.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/web/metrics-sample.test.js)
- [test/web/metrics-server.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/web/metrics-server.test.js)
- [test/web/schemas.test.js](R:/Code/github.com/Robotti-io/Meshcore-Observer/test/web/schemas.test.js)

## Other tracked engineering surfaces

- `AGENTS.md`, `package.json`, `package-lock.json`, `eslint.config.js`, `vitest.config.js`, `.github/workflows/ci.yml`, `.gitignore`: instructions, scripts/runtime/dependency declarations, lint/test/coverage and CI policy assessed. Lockfile was assessed as the install contract, not a vulnerability database.
- `README.md`, `CONTRIBUTING.md`, `.env.example`, four JSON examples: setup, boundaries, operator configuration/defaults and testing documentation assessed by owning domain.
- `scripts/register-scheduled-task.ps1`, `scripts/unregister-scheduled-task.ps1`: static platform-management and ShouldProcess scope reviewed; neither executed. No current destructive/path-injection defect established from these files.
- `docs/project_plan.spec.md`, `docs/telemetry-polling.md`, prior v2.4 MetricsStore/ChannelBot/CI/password decisions, relevant v2.5 protocol/contracts/pillar/closeout records: deliberate constraints and implemented-versus-planned status assessed. Historical plans were excluded from source metrics.
- Branding image and license retained as non-code assets; no new visual/media or legal review claimed. Private ignored configuration, credentials and data files were not opened. Existing threat-model report read as context only. Generated artifacts/dependencies excluded except installed SDK functions inspected to verify specific timer waits.
