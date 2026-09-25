# Feat: Repeater Lookup Enhancements

## Goals

- When a user looks up a repeater that is found we should provide the last heard time in the response.
- When a user looks up a repeater and no match is found we should include a count of all the repeaters we have.
  - eg. `❓ @[{sender}]! no repeater with prefix {query} heard in our list of {repeaterCount} repeaters.`
- When a user looks up a repeater with a prefix of less than 2 bytes we should return the 2 byte prefix in the response if a repeater is found.

## Implementation Plan

### 1. Feature Summary

- Extend `!lookup` replies with the matched repeater's relative last-heard age, the total number of known repeaters on a not-found result, and a two-byte public-key prefix when a query shorter than two bytes uniquely resolves to a repeater.
- Preserve the existing one-byte minimum query, ambiguity behavior, queued reply lifecycle, and 120-byte message budget.

### 2. Relevant Existing Architecture

- `src/nodes/node-registry.js` validates and normalizes the public-key prefix and returns `found`, `not_found`, `ambiguous`, or `invalid`. Its result already includes the node, with `publicKeyHex` and `lastHeardAt` supplied by the store.
- `src/metrics/store.js` persists nodes in SQLite and has a type-filtered prefix query, but no method to count all rows of a type. It also persists pending lookup reply fields (`query`, `lookupOutcome`, `name`, and `matchCount`) so queued replies can resume after restart.
- `src/bots/channel-bot.js` resolves lookups before enqueueing, then renders the configured outcome template when the reply is dispatched. Template values currently include `query`, `name`, and `matchCount`, but not `lastHeardAt`, a matched public-key prefix, or a total repeater count.
- `src/bots/response-template.js` performs plain placeholder substitution and enforces the configured byte limit. The lookup templates live in `bots.config.example.json`; config shape and validation live in `src/bots/schemas.js` and `src/bots/bots-config-loader.js`.
- Tests are in `test/nodes/node-registry.test.js`, `test/metrics/store.test.js`, `test/bots/channel-bot.test.js`, and `test/bots/bots-config-loader.test.js`.

### 3. Proposed Approach

- Keep prefix matching and repeater filtering in `NodeRegistry` / `MetricsStore`; add a narrow count-by-type store operation and expose the repeater total through the registry for the not-found response.
- Capture the matched node's `lastHeardAt` and its first two public-key bytes as lookup result data. Render them through explicit template placeholders `{lastHeard}` and `{nodePrefix}`, and expose the repeater total through `{repeaterCount}` on not-found results.
- Format `{lastHeard}` as a compact relative age at dispatch time (for example, `20m ago` or `1h ago`) using the persisted `lastHeardAt` value. This keeps a queued reply's age current when it is sent after waiting in the queue or after a restart.
- Preserve queued reply snapshot semantics. Extend the persisted pending-reply record with the matched `lastHeardAt`, two-byte `nodePrefix`, and not-found `repeaterCount`. Add a forward-only SQLite migration rather than re-querying mutable registry state when an old queued reply is dispatched.
- For a successful query shorter than four hex characters (two bytes), including a three-character query such as `E85`, render the first four hex characters of the matched public key (for example, `E85C`). Keep the user's normalized query for queries of four or more hex characters and for other outcomes. Leave ambiguous resolution and its match count unchanged.
- Update the sample `!lookup` templates to show relative last-heard age, repeater count on not-found, and the returned two-byte prefix for a successful query shorter than two bytes. Keep template customization backward compatible: existing configured templates that omit new placeholders should continue to render.

### 4. Impacted Areas

- `src/nodes/node-registry.js` — expose the total count of all stored repeaters and carry matched-node metadata in results as appropriate.
- `src/metrics/store.js` — count all nodes whose type is exactly `REPEATER` and persist the new queued reply snapshot fields; add an additive SQLite migration.
- `src/bots/channel-bot.js` — prepare lookup values and provide them to the queued reply/template renderer.
- `src/bots/schemas.js`, `src/bots/bots-config-loader.js` — likely no shape changes are needed if the feature only adds runtime template values; update only if a new configuration field is introduced.
- `bots.config.example.json` — update the sample found and not-found templates.
- `test/nodes/node-registry.test.js`, `test/metrics/store.test.js`, `test/bots/channel-bot.test.js`, and `test/bots/bots-config-loader.test.js` — cover count, metadata propagation, persisted queue resumption, relative-age formatting, prefix display, and response rendering.
- `README.md` and `docs/project_plan.spec.md` — update the `!lookup` response/template reference if they document its placeholders.

### 5. Task Breakdown

#### T1: Add a repeater count read to the registry/store

- Objective: Provide the total number of currently stored `REPEATER` rows for a not-found response.
- Specific changes: Add a parameterized, type-specific count method to `MetricsStore`; expose it through `NodeRegistry` without broadening the store API.
- Definition of done: Count excludes non-repeater nodes and reflects inserts/updates without depending on dashboard pagination.
- Expected tests / validation: Add store tests for mixed node types and registry tests for forwarding the total. Run the repository test and lint scripts during implementation.

#### T2: Carry response snapshot data through queued lookup replies

- Objective: Make matched-node metadata and the not-found repeater total available when a queued reply is eventually sent, including after process restart.
- Specific changes: Populate lookup reply data from the registry result in `ChannelBot`; extend `MetricsStore`'s `bot_replies` representation and row mapping with `lastHeardAt`, `nodePrefix`, and `repeaterCount`; add a forward-only SQLite migration. Preserve the existing `matchCount` meaning for ambiguous lookups.
- Definition of done: New lookup data round-trips through enqueue, pending-row read, and dispatch; pre-migration databases migrate without losing pending replies or reply history.
- Expected tests / validation: Add store migration/round-trip tests, including a pre-migration database with pending replies, and queue-backed channel-bot tests for resumed lookup items. Confirm the upgrade preserves pending items and historical reply metrics. Run `npm test` and `npm run lint` during implementation.

#### T3: Render the enhanced lookup responses

- Objective: Show relative last-heard age, all-known-repeater count, and the two-byte key prefix for a successful query shorter than two bytes.
- Specific changes: Add the runtime template values in `ChannelBot`; format the relative age from `lastHeardAt` at dispatch (with deterministic clock/formatting tests); update `bots.config.example.json` templates with the corresponding placeholders; preserve current behavior for longer queries, invalid queries, ambiguous results, and custom templates that do not use the new placeholders.
- Definition of done: Found, not-found, and short-prefix found replies contain the appropriate values and remain within the configured UTF-8 byte budget.
- Expected tests / validation: Add response assertions for 2-character and 3-character found queries, relative-age formatting, not-found repeater count, UTF-8/message-budget behavior, and unchanged ambiguous/exact-command behavior. Run `npm test` and `npm run lint` during implementation.

#### T4: Document the lookup response placeholders

- Objective: Make the supported lookup template values understandable to operators.
- Specific changes: Update the README and project plan command reference if they describe lookup response configuration; document the new placeholder names and their meaning.
- Definition of done: Operator-facing examples and placeholder documentation agree with the implemented templates.
- Expected tests / validation: Review docs against the final template values and run lint/tests if documentation is the only change in this task.

### 6. Risks and Edge Cases

- Pending replies are persisted and dispatched later. Omitting a newly required value from the persisted row would produce incomplete replies after restart; recomputing from the registry could also return a different node state than the lookup originally resolved.
- `lastHeardAt` is stored as a Unix millisecond timestamp. A compact display format is needed for radio messages, and the formatting must not turn a timestamp into an unexpectedly long message.
- A prefix shorter than two bytes may be ambiguous. The two-byte returned prefix applies only when the lookup result is uniquely `found`; ambiguous replies should retain the original query and existing match-count semantics.
- The total means all repeaters present in the persisted node registry, not all node types and not only repeaters matching the failed prefix. No expiry policy currently removes stale registry rows.
- All replies share a 120-byte default budget. Adding values can make replies exceed it; verify the existing truncation behavior does not cut off the useful result or produce a misleading partial timestamp.

### 7. Resolved Decisions

- Any query shorter than two bytes (fewer than four hex characters), including `E85`, displays the first four hex characters of the uniquely matched public key (for example, `E85C`).
- `{lastHeard}` is a compact relative age such as `20m ago` or `1h ago`, calculated when the queued reply is sent from the stored `lastHeardAt` timestamp.
- `{repeaterCount}` includes every currently stored row whose type is exactly `REPEATER`; no TTL/eviction filter applies.
- A SQLite schema migration is approved for this feature, provided the upgrade is clean and preserves existing functionality, pending replies, and reply history.

### 8. Suggested Execution Order

1. T1 — establish a tested count source for the not-found result.
2. T2 - persist lookup snapshot values and prove the migration preserves existing pending replies and history.
3. T3 - add relative-age formatting, the short-prefix response value, and updated sample templates against the finalized data shape.
4. T4 — align operator documentation with the implemented placeholders.
