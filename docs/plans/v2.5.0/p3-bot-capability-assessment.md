# Pillar 3 bot capability assessment — P3-01 / #52

Research completed 2026-11-01 against this checkout's resolved
`@liamcottle/meshcore.js` **1.15.0**, the existing Observer radio/bot seams,
the library's matching upstream tag, and primary MeshCore Companion protocol
and firmware sources. This is source research, not certification of any
deployed radio or client. No tests, hardware query, RF transmission, contact or
route edit, credential access, dependency change, or runtime operation was
performed.

## Capability summary

| Capability | Evidence in resolved SDK / protocol | Assessment and limit |
| --- | --- | --- |
| Companion identity | `Connection.getSelfInfo()` emits a `SelfInfo` object including the Companion's configured `name`; `RadioManager` reads it during each handshake and exposes normalized device info. Companion firmware keeps the name in a fixed `char node_name[32]` field. | **Supported.** Current identity is available on connect; reconnect refreshes it. There is no Observer-level rename event or explicit name refresh today. Treat the 32-byte firmware field as a byte bound (including terminator), not a JavaScript character count. Validate the returned value before using it for matching. |
| Target tag text | Companion protocol carries channel/contact messages as text and defines no bot-recipient field or standardized bot-tag grammar. Group-message sender names are unverified text. | **Unknown as a cross-client convention.** `@[name]` is a proposed plain-text convention in this project, not an authenticated protocol feature. Validate it against the intended client(s), retain opt-in semantics, and do not treat a matching display name as authentication. |
| Private/contact intake | SDK parses `ContactMsgRecv` (including V3) with `pubKeyPrefix`, `pathLen`, `txtType`, `senderTimestamp`, and `text`; `MsgWaiting` indicates the host should call `syncNextMessage()`. `RadioManager` currently forwards packet capture and channel-message events only, not contact-message events. | **Library path supported; Observer integration absent.** The supplied sender identity is only a six-byte public-key prefix. Resolve it against a fresh known-contact set and reject missing or ambiguous matches before invoking private handlers. Contact message text is a trust-boundary input and needs centralized strict validation before business logic. |
| Private/contact send | `Connection.sendTextMessage(publicKey, text, type)` sends command `CMD_SEND_TXT_MSG`; the SDK writes only the first six public-key bytes to the Companion. It resolves on `RESP_CODE_SENT` and returns route result, expected ACK code, and estimated timeout. The SDK method itself supplies no timeout option. | **Supported with a routing/ownership constraint.** Use an existing Companion contact and its maintained path; do not reverse an observed packet path. Because the command carries a six-byte prefix, the exact contact must resolve uniquely. A `Sent` response means the Companion accepted/prepared a send and supplies an expected ACK code; it is not destination confirmation. Bound waits and own event listeners explicitly around the single serialized radio command. |
| Destination ACK | The SDK parses `PUSH_CODE_SEND_CONFIRMED` as `ackCode` plus `roundTrip`; Companion protocol documentation says this push is emitted after a matching message ACK is received. The four-byte code is correlated with the earlier `Sent` expected ACK code. `RadioManager` does not currently forward this push. | **Supported as a destination-node message ACK, subject to correlation.** Serialize/track attempts so an ACK cannot be attributed to another message; handle duplicates, late ACKs, disconnect, and timeout. This is not evidence that a person read the message. The push carries no destination key, so the ACK code is the correlation evidence. |
| Flood/region scope | SDK exposes `setFloodScope(16-byte key)` and `clearFloodScope()`; both wait for a Companion `OK`/`ERR`. Firmware implements this as a connection-session override. Clearing sends an empty override and returns flood sends to the Companion's configured default scope; it does not necessarily mean unscoped. Companion firmware also has an explicit unscoped mode in newer protocol source, but the resolved SDK 1.15.0 wrapper does not expose that mode. | **Temporary scoped channel send supported.** The current Observer holds `RadioManager.runCommand()` ownership across set/send/clear and invalidates the connection if clearing fails. It has no read/restore API for an arbitrary pre-existing temporary override. The restore target is the device default, which may itself be scoped. Do not equate `clearFloodScope()` with an unscoped send or claim every firmware version implements identical semantics. |
| Scope persistence/reconnect | Firmware stores configured default scope in persistent preferences, while the temporary `send_scope` override is connection/runtime state. A new connection/firmware session begins without the old process's transient override. | **Supported distinction in inspected source.** P3-08 should restore to a verified safe default and retire an uncertain connection; it should not attempt to persist a temporary per-reply scope. Confirm supported firmware behavior before operational rollout. |
| Region name/key | Existing Observer helper derives the hashtag transport key as the first 16 bytes of SHA-256 over `#<region>` (retaining an already present leading `#`). The project already has pinned CoreScope docs/key-derivation references in [remote capability assessment](remote-capability-notes.md). | **Implemented local mapping for hashtag region names.** Reconfirm case, wildcard, custom/private region, and canonical display-name behavior against the chosen OKI/CoreScope deployment. Anonymous region discovery is not evidence that a bot is authorized to answer in that region. |

## Existing Observer seams and gaps

- `RadioManager` reads `name` from self info at connection establishment and exposes it in device info; the value is not currently validated through a dedicated strict schema for target matching.
- `RadioManager` forwards `LogRxData` and `ChannelMsgRecv`; it does not forward `ContactMsgRecv`, `MsgWaiting`, or `SendConfirmed` to application consumers.
- The current bot consumes decrypted public channel text. It has no private command intake path or private response dispatch path.
- The channel reply queue stores a plain-data item and persists `pending`, `sent`, `failed`, and `expired` outcomes. It already stores `region_scope`; it does not persist transport/attempt/ACK/suppression state.
- `ChannelBot.sendQueuedReply()` serializes scoped channel sends, then clears the temporary scope. On clear failure it invalidates that connection generation. Current scope configuration is bot-wide fixed scope or allowlist, not per-command private/scoped policy.
- The SDK's custom emitter implements `once()` by registering an internal wrapper and asynchronously invoking the callback. SDK promise helpers such as `sendTextMessage()` use unbounded `once()` listeners. Later private delivery/ACK work should not assume these methods supply deadlines or independently safe cross-operation correlation; use the application's serialized ownership seam and bounded listener cleanup.

## Decisions this evidence supports

1. P3-03 can use the current connection's validated `getDeviceInfo().name` as its starting identity source; reconnect refresh is already naturally available. Rename-in-place refresh needs an explicitly supported API/event or can wait for reconnect.
2. P3-04's `@[name]` grammar must be treated as Observer command syntax layered over plain message text. It must remain opt-in, Unicode-safe, and fail closed when the current name is missing or duplicated.
3. P3-09 can consume the SDK's parsed contact-message response, but the six-byte sender prefix requires unique known-contact resolution; no full sender key is supplied in that event.
4. P3-10 can send using the Companion contact table and SDK contact text API. The SDK `Sent` response is the local send/route result; it must not be recorded as destination ACK.
5. P3-11 can use `expectedAckCrc`/`ackCode` plus `roundTrip` if ACK tracking is serialized and bounded. Report “destination acknowledged” and never “read”.
6. P3-08 can build on the existing serialized scope transaction. Clearing returns to device default scope in inspected firmware; if that default is unknown or not allowed, fail closed rather than silently broadening.
7. No second MeshCore decoder/library or dependency upgrade is evidenced as necessary for these capabilities. Keep the current approved dependency and validate raw event envelopes at the Observer boundary.

## Unresolved evidence and follow-up

- The exact target client behavior and any adopted `@[name]` mention syntax are not established as an official Companion protocol contract. Confirm the intended client versions/conventions before freezing P3-02 grammar.
- Runtime Companion/repeater firmware versions, contact-table contents, current default scope, and operator-defined routing are not available from this source-only review. No claim is made about the deployed device.
- The firmware contact lookup behavior for colliding six-byte public-key prefixes must be verified against supported Companion builds. Until then, private send/intake must require exactly one matching full-key contact or reject the operation.
- ACK timeouts, retry budgets, late-ACK retention, scope fallback, private metadata retention, and lifecycle transitions are policy decisions for P3-02 and storage work for P3-05; this assessment does not choose numeric settings or authorize storage changes.
- Any live hardware validation of rename refresh, private intake/send, ACK delivery, scope restoration, or reconnect behavior must be planned and authorized separately.

## Sources

- Resolved package metadata: `node_modules/@liamcottle/meshcore.js/package.json` reports version **1.15.0**; repository lockfile resolves the same package version. Matching upstream tag: [`meshcore.js` 1.15.0 source](https://github.com/meshcore-dev/meshcore.js/tree/1c142946f9597d60fc634afd9a681f546792b0d5).
- SDK implementation: [`connection.js` self info, contact messages, private send, ACK push, and flood-scope helpers](https://github.com/meshcore-dev/meshcore.js/blob/1c142946f9597d60fc634afd9a681f546792b0d5/src/connection/connection.js); [`events.js` custom event behavior](https://github.com/meshcore-dev/meshcore.js/blob/1c142946f9597d60fc634afd9a681f546792b0d5/src/events.js).
- Companion message and ACK frames: [MeshCore Companion Radio Protocol, pinned revision](https://github.com/meshcore-dev/MeshCore/wiki/Companion-Radio-Protocol/b8885fcc919af7bd34e5af7a1542f1c836568477).
- On-air payload semantics: [MeshCore payload format — acknowledgement and plain/group text](https://github.com/meshcore-dev/MeshCore/blob/main/docs/payloads.md).
- Firmware scope state and name storage: [Companion `MyMesh.cpp`, pinned source](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/examples/companion_radio/MyMesh.cpp); [Companion `NodePrefs.h`, pinned source](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/examples/companion_radio/NodePrefs.h).
- Region-key contract and existing Observer evidence: [P1 remote capability assessment](remote-capability-notes.md) and [CoreScope region key derivation](https://github.com/OKI-Mesh/CoreScope/blob/6cab7d698d15f739dcaa0f04df70eaa80f5d13da/cmd/ingestor/region_keys.go).

## Outcome

Source capability research is complete for P3-01's local-library/protocol scope. Client targeting conventions, firmware-specific behavior, contact-prefix ambiguity, and deployed settings remain explicit unknowns. This record does not close GitHub issue #52 or authorize any implementation boundary; it is input to P3-02's policy decisions.
