import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Fixed rungs above the (dynamic, config-derived) sample interval. Ordered
// ascending; resolveBucketWidthMs() walks this to find the smallest width
// that keeps a query's bucket count within its requested maxBuckets, so an
// "all time" query over years of history still returns a bounded number of
// points to the client instead of one row per sample.
const BUCKET_WIDTH_LADDER_MS = [
  60_000, // 1m
  300_000, // 5m
  900_000, // 15m
  3_600_000, // 1h
  10_800_000, // 3h
  21_600_000, // 6h
  43_200_000, // 12h
  86_400_000, // 1d
  604_800_000, // 7d
  2_592_000_000 // 30d
];

const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE metrics_samples (
        id                 INTEGER PRIMARY KEY,
        sample_at          INTEGER NOT NULL,
        interval_ms        INTEGER NOT NULL,
        packets_received   INTEGER NOT NULL,
        packets_published  INTEGER NOT NULL,
        radio_connected    INTEGER NOT NULL,
        brokers_connected  INTEGER NOT NULL,
        brokers_total      INTEGER NOT NULL,
        bots_ready         INTEGER NOT NULL,
        bots_total         INTEGER NOT NULL
      )`,
      'CREATE INDEX idx_metrics_samples_at ON metrics_samples(sample_at)',
      `CREATE TABLE metrics_sample_packet_types (
        sample_id           INTEGER NOT NULL REFERENCES metrics_samples(id),
        packet_type_bucket  TEXT NOT NULL,
        count               INTEGER NOT NULL,
        PRIMARY KEY (sample_id, packet_type_bucket)
      )`,
      `CREATE TABLE bot_command_events (
        id           INTEGER PRIMARY KEY,
        occurred_at  INTEGER NOT NULL,
        bot_name     TEXT NOT NULL,
        trigger      TEXT NOT NULL
      )`,
      'CREATE INDEX idx_bot_command_events_bot_time ON bot_command_events(bot_name, occurred_at)'
    ]
  },
  {
    // Renames the misleadingly-named packets_published column (it counted
    // packets entering the publish pipeline, not confirmed broker delivery -
    // see docs/Code Review - 2026-09-22.md item 4) to packets_decoded, adds
    // a per-sample broker-delivery breakdown (sent/skipped/failed - the
    // accurate replacement for what packets_published used to imply), a
    // reply-queue-depth gauge for a future depth-over-time chart, and
    // generalizes bot_command_events (success-only) into bot_reply_events,
    // one row per reply-lifecycle outcome (sent/failed/expired/cancelled)
    // rather than just successful sends - see reply-queue.js's stop()/#tick().
    version: 2,
    statements: [
      'ALTER TABLE metrics_samples RENAME COLUMN packets_published TO packets_decoded',
      'ALTER TABLE metrics_samples ADD COLUMN reply_queue_size INTEGER NOT NULL DEFAULT 0',
      `CREATE TABLE metrics_sample_broker_deliveries (
        sample_id  INTEGER NOT NULL REFERENCES metrics_samples(id),
        broker_id  TEXT NOT NULL,
        outcome    TEXT NOT NULL CHECK (outcome IN ('sent', 'skipped', 'failed')),
        count      INTEGER NOT NULL,
        PRIMARY KEY (sample_id, broker_id, outcome)
      )`,
      `CREATE TABLE bot_reply_events (
        id           INTEGER PRIMARY KEY,
        occurred_at  INTEGER NOT NULL,
        bot_name     TEXT NOT NULL,
        trigger      TEXT NOT NULL,
        sender       TEXT,
        hash         TEXT,
        outcome      TEXT NOT NULL CHECK (outcome IN ('sent', 'failed', 'expired', 'cancelled')),
        queued_ms    INTEGER
      )`,
      'CREATE INDEX idx_bot_reply_events_bot_time ON bot_reply_events(bot_name, occurred_at)',
      'CREATE INDEX idx_bot_reply_events_outcome_time ON bot_reply_events(outcome, occurred_at)',
      // sender/hash/queued_ms didn't exist on the old table, so historical
      // rows carry them forward as NULL rather than a fabricated value.
      `INSERT INTO bot_reply_events (occurred_at, bot_name, trigger, sender, hash, outcome, queued_ms)
       SELECT occurred_at, bot_name, trigger, NULL, NULL, 'sent', NULL FROM bot_command_events`,
      'DROP TABLE bot_command_events'
    ]
  },
  {
    // Backs the dashboard's node ("!lookup" repeater registry) totals and
    // search/browse table - see
    // docs/plans/feat-bot_command_to_lookup_repeater_name.md and
    // NodeRegistry's `recordNode` hook. One row per public key (a current-
    // state snapshot, not an append-only log - see the class doc comment
    // on why it's excluded from pruneOlderThan), upserted every time a
    // verified named advert is heard: first_heard_at is set once, on
    // insert, and never touched again; last_heard_at is refreshed on every
    // upsert. "Added in range" and "updated in range" (queryNodeTotals)
    // are both derived from these two columns rather than a separate
    // event-log table, since only the latest state of each node - not a
    // full history of every re-hear - is needed for that count.
    version: 3,
    statements: [
      `CREATE TABLE nodes (
        public_key_hex   TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        type             TEXT,
        first_heard_at   INTEGER NOT NULL,
        last_heard_at    INTEGER NOT NULL
      )`,
      'CREATE INDEX idx_nodes_first_heard_at ON nodes(first_heard_at)',
      'CREATE INDEX idx_nodes_last_heard_at ON nodes(last_heard_at)'
    ]
  },
  {
    // Backs ReplyQueue's *pending* (not-yet-resolved) items - see
    // reply-queue.js. Previously an in-memory array, which meant a reply
    // still waiting for a quiet RF window was silently dropped on any
    // restart; persisting it lets a fresh ReplyQueue resume exactly where
    // the last one left off (see ReplyQueue#start()). A row's `expires_at`
    // is a fixed point in time set at the original enqueue - a resumed
    // item that's already past it is simply expired on the first tick
    // after restart by the same logic that expires any other stale item,
    // so downtime longer than ttlMs naturally self-heals with no special
    // shutdown-time handling required. One row per queued reply (deleted
    // the moment it's dequeued for dispatch, expired, or - going forward -
    // any other terminal resolution), so this table's own row count *is*
    // "how many are queued right now" (see ReplyQueue#getStats()) with no
    // separate counter to keep in sync.
    version: 4,
    statements: [
      `CREATE TABLE reply_queue_items (
        id              INTEGER PRIMARY KEY,
        bot_name        TEXT NOT NULL,
        channel         TEXT NOT NULL,
        trigger         TEXT NOT NULL,
        sender          TEXT NOT NULL,
        hop_count       INTEGER NOT NULL,
        path            TEXT NOT NULL,
        hash            TEXT NOT NULL,
        query           TEXT,
        lookup_outcome  TEXT,
        name            TEXT,
        match_count     INTEGER,
        enqueued_at     INTEGER NOT NULL,
        expires_at      INTEGER NOT NULL
      )`,
      'CREATE INDEX idx_reply_queue_items_enqueued_at ON reply_queue_items(enqueued_at)',
      'CREATE INDEX idx_reply_queue_items_expires_at ON reply_queue_items(expires_at)'
    ]
  },
  {
    // Consolidates the pending-item table (reply_queue_items, v4) and the
    // historical reply-lifecycle log (bot_reply_events, v2) into one table:
    // a reply's entire lifecycle, from enqueue through resolution, is now
    // one row that starts `status = 'pending'` and is later UPDATEd in
    // place to 'sent'/'failed'/'expired' (see reply-queue.js's #tick()),
    // rather than an insert into one table followed by a delete-and-insert
    // into another. 'cancelled' stays a valid status only so any
    // pre-existing historical rows with that outcome (from when stop()
    // used to drop queued items - an earlier design, since replaced by
    // restart-resumption) keep validating; nothing writes it going forward.
    //
    // The hot pending-item queries ReplyQueue runs on every poll tick
    // (peekOldestPendingReplyItem/takeExpiredReplyItems/
    // countPendingReplyItems) all filter on `status = 'pending'` first,
    // matching idx_bot_replies_status_enqueued, so they stay index lookups
    // against a small slice of the table no matter how much resolved
    // history accumulates - and pruneOlderThan (see below) only ever
    // deletes `status != 'pending'` rows, so a long-pending item can never
    // be pruned out from under the queue.
    version: 5,
    statements: [
      `CREATE TABLE bot_replies (
        id              INTEGER PRIMARY KEY,
        bot_name        TEXT NOT NULL,
        channel         TEXT,
        trigger         TEXT NOT NULL,
        sender          TEXT,
        hop_count       INTEGER,
        path            TEXT,
        hash            TEXT,
        query           TEXT,
        lookup_outcome  TEXT,
        name            TEXT,
        match_count     INTEGER,
        enqueued_at     INTEGER,
        expires_at      INTEGER,
        status          TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'expired', 'cancelled')),
        resolved_at     INTEGER,
        queued_ms       INTEGER
      )`,
      'CREATE INDEX idx_bot_replies_status_enqueued ON bot_replies(status, enqueued_at)',
      'CREATE INDEX idx_bot_replies_status_resolved ON bot_replies(status, resolved_at)',
      'CREATE INDEX idx_bot_replies_bot_status_resolved ON bot_replies(bot_name, status, resolved_at)',
      `INSERT INTO bot_replies (
         bot_name, channel, trigger, sender, hop_count, path, hash,
         query, lookup_outcome, name, match_count, enqueued_at, expires_at, status
       )
       SELECT bot_name, channel, trigger, sender, hop_count, path, hash,
              query, lookup_outcome, name, match_count, enqueued_at, expires_at, 'pending'
       FROM reply_queue_items`,
      `INSERT INTO bot_replies (bot_name, trigger, sender, hash, status, resolved_at, queued_ms)
       SELECT bot_name, trigger, sender, hash, outcome, occurred_at, queued_ms
       FROM bot_reply_events`,
      'DROP TABLE reply_queue_items',
      'DROP TABLE bot_reply_events'
    ]
  },
  {
    // Lookup replies are resolved before enqueue and may wait through a
    // restart. Keep the node timestamp, display prefix, and all-repeater
    // total with each queued item so dispatch renders the original lookup
    // result without consulting state that may have changed since enqueue.
    version: 6,
    statements: [
      'ALTER TABLE bot_replies ADD COLUMN last_heard_at INTEGER',
      'ALTER TABLE bot_replies ADD COLUMN node_prefix TEXT',
      'ALTER TABLE bot_replies ADD COLUMN repeater_count INTEGER'
    ]
  },
  {
    // One durable slot is enough for the observer's periodic self-advert:
    // missed intervals coalesce, while a startup can resume an advert that
    // was still waiting for quiet air. An attempt left in `sending` at a
    // process restart is ambiguous (the radio may already have accepted it)
    // and is recovered using its attempt timestamp rather than immediately
    // issued a second time.
    version: 7,
    statements: [
      `CREATE TABLE flood_advert_state (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        status              TEXT NOT NULL CHECK (status IN ('idle', 'pending', 'sending')),
        requested_at        INTEGER,
        attempt_started_at  INTEGER,
        last_attempt_at     INTEGER,
        last_sent_at        INTEGER,
        next_due_at         INTEGER
      )`,
      "INSERT INTO flood_advert_state (id, status) VALUES (1, 'idle')"
    ]
  }
];

// Shared by every bot_replies SELECT below so the camelCase shape handed
// back always matches exactly what ChannelBot#sendQueuedReply and
// ReplyQueue's own logging destructure - see reply-queue.js. Most fields
// are nullable at the SQL level: a still-pending row has no
// resolved_at/queued_ms yet, and a row migrated from the old
// bot_reply_events table (see the v5 migration) never had
// channel/hop_count/path/enqueued_at/expires_at to begin with.
const BOT_REPLY_COLUMNS = `
  id, bot_name AS botName, channel, trigger, sender, hop_count AS hopCount, path, hash,
  query, lookup_outcome AS lookupOutcome, name, match_count AS matchCount,
  last_heard_at AS lastHeardAt, node_prefix AS nodePrefix, repeater_count AS repeaterCount,
  enqueued_at AS enqueuedAt, expires_at AS expiresAt, status,
  resolved_at AS resolvedAt, queued_ms AS queuedMs
`;

function toNumberOrNull(value) {
  return value === null ? null : Number(value);
}

function mapBotReplyRow(row) {
  return {
    ...row,
    id: Number(row.id),
    hopCount: toNumberOrNull(row.hopCount),
    matchCount: toNumberOrNull(row.matchCount),
    lastHeardAt: toNumberOrNull(row.lastHeardAt),
    repeaterCount: toNumberOrNull(row.repeaterCount),
    enqueuedAt: toNumberOrNull(row.enqueuedAt),
    expiresAt: toNumberOrNull(row.expiresAt),
    resolvedAt: toNumberOrNull(row.resolvedAt),
    queuedMs: toNumberOrNull(row.queuedMs)
  };
}

/**
 * Picks the smallest bucket width (from the sample interval and the fixed
 * ladder above it) that keeps `Math.ceil(rangeMs / width) <= maxBuckets`.
 * If even the largest rung isn't wide enough (a multi-year "all" range),
 * falls back to the next whole multiple of that largest rung, which still
 * guarantees the bound rather than growing the ladder indefinitely.
 *
 * @param {{rangeMs: number, maxBuckets: number, sampleIntervalMs: number}} options
 * @returns {number} bucket width in milliseconds, always >= sampleIntervalMs.
 */
export function resolveBucketWidthMs({ rangeMs, maxBuckets, sampleIntervalMs }) {
  const safeRangeMs = Math.max(0, rangeMs);
  const idealWidth = safeRangeMs / Math.max(1, maxBuckets);

  const ladder = [sampleIntervalMs, ...BUCKET_WIDTH_LADDER_MS.filter((rung) => rung > sampleIntervalMs)];
  for (const rung of ladder) {
    if (rung >= idealWidth) {
      return rung;
    }
  }

  const largestRung = ladder[ladder.length - 1];
  return Math.ceil(idealWidth / largestRung) * largestRung;
}

/**
 * Local SQLite-backed persistence for packet and bot-command metrics, via
 * Node's built-in `node:sqlite` (DatabaseSync) - see
 * docs/plans/feat-improved_metrics_reporting.md for why this storage engine
 * and no multi-tier rollup table are the deliberate v1 choice. Exposes only
 * narrow, purpose-built methods (never a generic query passthrough) and
 * always binds parameters positionally rather than concatenating SQL.
 *
 * `packet_type_bucket` values are opaque strings as far as this module is
 * concerned - callers decide what categorization scheme to key samples by
 * (e.g. the dashboard's 8-category scheme), so this store has no knowledge
 * of MeshCore payload types.
 */
export class MetricsStore {
  #db;
  #insertSampleStmt;
  #insertPacketTypeStmt;
  #insertBrokerDeliveryStmt;
  #upsertNodeStmt;
  #insertBotReplyStmt;
  #countPendingBotRepliesStmt;
  #selectExpiredBotRepliesStmt;
  #expireBotRepliesStmt;
  #peekOldestPendingBotReplyStmt;
  #resolveBotReplyStmt;
  #selectFloodAdvertStateStmt;
  #requestFloodAdvertStmt;
  #startFloodAdvertAttemptStmt;
  #resolveFloodAdvertAttemptStmt;
  #recoverFloodAdvertAttemptStmt;

  /** @param {{dbPath: string}} options */
  constructor({ dbPath }) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.#db = new DatabaseSync(dbPath);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#runMigrations();

    this.#insertSampleStmt = this.#db.prepare(`
      INSERT INTO metrics_samples (
        sample_at, interval_ms, packets_received, packets_decoded,
        radio_connected, brokers_connected, brokers_total, bots_ready, bots_total, reply_queue_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#insertPacketTypeStmt = this.#db.prepare(`
      INSERT INTO metrics_sample_packet_types (sample_id, packet_type_bucket, count)
      VALUES (?, ?, ?)
    `);
    this.#insertBrokerDeliveryStmt = this.#db.prepare(`
      INSERT INTO metrics_sample_broker_deliveries (sample_id, broker_id, outcome, count)
      VALUES (?, ?, ?, ?)
    `);
    this.#upsertNodeStmt = this.#db.prepare(`
      INSERT INTO nodes (public_key_hex, name, type, first_heard_at, last_heard_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(public_key_hex) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        last_heard_at = excluded.last_heard_at
    `);
    this.#insertBotReplyStmt = this.#db.prepare(`
      INSERT INTO bot_replies (
        bot_name, channel, trigger, sender, hop_count, path, hash,
        query, lookup_outcome, name, match_count, last_heard_at, node_prefix, repeater_count,
        enqueued_at, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    this.#countPendingBotRepliesStmt = this.#db.prepare("SELECT COUNT(*) AS total FROM bot_replies WHERE status = 'pending'");
    this.#selectExpiredBotRepliesStmt = this.#db.prepare(
      `SELECT ${BOT_REPLY_COLUMNS} FROM bot_replies WHERE status = 'pending' AND expires_at <= ? ORDER BY enqueued_at ASC`
    );
    this.#expireBotRepliesStmt = this.#db.prepare(
      "UPDATE bot_replies SET status = 'expired', resolved_at = ?, queued_ms = ? - enqueued_at WHERE status = 'pending' AND expires_at <= ?"
    );
    this.#peekOldestPendingBotReplyStmt = this.#db.prepare(
      `SELECT ${BOT_REPLY_COLUMNS} FROM bot_replies WHERE status = 'pending' ORDER BY enqueued_at ASC LIMIT 1`
    );
    this.#resolveBotReplyStmt = this.#db.prepare('UPDATE bot_replies SET status = ?, resolved_at = ?, queued_ms = ? WHERE id = ?');
    this.#selectFloodAdvertStateStmt = this.#db.prepare(`
      SELECT status, requested_at AS requestedAt, attempt_started_at AS attemptStartedAt,
             last_attempt_at AS lastAttemptAt, last_sent_at AS lastSentAt, next_due_at AS nextDueAt
      FROM flood_advert_state WHERE id = 1
    `);
    this.#requestFloodAdvertStmt = this.#db.prepare(`
      UPDATE flood_advert_state SET status = 'pending', requested_at = ?
      WHERE id = 1 AND status = 'idle'
    `);
    this.#startFloodAdvertAttemptStmt = this.#db.prepare(`
      UPDATE flood_advert_state SET status = 'sending', attempt_started_at = ?, last_attempt_at = ?
      WHERE id = 1 AND status = 'pending'
    `);
    this.#resolveFloodAdvertAttemptStmt = this.#db.prepare(`
      UPDATE flood_advert_state
      SET status = 'idle', requested_at = NULL, attempt_started_at = NULL,
          last_sent_at = CASE WHEN ? = 1 THEN ? ELSE last_sent_at END,
          next_due_at = ?
      WHERE id = 1 AND status = 'sending'
    `);
    this.#recoverFloodAdvertAttemptStmt = this.#db.prepare(`
      UPDATE flood_advert_state
      SET status = 'idle', requested_at = NULL, attempt_started_at = NULL,
          last_attempt_at = ?, next_due_at = ?
      WHERE id = 1 AND status = 'sending'
    `);
  }

  #runMigrations() {
    const { user_version: currentVersion } = this.#db.prepare('PRAGMA user_version').get();

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) {
        continue;
      }
      this.#db.exec('BEGIN');
      try {
        for (const statement of migration.statements) {
          this.#db.exec(statement);
        }
        // PRAGMA doesn't accept bound parameters; migration.version is our
        // own fixed integer literal, never external input.
        this.#db.exec(`PRAGMA user_version = ${migration.version}`);
        this.#db.exec('COMMIT');
      } catch (err) {
        this.#db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /**
   * Persists one tick's worth of deltas: the aggregate sample row plus one
   * child row per non-zero packet-type bucket and per non-zero (broker,
   * outcome) delivery-outcome pair, as a single transaction.
   *
   * @param {{sampleAt: number, intervalMs: number, packetsReceived: number, packetsDecoded: number, radioConnected: boolean, brokersConnected: number, brokersTotal: number, botsReady: number, botsTotal: number, replyQueueSize: number, packetsByType: Record<string, number>, brokerDeliveries: Record<string, {sent: number, skipped: number, failed: number}>}} sample
   */
  recordPacketSample(sample) {
    this.#db.exec('BEGIN');
    try {
      // lastInsertRowid comes back on run()'s return value, not as a
      // property of the prepared statement itself.
      const { lastInsertRowid } = this.#insertSampleStmt.run(
        sample.sampleAt,
        sample.intervalMs,
        sample.packetsReceived,
        sample.packetsDecoded,
        sample.radioConnected ? 1 : 0,
        sample.brokersConnected,
        sample.brokersTotal,
        sample.botsReady,
        sample.botsTotal,
        sample.replyQueueSize
      );
      const sampleId = Number(lastInsertRowid);

      for (const [bucket, count] of Object.entries(sample.packetsByType ?? {})) {
        if (count > 0) {
          this.#insertPacketTypeStmt.run(sampleId, bucket, count);
        }
      }

      for (const [brokerId, counts] of Object.entries(sample.brokerDeliveries ?? {})) {
        for (const [outcome, count] of Object.entries(counts)) {
          if (count > 0) {
            this.#insertBrokerDeliveryStmt.run(sampleId, brokerId, outcome, count);
          }
        }
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /** @returns {number|null} epoch ms of the earliest recorded sample, or null if none exist yet. */
  getEarliestSampleAt() {
    const row = this.#db.prepare('SELECT MIN(sample_at) AS earliest FROM metrics_samples').get();
    return row.earliest ?? null;
  }

  /**
   * Backend-computed, bucketed packet-type history over [start, end) -
   * see resolveBucketWidthMs() for how the bucket width is chosen.
   *
   * @param {{start: number, end: number, maxBuckets: number, sampleIntervalMs: number}} options
   * @returns {{bucketStart: number, bucketWidthMs: number, packetsReceived: number, packetsDecoded: number, countsByType: Record<string, number>}[]}
   */
  queryPacketHistory({ start, end, maxBuckets, sampleIntervalMs }) {
    const bucketWidthMs = resolveBucketWidthMs({ rangeMs: end - start, maxBuckets, sampleIntervalMs });

    // Two separate grouped queries rather than one join: summing
    // ms.packets_received through the packet-type join would multiply each
    // sample's received/decoded totals by however many distinct type rows
    // that sample has, over-counting them. Every bucket this totals query
    // produces is a superset of the per-type query's buckets (a sample
    // always has a row here even with zero decoded packet types), so it's
    // used as the canonical bucket set below.
    const totalsRows = this.#db
      .prepare(
        `
        SELECT
          CAST((ms.sample_at - ?) / ? AS INTEGER) AS bucket_idx,
          SUM(ms.packets_received) AS received,
          SUM(ms.packets_decoded) AS decoded
        FROM metrics_samples ms
        WHERE ms.sample_at >= ? AND ms.sample_at < ?
        GROUP BY bucket_idx
        ORDER BY bucket_idx
      `
      )
      .all(start, bucketWidthMs, start, end);

    const typeRows = this.#db
      .prepare(
        `
        SELECT
          CAST((ms.sample_at - ?) / ? AS INTEGER) AS bucket_idx,
          t.packet_type_bucket AS bucket_key,
          SUM(t.count) AS total
        FROM metrics_samples ms
        JOIN metrics_sample_packet_types t ON t.sample_id = ms.id
        WHERE ms.sample_at >= ? AND ms.sample_at < ?
        GROUP BY bucket_idx, bucket_key
        ORDER BY bucket_idx
      `
      )
      .all(start, bucketWidthMs, start, end);

    const bucketsByIdx = new Map();
    for (const row of totalsRows) {
      const idx = Number(row.bucket_idx);
      bucketsByIdx.set(idx, {
        bucketStart: start + idx * bucketWidthMs,
        bucketWidthMs,
        packetsReceived: Number(row.received),
        packetsDecoded: Number(row.decoded),
        countsByType: {}
      });
    }
    for (const row of typeRows) {
      bucketsByIdx.get(Number(row.bucket_idx)).countsByType[row.bucket_key] = Number(row.total);
    }

    return [...bucketsByIdx.values()].sort((a, b) => a.bucketStart - b.bucketStart);
  }

  /**
   * Non-bucketed per-type totals over [start, end) - for the packet-types
   * pie chart and table.
   *
   * @param {{start: number, end: number}} options
   * @returns {{packetTypeBucket: string, total: number}[]}
   */
  queryPacketTypeTotals({ start, end }) {
    const rows = this.#db
      .prepare(
        `
        SELECT t.packet_type_bucket AS bucket_key, SUM(t.count) AS total
        FROM metrics_sample_packet_types t
        JOIN metrics_samples ms ON ms.id = t.sample_id
        WHERE ms.sample_at >= ? AND ms.sample_at < ?
        GROUP BY bucket_key
        ORDER BY total DESC
      `
      )
      .all(start, end);

    return rows.map((row) => ({ packetTypeBucket: row.bucket_key, total: Number(row.total) }));
  }

  /**
   * Per-trigger *sent* reply counts for one bot over [start, end) - for
   * that bot's command pie chart and table. A thin filtered view over
   * bot_replies (status = 'sent'); see queryBotReplyOutcomeTotals() for the
   * full sent/failed/expired/cancelled breakdown. `resolved_at`, not
   * `enqueued_at`, is the range-scoping column - excluding
   * `status = 'pending'` first (idx_bot_replies_bot_status_resolved leads
   * with bot_name/status) means this never has to look at a still-pending
   * row's meaningless-for-this-purpose `enqueued_at` anyway.
   *
   * @param {{botName: string, start: number, end: number}} options
   * @returns {{trigger: string, count: number}[]}
   */
  queryBotCommandCounts({ botName, start, end }) {
    const rows = this.#db
      .prepare(
        `
        SELECT trigger, COUNT(*) AS total
        FROM bot_replies
        WHERE bot_name = ? AND status = 'sent' AND resolved_at >= ? AND resolved_at < ?
        GROUP BY trigger
        ORDER BY total DESC
      `
      )
      .all(botName, start, end);

    return rows.map((row) => ({ trigger: row.trigger, count: Number(row.total) }));
  }

  /**
   * Per-trigger sent reply counts for every bot over [start, end), grouped
   * in one database query for dashboard views. Configured bots with no
   * rows are intentionally omitted here; the caller applies the validated
   * bot configuration to preserve configured order and zero-fill.
   *
   * @param {{start: number, end: number}} options
   * @returns {{botName: string, trigger: string, count: number}[]}
   */
  queryBotCommandCountsByBot({ start, end }) {
    const rows = this.#db
      .prepare(
        `
        SELECT bot_name AS botName, trigger, COUNT(*) AS total
        FROM bot_replies
        WHERE status = 'sent' AND resolved_at >= ? AND resolved_at < ?
        GROUP BY bot_name, trigger
        ORDER BY bot_name, trigger
      `
      )
      .all(start, end);

    return rows.map((row) => ({ botName: row.botName, trigger: row.trigger, count: Number(row.total) }));
  }

  /**
   * Reply-lifecycle outcome totals over [start, end), summed across every
   * bot - backs the dashboard's reply-queue tiles (see metrics-server.js),
   * which - like every other historical chart on the dashboard - are
   * scoped to whatever duration is currently selected, and survive a
   * restart the way an in-memory counter can't. `status != 'pending'`
   * excludes anything still waiting for a quiet window - those aren't a
   * resolved outcome yet.
   *
   * @param {{start: number, end: number}} options
   * @returns {{sent: number, failed: number, expired: number, cancelled: number}}
   */
  queryReplyOutcomeTotals({ start, end }) {
    const totals = { sent: 0, failed: 0, expired: 0, cancelled: 0 };
    const rows = this.#db
      .prepare("SELECT status AS outcome, COUNT(*) AS total FROM bot_replies WHERE status != 'pending' AND resolved_at >= ? AND resolved_at < ? GROUP BY status")
      .all(start, end);
    for (const row of rows) {
      totals[row.outcome] = Number(row.total);
    }
    return totals;
  }

  /**
   * Per-bot, per-outcome reply-lifecycle totals over [start, end) - sent,
   * failed, expired, and cancelled counts broken down by bot. Not yet
   * surfaced on the dashboard; structured so a future "queue health" view
   * can query it directly rather than needing a schema change.
   *
   * @param {{start: number, end: number}} options
   * @returns {{botName: string, outcome: string, total: number}[]}
   */
  queryBotReplyOutcomeTotals({ start, end }) {
    const rows = this.#db
      .prepare(
        `
        SELECT bot_name AS botName, status AS outcome, COUNT(*) AS total
        FROM bot_replies
        WHERE status != 'pending' AND resolved_at >= ? AND resolved_at < ?
        GROUP BY bot_name, status
        ORDER BY bot_name, status
      `
      )
      .all(start, end);

    return rows.map((row) => ({ botName: row.botName, outcome: row.outcome, total: Number(row.total) }));
  }

  /**
   * Per-broker, per-outcome (sent/skipped/failed) packet delivery totals
   * over [start, end) - backs the dashboard's "MQTT brokers" section (see
   * metrics-server.js's #handleBrokerDeliveries).
   *
   * @param {{start: number, end: number}} options
   * @returns {{brokerId: string, outcome: string, total: number}[]}
   */
  queryBrokerDeliveryTotals({ start, end }) {
    const rows = this.#db
      .prepare(
        `
        SELECT d.broker_id AS brokerId, d.outcome, SUM(d.count) AS total
        FROM metrics_sample_broker_deliveries d
        JOIN metrics_samples ms ON ms.id = d.sample_id
        WHERE ms.sample_at >= ? AND ms.sample_at < ?
        GROUP BY d.broker_id, d.outcome
        ORDER BY d.broker_id, d.outcome
      `
      )
      .all(start, end);

    return rows.map((row) => ({ brokerId: row.brokerId, outcome: row.outcome, total: Number(row.total) }));
  }

  /**
   * Upserts one node's current state - called from NodeRegistry's
   * `recordNode` hook every time a verified named advert is heard, for
   * both a brand-new public key and a re-heard one. `heardAt` becomes
   * `first_heard_at` only on the first call for a given `publicKeyHex`
   * (a later call never moves it); `last_heard_at` is refreshed every time.
   *
   * @param {{publicKeyHex: string, name: string, type: string|null, heardAt: number}} node
   */
  upsertNode({ publicKeyHex, name, type, heardAt }) {
    this.#upsertNodeStmt.run(publicKeyHex, name, type ?? null, heardAt, heardAt);
  }

  /**
   * Distinct-node counts over [start, end) for the dashboard's node tiles:
   * `added` is nodes first heard in range; `updated` is nodes re-heard
   * (last_heard_at in range) *after* their initial add - a node heard only
   * once (first_heard_at === last_heard_at) counts toward `added` only,
   * never both, even if that single hearing falls in range. `type`,
   * optional, narrows to one advert type (e.g. the dashboard's "Repeaters"
   * tiles always pass `'REPEATER'`) - matched via `(? = '' OR ...)` rather
   * than building the WHERE clause conditionally, same as queryNodes()
   * below.
   *
   * @param {{start: number, end: number, type?: string}} options
   * @returns {{added: number, updated: number}}
   */
  queryNodeTotals({ start, end, type = '' }) {
    const row = this.#db
      .prepare(
        `
        SELECT
          SUM(CASE WHEN first_heard_at >= ? AND first_heard_at < ? AND (? = '' OR type = ?) THEN 1 ELSE 0 END) AS added,
          SUM(CASE WHEN last_heard_at >= ? AND last_heard_at < ? AND last_heard_at != first_heard_at AND (? = '' OR type = ?) THEN 1 ELSE 0 END) AS updated
        FROM nodes
      `
      )
      .get(start, end, type, type, start, end, type, type);

    return { added: Number(row.added ?? 0), updated: Number(row.updated ?? 0) };
  }

  /** Counts the current node registry, optionally narrowed to one advert type. */
  countNodesByType(type = '') {
    const { total } = this.#db
      .prepare('SELECT COUNT(*) AS total FROM nodes WHERE (? = \'\' OR type = ?)')
      .get(type, type);
    return Number(total);
  }

  /** Returns the single durable flood-advert scheduler state row. */
  getFloodAdvertState() {
    const row = this.#selectFloodAdvertStateStmt.get();
    if (!row) {
      throw new Error('flood advert state row is missing');
    }
    return {
      status: row.status,
      requestedAt: toNumberOrNull(row.requestedAt),
      attemptStartedAt: toNumberOrNull(row.attemptStartedAt),
      lastAttemptAt: toNumberOrNull(row.lastAttemptAt),
      lastSentAt: toNumberOrNull(row.lastSentAt),
      nextDueAt: toNumberOrNull(row.nextDueAt)
    };
  }

  /** Creates a pending request only when the durable slot is idle. */
  requestFloodAdvert(requestedAt) {
    this.#requestFloodAdvertStmt.run(requestedAt);
    return this.getFloodAdvertState();
  }

  /** Atomically claims the pending request before invoking the device. */
  startFloodAdvertAttempt(attemptStartedAt) {
    return Number(this.#startFloodAdvertAttemptStmt.run(attemptStartedAt, attemptStartedAt).changes) === 1;
  }

  /** Resolves an attempt and establishes the next allowed attempt time. */
  resolveFloodAdvertAttempt({ resolvedAt, intervalMs, sent }) {
    return Number(
      this.#resolveFloodAdvertAttemptStmt.run(sent ? 1 : 0, resolvedAt, resolvedAt + intervalMs).changes
    ) === 1;
  }

  /**
   * Recovers a command interrupted by process exit. Since the radio may
   * already have accepted it, do not make the slot immediately runnable.
   */
  recoverFloodAdvertAttempt({ intervalMs, uncertainAttemptIntervalMs = intervalMs }) {
    const state = this.getFloodAdvertState();
    if (state.status !== 'sending' || state.attemptStartedAt === null) {
      return false;
    }
    const retryAfterMs = Math.max(intervalMs, uncertainAttemptIntervalMs);
    const nextDueAt = state.attemptStartedAt + retryAfterMs;
    return Number(this.#recoverFloodAdvertAttemptStmt.run(state.attemptStartedAt, nextDueAt).changes) === 1;
  }

  /**
   * A page of the current node "contact list" - not range-scoped (it's
   * live current state, not history) - optionally filtered by a search
   * term (case-insensitive name substring, or a public-key hex prefix -
   * whichever matches) and/or an exact `type`, sorted most-recently-heard
   * first. `q`/`type` are matched via `(? = '' OR ...)` rather than
   * building the WHERE clause conditionally in JS, so this stays one
   * static, always-parameterized prepared statement - see the class doc
   * comment's "never a generic query passthrough" rule.
   *
   * @param {{q?: string, type?: string, limit: number, offset: number}} options
   * @returns {{total: number, nodes: {publicKeyHex: string, name: string, type: string|null, firstHeardAt: number, lastHeardAt: number}[]}}
   */
  queryNodes({ q = '', type = '', limit, offset }) {
    const normalizedQ = q.toUpperCase();
    const whereClause = `
      WHERE (? = '' OR name LIKE '%' || ? || '%' COLLATE NOCASE OR public_key_hex LIKE ? || '%')
        AND (? = '' OR type = ?)
    `;

    const { total } = this.#db
      .prepare(`SELECT COUNT(*) AS total FROM nodes ${whereClause}`)
      .get(q, q, normalizedQ, type, type);

    const rows = this.#db
      .prepare(
        `
        SELECT public_key_hex AS publicKeyHex, name, type, first_heard_at AS firstHeardAt, last_heard_at AS lastHeardAt
        FROM nodes
        ${whereClause}
        ORDER BY last_heard_at DESC
        LIMIT ? OFFSET ?
      `
      )
      .all(q, q, normalizedQ, type, type, limit, offset);

    return {
      total: Number(total),
      nodes: rows.map((row) => ({ ...row, firstHeardAt: Number(row.firstHeardAt), lastHeardAt: Number(row.lastHeardAt) }))
    };
  }

  /**
   * Every node whose public key starts with `prefixHex` (already normalized/
   * validated by the caller - see NodeRegistry#findByPrefix), optionally
   * narrowed to one `type`, most-recently-heard first. This is the
   * `!lookup` bot command's actual read path now - deliberately separate
   * from queryNodes() above, which also matches a name substring and is
   * paginated for the dashboard's browse/search table; a bare public-key
   * prefix match with the *full* match set (not a page of it) is what
   * NodeRegistry needs to decide found/not_found/ambiguous.
   *
   * @param {string} prefixHex
   * @param {{type?: string}} [options]
   * @returns {{publicKeyHex: string, name: string, type: string|null, firstHeardAt: number, lastHeardAt: number}[]}
   */
  findNodesByPublicKeyPrefix(prefixHex, { type = '' } = {}) {
    const rows = this.#db
      .prepare(
        `
        SELECT public_key_hex AS publicKeyHex, name, type, first_heard_at AS firstHeardAt, last_heard_at AS lastHeardAt
        FROM nodes
        WHERE public_key_hex LIKE ? || '%'
          AND (? = '' OR type = ?)
        ORDER BY last_heard_at DESC
      `
      )
      .all(prefixHex, type, type);

    return rows.map((row) => ({ ...row, firstHeardAt: Number(row.firstHeardAt), lastHeardAt: Number(row.lastHeardAt) }));
  }

  /**
   * Inserts one reply as `status = 'pending'` (see reply-queue.js's
   * enqueue()). Every field ChannelBot#sendQueuedReply and ReplyQueue's own
   * logging need travels with the row, so a fresh process can fully resume
   * it later with no extra lookups - see the v5 migration's doc comment for
   * why this and every resolved reply live in the same table now.
   *
   * @param {{botName: string, channel: string, trigger: string, sender: string, hopCount: number, path: string, hash: string, query?: string, lookupOutcome?: string, name?: string, matchCount?: number, lastHeardAt?: number, nodePrefix?: string, repeaterCount?: number, enqueuedAt: number, expiresAt: number}} item
   */
  enqueueReplyItem(item) {
    this.#insertBotReplyStmt.run(
      item.botName,
      item.channel,
      item.trigger,
      item.sender,
      item.hopCount,
      item.path,
      item.hash,
      item.query ?? null,
      item.lookupOutcome ?? null,
      item.name ?? null,
      item.matchCount ?? null,
      item.lastHeardAt ?? null,
      item.nodePrefix ?? null,
      item.repeaterCount ?? null,
      item.enqueuedAt,
      item.expiresAt
    );
  }

  /** How many replies are currently queued (`status = 'pending'`) - see ReplyQueue#getStats(). */
  countPendingReplyItems() {
    const { total } = this.#countPendingBotRepliesStmt.get();
    return Number(total);
  }

  /**
   * Marks every pending item whose `expiresAt` is at or before `now` as
   * `status = 'expired'` (`resolved_at`/`queued_ms` set to match) and
   * returns what they were, oldest first - ReplyQueue calls this at the
   * start of every tick (see its own #tick()) to expire stale items,
   * whether they went stale during normal operation or across a restart (a
   * resumed item's `expiresAt` is a fixed point in time from its original
   * enqueue, so downtime longer than its remaining TTL expires it here
   * exactly as if the process had never stopped).
   *
   * @param {number} now
   * @returns {object[]} the now-expired items, as they were *before* this call (still carrying the old `status: 'pending'`).
   */
  takeExpiredReplyItems(now) {
    const rows = this.#selectExpiredBotRepliesStmt.all(now);
    if (rows.length > 0) {
      this.#expireBotRepliesStmt.run(now, now, now);
    }
    return rows.map(mapBotReplyRow);
  }

  /**
   * The single oldest pending item, or `null` if none are queued -
   * ReplyQueue calls this once a quiet window is observed (see its own
   * #tick()), then calls resolveReplyItem() once dispatch settles. Unlike
   * the in-memory array this replaced (`Array#shift()`), this does *not*
   * remove the row - it stays `status = 'pending'` until resolveReplyItem()
   * is called, so a failure between the two (an unexpected process death,
   * or - far more likely - resolveReplyItem() itself failing) leaves the
   * item queued to be picked up again rather than silently lost. The
   * tradeoff is the opposite risk: if the item's *dispatch* already
   * succeeded but resolveReplyItem() then fails, a future tick could
   * re-dispatch (and thus double-send) it - see ReplyQueue's own handling.
   *
   * @returns {object|null}
   */
  peekOldestPendingReplyItem() {
    const row = this.#peekOldestPendingBotReplyStmt.get();
    return row ? mapBotReplyRow(row) : null;
  }

  /**
   * Resolves one reply by id - the counterpart to peekOldestPendingReplyItem()
   * and takeExpiredReplyItems() above; this is the only way a row moves out
   * of `status = 'pending'` for a reply that was actually dispatched.
   *
   * @param {number} id
   * @param {{status: 'sent'|'failed', resolvedAt: number, queuedMs: number}} resolution
   */
  resolveReplyItem(id, { status, resolvedAt, queuedMs }) {
    this.#resolveBotReplyStmt.run(status, resolvedAt, queuedMs, id);
  }

  /** One reply by id, in the same shape as the pending-item queries above - for diagnostics/tests. */
  getReplyById(id) {
    const row = this.#db.prepare(`SELECT ${BOT_REPLY_COLUMNS} FROM bot_replies WHERE id = ?`).get(id);
    return row ? mapBotReplyRow(row) : null;
  }

  /** Deletes packet samples/their child rows, and resolved (never pending) replies, at or before `cutoffMs`. */
  pruneOlderThan(cutoffMs) {
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('DELETE FROM metrics_sample_packet_types WHERE sample_id IN (SELECT id FROM metrics_samples WHERE sample_at < ?)').run(cutoffMs);
      this.#db.prepare('DELETE FROM metrics_sample_broker_deliveries WHERE sample_id IN (SELECT id FROM metrics_samples WHERE sample_at < ?)').run(cutoffMs);
      this.#db.prepare('DELETE FROM metrics_samples WHERE sample_at < ?').run(cutoffMs);
      this.#db.prepare("DELETE FROM bot_replies WHERE status != 'pending' AND resolved_at < ?").run(cutoffMs);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.#db.close();
  }
}
