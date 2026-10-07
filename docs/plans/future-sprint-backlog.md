# Future Sprint Backlog

Items here are unscheduled investigation or implementation candidates for a future sprint. They are not part of the active v2.4.0 release unless explicitly added to its plan.

## OBS-01 — Investigate noisy handling of MeshCore frame code 142

- **Type:** Investigation
- **Status:** Unscheduled
- **Observed behavior:** The observer periodically prints `unhandled frame: code=142` while running. The operator has also seen this during prior day-long runs and believes these are control packets sent across the mesh. During the v2.4.0 soak so far, packet capture and MQTT delivery continued normally when the message appeared.
- **Evidence and likely cause:**
  - The project depends on `@liamcottle/meshcore.js` (`package.json` allows `^1.15.0`; `package-lock.json` currently resolves `1.15.0`).
  - In that installed dependency, `src/connection/connection.js`, `Connection.onFrameReceived()`, reads the first byte and dispatches recognized response and push codes. Its fallback logs `unhandled frame: code=${responseCode}` and the complete frame with `console.log`.
  - The dependency's `src/constants.js` defines push codes only through `0x8C` (`BinaryResponse`); it does not define or dispatch `0x8E`. Decimal 142 is `0x8E`, so a frame beginning with that code reaches the fallback. The failure is an unsupported notification in the dependency's dispatcher, not evidence that the incoming frame is malformed.
  - The upstream [MeshCore Companion Radio Protocol](https://github.com/meshcore-dev/MeshCore/wiki/Companion-Radio-Protocol) defines `PUSH_CODE_CONTROL_DATA` as `0x8E`, emitted when a CONTROL packet is received. Its documented frame includes SNR, RSSI, path length, and payload. Thus the observed code is expected control-data notification traffic.
  - The observer's `src/radio/radio-manager.js` currently subscribes to `LogRxData` and `ChannelMsgRecv`, not the control-data push. The unsupported push is therefore logged by the dependency and otherwise ignored by the application; packet capture and MQTT delivery continue through their existing events.
- **Dependency review target:** Review `@liamcottle/meshcore.js` upstream [`connection.js`](https://github.com/meshcore-dev/meshcore.js/blob/main/src/connection/connection.js) and [`constants.js`](https://github.com/meshcore-dev/meshcore.js/blob/main/src/constants.js), compare current upstream issues/releases with the installed 1.15.0 behavior, and decide whether to propose a dependency PR (for example, define and dispatch `0x8E` without logging the payload) or handle the known push at a quieter level. Preserve generic visibility for genuinely unknown frames and avoid exposing control payloads in logs.
- **Investigation:** Determine the expected client handling for `PUSH_CODE_CONTROL_DATA`, whether current upstream has already addressed it, and the narrowest compatible library fix. No application or dependency code change is authorized by this backlog entry.
- **Acceptance criteria:**
  - The meaning and expected handling of code 142 are documented with evidence.
  - Expected control traffic no longer produces an alarming console error.
  - Truly malformed or unsupported frames remain observable at an appropriate log level.
  - Tests cover the chosen handling and ensure packet capture and forwarding behavior remain unchanged.
- **Constraints:** Do not log full packet payloads or introduce additional dependencies without approval.

## OBS-02 — Repeater region discovery for CoreScope

- **Type:** Feature request
- **Status:** Unscheduled / release unassigned
- **Feature document:** [Repeater Region Discovery for CoreScope](feat-repeater_region_discovery.md)
- **Goal:** Query recently direct-heard repeaters for their declared flood-allowed regions, persist successful answers, and publish CoreScope-compatible `meshcore/client/{PUBLIC_KEY}/regions` objects.
- **Initial scope:** Opt-in anonymous zero-hop queries, conservative scheduling through existing radio coordination, strict validation, and persisted answer freshness. This is independent of the gessaman firmware's built-in observer `/neighbors` report.
- **Planning dependencies:** Confirm firmware/library support, direct-routing and contact-state handling, remote-request ownership, storage representation, and per-broker publication permissions.
- **Approval scope:** Backlog documentation only; implementation and protected-boundary changes need separate approval. Not assigned to the v2.5.0 telemetry work by this entry.
