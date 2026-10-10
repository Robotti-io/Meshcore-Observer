// Migration 15 stores scheduling permission, never a durable RF replay queue.
const key = column => `length(${column})=64 AND ${column} NOT GLOB '*[^0-9A-F]*'`;
const epoch = column => `${column} BETWEEN 0 AND 9007199254740991`;
export const regionPollMigration = {
  version: 15,
  statements: [
    `CREATE TABLE region_poll_state (
      observer_public_key TEXT NOT NULL CHECK(${key('observer_public_key')}),
      target_public_key TEXT NOT NULL CHECK(${key('target_public_key')}),
      next_due_at INTEGER NOT NULL CHECK(${epoch('next_due_at')}),
      cycle_started_at INTEGER NOT NULL CHECK(${epoch('cycle_started_at')}),
      cycle_reservations INTEGER NOT NULL CHECK(cycle_reservations BETWEEN 0 AND 10),
      last_policy_at INTEGER NOT NULL CHECK(${epoch('last_policy_at')} AND last_policy_at>=cycle_started_at),
      last_reservation_id TEXT UNIQUE CHECK(last_reservation_id IS NULL OR (
        length(last_reservation_id)=36 AND length(replace(last_reservation_id,'-',''))=32
        AND last_reservation_id NOT GLOB '*[^0-9a-f-]*'
        AND substr(last_reservation_id,9,1)='-' AND substr(last_reservation_id,14,1)='-'
        AND substr(last_reservation_id,19,1)='-' AND substr(last_reservation_id,24,1)='-'
        AND substr(last_reservation_id,15,1)='4' AND substr(last_reservation_id,20,1) IN ('8','9','a','b'))),
      last_reservation_at INTEGER CHECK(${epoch('last_reservation_at')}),
      reservation_run_id TEXT REFERENCES observer_runs(id),
      last_reason TEXT NOT NULL CHECK(last_reason IN (
        'ready','seeded-success','seeded-failure','contact-missing','unsafe-route',
        'preflight-unsupported','preflight-failed','reserved','answered','retry','exhausted','unsupported','clock-anomaly')),
      PRIMARY KEY(observer_public_key,target_public_key),
      CHECK((last_reservation_id IS NULL AND last_reservation_at IS NULL AND reservation_run_id IS NULL AND cycle_reservations=0)
        OR (last_reservation_id IS NOT NULL AND last_reservation_at IS NOT NULL AND reservation_run_id IS NOT NULL
          AND last_policy_at>=last_reservation_at AND next_due_at>=last_reservation_at)),
      CHECK(last_reason NOT IN ('reserved','retry','exhausted','clock-anomaly')
        OR (cycle_reservations>0 AND last_reservation_id IS NOT NULL))
    ) WITHOUT ROWID`,
    'CREATE INDEX idx_region_poll_due ON region_poll_state(observer_public_key,next_due_at,target_public_key)',
    'CREATE INDEX idx_region_poll_policy_at ON region_poll_state(last_policy_at)',
    'CREATE INDEX idx_region_poll_reservation_run ON region_poll_state(reservation_run_id)',
    'CREATE INDEX idx_nodes_type_key ON nodes(type,public_key_hex)'
  ]
};
