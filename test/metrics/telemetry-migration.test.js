import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createTelemetryFixture, telemetryResult, telemetrySnapshot } from '../fixtures/telemetry-store.js';
import { dropTelemetrySchema } from '../fixtures/telemetry-downgrade.js';
import { dropRegionSchema } from '../fixtures/region-downgrade.js';
import { completion, reservation } from '../fixtures/region-poll.js';

const fixtures = [];
const fixture = () => { const f = createTelemetryFixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const legacy = db => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'telemetry_%' ORDER BY name")
  .all().map(({ name }) => [name, db.prepare('SELECT * FROM '+name).all().map(row => ({ ...row }))]);

test('migration 16 preserves v15 inventory/run/bot/region/polling and capture data without fabricating observations', () => {
  const f = fixture();
  f.store.recordVerifiedAdvert({ publicKeyHex: 'AB'.repeat(32), eventDigest: 'ab'.repeat(32), name: 'Fixture',
    type: 'REPEATER', receivedAt: 1000, hopCount: 0 });
  f.store.recordRegionResult(completion(reservation(f.run, 0), { csv: '*,Be' }).result);
  f.store.reserveRegionPoll(reservation(f.run, 1000));
  f.store.enqueueReplyItem({ botName: 'echo', channel: '#echo', trigger: '!echo', sender: 'Fixture', hopCount: 1,
    path: 'AB', hash: 'AB'.repeat(16), enqueuedAt: 1000, expiresAt: 5000 });
  f.store.requestFloodAdvert(1000);
  f.store.recordRuntimeEvent({ runId: f.run.runId, observedAt: 1000, kind: 'radio.connected', serviceId: null,
    state: 'connected', precision: 'event', observationWindowMs: null });
  f.store.recordPacketSample({ sampleAt: 1000, intervalMs: 1000, packetsReceived: 1, packetsDecoded: 1,
    radioConnected: true, brokersConnected: 0, brokersTotal: 0, botsReady: 1, botsTotal: 1, replyQueueSize: 1,
    packetsByType: { advert: 1 }, brokerDeliveries: {} });
  f.close();
  const prior = f.inspect(db => { db.exec(dropTelemetrySchema+' PRAGMA user_version=15;'); return legacy(db); });
  f.open(); f.close(); f.inspect(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 16);
    assert.deepEqual(legacy(db), prior);
    assert.ok(Object.values(telemetrySnapshot(db)).every(rows => rows.length === 0));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('sequential v13/v14 upgrades recreate later schemas atomically without interpreting old region data as telemetry', () => {
  for (const version of [13, 14]) {
    const f = fixture(); f.store.upsertNode({ publicKeyHex: 'AB'.repeat(32), name: 'Kept', type: 'REPEATER', heardAt: 1000 }); f.close();
    f.inspect(db => {
      if (version === 13) db.exec(dropRegionSchema);
      else db.exec(dropTelemetrySchema+' DROP TABLE region_poll_state; DROP INDEX idx_nodes_type_key;');
      db.exec(`PRAGMA user_version=${version}`);
    });
    f.open(); f.close(); f.inspect(db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 16);
      assert.equal(db.prepare('SELECT name FROM nodes').get().name, 'Kept');
      assert.ok(Object.values(telemetrySnapshot(db)).every(rows => rows.length === 0));
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
  }
});

test('fresh migration and repeated reopening are idempotent and preserve saved telemetry', () => {
  const f = fixture(); f.store.recordTelemetryResult(telemetryResult(f.run)); f.close();
  const prior = f.inspect(telemetrySnapshot);
  for (let n = 0; n < 3; n++) {
    f.open(); f.close(); f.inspect(db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 16); assert.deepEqual(telemetrySnapshot(db), prior);
    });
  }
});

test('a final-index failure rolls back all migration-16 tables/indexes and version, then startup retry succeeds', () => {
  const f = fixture(); f.store.upsertNode({ publicKeyHex: 'AB'.repeat(32), name: 'Kept', type: 'REPEATER', heardAt: 1 }); f.close();
  const prior = f.inspect(db => { db.exec(dropTelemetrySchema+' PRAGMA user_version=15; CREATE INDEX idx_telemetry_latest_decoded ON nodes(name);');
    return legacy(db); });
  assert.throws(() => f.open(), /idx_telemetry_latest_decoded/);
  f.inspect(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 15); assert.deepEqual(legacy(db), prior);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'telemetry_%'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'idx_telemetry_%' AND name!='idx_telemetry_latest_decoded'").get().n, 0);
    db.exec('DROP INDEX idx_telemetry_latest_decoded');
  });
  f.open(); f.close(); f.inspect(db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 16));
});

test('migration supplies indexes for scope/time/run queries and both protected latest pointers', () => {
  const f = fixture(); f.close(); f.inspect(db => {
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_telemetry_%'").all().map(row => row.name);
    assert.deepEqual(names.sort(), ['idx_telemetry_latest_decoded', 'idx_telemetry_latest_observation', 'idx_telemetry_observations_at',
      'idx_telemetry_observations_scope_at', 'idx_telemetry_outcomes_at', 'idx_telemetry_outcomes_run_at', 'idx_telemetry_outcomes_scope_at']);
    const references = db.prepare("SELECT * FROM pragma_foreign_key_list('telemetry_query_outcomes')").all();
    assert.ok(references.some(row => row.table === 'observer_runs' && row.from === 'run_id'));
  });
});
