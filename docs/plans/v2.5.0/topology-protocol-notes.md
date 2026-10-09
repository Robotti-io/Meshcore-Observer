# Passive topology protocol subset for #27

Reviewed 2026-10-08. Owning research: [#22](https://github.com/Robotti-io/Meshcore-Observer/issues/22). Consuming plan: [#27](pillar-1-issues/p1-06.md#implementation-plan), now approved and implemented locally with passing parser/storage/collector/query/retention/offline fixtures. This is the passive header-path subset, not the complete telemetry/regions/authentication/contact capability assessment.

## Verified references and local baseline

- Observer release-v_2_5_0 a903e0e; MetricsStore migration 12; installed @liamcottle/meshcore.js 1.15.0 from package.json/package-lock and installed source. No dependency replacement is needed for passive parsing.
- Firmware reference a366955cb2f67b8e6842d4f00d2b6a554dddd88a, committed 2026-09-30T01:56:20Z. Its relevant files were read through GitHub's contents API at this exact ref.
- [Packet definitions](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/src/Packet.h): explicit route predicates include scoped/unscoped variants, encoded hash size/count and payload version values.
- [Mesh forwarding](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/src/Mesh.cpp): routeRecvPacket appends flood relay prefixes; removeSelfFromPath consumes the first direct prefix; onRecvPacket/sendDirect special-case TRACE SNR entries.
- [Identity prefix representation](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/src/Identity.h): copyHashTo/isHashMatch operate on leading public-key bytes, not a uniquely identifying separate digest.
- [Dispatcher frame validation](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/src/Dispatcher.cpp): reserved path mode 3, truncated paths and excessive path bytes are rejected.
- [Firmware bounds](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/src/MeshCore.h): MAX_PATH_SIZE=64, MAX_PACKET_PAYLOAD=184, MAX_TRANS_UNIT=255.
- [Packet format documentation](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/docs/packet_format.md) records width/count/header/transport layout. [Official firmware explanation](https://blog.meshcore.io/2026/03/06/path-diagnostics-improvements) describes multibyte prefix support introduced in v1.14.0; this does not verify the user's deployed firmware.

## Capability conclusions

| Topic | Verified fact | #27 implication |
| --- | --- | --- |
| Prefix width | Metadata low six bits are entry count; high two bits encode width minus one. Widths 1/2/3 valid, 4 reserved. | Preserve width explicitly; byte count is not hop count. |
| Effective bounds | Count <=63 and path bytes <=64. | Width 1 max63, width2 max32, width3 max21. |
| Flood order | A forwarding relay appends itself to the end. | Header entries are earliest-to-latest relays; observed distance n-i. |
| Direct order | Forwarding removes the next entry. | Remaining path is not a traveled path or evidence of distance to this Observer. |
| TRACE | Direct TRACE records SNR bytes in the header path. | Exclude TRACE from normal prefix/proximity interpretation. |
| Prefix identity | Prefix is leading public-key bytes; not unique. | Preserve unresolved/colliding evidence; resolve dynamically against all known identities. |
| Transport context | Scoped routes insert two little-endian 16-bit codes before path metadata. | Parse offsets explicitly; include context in path identity; transport codes are not relays. |
| Installed JS decoder | Packet APIs expose count/width/entries, but BufferReader may return short slices; isRouteFlood only covers unscoped FLOOD. | Explicit structural validation and enum classification are required. |
| Trust/routing | Observed path headers are not proof of authenticated relays or usable reverse links. | No trusted inventory mutation, automatic contact updates or outbound-route verification claim. |

## Fixture specification for implementation

These synthetic ACK payloads test header/path boundaries, not remote ACK validity or physical reachability. Payload `01020304` is deliberately opaque. Use the existing JavaScript frame builder and compare exact bytes; no captured/private traffic or hardware operation is required.

| Fixture | Raw frame hex | Expected result |
| --- | --- | --- |
| Unscoped flood, 2-byte prefixes | 0D43AC019905E85C01020304 | Prefixes AC01/9905/E85C, distances 3/2/1; radius2 excludes AC01. |
| Unscoped direct, same prefixes | 0E43AC019905E85C01020304 | Preserve direct-remaining path; no proximity distances/candidates. |
| Scoped flood, codes1234/5678 | 0C3412785643AC019905E85C01020304 | Same ordered prefixes/distances, separate scoped context. |
| Legacy 1-byte flood | 0D03AC99E801020304 | Prefixes AC/99/E8; resolve each at one-byte width. |
| 3-byte flood | 0D83AC0102990506E85C0701020304 | Prefixes AC0102/990506/E85C07, distances3/2/1. |
| Empty flood relay path | 0D0001020304 | No relay evidence; do not assign origin identity/distance. |
| Truncated declared 2-byte path | 0D43AC019905 | Reject before topology mutation, even if installed Packet construction succeeds. |

Also generate: reserved width4 and payload versions, reserved payload types, TRACE in both route families, missing transport bytes, byte-size overflow at width2/count33 and width3/count22, valid width limits, repeated-prefix positions, two Observers, same prefix at different widths, mutable inventory collisions, future/out-of-order reception times and same payload on multiple/repeated paths.

## Known limits and remaining research

No deployed firmware version or live-radio path is verified. Unknown nodes can collide with a locally unique prefix. Direct PATH-return payloads, contact routing, authentication, login/status/neighbour/region response fields, upstream PR44 delivery and remote-request completion/timeout/disconnect ownership remain the full #22 research scope. This evidence is sufficient to stage passive #27 parsing/storage planning; it does not authorize active requests, reverse routing, contact mutation or a dependency upgrade.
