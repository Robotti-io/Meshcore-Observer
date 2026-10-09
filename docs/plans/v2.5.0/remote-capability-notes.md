# Remote repeater capability assessment — P1-01 / #22

Research completed 2026-10-09 against Observer `cae9a48de7b2dd052fcb2e3c64372396e3654c96`, migration 13. This is source research, not a deployed-device certification. No hardware query, RF transmission, contact edit, credential access, dependency upgrade or runtime change was performed. [Passive topology findings](topology-protocol-notes.md) remain part of this assessment.

## Version and deployment evidence

| Component | Verified artifact / assumption | Limits |
| --- | --- | --- |
| Installed library | `@liamcottle/meshcore.js` 1.15.0; upstream tag [1c142946f9597d60fc634afd9a681f546792b0d5](https://github.com/meshcore-dev/meshcore.js/tree/1c142946f9597d60fc634afd9a681f546792b0d5). Installed connection/events files match tag blobs `8d7365431d912bc97d59c2d572d227482e180927` / `606fff2ed2e4374d24a9170d583fc617bd1b8c12`. [Published npm latest](https://registry.npmjs.org/@liamcottle%2fmeshcore.js/latest) is still 1.15.0. | No anonymous-request/regions helper in this installed artifact. Package range is not evidence of a newer installed version. |
| Library upstream | Master `26193c059fcd1d0524f1ad5b19fd88287ecc5c61`; [PR #44](https://github.com/meshcore-dev/meshcore.js/pull/44) remains OPEN/unmerged; proposed head `4031dd0a6843cc8dc4d25da1ecf812e1819704b9`. | Proposed anonymous APIs are not approved or installed. Recheck actual released artifact during #31 planning. |
| Firmware inspected | [MeshCore source a366955cb2f67b8e6842d4f00d2b6a554dddd88a](https://github.com/meshcore-dev/MeshCore/tree/a366955cb2f67b8e6842d4f00d2b6a554dddd88a), dated 2026-09-30, still current main at research time. | Board options, ACL, sensor suite and capacity can change behavior. Earliest release support is not inferred from current source. |
| Released Companion source | Latest release `companion-v1.17.1` (2026-08-14), resolved source [d92964352441e53b93e8667b802e04f6e072b39e](https://github.com/meshcore-dev/MeshCore/tree/d92964352441e53b93e8667b802e04f6e072b39e). Its Companion code contains protocol code 13, command 57 and non-contact creation. | This establishes released source support, not the version running on our Companion or every repeater. No firmware upgrade is proposed. |
| Deployed radios | Not queried. Current Observer device metadata reports protocol code/build date; it does not reliably preserve a full semantic release/commit. | Companion/repeater firmware, board, `MAX_CONTACTS`, `MAX_NEIGHBOURS`, ACL role and sensor support remain unknown. Future feature activation must verify them. |
| CoreScope contract | [6cab7d698d15f739dcaa0f04df70eaa80f5d13da docs](https://github.com/OKI-Mesh/CoreScope/blob/6cab7d698d15f739dcaa0f04df70eaa80f5d13da/docs/client-regions.md) and [key derivation](https://github.com/OKI-Mesh/CoreScope/blob/6cab7d698d15f739dcaa0f04df70eaa80f5d13da/cmd/ingestor/region_keys.go). Both blobs are unchanged at current master `aa40e9e302ffc6eabe51424bb7416b047b5354b5`: `1e70bf002a13161702ffa4401cda42fe79587670` / `298aba9307f14c5737d8b0375a92c0b5bf050254`. | Deployed ingestor configuration and broker permissions are unknown; #32 must verify them. |

## Capability matrix

Supported means present in the inspected source/artifact. Unknown deployment support never becomes a successful empty result.

| Capability | Source/artifact support | Identity / prerequisites | Owning issue |
| --- | --- | --- | --- |
| Login / guest authorization | Installed login helper; Companion command 26; repeater guest and management roles. | Existing full-key contact; role and guest-only credential policy need review. Host legacy reply uses a key prefix, not a request tag. No anonymous-discovery credential needed. | #34, separate authentication approval |
| Status | Installed `getStatus` uses command 27 and parses a 48-byte prefix; generic binary command 50 with request type 01 is supported. Pinned repeater layout is 56 bytes. | Contact and repeater ACL. Prefer tagged binary path for future polling; no prefix-only completion fallback. | #33 fields/storage, #34 polling |
| Sensor telemetry | Installed legacy command 39/helper; generic binary type 03 supported; Cayenne LPP subset decoder available. | Contact/ACL and sensor permissions/build. Missing sensors and partial decoding are unavailable, not zero. | #33/#34 |
| Neighbours | Installed generic binary helper and type 06 request; pinned repeater implements version 0 pagination. Upstream documents v1.9.0+; [PR #833](https://github.com/meshcore-dev/MeshCore/pull/833) merged 2025-09-25. | No independently verified earliest-release or deployed support. Compile-time neighbour tracking may be disabled. Prefixes do not prove full-key identity or reachability. | #33/#34 |
| Anonymous region declarations | Firmware command 57/type 01 and zero-hop reply path supported in inspected source. Installed library has no method; [upstream PR #44](https://github.com/meshcore-dev/meshcore.js/pull/44) proposes it. | Exact full-key target and verified fresh zero-hop evidence plus dispatch-time Companion contact/route check. No login. | #31 dependency/adapter and query loop |
| Remote completion ownership | Firmware clears all prior pending request types when accepting a new one. Binary push retains tag; legacy login/status use prefixes, telemetry push strips tag. | One aggregate pending remote request across all producers; ACK is not completion. | #29 |
| Saved contact/routing control | Firmware uses existing saved route. Missing anonymous target can add a contact with zero-hop path; full table rejects it. | Local inventory is not the Companion contact table. Initial proposal: defer missing/non-zero-hop contacts; no automatic route edit or eviction. | #31/#34 |
| CoreScope publication | Inspected contract accepts deliberate empty lists, observation time and optional repeater clock, no mandatory GPS. | Per-broker opt-in and reporter-topic ACL; target attribution remains the reporting Companion's assertion. | #30 data, #32 publication |

## Primary protocol references

All firmware references below are pinned to `a366955cb2f67b8e6842d4f00d2b6a554dddd88a`:

- [Companion commands and response handling](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/examples/companion_radio/MyMesh.cpp): commands 26/27/39/50/57; `onContactResponse`; anonymous contact creation; Sent/Err frames.
- [Companion pending slots](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/examples/companion_radio/MyMesh.h#L163): `clearPendingReqs` clears login/status/telemetry/discovery/binary together.
- [Request construction/routing](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/src/helpers/BaseChatMesh.cpp): `sendAnonReq`, `sendRequest`, time-derived tags and dynamic contact paths.
- [Repeater request handlers](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/examples/simple_repeater/MyMesh.cpp): login, status/telemetry/neighbours, direct-only anonymous regions and limiter.
- [Repeater status layout](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/examples/simple_repeater/MyMesh.h#L44), [ACL roles](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/src/helpers/ClientACL.h), [region export](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/src/helpers/RegionMap.cpp) and [padding](https://github.com/meshcore-dev/MeshCore/blob/a366955cb2f67b8e6842d4f00d2b6a554dddd88a/src/Utils.cpp).
- [Installed connection implementation](https://github.com/meshcore-dev/meshcore.js/blob/1c142946f9597d60fc634afd9a681f546792b0d5/src/connection/connection.js), [custom event emitter](https://github.com/meshcore-dev/meshcore.js/blob/1c142946f9597d60fc634afd9a681f546792b0d5/src/events.js), and [proposed PR #44 connection implementation](https://github.com/meshcore-dev/meshcore.js/blob/4031dd0a6843cc8dc4d25da1ecf812e1819704b9/src/connection/connection.js).

## Correlation and cleanup findings

One remote operation must retain ownership from admission through answer, failure, timeout, disconnect or shutdown. A second remote request clears the Companion's first pending operation even if its command ACK already arrived. Local channel sends/signing/reads can still use the command queue while that remote answer is awaited.

`Sent` is command code `06`, result byte (0 direct / 1 flood), uint32 little-endian tag and uint32 estimated timeout in milliseconds: 10 bytes. `Err` is `01` plus one error code. Binary push `8C` contains reserved zero, uint32 tag and bounded body. It has **no target public key**: attribution is the submitted full-key context matched by a tag from a trusted Companion. It is not independent full-key or cryptographic proof. Direct result 0 also includes routed direct requests; it does not establish zero-hop delivery.

Legacy login/status correlate using the first four key bytes in firmware; their host pushes expose a six-byte prefix. Legacy telemetry correlates its tag in firmware but removes it from the host push. Prefer tagged binary status/telemetry/neighbours rather than treating these legacy pushes as strong application correlation. Login and permissions remain #34's reviewed authentication problem.

The installed custom emitter wraps `once` callbacks internally; removing the original callback does not remove that wrapper. Existing remote helpers use `once`, so an unrelated response can consume the listener before its callback rejects the mismatch. They generally start response timeout only after Sent, leaving a missing ACK unbounded; cleanup/disconnect behavior is insufficient for shared ownership. [Upstream PR #44](https://github.com/meshcore-dev/meshcore.js/pull/44) improves its anonymous helper, but does not fix all older helpers or establish cross-producer ownership. #29 should use owned `on`/exact `off` listeners and bounded validated raw envelopes, preserving transport/capture behavior rather than adding another decoding library.

Tags are derived from the Companion clock, not cryptographic nonces. A bounded recently retired tag set can reject observed reuse and queued callbacks must check connection generation. It cannot prove replay protection across process restart or arbitrary RF delays. A pre-ACK push must not be guessed into a request. Normal response timeout releases local ownership; cancellation does not retract RF already sent. An ambiguous ACK timeout/write failure requires invalidating that transport generation before another command can mistake its late acknowledgement for its own.

## Contact and anonymous-region findings

The firmware's command-57 non-contact path **creates a Companion contact** with type NONE and zero-hop outbound path; it can fail with table-full error 3. Existing contacts use their saved path unchanged, including unknown/flood or relayed direct paths. A fresh local verified zero-hop advert does not prove the saved Companion route is zero-hop. Region queries must check exact full-key contact/path at dispatch, not infer an outbound route from #27 passive paths.

Recommended #31 starting policy, pending its plan approval: use only an existing exact-key `out_path_len=0` contact and #26's configured fresh verified-zero-hop eligibility (72 hours by default). Defer absent, stale, unknown or nonzero routes. Do not temporarily replace routes, create contacts, evict entries, repair contacts, or fall back to flooding. These alternatives would require a separately approved recovery/mutation contract. Saved paths can change through received path updates or another client; dispatch checks narrow that risk but cannot prove atomicity against external actors. An unexpected flood Sent is a recorded failed attempt, not an undoable preflight rejection.

Anonymous type 01 with reply-path length 00 needs no password. Repeater accepts the request only over a direct route. Its pinned limiter allows four anonymous queries per 180 seconds, shared with other anonymous request types/clients. Timeout can mean loss, busy/rate limit, ACL/firmware/path issues, or silence; it is not proof of unsupported capability.

After Companion removes the echoed tag, the region body is remote clock uint32 LE followed by CSV and possible trailing crypto NUL padding. Strict parsing must preserve case and wildcard `*`, trim only trailing padding, validate UTF-8 and reject embedded NUL/empty CSV entries. A valid empty declaration is different from unknown/failure. The region exporter strips leading `#`, skips names that do not fit and continues, without a wire truncation flag. **A short response or `truncated:false` cannot prove completeness.** Packet/build/export limits must be captured separately from any publication heuristic; do not fabricate a universal completeness ceiling.

## Telemetry fields and authorization

Guest credentials and management credentials are separate. Pinned repeater roles are guest 0, read-only 1, read-write 2, admin 3 under mask 3. An empty login password can use existing ACL membership; management password grants admin. Future polling must never substitute a management password. The wire login truncates password input at its fixed limit; #34 must reject incompatible UTF-8 length/NUL rather than silently truncate. The installed LoginSuccess parser omits newer permission/server-time/firmware fields, so success alone is not proof of a safe read-only role. Concrete authentication/schema/role handling requires #34 approval.

Status known layout is 56 bytes, little-endian. The installed helper reads only the first 48. #33 should explicitly distinguish known legacy/current layouts, absent extension fields and unsupported layouts; structural zero bytes are data, not padding to strip blindly.

| Offset / type | Meaning / normalization |
| --- | --- |
| 0 u16 | Battery millivolts, not percentage; percentage needs board/calibration evidence. |
| 2 u16; 4 s16; 6 s16 | Queue length; noise floor; last RSSI (dBm). |
| 8/12 u32 | Received/sent counters. |
| 16/20 u32 | TX airtime seconds / uptime seconds. |
| 24/28/32/36 u32 | Sent flood/direct; received flood/direct counters. |
| 40 u16; 42 s16 | Error-event bitflags (not count); last SNR in quarter dB (divide by four). |
| 44/46 u16 | Direct/flood duplicates. |
| 48/52 u32 | RX airtime seconds / receive errors; unavailable from installed legacy helper. |

Remote counters can reset/wrap; do not compute cross-reboot rates as monotonic counters. Observer receipt time and repeater clock are separate. Telemetry LPP sensor presence depends on board/permissions: voltage 0.01 V, temperature 0.1 °C, humidity 0.5%, pressure 0.1 hPa, current 0.001 A. The library decoder supports a subset, terminates at padding/unknown types and can return a partial list or throw on truncated numeric reads. Constants alone do not prove decoder support. #33 must boundary-check known widths, use strict normalized schemas and retain unavailable/partial evidence. No invented battery percentage, absent temperature as zero, or stationary GPS default.

Neighbours type 06/version 0 request includes count u8, offset u16 LE, ordering 0–3 and prefix width 1–32, followed by uniqueness bytes. Response starts total/result counts u16 LE, then each entry has prefix bytes, age u32 seconds and signed quarter-dB SNR. The pinned 130-byte entry budget permits ten 8-byte-prefix entries or three 32-byte entries per page. Compile-time tracking may be disabled; pages can shift between requests and are not an atomic inventory. Age uses the repeater clock; prefixes remain ambiguous observations, not verified full identities or outbound route evidence.

## CoreScope publication implications

Topic reporter key and payload target use lowercase hex; target is exactly 64 characters. Required shape is `type:REGIONS`, original Observer answer-receipt ISO timestamp, target, regions string array and truncated boolean; repeater_clock is optional and GPS is optional. Do not replace the observation time with retry time or remote clock. Successful empty answers are stored/published; timeout/unknown sends nothing. Broker ACL binds the reporter topic, not the claimed target. Publication requires explicit per-broker opt-in, applicable client-topic permissions and deployed `clientRegions.enabled`. Existing observer-feed access is insufficient.

The contract chooses latest by observed time and uses `(target, rx_pubkey, observed_at)` for idempotent retries. #30 owns durable answer/attempt/publication semantics; #32 owns exact validated MQTT compatibility and truthful truncation mapping. A false hint must never become a dashboard claim of completeness. Local successful answers and previous learned inventory must remain usable offline and survive broker failure.

## Proposed synthetic fixtures and validation ownership

These are specifications for later tests; no tests or commands were added to runtime by this research.

| Fixture | Expected result / owner |
| --- | --- |
| `06007856341288130000` | Sent direct, tag 0x12345678, estimate 5000 ms; retain remote ownership after ACK (#29). |
| `06017856341288130000` | Sent flood; reject when direct-only was required, count already attempted send (#29/#31). |
| `8C0078563412040302010000000000000000` | Tag match; body clock 0x01020304 followed by empty CSV/eight padding bytes; successful empty regions (#29 envelope, #30/#31 body). |
| Same push with tag `79563412`; duplicate, pre-ACK and previous-generation pushes | Ignore without consuming current listener; no stale/new-session resolution (#29). |
| Short Sent, nonzero Binary reserved byte, over-bound body, Err `0101` / `0102` / `0103` | Strict reject/typed unsupported/not-found/table-full; cleanup without speculative fallback (#29). |
| CSV `*`, `Be,be-vlg`, invalid UTF-8, embedded NUL, empty CSV item, omitted long name | Preserve valid case/wildcard; reject malformed input; a short answer remains potentially incomplete (#30/#31/#32). |
| Synthetic status layouts 48/56 bytes, SNR -16, error flags 3, extension absent | SNR -4 dB; flags are flags; unavailable fields remain null; unknown/truncated layouts fail validation (#33). |
| LPP `0174014A` / `016700FA`; unknown type and truncated value | Voltage 3.30 V / temperature 25.0 °C; disclose partial/unsupported instead of presenting complete success (#33). |
| Neighbour body `01000100` + 8-byte prefix + `05000000F0` | One result, age 5 s, SNR -4 dB; width/count/paging bounds and prefix ambiguity remain explicit (#33). |
| Missing ACK, hung write, disconnect/stop, queued old connection, tag reuse and 1,000 request cycles | Bounded terminal settlement; no timer/listener/job growth; late ACK cannot satisfy another command (#29). |
| Remote answer pending plus bot reply, advert, signing/local read and capture | Only remote producers are excluded; existing foreground work/capture continue; busy admission defers without bursts (#29). |

## Separately authorized hardware/release checks

**None authorized or executed during #22.** #31/#34/#37 must obtain a named-device/action approval before RF or contact/auth work. Proposed checklist:

1. Record exact Companion/repeater build, board and supported protocol; inspect existing full-key contact/path/capacity and guest ACL policy without exposing credentials. Record limitations, not guessed minimum versions.
2. With separately approved target/action/budget, perform one existing-contact zero-hop anonymous region request. Capture route result, tag, body length/clock/case/empty answer and before/after contact inventory. Do not silently create/edit/evict contacts.
3. Exercise explicitly approved disconnect/timeout/restart scenarios; verify independent capture/bot behavior, listener cleanup and preserved successful answers. Table-full/missing-contact cases should use fixtures unless their live mutation is separately approved.
4. With separately approved guest-only credentials/actions, verify available status/sensor/neighbour layouts and actual permissions. Never probe management fallback or infer admin safety from old parser output.
5. Verify the separately approved broker/client ACL and deployed CoreScope setting, then one durable answer publication/retry. Include offline/restart preservation and original observation time.

Research acceptance is complete. Deployment checks, authentication/dependency integration, RF sampling and publication remain concrete future owning-issue gates, not unfinished research or implied authorization.
