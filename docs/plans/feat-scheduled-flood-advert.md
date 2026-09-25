# Feature: Scheduled startup and periodic flood advert

## Goals

- Send the Companion device's own flood advert once after the observer starts and the radio connects.
- Send another flood advert at a configurable interval, defaulting to 47 hours, with no periodic interval shorter than 47 hours.
- Wait for the same observed quiet-air window used by channel replies before sending. Incoming packets and this observer's own transmissions must keep the shared radio quiet-window state accurate.
- Use the Companion device to create and sign its own advert; the observer must not construct or sign an advert packet itself.

## Implementation Plan

### 1. Feature Summary

Add a lifecycle-managed scheduler that requests an initial flood advert after the first successful radio connection, then requests one at each configured interval. Requests must wait until no RF packet has been observed for the configured bot reply quiet window. While disconnected or busy, repeated periodic triggers are coalesced into at most one pending advert rather than accumulating a backlog.

The default interval is 47 hours, following local mesh community guidance for flood adverts. `PACKETCAPTURE_FLOOD_ADVERT_INTERVAL_HOURS=0` disables periodic adverts while retaining the one startup advert; otherwise accepted values are whole hours from 47 through 168. One-hour zero-hop adverts are a separate mode and are not scheduled by this feature. The interval is measured from one accepted send to the next, not aligned to wall-clock hour boundaries.

### 2. Relevant Existing Architecture

- `src/radio/radio-manager.js` owns the Companion connection and exposes `runCommand(fn)`. It serializes every device command through `CommandQueue`; feature code should not call the connection directly.
- The installed `@liamcottle/meshcore.js` version is 1.15.0 and exposes `connection.sendFloodAdvert()`. The Companion protocol's `CMD_SEND_SELF_ADVERT` (command 7) accepts an advert type, where type 1 requests flood mode and responds with OK or ERR. The device uses its own advert identity and signing state.
- `src/bots/reply-queue.js` records `radio.packet` activity, waits for `botReplyQueue.quietMs`, serializes reply sends, and resets activity when the observer sends. Its persisted queue and resolution metrics are specifically bot-reply data, so it should not be overloaded with synthetic bot replies for an advert.
- `src/index.js` wires `radio.packet`, starts services, and stops them during shutdown. `radio.connected` is emitted only after connection setup and required device initialization commands complete.
- Configuration is read in `src/config/index.js` and strictly validated through the centralized AJV schema in `src/config/schema.js`. Runtime configuration belongs in the central config path; modules must not read `process.env` directly.
- Existing timers (`src/metrics/sampler.js`, `src/bots/reply-queue.js`) are idempotently started/stopped and unreferenced so they do not keep the process alive.

### 3. Proposed Approach

- Introduce a small shared radio-airtime coordinator that owns the last observed RF activity time and an exclusive transmission reservation. Feed it every `radio.packet`. Make `ReplyQueue` acquire the same reservation before dispatching a reply, preserving its existing SQLite persistence, FIFO order, expiry, and outcome accounting.
- Add a one-slot/coalescing `FloodAdvertScheduler`. On the first `radio.connected` event it requests the startup advert; while disconnected or awaiting quiet air, any periodic due events coalesce into one pending request. Once radio and air are available, it calls `radioManager.runCommand((connection) => connection.sendFloodAdvert())` under the shared reservation.
- Reset shared activity when an outbound send is initiated, following the existing reply queue's self-activity behavior. Do not queue a separate advert for every missed interval and do not send multiple startup adverts on reconnect.
- Persist a singleton flood-advert job state in `MetricsStore`, separate from `bot_replies`. Startup must resume an existing pending job instead of creating another. Record when an attempt starts and when the device accepts a send so a restart during an uncertain in-flight command does not immediately retransmit it; defer that uncertain retry until the configured interval has elapsed.
- Add `PACKETCAPTURE_FLOOD_ADVERT_INTERVAL_HOURS`, default `47`, validated as either `0` or an integer from `47` through `168`. Zero means startup-only; values 47 through 168 set the recurring interval. This value controls observer scheduling and does not modify device firmware settings.
- Start and stop the scheduler explicitly in `src/index.js`. Stop it before the radio manager closes, and wait for an in-flight command to settle as part of bounded shutdown.
- Log standalone scheduler outcomes with stable sources and no request ID. Log success, skipped/coalesced/reconnected behavior only when operationally useful, and never log packet contents or secrets.

This approach shares one source of truth for observed quiet air without mixing radio actions into the bot reply persistence schema. It retains command serialization and avoids an unbounded backlog during long busy periods or disconnections.

### 4. Impacted Areas

- `src/radio/airtime-coordinator.js` — new shared activity and transmission-reservation seam.
- `src/bots/reply-queue.js` — acquire the shared reservation for reply dispatch while preserving persistent reply semantics.
- `src/radio/flood-advert-scheduler.js` — new startup/periodic scheduler, coalescing, connection handling, logs, and lifecycle.
- `src/metrics/store.js` — a forward-only migration and narrow methods for the single pending flood-advert job state, distinct from bot reply history.
- `src/config/index.js`, `src/config/schema.js` — parse and validate the interval setting.
- `src/index.js` — construct, wire, start, and stop the coordinator/scheduler.
- `.env.example`, `README.md` — document the interval, its default, zero behavior, startup behavior, and shared quiet-window rule.
- `test/radio/airtime-coordinator.test.js`, `test/radio/flood-advert-scheduler.test.js`, `test/config/config.test.js`, `test/bots/reply-queue.test.js`, and `test/metrics/store.test.js` — cover coordination, scheduling, config validation, restart recovery, and unchanged reply behavior.
- Manual device validation is scoped to COM4 only. Do not connect to, interrupt, or send commands to COM3, which has the actively running local instance.
- No new dependency is expected. A database migration is needed to resume/coalesce the pending job safely across application restarts.

### 5. Task Breakdown

#### T1: Add shared quiet-air coordination

- **Objective:** Let reply sends and scheduled adverts use one observed quiet-window clock and one exclusive outbound reservation.
- **Specific changes:** Add `AirtimeCoordinator` with `noteActivity`, quiet-window eligibility, and exclusive send execution. Wire `radio.packet` activity through it. Update `ReplyQueue` to use the coordinator for outbound dispatch while retaining its existing queue persistence, ordering, expiry, and metrics.
- **Definition of done:** A reply and another outbound action cannot both claim the same quiet window; incoming RF activity delays both; a completed outbound send resets the shared quiet state. Existing reply lifecycle behavior remains intact.
- **Expected tests / validation:** Deterministic-clock tests for recent activity, a quiet window, concurrent send reservation, and self-activity reset; run `npm test` and `npm run lint`.

#### T2: Persist one pending advert job across restarts

- **Objective:** Prevent a restored advert waiting for airtime from being duplicated by the next startup request.
- **Specific changes:** Add a forward-only SQLite migration with a dedicated singleton flood-advert job record, separate from `bot_replies`. Add store methods to load or coalesce a pending startup/periodic request, mark an attempt as started, and record a confirmed device response. Recover a pending-not-started job after restart. Treat an attempt left in progress by a crash as uncertain and defer any retry until at least the configured interval after its recorded attempt time.
- **Definition of done:** Repeated startup requests do not create multiple pending advert jobs; a waiting job resumes after restart; an uncertain in-flight send is not immediately repeated; bot reply lifecycle history and counts are unchanged.
- **Expected tests / validation:** Store migration and recovery tests for empty, pending, and interrupted-attempt states; verify old reply data and outcome totals remain intact; run `npm test` and `npm run lint`.

#### T3: Add and validate the advert interval configuration

- **Objective:** Make the recurring schedule operator-configurable with a safe default.
- **Specific changes:** Parse `PACKETCAPTURE_FLOOD_ADVERT_INTERVAL_HOURS` centrally with default `47`; validate `0` or integer values from `47` to `168` through AJV; document that `0` keeps the startup advert and disables recurrence.
- **Definition of done:** Invalid, fractional, negative, below-47-hour, and above-168 values fail configuration before hardware/network side effects; omitted value resolves to 47 hours.
- **Expected tests / validation:** Config tests for default, valid boundaries, and rejection cases; verify `.env.example` and README agree; run `npm test` and `npm run lint`.

#### T4: Implement startup and periodic flood advert scheduling

- **Objective:** Send one startup advert and recurring adverts without bypassing quiet-air or radio-command serialization.
- **Specific changes:** Add `FloodAdvertScheduler`. Trigger startup once on the first `radio.connected`, resuming an existing persisted pending job if present; then schedule from the previous accepted send using the configured interval. Use one coalesced pending state while busy or disconnected. Call `sendFloodAdvert()` through `RadioManager.runCommand()` and the shared airtime coordinator. Log outcomes and handle errors without crashing packet ingest.
- **Definition of done:** Startup waits for connection and quiet air; periodic requests run at intervals of at least 47 hours; reconnect does not create duplicate startup sends; multiple overdue intervals do not create a burst; a restored pending advert is not duplicated; sends are serialized with all existing Companion commands; `stop()` clears timers and waits safely for an active send.
- **Expected tests / validation:** Scheduler tests for startup, first-send timing, 47-hour default, configured interval, zero interval, busy-air delay, disconnect/reconnect coalescing, restart recovery, failures, and shutdown with an in-flight operation; run `npm test` and `npm run lint`.

#### T5: Wire lifecycle, document operation, and validate on the scoped device

- **Objective:** Integrate the service into application startup/shutdown and explain its RF behavior to operators.
- **Specific changes:** Construct and wire the coordinator and scheduler in `src/index.js`, start after dependencies are ready, and stop before `radioManager.stop()`. Update README and `.env.example` with the 47-hour default, minimum interval, startup-only setting, restart recovery, and the fact that flood adverts are retransmitted by repeaters. Perform manual Companion command validation only on COM4; leave the active COM3 instance untouched.
- **Definition of done:** The feature starts and stops with the observer, reports failures through the structured logger, documentation describes the configured behavior accurately, and the hardware check confirms the advert command and response on COM4 only.
- **Expected tests / validation:** Bootstrap/lifecycle tests or focused wiring tests as supported by the existing suite; full `npm test` and `npm run lint`; manual test checklist records device/port COM4 and does not connect to COM3.

### 6. Risks and Edge Cases

- Flood adverts are network-wide transmissions that repeaters may rebroadcast. At the 47-hour default this is about one periodic advert every two days, plus one startup advert each time the process starts. This follows local community guidance for flood adverts; zero-hop adverts have a separate one-hour cadence and are outside this scheduler. Operators can use longer intervals or set zero for startup-only. See [MeshCore FAQ](https://github.com/meshcore-dev/MeshCore/blob/main/docs/faq.md).
- The quiet-window mechanism is inferred from received packets, not a physical channel-activity/CAD measurement. It cannot detect transmissions that the Companion did not report to the app.
- Startup means after the first successful radio connection in each process lifetime, then after the quiet window and configured minimum cadence. A restart resumes a pending job rather than duplicating it; a recent successful or uncertain attempt delays the next send until the cadence permits it.
- When disconnected or busy, coalesce missed periodic triggers to one durable pending send; never replay every missed interval after reconnect.
- Process restart while an advert is pending must resume/coalesce the existing persisted job rather than enqueue a second startup advert. If a crash occurs after the device receives a command but before the observer records its response, the send outcome is uncertain; defer retry by the configured interval because exactly-once radio delivery cannot be guaranteed across the device/database boundary.
- Persisting pending advert state requires a SQLite schema migration. The user approved this planned migration when authorizing implementation.
- The installed `sendFloodAdvert()` implementation waits for a Companion OK/ERR response and does not expose an explicit timeout in the local 1.15.0 source. Verify response behavior on target firmware before rollout. Do not use a `Promise.race` timeout that releases `CommandQueue` while the underlying device transaction is still active; that could allow overlapping command/response correlation.
- Startup and interval scheduling use process timers, so delivery can drift with event-loop load and quiet-air delays. The interval is a minimum cadence measured between accepted sends, not a precise wall-clock schedule.
- If the quiet period is configured to zero, the shared coordinator must still serialize outbound operations and prevent simultaneous dispatch.

### 7. Resolved Decisions and Execution Checks

- **Resolved:** The interval is configured in hours. If unset, it defaults to 47 hours and this default will be shown in `.env.example`.
- **Resolved:** Zero means startup-only; valid periodic settings range from 47 through 168 hours.
- **Resolved:** The next interval starts after the device accepts the previous advert, so quiet-air delays do not cause catch-up bursts or intervals shorter than configured.
- **Resolved:** Reconnect does not count as a second startup. A pending overdue periodic request is coalesced and may run after reconnect.
- **Resolved:** Persist pending advert state separately from bot replies so startup resumes/coalesces an existing job rather than duplicating it. If a crash leaves the command in an uncertain in-flight state, defer a retry for at least the configured interval.
- **Updated guidance:** Local mesh community guidance recommends a 47-hour flood interval. One-hour zero-hop adverts are a separate behavior and are not configured by this scheduler.
- **Resolved:** Manual device testing is restricted to COM4. Do not connect to or disrupt the active COM3 instance.
- **Execution check:** Confirm target Companion firmware supports `sendFloodAdvert()` and returns its response reliably enough for the serialized command queue, using COM4 only.

### 8. Suggested Execution Order

1. **T1** — establish one shared airtime reservation before adding a second class of radio transmission.
2. **T2** — persist/coalesce the single pending advert so restarts cannot enqueue duplicates.
3. **T3** — add strict configuration and validate the 47-hour minimum.
4. **T4** — implement the scheduler on the stable coordination, persistence, and config seams.
5. **T5** — wire lifecycle, document RF behavior, then validate hardware only on COM4.
