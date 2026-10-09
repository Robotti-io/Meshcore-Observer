import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { botInteractionSchema, botUsageFiltersSchema, botUsageRangeSchema, botUsagePageSchema } from './schemas.js';
import { verifiedAdvertSchema, advertRangeSchema, advertPageSchema, directHeardQuerySchema, fingerprintPruneSchema } from '../nodes/schemas.js';
import { runStartSchema, runCheckpointSchema, runEndSchema, runIdentitySchema, runPageSchema } from './run-schemas.js';

const validateRunStart = compileSchema(runStartSchema);
const validateRunCheckpoint = compileSchema(runCheckpointSchema);
const validateRunEnd = compileSchema(runEndSchema);
const validateRunIdentity = compileSchema(runIdentitySchema);
const validateRunPage = compileSchema(runPageSchema);

function assertRunInput(validate, value) {
  if (!validate(value)) throw new Error(`Invalid run history input: ${formatErrors(validate.errors)}`);
  if (value.start !== undefined && value.start > value.end) throw new Error('Invalid run history input: start must not exceed end');
}
function wallTimeAnomaly(startedAt, previousAt, { observedAt, observedDurationMs }) {
  return observedAt < previousAt || Math.abs(observedAt - startedAt - observedDurationMs) > 1000;
}
const RUN_COLUMNS = `id AS runId, instance_id AS instanceId, started_at AS startedAt,
  last_known_alive_at AS lastKnownAliveAt, observed_duration_ms AS observedDurationMs,
  ended_at AS endedAt, end_reason AS endReason, state, wall_time_anomaly AS wallTimeAnomaly,
  app_version AS appVersion, node_version AS nodeVersion, platform, architecture`;
function mapRun(row) {
  return row ? { ...row, wallTimeAnomaly: Boolean(row.wallTimeAnomaly), durationIsLowerBound: row.state !== 'clean' } : null;
}

function explainDatabaseLock(error) {
  // SQLite extended result codes retain the primary code in the low byte.
  // SQLITE_BUSY (5) and SQLITE_LOCKED (6) identify contention, not corruption
  // or missing runtime support. Preserve the original error for diagnostics.
  if (!Number.isInteger(error.errcode) || ![5, 6].includes(error.errcode & 0xff)) return error;
  const explained = new Error('Observer database is locked by another connection. Only one Observer can use this database at a time. Stop the other Observer instance or close external SQLite tools/scripts, then restart. Stop Observer before using external database tools. Locks release automatically when the owning process exits.', { cause: error });
  explained.code = 'OBSERVER_DATABASE_IN_USE';
  return explained;
}

const validateBotInteraction = compileSchema(botInteractionSchema);
const validateBotUsageFilters = compileSchema(botUsageFiltersSchema);
const validateBotUsageRange = compileSchema(botUsageRangeSchema);
const validateBotUsagePage = compileSchema(botUsagePageSchema);
const validateAdvert = compileSchema(verifiedAdvertSchema);
const validateAdvertRange = compileSchema(advertRangeSchema);
const validateAdvertPage = compileSchema(advertPageSchema);
const validateDirectHeardQuery = compileSchema(directHeardQuerySchema);
const validateFingerprintPrune = compileSchema(fingerprintPruneSchema);

function assertAdvertQuery(validate, query) {
  if (!validate(query)) {
    throw new Error(`Invalid advert query: ${formatErrors(validate.errors)}`);
  }
  if (query.start !== undefined && query.start > query.end) {
    throw new Error('Invalid advert query: start must not exceed end');
  }
}

function assertBotQuery(validate, query) {
  if (!validate(query)) {
    throw new Error(`Invalid bot reporting query: ${formatErrors(validate.errors)}`);
  }
  if (query.start !== undefined && query.start > query.end) {
    throw new Error('Invalid bot reporting query: start must not exceed end');
  }
}

// Fixed SQL and bound values only. Exact sender spelling is intentional;
// unknown legacy names remain NULL, never an invented display label.
const BOT_FILTER_SQL = `
  (? IS NULL OR bot_name = ? COLLATE BINARY)
  AND (? IS NULL OR channel = ? COLLATE BINARY)
  AND (? IS NULL OR trigger = ? COLLATE BINARY)
  AND (? IS NULL OR sender = ? COLLATE BINARY)
`;

function botFilterValues({ botName, channel, trigger, sender }) {
  return [botName, channel, trigger, sender].flatMap((value) => [value ?? null, value ?? null]);
}

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
  },
  {
    // Replaces lookup-specific reply columns with one versioned, validated
    // command context. The lifecycle/metrics columns and row IDs remain
    // unchanged, so dashboards and reply history keep their existing shape.
    // Existing rows are converted in place: lookup markers take precedence,
    // query-only rows represent stats, and rows with neither marker use the
    // empty exact-command context. This migration is transactional through
    // #runMigrations(), including the user_version update.
    version: 8,
    statements: [
      `CREATE TABLE bot_replies_new (
        id                  INTEGER PRIMARY KEY,
        bot_name            TEXT NOT NULL,
        channel             TEXT,
        trigger             TEXT NOT NULL,
        sender              TEXT,
        hop_count           INTEGER,
        path                TEXT,
        hash                TEXT,
        handler_state_json  TEXT NOT NULL CHECK (json_valid(handler_state_json)),
        enqueued_at         INTEGER,
        expires_at          INTEGER,
        status              TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'expired', 'cancelled')),
        resolved_at         INTEGER,
        queued_ms           INTEGER
      )`,
      `INSERT INTO bot_replies_new (
         id, bot_name, channel, trigger, sender, hop_count, path, hash,
         handler_state_json, enqueued_at, expires_at, status, resolved_at, queued_ms
       )
       SELECT id, bot_name, channel, trigger, sender, hop_count, path, hash,
         CASE
           WHEN lookup_outcome IS NOT NULL THEN json_object(
             'kind', 'lookup', 'version', 1,
             'data', json_object(
               'query', COALESCE(query, ''), 'outcome', lookup_outcome,
               'name', name, 'matchCount', match_count, 'lastHeardAt', last_heard_at,
               'nodePrefix', node_prefix, 'repeaterCount', repeater_count
             )
           )
           WHEN query IS NOT NULL THEN json_object(
             'kind', 'stats', 'version', 1,
             'data', json_object('query', query)
           )
           ELSE json_object('kind', 'exact', 'version', 1, 'data', json_object())
         END,
         enqueued_at, expires_at, status, resolved_at, queued_ms
       FROM bot_replies`,
      'DROP TABLE bot_replies',
      'ALTER TABLE bot_replies_new RENAME TO bot_replies',
      'CREATE INDEX idx_bot_replies_status_enqueued ON bot_replies(status, enqueued_at)',
      'CREATE INDEX idx_bot_replies_status_resolved ON bot_replies(status, resolved_at)',
      'CREATE INDEX idx_bot_replies_bot_status_resolved ON bot_replies(bot_name, status, resolved_at)'
    ]
  },
  {
    // Keep the existing interaction and its IDs, adding attribution evidence
    // without a parallel event table. AUTOINCREMENT prevents a pruned highest
    // ID from later identifying a different interaction in this database.
    version: 9,
    statements: [
      `CREATE TABLE bot_replies_new (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_name                TEXT NOT NULL,
        channel                 TEXT,
        trigger                 TEXT NOT NULL,
        sender                  TEXT,
        hop_count               INTEGER,
        path                    TEXT,
        hash                    TEXT,
        handler_state_json      TEXT NOT NULL CHECK (json_valid(handler_state_json)),
        enqueued_at             INTEGER,
        expires_at              INTEGER,
        status                  TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'expired', 'cancelled')),
        resolved_at             INTEGER,
        queued_ms               INTEGER,
        sender_identifier       TEXT,
        sender_identifier_kind  TEXT,
        sender_identifier_source TEXT,
        CHECK (
          (sender_identifier IS NULL AND sender_identifier_kind IS NULL AND sender_identifier_source IS NULL)
          OR (sender_identifier IS NOT NULL AND sender_identifier_kind IS NOT NULL AND sender_identifier_source IS NOT NULL)
        )
      )`,
      `INSERT INTO bot_replies_new (
        id, bot_name, channel, trigger, sender, hop_count, path, hash,
        handler_state_json, enqueued_at, expires_at, status, resolved_at, queued_ms
      ) SELECT id, bot_name, channel, trigger, sender, hop_count, path, hash,
        handler_state_json, enqueued_at, expires_at, status, resolved_at, queued_ms
        FROM bot_replies`,
      'DROP TABLE bot_replies',
      'ALTER TABLE bot_replies_new RENAME TO bot_replies',
      'CREATE INDEX idx_bot_replies_status_enqueued ON bot_replies(status, enqueued_at)',
      'CREATE INDEX idx_bot_replies_status_resolved ON bot_replies(status, resolved_at)',
      'CREATE INDEX idx_bot_replies_bot_status_resolved ON bot_replies(bot_name, status, resolved_at)',
      'CREATE INDEX idx_bot_replies_accepted ON bot_replies(enqueued_at, bot_name) WHERE enqueued_at IS NOT NULL'
    ]
  },
  {
    version: 10,
    statements: [
      `CREATE TABLE nodes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_key_hex TEXT NOT NULL UNIQUE,
        name TEXT, type TEXT,
        first_heard_at INTEGER NOT NULL, last_heard_at INTEGER NOT NULL,
        name_heard_at INTEGER, name_digest TEXT,
        type_heard_at INTEGER, type_digest TEXT,
        discovery_digest BLOB,
        last_direct_heard_at INTEGER
      )`,
      `INSERT INTO nodes_new (public_key_hex,name,type,first_heard_at,last_heard_at,name_heard_at,type_heard_at)
        SELECT public_key_hex,name,type,first_heard_at,last_heard_at,
          CASE WHEN name IS NOT NULL THEN last_heard_at END,
          CASE WHEN type IS NOT NULL THEN last_heard_at END FROM nodes`,
      'DROP TABLE nodes',
      'ALTER TABLE nodes_new RENAME TO nodes',
      'CREATE INDEX idx_nodes_first_heard_at ON nodes(first_heard_at)',
      'CREATE INDEX idx_nodes_last_heard_at ON nodes(last_heard_at)',
      `CREATE TABLE advert_fingerprints (
        digest BLOB PRIMARY KEY CHECK(length(digest)=32),
        node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE
      ) WITHOUT ROWID`,
      `CREATE TABLE advert_events (
        digest BLOB PRIMARY KEY CHECK(length(digest)=32),
        public_key_hex TEXT NOT NULL,
        received_at INTEGER NOT NULL, last_received_at INTEGER NOT NULL,
        name TEXT, type TEXT NOT NULL CHECK(type IN ('CHAT','REPEATER')),
        is_new INTEGER NOT NULL CHECK(is_new IN (0,1)),
        first_hops INTEGER NOT NULL, min_hops INTEGER NOT NULL
      ) WITHOUT ROWID`,
      'CREATE INDEX idx_advert_events_at ON advert_events(received_at)',
      'CREATE INDEX idx_advert_events_type_at ON advert_events(type,received_at)'
    ]
  },
  {
    version: 11,
    statements: [
      `CREATE TABLE observer_instance (id INTEGER PRIMARY KEY CHECK(id=1), instance_id TEXT NOT NULL UNIQUE)`,
      `CREATE TABLE observer_runs (
        id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES observer_instance(instance_id),
        started_at INTEGER NOT NULL, last_known_alive_at INTEGER NOT NULL,
        observed_duration_ms INTEGER NOT NULL CHECK(observed_duration_ms>=0),
        ended_at INTEGER, end_reason TEXT, state TEXT NOT NULL CHECK(state IN ('running','clean','unclean')),
        wall_time_anomaly INTEGER NOT NULL CHECK(wall_time_anomaly IN (0,1)),
        app_version TEXT NOT NULL, node_version TEXT NOT NULL, platform TEXT NOT NULL, architecture TEXT NOT NULL,
        CHECK((state='clean' AND ended_at IS NOT NULL AND end_reason IN ('SIGINT','SIGTERM'))
          OR (state IN ('running','unclean') AND ended_at IS NULL AND end_reason IS NULL))
      )`,
      'CREATE INDEX idx_observer_runs_started ON observer_runs(started_at)',
      'CREATE INDEX idx_observer_runs_state_end ON observer_runs(state,ended_at,last_known_alive_at)',
      "CREATE UNIQUE INDEX idx_observer_runs_active ON observer_runs(state) WHERE state='running'"
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
  handler_state_json AS handlerStateJson,
  sender_identifier AS senderIdentifier, sender_identifier_kind AS senderIdentifierKind,
  sender_identifier_source AS senderIdentifierSource,
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
  #activeRunId = null;
  #ownsRuns = false;
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

    try {
      this.#db = new DatabaseSync(dbPath);
      this.#db.exec('PRAGMA journal_mode = WAL');
      this.#db.exec('PRAGMA foreign_keys = ON');
      this.#runMigrations();
    } catch (error) {
      this.#db?.close();
      throw explainDatabaseLock(error);
    }

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
      INSERT INTO nodes (public_key_hex, name, type, first_heard_at, last_heard_at, name_heard_at, type_heard_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(public_key_hex) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        last_heard_at = excluded.last_heard_at,
        name_heard_at = excluded.name_heard_at,
        type_heard_at = excluded.type_heard_at
    `);
    this.#insertBotReplyStmt = this.#db.prepare(`
      INSERT INTO bot_replies (
        bot_name, channel, trigger, sender, hop_count, path, hash,
        handler_state_json,
        enqueued_at, expires_at, status,
        sender_identifier, sender_identifier_kind, sender_identifier_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
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

  /** Exclusive connection ownership survives commits and releases automatically
   * when the process/store closes. No guessed lease or host identity is involved. */
  #acquireRunOwnership() {
    if (this.#ownsRuns) return;
    try {
      this.#db.exec('PRAGMA busy_timeout=0');
      this.#db.exec('PRAGMA locking_mode=EXCLUSIVE');
      this.#db.exec('BEGIN EXCLUSIVE');
      this.#db.exec('COMMIT');
      this.#ownsRuns = true;
    } catch (error) {
      this.#db.exec('PRAGMA locking_mode=NORMAL');
      const explained = explainDatabaseLock(error);
      if (explained !== error) throw explained;
      throw new Error('Cannot acquire exclusive Observer database ownership; stop other database users before starting', { cause: error });
    }
  }

  /** Recover unknown prior endings and start one run atomically, before services. */
  beginObserverRun(input) {
    assertRunInput(validateRunStart, input);
    if (this.#activeRunId !== null) {
      if (this.#activeRunId === input.runId) return this.getObserverRun({ runId: input.runId });
      throw new Error('This store already owns an Observer run');
    }
    this.#acquireRunOwnership();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      let instance = this.#db.prepare('SELECT instance_id FROM observer_instance WHERE id=1').get();
      if (!instance) {
        instance = { instance_id: randomUUID() };
        this.#db.prepare('INSERT INTO observer_instance(id,instance_id) VALUES(1,?)').run(instance.instance_id);
      }
      this.#db.exec("UPDATE observer_runs SET state='unclean' WHERE state='running'");
      this.#db.prepare(`INSERT INTO observer_runs
        (id,instance_id,started_at,last_known_alive_at,observed_duration_ms,state,wall_time_anomaly,
         app_version,node_version,platform,architecture) VALUES(?,?,?,?,?,'running',?,?,?,?,?)
      `).run(input.runId, instance.instance_id, input.startedAt, input.observedAt, input.observedDurationMs,
        wallTimeAnomaly(input.startedAt, input.startedAt, input) ? 1 : 0,
        input.appVersion, input.nodeVersion, input.platform, input.architecture);
      this.#db.exec('COMMIT');
      this.#activeRunId = input.runId;
      return this.getObserverRun({ runId: input.runId });
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  checkpointObserverRun(input) {
    assertRunInput(validateRunCheckpoint, input);
    if (input.runId !== this.#activeRunId) return false;
    const previous = this.getObserverRun({ runId: input.runId });
    if (!previous || previous.state !== 'running' || input.observedDurationMs <= previous.observedDurationMs) return false;
    const result = this.#db.prepare(`UPDATE observer_runs SET last_known_alive_at=?,observed_duration_ms=?,
      wall_time_anomaly=MAX(wall_time_anomaly,?) WHERE id=? AND state='running'
    `).run(input.observedAt, input.observedDurationMs,
      wallTimeAnomaly(previous.startedAt, previous.lastKnownAliveAt, input) ? 1 : 0, input.runId);
    return Number(result.changes) === 1;
  }

  endObserverRun(input) {
    assertRunInput(validateRunEnd, input);
    if (input.runId !== this.#activeRunId) return false;
    const previous = this.getObserverRun({ runId: input.runId });
    if (!previous || previous.state !== 'running' || input.observedDurationMs < previous.observedDurationMs) return false;
    const result = this.#db.prepare(`UPDATE observer_runs SET state='clean',last_known_alive_at=?,
      observed_duration_ms=?,ended_at=?,end_reason=?,wall_time_anomaly=MAX(wall_time_anomaly,?)
      WHERE id=? AND state='running'
    `).run(input.observedAt, input.observedDurationMs, input.observedAt, input.reason,
      wallTimeAnomaly(previous.startedAt, previous.lastKnownAliveAt, input) ? 1 : 0, input.runId);
    return Number(result.changes) === 1;
  }

  getObserverRun(input) {
    assertRunInput(validateRunIdentity, input);
    return mapRun(this.#db.prepare(`SELECT ${RUN_COLUMNS} FROM observer_runs WHERE id=?`).get(input.runId));
  }

  /** Pages select bootstrap starts, never prorated duration over uncertain wall intervals. */
  queryObserverRuns(input) {
    const page = { limit: 100, offset: 0, ...input };
    assertRunInput(validateRunPage, page);
    const where = 'WHERE started_at>=? AND started_at<? AND (? IS NULL OR state=?)';
    const args = [page.start, page.end, page.state ?? null, page.state ?? null];
    const { total } = this.#db.prepare(`SELECT COUNT(*) AS total FROM observer_runs ${where}`).get(...args);
    return { total: Number(total), runs: this.#db.prepare(`SELECT ${RUN_COLUMNS} FROM observer_runs ${where}
      ORDER BY started_at DESC,id LIMIT ? OFFSET ?`).all(...args,page.limit,page.offset).map(mapRun) };
  }

  queryObserverRuntimeSummary() {
    const row = this.#db.prepare(`SELECT COUNT(*) AS runs,COALESCE(SUM(observed_duration_ms),0) AS observedDurationMs,
      MIN(started_at) AS earliestRunStartedAt,COALESCE(SUM(state='clean'),0) AS cleanRuns,
      COALESCE(SUM(state='unclean'),0) AS uncleanRuns,COALESCE(SUM(state='running'),0) AS runningRuns,
      COALESCE(MAX(wall_time_anomaly),0) AS wallTimeAnomaly FROM observer_runs`).get();
    const instance = this.#db.prepare('SELECT instance_id AS instanceId FROM observer_instance WHERE id=1').get();
    return { ...row, instanceId: instance?.instanceId ?? null,
      wallTimeAnomaly: Boolean(row.wallTimeAnomaly), durationIsLowerBound: row.uncleanRuns + row.runningRuns > 0,
      retainedHistoryOnly: true };
  }

  /** Protect actual retained FK children, including future #25 datasets. Names
   * come from SQLite schema metadata and are quoted as identifiers, never values. */
  #pruneEndedRuns(cutoffMs) {
    const references = this.#db.prepare(`SELECT m.name AS tableName,f."from" AS columnName
      FROM sqlite_schema AS m JOIN pragma_foreign_key_list(m.name) AS f
      WHERE m.type='table' AND f."table"='observer_runs' AND (f."to"='id' OR f."to" IS NULL)`).all();
    const quoteIdentifier = (name) => '"' + name.replaceAll('"', '""') + '"';
    const guards = references.map((ref) => `AND NOT EXISTS(SELECT 1 FROM ${quoteIdentifier(ref.tableName)} AS child
      WHERE child.${quoteIdentifier(ref.columnName)}=observer_runs.id)`).join(' ');
    this.#db.prepare(`DELETE FROM observer_runs WHERE
      ((state='clean' AND ended_at<?) OR (state='unclean' AND last_known_alive_at<?)) ${guards}`).run(cutoffMs, cutoffMs);
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
   * Total received/decoded packet volume over [start, end) - the same
   * per-interval-delta samples queryPacketTypeTotals() sums from, just
   * without the per-type breakdown. Backs the !stats bot command (see
   * StatsReporter) rather than any dashboard chart.
   *
   * @param {{start: number, end: number}} options
   * @returns {{received: number, decoded: number}}
   */
  queryPacketTotals({ start, end }) {
    const row = this.#db
      .prepare('SELECT SUM(packets_received) AS received, SUM(packets_decoded) AS decoded FROM metrics_samples WHERE sample_at >= ? AND sample_at < ?')
      .get(start, end);
    return { received: Number(row.received ?? 0), decoded: Number(row.decoded ?? 0) };
  }

  /**
   * Distinct count of nodes with any recorded activity in [start, end) -
   * either first heard or (re-)heard in the window. Deliberately not
   * `queryNodeTotals()`'s `added + updated`: a node that is both newly
   * discovered *and* re-heard again later in the same window would count
   * twice under that sum (worse, for `all` this double-counts almost every
   * repeater ever heard more than once). This query counts each such node
   * once via OR rather than summing two separate conditions.
   *
   * @param {{start: number, end: number, type?: string}} options
   * @returns {number}
   */
  countActiveNodesInRange({ start, end, type = '' }) {
    const { total } = this.#db
      .prepare(
        `
        SELECT COUNT(*) AS total
        FROM nodes
        WHERE (? = '' OR type = ?)
          AND (
            (first_heard_at >= ? AND first_heard_at < ?)
            OR (last_heard_at >= ? AND last_heard_at < ?)
          )
      `
      )
      .get(type, type, start, end, start, end);
    return Number(total);
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

  /** Earliest retained, known acceptance; independent of packet sample coverage. */
  getEarliestBotAcceptanceAt(filters = {}) {
    assertBotQuery(validateBotUsageFilters, filters);
    const row = this.#db.prepare(`SELECT MIN(enqueued_at) AS earliest FROM bot_replies WHERE ${BOT_FILTER_SQL}`)
      .get(...botFilterValues(filters));
    return toNumberOrNull(row.earliest);
  }

  /**
   * Accepted usage over [start, end). Unknown acceptance is retained-history
   * metadata, not assigned to this range. Names are exact labels, not people.
   */
  queryBotUsageTotals(query) {
    assertBotQuery(validateBotUsageRange, query);
    const values = botFilterValues(query);
    const row = this.#db.prepare(`
      SELECT COUNT(*) AS accepted, COUNT(DISTINCT sender COLLATE BINARY) AS distinctSenderNames,
        COALESCE(SUM(sender IS NULL), 0) AS unknownSenderAccepted
      FROM bot_replies WHERE enqueued_at >= ? AND enqueued_at < ? AND ${BOT_FILTER_SQL}
    `).get(query.start, query.end, ...values);
    const coverage = this.#db.prepare(`
      SELECT MIN(enqueued_at) AS earliestAcceptanceAt,
        COALESCE(SUM(enqueued_at IS NULL), 0) AS retainedUnknownAcceptance
      FROM bot_replies WHERE ${BOT_FILTER_SQL}
    `).get(...values);
    return {
      accepted: Number(row.accepted), distinctSenderNames: Number(row.distinctSenderNames),
      unknownSenderAccepted: Number(row.unknownSenderAccepted),
      retainedUnknownAcceptance: Number(coverage.retainedUnknownAcceptance),
      earliestAcceptanceAt: toNumberOrNull(coverage.earliestAcceptanceAt)
    };
  }

  /** Bounded exact-name/command/bot/channel groups for accepted usage. */
  queryBotUsageGroups(query) {
    const page = { limit: 100, offset: 0, ...query };
    assertBotQuery(validateBotUsagePage, page);
    const where = `WHERE enqueued_at >= ? AND enqueued_at < ? AND ${BOT_FILTER_SQL}`;
    const values = [page.start, page.end, ...botFilterValues(page)];
    const group = 'GROUP BY bot_name COLLATE BINARY, channel COLLATE BINARY, trigger COLLATE BINARY, sender COLLATE BINARY';
    const { total } = this.#db.prepare(`SELECT COUNT(*) AS total FROM (SELECT 1 FROM bot_replies ${where} ${group})`).get(...values);
    const rows = this.#db.prepare(`
      SELECT bot_name AS botName, channel, trigger, sender, COUNT(*) AS count
      FROM bot_replies ${where} ${group}
      ORDER BY count DESC, bot_name COLLATE BINARY, channel COLLATE BINARY, trigger COLLATE BINARY, sender COLLATE BINARY
      LIMIT ? OFFSET ?
    `).all(...values, page.limit, page.offset);
    return { total: Number(total), groups: rows.map((row) => ({ ...row, count: Number(row.count) })) };
  }

  /** Bounded sender-name totals, with null representing unavailable evidence. */
  queryBotSenderCounts(query) {
    const page = { limit: 100, offset: 0, ...query };
    assertBotQuery(validateBotUsagePage, page);
    const where = `WHERE enqueued_at >= ? AND enqueued_at < ? AND ${BOT_FILTER_SQL}`;
    const values = [page.start, page.end, ...botFilterValues(page)];
    const { total } = this.#db.prepare(`SELECT COUNT(*) AS total FROM (
      SELECT 1 FROM bot_replies ${where} GROUP BY sender COLLATE BINARY
    )`).get(...values);
    const rows = this.#db.prepare(`SELECT sender, COUNT(*) AS count FROM bot_replies ${where}
      GROUP BY sender COLLATE BINARY ORDER BY count DESC, sender COLLATE BINARY LIMIT ? OFFSET ?
    `).all(...values, page.limit, page.offset);
    return { total: Number(total), senders: rows.map((row) => ({ ...row, count: Number(row.count) })) };
  }

  /** Bounded outcomes by completion time, including sent/failed/expired/cancelled. */
  queryBotOutcomeGroups(query) {
    const page = { limit: 100, offset: 0, ...query };
    assertBotQuery(validateBotUsagePage, page);
    const where = `WHERE status != 'pending' AND resolved_at >= ? AND resolved_at < ? AND ${BOT_FILTER_SQL}`;
    const values = [page.start, page.end, ...botFilterValues(page)];
    const group = 'GROUP BY bot_name COLLATE BINARY, channel COLLATE BINARY, trigger COLLATE BINARY, sender COLLATE BINARY, status';
    const { total } = this.#db.prepare(`SELECT COUNT(*) AS total FROM (SELECT 1 FROM bot_replies ${where} ${group})`).get(...values);
    const rows = this.#db.prepare(`
      SELECT bot_name AS botName, channel, trigger, sender, status AS outcome, COUNT(*) AS count
      FROM bot_replies ${where} ${group}
      ORDER BY count DESC, bot_name COLLATE BINARY, channel COLLATE BINARY, trigger COLLATE BINARY, sender COLLATE BINARY, status
      LIMIT ? OFFSET ?
    `).all(...values, page.limit, page.offset);
    return { total: Number(total), groups: rows.map((row) => ({ ...row, count: Number(row.count) })) };
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
   * Legacy inventory-only seam. Live verified receptions use
   * recordVerifiedAdvert; this method does not manufacture history or
   * qualifying direct evidence. `heardAt` becomes
   * `first_heard_at` only on the first call for a given `publicKeyHex`
   * (a later call never moves it); `last_heard_at` is refreshed every time.
   *
   * @param {{publicKeyHex: string, name: string, type: string|null, heardAt: number}} node
   */
  upsertNode({ publicKeyHex, name, type, heardAt }) {
    this.#upsertNodeStmt.run(publicKeyHex, name, type ?? null, heardAt, heardAt,
      name === null ? null : heardAt, type == null ? null : heardAt);
  }

  /** Atomic verified-reception write. Caller verifies authenticity; AJV guards the DTO. */
  recordVerifiedAdvert(observation) {
    if (!validateAdvert(observation)) throw new Error(`Invalid verified advert: ${formatErrors(validateAdvert.errors)}`);
    const { publicKeyHex, eventDigest, name, type, receivedAt, hopCount } = observation;
    const digest = Buffer.from(eventDigest, 'hex');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.#db.prepare('SELECT * FROM nodes WHERE public_key_hex=?').get(publicKeyHex);
      const earlierDiscovery = previous?.discovery_digest != null &&
        (receivedAt < previous.first_heard_at || (receivedAt === previous.first_heard_at &&
          Buffer.compare(digest, previous.discovery_digest) < 0));
      const isNew = !previous || earlierDiscovery ||
        (previous.discovery_digest != null && Buffer.compare(digest, previous.discovery_digest) === 0);
      const chooseName = name !== null && (!previous || previous.name_heard_at === null ||
        receivedAt > previous.name_heard_at || (receivedAt === previous.name_heard_at && eventDigest > (previous.name_digest ?? '')));
      const chooseType = type !== null && (!previous || previous.type_heard_at === null ||
        receivedAt > previous.type_heard_at || (receivedAt === previous.type_heard_at && eventDigest > (previous.type_digest ?? '')));
      const directAt = type === 'REPEATER' && hopCount === 0
        ? Math.max(receivedAt, previous?.last_direct_heard_at ?? 0) : previous?.last_direct_heard_at ?? null;
      this.#db.prepare(`INSERT INTO nodes (public_key_hex,name,type,first_heard_at,last_heard_at,
        name_heard_at,name_digest,type_heard_at,type_digest,discovery_digest,last_direct_heard_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(public_key_hex) DO UPDATE SET
        name=excluded.name,type=excluded.type,first_heard_at=excluded.first_heard_at,last_heard_at=excluded.last_heard_at,
        name_heard_at=excluded.name_heard_at,name_digest=excluded.name_digest,
        type_heard_at=excluded.type_heard_at,type_digest=excluded.type_digest,
        discovery_digest=excluded.discovery_digest,last_direct_heard_at=excluded.last_direct_heard_at
      `).run(publicKeyHex, chooseName ? name : previous?.name ?? null, chooseType ? type : previous?.type ?? null,
        Math.min(receivedAt, previous?.first_heard_at ?? receivedAt), Math.max(receivedAt, previous?.last_heard_at ?? receivedAt),
        chooseName ? receivedAt : previous?.name_heard_at ?? null, chooseName ? eventDigest : previous?.name_digest ?? null,
        chooseType ? receivedAt : previous?.type_heard_at ?? null, chooseType ? eventDigest : previous?.type_digest ?? null,
        !previous || earlierDiscovery ? digest : previous.discovery_digest, directAt);
      const { id } = this.#db.prepare('SELECT id FROM nodes WHERE public_key_hex=?').get(publicKeyHex);
      let eventRecorded = false;
      if (type === 'CHAT' || type === 'REPEATER') {
        const inserted = this.#db.prepare('INSERT OR IGNORE INTO advert_fingerprints(digest,node_id) VALUES (?,?)').run(digest, id);
        const newFingerprint = Number(inserted.changes) === 1;
        if (earlierDiscovery) {
          this.#db.prepare('UPDATE advert_events SET is_new=0 WHERE digest=?').run(previous.discovery_digest);
        }
        if (newFingerprint) {
          const eventInsert = this.#db.prepare(`INSERT INTO advert_events
            (digest,public_key_hex,received_at,last_received_at,name,type,is_new,first_hops,min_hops)
            VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(digest) DO NOTHING
          `).run(digest, publicKeyHex, receivedAt, receivedAt, name, type, isNew ? 1 : 0, hopCount, hopCount);
          eventRecorded = Number(eventInsert.changes) === 1;
        }
        // Reception evidence updates even when the advert identity is a duplicate.
        // Shared history pruning cannot recreate an event while its fingerprint
        // survives. Operator-enabled fingerprint cleanup deliberately bounds
        // that guarantee for inactive repeaters, preserving original discovery.
        this.#db.prepare(`UPDATE advert_events SET
          first_hops=CASE WHEN ? < received_at THEN ? ELSE first_hops END,
          received_at=MIN(received_at,?),last_received_at=MAX(last_received_at,?),min_hops=MIN(min_hops,?),
          is_new=CASE WHEN ? THEN 1 ELSE is_new END WHERE digest=?
        `).run(receivedAt, hopCount, receivedAt, receivedAt, hopCount, isNew ? 1 : 0, digest);
      } else if (earlierDiscovery) {
        this.#db.prepare('UPDATE advert_events SET is_new=0 WHERE digest=?').run(previous.discovery_digest);
      }
      this.#db.exec('COMMIT');
      return { eventRecorded, newlyDiscovered: !previous };
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  /** Direct evidence is reception based, independent of general last-heard or event retention. */
  queryDirectHeardEligibility(query) {
    assertAdvertQuery(validateDirectHeardQuery, query);
    const node = this.#db.prepare('SELECT type,last_direct_heard_at AS lastDirectHeardAt FROM nodes WHERE public_key_hex=?')
      .get(query.publicKeyHex);
    const lastDirectHeardAt = node?.lastDirectHeardAt ?? null;
    return { lastDirectHeardAt, eligible: node?.type === 'REPEATER' && lastDirectHeardAt !== null &&
      query.now >= lastDirectHeardAt && query.now - lastDirectHeardAt < query.windowMs };
  }

  /** Opt-in local cleanup. Preserve inventory, retained event identities and original discovery.
   * One DELETE is atomic; validation precedes all side effects. Cutoff equality is inactive. */
  pruneInactiveRepeaterFingerprints(query) {
    assertAdvertQuery(validateFingerprintPrune, query);
    const result = this.#db.prepare(`DELETE FROM advert_fingerprints AS f
      WHERE EXISTS (SELECT 1 FROM nodes AS n WHERE n.id=f.node_id
        AND n.type='REPEATER' AND n.last_heard_at<=?
        AND (n.discovery_digest IS NULL OR f.digest!=n.discovery_digest))
      AND NOT EXISTS (SELECT 1 FROM advert_events AS e WHERE e.digest=f.digest)
    `).run(query.cutoffMs);
    return Number(result.changes);
  }

  /** Half-open retained event counts. Companion is the library's CHAT type. */
  queryAdvertTotals(query) {
    assertAdvertQuery(validateAdvertRange, query);
    const row = this.#db.prepare(`SELECT COUNT(*) AS events,COUNT(DISTINCT public_key_hex) AS distinctNodes,
      COALESCE(SUM(is_new),0) AS newDiscoveries FROM advert_events
      WHERE received_at>=? AND received_at<? AND (? IS NULL OR type=?)
    `).get(query.start, query.end, query.type ?? null, query.type ?? null);
    const earliest = this.#db.prepare('SELECT MIN(received_at) AS at FROM advert_events WHERE (? IS NULL OR type=?)')
      .get(query.type ?? null, query.type ?? null);
    return { events: Number(row.events), distinctNodes: Number(row.distinctNodes),
      newDiscoveries: Number(row.newDiscoveries), rehears: Number(row.events - row.newDiscoveries), earliestEventAt: toNumberOrNull(earliest.at) };
  }

  /** Fixed two-type breakdown; each unique count uses that type's event snapshots. */
  queryAdvertTypeTotals(query) {
    assertAdvertQuery(validateAdvertRange, query);
    return ['CHAT', 'REPEATER'].filter((type) => query.type === undefined || query.type === type)
      .map((type) => ({ type, ...this.queryAdvertTotals({ ...query, type }) }));
  }

  /** Bounded full-key/type groups using event snapshots, independent of current inventory type. */
  queryAdvertNodeCounts(query) {
    const page = { limit: 100, offset: 0, ...query };
    assertAdvertQuery(validateAdvertPage, page);
    const where = 'WHERE received_at>=? AND received_at<? AND (? IS NULL OR type=?)';
    const args = [page.start, page.end, page.type ?? null, page.type ?? null];
    const { total } = this.#db.prepare(`SELECT COUNT(*) AS total FROM
      (SELECT 1 FROM advert_events ${where} GROUP BY public_key_hex,type)`).get(...args);
    const rows = this.#db.prepare(`SELECT public_key_hex AS publicKeyHex,type,COUNT(*) AS events,
      SUM(is_new) AS newDiscoveries,MIN(received_at) AS firstEventAt,MAX(received_at) AS lastEventAt
      FROM advert_events ${where} GROUP BY public_key_hex,type
      ORDER BY events DESC,type,public_key_hex LIMIT ? OFFSET ?`).all(...args,page.limit,page.offset);
    return { total: Number(total), nodes: rows.map((row) => ({ ...row, rehears: Number(row.events - row.newDiscoveries) })) };
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
   * @param {{botName: string, channel: string, trigger: string, sender: string, hopCount: number, path: string, hash: string, handlerStateJson?: string, enqueuedAt: number, expiresAt: number}} item
   */
  enqueueReplyItem(item) {
    const interaction = {
      ...item,
      handlerStateJson: item.handlerStateJson ?? '{"kind":"exact","version":1,"data":{}}',
      senderIdentifier: item.senderIdentifier ?? null,
      senderIdentifierKind: item.senderIdentifierKind ?? null,
      senderIdentifierSource: item.senderIdentifierSource ?? null
    };
    if (!validateBotInteraction(interaction)) {
      throw new Error(`Invalid bot interaction: ${formatErrors(validateBotInteraction.errors)}`);
    }
    const { lastInsertRowid } = this.#insertBotReplyStmt.run(
      interaction.botName,
      interaction.channel,
      interaction.trigger,
      interaction.sender,
      interaction.hopCount,
      interaction.path,
      interaction.hash,
      interaction.handlerStateJson,
      interaction.enqueuedAt,
      interaction.expiresAt,
      interaction.senderIdentifier,
      interaction.senderIdentifierKind,
      interaction.senderIdentifierSource
    );
    return Number(lastInsertRowid);
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

  /** Shared history retention: samples, completed replies, advert events and ended unreferenced runs.
   * Inventory, direct evidence, fingerprints, active runs and pending replies survive this cleanup. */
  pruneOlderThan(cutoffMs) {
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('DELETE FROM metrics_sample_packet_types WHERE sample_id IN (SELECT id FROM metrics_samples WHERE sample_at < ?)').run(cutoffMs);
      this.#db.prepare('DELETE FROM metrics_sample_broker_deliveries WHERE sample_id IN (SELECT id FROM metrics_samples WHERE sample_at < ?)').run(cutoffMs);
      this.#db.prepare('DELETE FROM metrics_samples WHERE sample_at < ?').run(cutoffMs);
      this.#db.prepare("DELETE FROM bot_replies WHERE status != 'pending' AND resolved_at < ?").run(cutoffMs);
      this.#db.prepare('DELETE FROM advert_events WHERE received_at < ?').run(cutoffMs);
      this.#pruneEndedRuns(cutoffMs);
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
