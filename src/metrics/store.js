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
  }
];

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
  #insertBotCommandStmt;

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
        sample_at, interval_ms, packets_received, packets_published,
        radio_connected, brokers_connected, brokers_total, bots_ready, bots_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#insertPacketTypeStmt = this.#db.prepare(`
      INSERT INTO metrics_sample_packet_types (sample_id, packet_type_bucket, count)
      VALUES (?, ?, ?)
    `);
    this.#insertBotCommandStmt = this.#db.prepare(`
      INSERT INTO bot_command_events (occurred_at, bot_name, trigger) VALUES (?, ?, ?)
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
   * child row per non-zero packet-type bucket, as a single transaction.
   *
   * @param {{sampleAt: number, intervalMs: number, packetsReceived: number, packetsPublished: number, radioConnected: boolean, brokersConnected: number, brokersTotal: number, botsReady: number, botsTotal: number, packetsByType: Record<string, number>}} sample
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
        sample.packetsPublished,
        sample.radioConnected ? 1 : 0,
        sample.brokersConnected,
        sample.brokersTotal,
        sample.botsReady,
        sample.botsTotal
      );
      const sampleId = Number(lastInsertRowid);

      for (const [bucket, count] of Object.entries(sample.packetsByType ?? {})) {
        if (count > 0) {
          this.#insertPacketTypeStmt.run(sampleId, bucket, count);
        }
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * @param {{botName: string, trigger: string, occurredAt: number}} event
   */
  recordBotCommand({ botName, trigger, occurredAt }) {
    this.#insertBotCommandStmt.run(occurredAt, botName, trigger);
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
   * @returns {{bucketStart: number, bucketWidthMs: number, packetsReceived: number, packetsPublished: number, countsByType: Record<string, number>}[]}
   */
  queryPacketHistory({ start, end, maxBuckets, sampleIntervalMs }) {
    const bucketWidthMs = resolveBucketWidthMs({ rangeMs: end - start, maxBuckets, sampleIntervalMs });

    // Two separate grouped queries rather than one join: summing
    // ms.packets_received through the packet-type join would multiply each
    // sample's received/published totals by however many distinct type
    // rows that sample has, over-counting them. Every bucket this totals
    // query produces is a superset of the per-type query's buckets (a
    // sample always has a row here even with zero decoded packet types),
    // so it's used as the canonical bucket set below.
    const totalsRows = this.#db
      .prepare(
        `
        SELECT
          CAST((ms.sample_at - ?) / ? AS INTEGER) AS bucket_idx,
          SUM(ms.packets_received) AS received,
          SUM(ms.packets_published) AS published
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
        packetsPublished: Number(row.published),
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
   * Per-trigger command counts for one bot over [start, end) - for that
   * bot's command pie chart and table.
   *
   * @param {{botName: string, start: number, end: number}} options
   * @returns {{trigger: string, count: number}[]}
   */
  queryBotCommandCounts({ botName, start, end }) {
    const rows = this.#db
      .prepare(
        `
        SELECT trigger, COUNT(*) AS total
        FROM bot_command_events
        WHERE bot_name = ? AND occurred_at >= ? AND occurred_at < ?
        GROUP BY trigger
        ORDER BY total DESC
      `
      )
      .all(botName, start, end);

    return rows.map((row) => ({ trigger: row.trigger, count: Number(row.total) }));
  }

  /** Deletes packet samples and bot command events at or before `cutoffMs`. */
  pruneOlderThan(cutoffMs) {
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('DELETE FROM metrics_sample_packet_types WHERE sample_id IN (SELECT id FROM metrics_samples WHERE sample_at < ?)').run(cutoffMs);
      this.#db.prepare('DELETE FROM metrics_samples WHERE sample_at < ?').run(cutoffMs);
      this.#db.prepare('DELETE FROM bot_command_events WHERE occurred_at < ?').run(cutoffMs);
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
