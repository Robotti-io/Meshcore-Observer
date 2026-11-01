# Pillar 3 policy decisions — P3-02 / #53

**Status:** Accepted by human review on 2026-11-01. Each implementation task remains subject to its own approval and the protected-boundary gates below.
**Date:** 2026-11-01
**Inputs:** [P3-01 capability assessment](p3-bot-capability-assessment.md),
[P1-02 reporting decisions](pillar-1-decisions.md#settled-bot-reporting-decisions--2026-10-07),
[Enhanced Bots feature request](feat-enhanced_bots.md), and P3-02/#53.

This record turns the accepted feature scope into a small set of recommended
policies. It is deliberately explicit about failure behavior and compatibility.
Human review accepted these policies before P3-03 implementation began. This
acceptance does not authorize dependent persistence, reporting, or radio
behavior changes without their own task approval and protected-boundary review.

## Decision summary

| Area | Recommended policy |
| --- | --- |
| Target syntax | Leading `@[Companion name]` text token; exact token parser, NFC normalization, case-sensitive identity comparison; names select a bot but never authenticate a sender. |
| Targeting default | Opt-in per command; omitted/false retains current untagged behavior. A mismatched well-formed tag suppresses that command even when the command is otherwise untargeted. |
| Duplicate names | Do not assume mesh-wide uniqueness. Reject locally ambiguous target-required bot/command configurations on the same channel; document that independently operated remote bots with the same Companion name can still both match. |
| Cooperative suppression | Opt-in per command and disabled when no handler-specific satisfactory-response matcher exists. Match only while the reply remains pending; ambiguous competing requests suppress none. |
| Commit boundary | Atomically claim `pending → dispatching` immediately before beginning the radio delivery transaction. Only `pending` can become `suppressed`. |
| Transport default | Inherit the request transport: channel request → channel reply; private request → private reply. Preserve existing channel behavior for legacy commands. |
| Fallback | No implicit transport or scope broadening. Default private fallback is none; default scoped-channel fallback is none. Any alternate scope/transport must be explicit command policy. |
| Region scope | Per-command explicit region takes precedence only within the bot's configured allowlist; bot fixed scope remains forced. Otherwise preserve current incoming-scope mirroring and device-default behavior. `default`, named region, and explicit `unscoped` are distinct policies. |
| Retries | At most one retry, and only after a definitive Companion rejection that proves no RF send was accepted. Never retry after `Sent`, a missing destination ACK, timeout, disconnect, or ambiguous write outcome. |
| Lifecycle/counting | Durable enqueue is invocation acceptance (per P1-02). Terminal reply outcome and destination ACK evidence are separate dimensions; ACK never creates a second reply or replaces `sent`. |
| Recovery | Pending items resume with their accepted policy snapshot. A reply found in `dispatching` after restart becomes `delivery-unknown`; do not automatically resend it. |
| Privacy | Never persist raw private message text. Retain only bounded validated handler state needed for a pending reply and the full contact key required for pending private delivery; clear recipient key at terminal resolution. Completed reporting has no recipient dimension. |

## Detailed recommendations

### 1. Target grammar and identity matching

- Parse one optional leading token of the form `@[<name>]`, followed by whitespace and then the existing command text. A token elsewhere in the message is ordinary text. Reject malformed, unterminated, empty, or oversized tokens before handler matching.
- Compare the candidate with the current validated Companion name after Unicode NFC normalization. Keep the comparison case-sensitive and do not trim or case-fold the name contents. Allow only the protocol-supported UTF-8 byte length (the inspected Companion name field is 31 payload bytes plus its terminator); reject invalid UTF-8 or names outside that bound for target-required commands.
- Use literal parsing and equality checks; never interpolate a Companion name into a regular expression.
- A well-formed tag for a different name causes this bot to ignore the message, even if the matched command is not target-required. This prevents an ordinary command from answering a message explicitly addressed to another bot.
- A target-required command with no tag, unavailable identity, malformed identity, or an ambiguous local identity match is ignored. A tagged command for this bot proceeds through the existing handler parser.
- Group-text sender names and the bot tag are unverified message text. The tag is a routing selector, not authorization, identity proof, or access control. Contact/private command authorization is a separate P3-09 decision and must rely on a uniquely resolved contact identity.
- At config load, reject overlapping target-required definitions that could cause two local configured bot instances to answer the same channel/trigger using the same connected Companion identity. Do not claim protection from another operator's remote bot using the same display name; the protocol has no signed mention target.

The Companion protocol defines text payloads, not a standardized `@[name]` addressing field. The project should document this syntax as Observer command behavior and test it against intended clients before declaring interoperability.

### 2. Cooperative response suppression

- Keep suppression disabled unless the command explicitly opts in and its handler provides a tested `isSatisfactoryResponse` matcher. No global rule based on sender-name mentions, arbitrary text, or any message arriving after the request is acceptable.
- A matcher may use the original channel, command/trigger, bounded validated handler state, Observer receipt order, and the response structure/content expected by that handler. Channel sender names are unverified; they can be a correlation hint but not proof that the original requester received an answer.
- Consider only replies still in `pending`, accepted for the same channel and matching command family, whose original request is still in its pending lifetime. This avoids a second wall-clock correlation timer. Use Observer receipt time; never trust a sender-supplied timestamp to extend the window.
- Suppress only when exactly one pending interaction satisfies the matcher. If simultaneous requests or response evidence make the target ambiguous, suppress none. Never cancel `dispatching` or later work.
- Persist one distinct `suppressed` terminal outcome and reason category, without storing the competing message body. Suppression is not a send failure, expiry, or administrative cancellation.

### 3. Delivery transport, scope, fallback, and retry

- Keep current command definitions and channel-delivery behavior as defaults. New command policy is opt-in; omitted transport means `inherit`.
- `inherit` sends a channel invocation to its channel and a private invocation privately to the uniquely resolved sender contact. A command may request another transport only explicitly. Private request/response text must never be published to a channel through automatic fallback.
- Private delivery uses Companion-maintained contact routing. Resolve a six-byte incoming contact prefix to exactly one full key from a fresh contact inventory; reject zero or multiple matches. Do not reverse inbound paths or infer route authorization from Pillar 1 topology.
- For channel replies, resolve policy in this order: explicit per-command scope, compatible bot-level fixed/allowlist constraint, current supported incoming-scope mirror, then Companion device default for legacy-compatible unscoped input. A bot fixed scope cannot be overridden by a conflicting command scope; reject that config. A bot allowlist constrains every explicit command scope.
- Represent `device-default`, a named region, and `unscoped` as different policy values. Continue to present semantic names, not raw transport keys, in operator config. Use the verified Companion operation for explicit unscoped mode; if the operation returns unsupported/error or its result is uncertain, fail without sending. `clearFloodScope()` means restore the device default, not necessarily send unscoped.
- Default `fallback` is `none`. A scoped send failure never falls back to device default or unscoped traffic implicitly. An explicitly configured alternate region may be used only if validated and permitted by the bot allowlist. Any explicit unscoped fallback must be separately visible in configuration and reporting.
- A private reply never falls back to channel by default. The initial recommended v2.5.0 policy is private-only; adding private-to-channel fallback should require a separate explicit command option and human review because it can disclose private command results.
- Permit at most one retry only when a terminal Companion response proves the message was rejected before RF acceptance. Do not retry on a serial write error, timeout, disconnect, `Sent` followed by ACK timeout, or other uncertain outcome. Such cases may have transmitted, so retry could duplicate the response. If the SDK cannot preserve the rejection reason, record failure/unknown and do not retry.
- Keep the whole scope-apply/send/restore transaction inside the existing serialized radio command ownership. A failed restore invalidates that connection generation before another radio operation can run.

### 4. Lifecycle, ACK, accounting, and recovery

- Preserve P1-02 accounting: a successful durable enqueue is one accepted invocation; duplicate packet deliveries do not create a second invocation; resumption/retry does not create another invocation.
- Keep reply outcome as one terminal value: `sent`, `failed`, `expired`, or `suppressed`; retain `cancelled` only for an explicitly supported administrative action. Add `delivery-unknown` for a process restart after a durable dispatch claim where RF outcome cannot be proved. Do not map unknown to sent or failed.
- For a private reply, track destination acknowledgement separately as `not-applicable`, `waiting`, `acknowledged`, or `timed-out`. A successful SDK `Sent` response means Companion send acceptance/route selection, not destination ACK. `PUSH_CODE_SEND_CONFIRMED` means the matching message ACK reached the Companion; it is not a read receipt.
- ACK is a milestone on the same interaction. It does not add another sent reply, alter the invocation time, or create a second terminal outcome. ACK timeout does not turn a Companion-accepted send into a send failure.
- Correlate ACK only to the active reply attempt's expected ACK code under serialized ownership. Ignore unknown, duplicate, and late codes after bounded cleanup; never associate by arrival order alone across concurrent sends.
- Define transmission commitment as a durable, conditional claim `pending → dispatching` made before scope mutation or private/channel send begins. Suppression updates only `WHERE status = 'pending'`; if the claim wins, the response proceeds and no later observed message cancels it.
- On clean restart, pending rows resume using a frozen policy/config snapshot accepted with the interaction. Old pending rows use the existing channel/default policy. If current config no longer supports a frozen private/scope policy, fail closed with an explicit terminal reason; do not reinterpret it as public/default delivery.
- On crash/restart, rows already in `dispatching` become `delivery-unknown` and are not replayed automatically. This accepts possible loss in that narrow window to avoid an unprovable duplicate RF send. Ordinary `pending` rows continue to survive restart as today.

### 5. Private-data retention and reporting

- Do not log or persist raw private message bodies. Validate the event before parsing; place only the command trigger and bounded handler-specific state needed to render the queued reply into the pending record.
- Persist the resolved full contact key only while a private reply is pending/dispatching because retry/recovery and exact contact routing need it. Clear it on terminal resolution. Never put the key in logs or aggregate dimensions.
- Apply the existing shared bot-history retention from P1-02; add no private-specific retention setting. Completed records may report bot, command, transport, terminal outcome, and ACK outcome/latency where approved, but not recipient key, message text, or sender-name identity as a verified person.
- Keep accepted invocation time and terminal reply outcome time distinct. ACK outcome/time is separate evidence on that interaction. Existing legacy rows remain unknown where those timestamps/evidence are absent.

## Worked cases

| Case | Expected result |
| --- | --- |
| Legacy `!stats` command, no policy fields | Same channel response behavior as current v2.4.0 configuration. |
| Target-required command receives `@[Other Bot] !lookup X` | Ignore the request; do not run handlers or enqueue. |
| Target-required command receives `@[This Bot] !lookup X`, current identity valid | Run the existing lookup handler, then enqueue with the accepted target/delivery policy. |
| Two same-channel pending lookups and one generic message mentions the requester | Suppress neither; no handler-specific satisfactory response evidence. |
| One unique pending command receives a handler-validated satisfactory answer before the queue claims it | Atomically resolve `pending → suppressed`; do not transmit. |
| Matching response arrives after `pending → dispatching` | Keep sending; a begun transaction cannot be cancelled. |
| Private request from a contact whose six-byte prefix maps to two full keys | Reject intake and do not queue or reply. |
| Private send returns `Sent`, then no destination ACK | Keep terminal reply outcome `sent`; set ACK outcome `timed-out`; do not resend. |
| Private send returns an ambiguous timeout before `Sent` | Record failed/unknown according to validated SDK evidence; do not send publicly and do not retry. |
| Regional scope apply fails | Do not send; record failure. Use only an explicitly configured and validated alternate scope. |
| Scope restore fails after attempted send | Invalidate the connection; record delivery outcome from send evidence and scope restoration failure separately; no next operation uses the uncertain connection. |
| Restart sees an ordinary `pending` reply | Resume once with its original policy snapshot; do not recount invocation. |
| Restart sees `dispatching` | Resolve as `delivery-unknown`, do not resend automatically. |

## Implementation gates

- P3-03/#54 and P3-04/#55 can implement identity and matching after these policy choices are accepted.
- P3-05/#56 requires explicit storage approval before schema/migration changes. This record recommends status/milestone semantics but does not approve a migration.
- P3-06/#57 can implement the matcher/atomic-claim contract only for handlers with concrete tested evidence.
- P3-07/#58 and P3-08/#59 must verify the exact explicit unscoped operation and safe restoration on supported firmware; no silent broadening is allowed.
- P3-09/#60 and P3-10/#61 must validate strict contact input and unique full-key resolution. Authentication/contact policy changes require separate approval if implementation goes beyond receiving messages from existing known contacts.
- P3-11/#62 may report Companion ACK semantics only; no read-receipt claim.
- P3-13/#64 requires explicit storage and public-API approval before changing schemas, queries, or HTTP/dashboard contracts.
- P3-14/#65 RF, restart, and hardware scenarios remain separately authorized operational validation.

## Acceptance review checklist

- [x] Target grammar, normalization, defaults, and selector/authentication distinction proposed.
- [x] Satisfaction evidence, pending-only correlation, and transmission-commit boundary defined.
- [x] Transport inheritance, scope inheritance, fallback, and bounded retry behavior defined.
- [x] Terminal reply outcome, destination ACK, invocation/outcome counting, and recovery semantics separated.
- [x] Private data minimization and shared retention defined.
- [x] Human review accepts the recommended decisions (2026-11-01).

Acceptance settles the policy recommendations for dependent planning. It does
not grant blanket implementation permission or cross the protected boundaries
above.
