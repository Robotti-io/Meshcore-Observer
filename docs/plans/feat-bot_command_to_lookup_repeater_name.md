# Plan: `!lookup <hex-prefix>` bot command

## Goal

A channel-bot command that resolves a *repeater's* advertised name from a
public-key hex prefix heard over the air, e.g. `!lookup E85C` -> the name
from the most recent ADVERT we've heard from a repeater whose public key
begins `E85C`.

The underlying store is broader than the command: it's a general "contact
list" of every node type we've heard advertise a name (repeater, room, chat,
sensor), each with a last-heard timestamp. `!lookup` is just today's one
consumer of it, filtered to repeaters only.

## Current state (confirmed by reading the code)

- ADVERT packets (`payload_type` 4) already flow through `PacketPipeline` and
  are decoded to the flat compatibility shape in
  [packet-decoder.js](../../src/packets/packet-decoder.js), but nothing
  parses the advert *payload* - no name/type/public-key is ever extracted.
- No node/repeater registry exists anywhere in `src/`.
- `@liamcottle/meshcore.js` ships a ready-made `Advert` class
  (`node_modules/@liamcottle/meshcore.js/src/advert.js`) with
  `Advert.fromBytes(payload)` -> `{ publicKey, timestamp, signature, parsed: { type, name, lat, lon, feat1, feat2 } }`
  and an async `isVerified()` that checks the advert's ed25519 signature
  against its own `publicKey`. `parsed.name` is `null` when the advertiser
  didn't set the name flag. `isVerified()` dynamically imports
  `@noble/curves/ed25519`, which is already a declared dependency of
  `@liamcottle/meshcore.js` itself (`node_modules/@liamcottle/meshcore.js/package.json`)
  - using it adds no new dependency of our own, so it doesn't need the
    dependency-approval step in AGENTS.md.
- `ChannelBot` ([channel-bot.js](../../src/bots/channel-bot.js)) only
  supports exact-string trigger matching (`this.#commands.get(decrypted.text)`)
  - no argument parsing exists today.
- `ReplyQueue`/`reply-dispatcher.js` are fully generic over the enqueued item
  shape (`enqueue()` just spreads `...item`), so extending what a queued
  reply item carries needs no changes there.
- Public keys elsewhere in this codebase are formatted as uppercase hex
  strings (see `radio-manager.js`, `letsmesh-auth.js`) - the registry should
  follow that convention.

## Design

### 1. `src/nodes/advert-parser.js` (new, small, single-purpose)

`parseAdvertFromPacket(decodedPacket)`:

- Returns `null` immediately unless `decodedPacket.packet_type === '4'`.
- Re-parses `Packet.fromBytes(Buffer.from(decodedPacket.raw, 'hex'))` to get
  at the raw `payload` bytes, which `packet-decoder.js`'s flat compatibility
  shape intentionally doesn't expose (same re-parse pattern `channel-bot.js`
  already uses for its own reasons).
- Calls `Advert.fromBytes(packet.payload)` in a try/catch - a malformed or
  truncated advert payload must not throw pipeline-wide - returning `null`
  on failure.
- Returns the parsed `Advert` instance itself (not a plain object): the
  caller needs to call `await advert.isVerified()` before trusting anything
  in it (see below), so handing back the instance avoids re-parsing.

### 2. `src/nodes/node-registry.js` (new)

`NodeRegistry` - a small in-memory store, no persistence (v1 constraint):

- `#nodesByPublicKey = new Map()` keyed by full uppercase hex public key.
  Each stored record is
  `{ publicKeyHex, name, type, lastHeardAt }` where `type` is one of
  `REPEATER | ROOM | CHAT | SENSOR` (whatever `advert.parsed.type` reports).
- `async recordFromDecodedPacket(packet)` - the one method `index.js` calls
  per decoded packet:
  1. `parseAdvertFromPacket(packet)` -> `null` short-circuits (not an
     advert, or malformed).
  2. Skip if `advert.parsed.name` is empty/null - **we only ever store a
     name we actually heard**, never a placeholder.
  3. **Must** `await advert.isVerified()` before storing anything - a name
     is never written to the registry from an advert whose signature
     doesn't verify against its own claimed public key. This is a
     deliberate integrity requirement (no "trust it anyway" fallback), so
     `recordFromDecodedPacket` is async and its caller in `index.js` treats
     it as fire-and-forget with a caught/logged rejection, matching the
     existing `observerPublisher.publishPacket(...).catch(...)` pattern
     already used for the sibling `packetPipeline.on('packet', ...)`
     listener.
  4. On success, upsert `{ publicKeyHex, name, type, lastHeardAt: now }` -
     repeated adverts overwrite the previous entry for that key, so both
     the name *and* `lastHeardAt` always reflect the latest verified
     advert heard (a renamed node doesn't leave a stale name behind, and
     `lastHeardAt` is the field a future TTL/eviction pass will read - not
     built now, but the data it needs is captured from day one).
  5. A verification failure is logged (no public key/signature bytes in
     the log payload - the AGENTS.md "known-sensitive metadata" rule is
     about secrets, but there's no reason to echo raw key material into
     logs either) and otherwise dropped - it must never throw out of the
     `packetPipeline.on('packet', ...)` handler.
- `findByPrefix(rawQuery, { type } = {})` - validates and normalizes the
  query, optionally restricts the candidate set to one `type` *before*
  deciding found/not_found/ambiguous (so e.g. one matching repeater plus
  two matching chat nodes still resolves as `found` when
  `type: 'REPEATER'` is given), and returns a typed result the caller can
  render directly without re-implementing validation:
  - `{ status: 'invalid' }` - fails validation (see rules below).
  - `{ status: 'not_found', query }` - valid query, zero matches (after any
    type filter).
  - `{ status: 'found', query, node }` - exactly one match.
  - `{ status: 'ambiguous', query, matchCount, node }` - more than one
    match. `matchCount` is the total number of matches; `node` is the
    single **most recently heard** match (matches are sorted by
    `lastHeardAt` descending before picking it), so a caller can surface
    "closest guess" alongside the count instead of just refusing to
    answer.
- `entries()` / `size()` for diagnostics and tests - returns every stored
  node regardless of type, since the registry itself is the general
  contact list; only the `!lookup` command narrows to repeaters.

**Query validation rules:**

- Trim whitespace; reject empty.
- Must match `/^[0-9A-Fa-f]+$/`.
- Length must be >= 2 hex chars (1 byte) - the floor CoreScope also uses
  for this kind of prefix search.
- Odd-length (non-byte-aligned) queries longer than the 2-char floor are
  allowed too (e.g. `E85`, 2.5 bytes) - CoreScope treats hex-prefix search
  the same way, and a plain `startsWith` naturally supports it without
  extra code.
- Length must be <= 64 (can't exceed a full 32-byte key).
- Normalized to uppercase before comparing against stored keys.
- Matching is `publicKeyHex.startsWith(normalizedQuery)` - never a
  regex/database - so a short query can and will legitimately return
  multiple matches (`ambiguous`).

### 3. Wiring in `src/index.js`

```js
const nodeRegistry = new NodeRegistry();
packetPipeline.on('packet', (packet) => {
  nodeRegistry.recordFromDecodedPacket(packet).catch((err) => {
    logger.warn('services.nodeRegistry', 'failed to process a possible advert', { error: err.message });
  });
});
```

placed next to the existing `packetPipeline.on('packet', ...)` MQTT-publish
wiring. `nodeRegistry` is then passed into every `ChannelBot` alongside the
existing `replyQueue`.

### 4. `ChannelBot` changes ([channel-bot.js](../../src/bots/channel-bot.js))

- Constructor accepts an optional `nodeRegistry`.
- Command config gains a `kind` field: `'exact'` (default - today's
  behavior, completely unchanged) or `'lookup'` (new). Only `'lookup'`
  commands get argument parsing; every existing `bots.config.json` entry
  keeps working exactly as-is since `kind` defaults to `'exact'`.
- A `'lookup'` command's config carries four response templates instead of
  one, keyed by outcome:

  ```json
  {
    "trigger": "!lookup",
    "kind": "lookup",
    "foundResponse": "📡 @[{sender}]! {query} = {name}",
    "notFoundResponse": "❓ @[{sender}]! no repeater heard with prefix {query} yet",
    "ambiguousResponse": "⚠️ @[{sender}]! {matchCount} repeaters match {query}, most recent: {name} - use more hex digits",
    "invalidResponse": "⚠️ @[{sender}]! give at least 1 byte in hex, e.g. !lookup E8"
  }
  ```

  (`{name}` only, not `{nodeType}`, since this command is hardcoded to
  `type: 'REPEATER'` - see below. For the `ambiguous` outcome, `{name}` is
  the most-recently-heard of the matches (see `findByPrefix` above), paired
  with `{matchCount}` for the total. `lastHeardAt` is captured in the
  registry now but not otherwise exposed in the response for this phase; a
  `{lastHeard}` placeholder is an easy future addition once TTL/eviction
  is designed.)
- `#handleRawPacket` matching order:
  1. Exact match against `this.#commands` (unchanged).
  2. If no exact match, check configured `'lookup'` commands: does
     `decrypted.text === trigger` or start with `` `${trigger} ` ``? If so,
     extract the remainder as `query` (empty -> outcome `'invalid'`
     directly, skipping the registry). Otherwise call
     `nodeRegistry.findByPrefix(query, { type: 'REPEATER' })` synchronously
     (reads are sync even though writes are async) and carry its
     `status`/`node`/`matchCount` forward.
  3. minHops and dedup checks apply exactly as they do today, unchanged,
     downstream of matching for every command kind.
  4. Enqueue a plain-data item with the existing fields plus `query`,
     `outcome`, `name`, `matchCount` as applicable (for `ambiguous`, `name`
     is the most-recently-heard match's name and `matchCount` is the total,
     both already resolved by `findByPrefix` - `ChannelBot` doesn't re-sort
     anything itself) - no changes needed to `ReplyQueue`/
     `reply-dispatcher.js`, which are already generic over item shape.
- `sendQueuedReply`: for a `kind === 'lookup'` command, pick the response
  template by `outcome` instead of the single `response` field, then render
  through the existing `renderResponse`/`renderTemplate` unchanged.

### 5. Schema (`src/bots/schemas.js`) + `bots-config-loader.js`

Extend the command item schema with `kind` (`enum: ['exact','lookup']`,
default `'exact'`) and the four lookup response fields, all as plain
optional properties (only `trigger` stays AJV-`required`). An AJV
`if/kind-is-lookup/then-require-the-four-fields` conditional was tried
first but rejected: under this project's strict AJV instance
(`src/validation/ajv.js`), `strictRequired` refuses to compile a
`required` list inside a nested branch unless that same branch also
re-declares full type schemas for every field involved - workable, but it
meant duplicating every field's `{type: 'string', minLength: 1}` schema a
second time per branch for no real benefit.

Instead, `kind`-based consistency ("a 'lookup' command needs all four
outcome templates and must not carry `response`/`overflowResponse`; an
'exact' command needs `response` and must not carry any lookup-only
field") is enforced as a plain JS check in `bots-config-loader.js`, right
next to its existing duplicate-name/duplicate-trigger checks - same
`BotsConfigError` pattern, no new validation approach introduced.
`schemas.js` exports `LOOKUP_RESPONSE_FIELDS` so both places share one
list.

`botConfigSchema` is still shared by direct reference with
`src/config/schema.js`'s `bots` property (shape-only re-validation there;
the loader's consistency check runs once, upstream, in `readBots()`).

### 6. `bots.config.example.json`

Add a `!lookup` example command to the sample bot, plus a line in
`!commands`'s response.

### 7. Tests

- `node-registry.test.js`: store-only-when-named, store-only-when-verified
  (a rejected/failing `isVerified()` must not write a name), overwrite +
  `lastHeardAt` refresh on re-hear, all node types are stored, prefix
  validation (too short / non-hex / odd-length allowed / case-insensitive /
  full-key exact match), `type` filter narrows both matches and ambiguity
  counts, ambiguous multi-match without a filter, and - for an ambiguous
  result - the returned `node` is the most-recently-heard of the matches
  (not insertion order or key order).
- `advert-parser.test.js`: a real encoded ADVERT payload -> a usable
  `Advert` instance; non-ADVERT packet -> `null`; truncated/malformed
  payload -> `null`, never throws.
- `channel-bot.test.js` additions: `!lookup <prefix>` end-to-end through
  decrypt -> found/not_found/ambiguous/invalid response rendering; confirms
  a matching non-repeater node is correctly excluded (`not_found`, not
  `found`); confirms minHops/dedup still gate lookup replies same as any
  other command; confirms existing exact-match commands are byte-for-byte
  unaffected.

### 8. Docs

Update README's "Channel bots" section and
`docs/project_plan.spec.md` Section 21's command reference once implemented.

## Decisions (resolved)

1. **Prefix granularity** - minimum 1 byte (2 hex chars), but no
   byte-alignment requirement beyond that floor - odd nibble counts like
   `E85` are allowed, matching CoreScope's own behavior for this kind of
   search.
2. **Node types** - the registry stores every advertised type (it's a
   general contact list, each record carries its `type` and `lastHeardAt`),
   but the `!lookup` command itself is hardcoded to `type: 'REPEATER'` for
   now.
3. **Advert authenticity** - never skipped. `await advert.isVerified()`
   must pass before a name is written to the registry; a failed/unverified
   advert is logged and dropped.
4. **Unbounded growth** - no TTL/eviction implemented yet, but every record
   carries `lastHeardAt` so that a future eviction pass (and a possible
   "last heard" field in the `!lookup` response) has the data it needs
   without a schema change.
