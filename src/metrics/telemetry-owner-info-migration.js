import { TELEMETRY_OWNER_REASONS } from '../telemetry/telemetry-owner-schemas.js';

const stateReasons = [...TELEMETRY_OWNER_REASONS, 'ready', 'reserved', 'answered', 'partial', 'unsupported',
  'exhausted', 'retry', 'authenticated', 'auth-cooldown', 'orphaned'].map(value => `'${value}'`).join(',');
const ownerInfoOutcomes = `CREATE TABLE telemetry_query_outcomes_v21 (
  request_id TEXT PRIMARY KEY CHECK(length(request_id)=36),run_id TEXT NOT NULL REFERENCES observer_runs(id),
  observer_public_key TEXT NOT NULL CHECK(length(observer_public_key)=64 AND observer_public_key NOT GLOB '*[^0-9A-F]*'),
  target_public_key TEXT NOT NULL CHECK(length(target_public_key)=64 AND target_public_key NOT GLOB '*[^0-9A-F]*'),
  component TEXT NOT NULL CHECK(component IN ('owner-info','status','sensors','neighbours')),
  variant_key TEXT NOT NULL CHECK(length(variant_key) BETWEEN 1 AND 100),
  variant_json TEXT NOT NULL CHECK(json_valid(variant_json) AND json_type(variant_json)='object'
    AND json_type(variant_json,'$.params') IS 'object' AND json_extract(variant_json,'$.component') IS component),
  decoder_version INTEGER NOT NULL CHECK(decoder_version=1),
  started_at INTEGER NOT NULL CHECK(started_at BETWEEN 0 AND 9007199254740991),
  completed_at INTEGER NOT NULL CHECK(completed_at BETWEEN 0 AND 9007199254740991),
  received_at INTEGER CHECK(received_at BETWEEN 0 AND 9007199254740991),
  clock_anomaly INTEGER NOT NULL CHECK(clock_anomaly IN (0,1)),tag INTEGER CHECK(tag BETWEEN 0 AND 4294967295),
  route TEXT CHECK(route IN ('direct','flood')),status TEXT NOT NULL CHECK(status IN ('answered','partial','failed','unsupported')),reason TEXT,
  CHECK((status IN ('answered','partial') AND reason IS NULL AND received_at IS NOT NULL AND tag IS NOT NULL AND route IS NOT NULL)
    OR (status='failed' AND reason IS NOT NULL AND reason IN
      ('disconnected','stopped','command-error','ack-timeout','response-timeout','write-error','protocol-error','retired-tag','route-mismatch','malformed-response','trace-timeout','trace-malformed','trace-write-error','trace-login-not-dispatched'))
    OR (status='unsupported' AND reason IS NOT NULL AND reason IN ('unsupported','unsupported-layout','unsupported-profile'))),
  CHECK(clock_anomaly=1 OR (completed_at>=started_at AND (received_at IS NULL OR received_at BETWEEN started_at AND completed_at))),
  UNIQUE(request_id,observer_public_key,target_public_key,component,variant_key,status,received_at)
)`;
const pollReasons = `('guest-login','owner-info','status','sensors','neighbours')`;
const pollTable = `CREATE TABLE telemetry_poll_state_v21 (
  observer_public_key TEXT NOT NULL CHECK(length(observer_public_key)=64 AND observer_public_key NOT GLOB '*[^0-9A-F]*'),
  target_public_key TEXT NOT NULL CHECK(length(target_public_key)=64 AND target_public_key NOT GLOB '*[^0-9A-F]*'),
  component TEXT NOT NULL CHECK(component IN ${pollReasons}),variant_key TEXT NOT NULL CHECK(length(variant_key) BETWEEN 1 AND 100),
  variant_json TEXT NOT NULL CHECK(json_valid(variant_json) AND json_type(variant_json)='object' AND json_extract(variant_json,'$.component') IS component),
  next_due_at INTEGER NOT NULL CHECK(next_due_at BETWEEN 0 AND 9007199254740991),
  cycle_started_at INTEGER NOT NULL CHECK(cycle_started_at BETWEEN 0 AND 9007199254740991),
  cycle_attempts INTEGER NOT NULL CHECK(cycle_attempts BETWEEN 0 AND 10),last_policy_at INTEGER NOT NULL CHECK(last_policy_at BETWEEN 0 AND 9007199254740991),
  last_completed_at INTEGER CHECK(last_completed_at BETWEEN 0 AND 9007199254740991),
  request_id TEXT CHECK(request_id IS NULL OR length(request_id)=36),reserved_at INTEGER CHECK(reserved_at BETWEEN 0 AND 9007199254740991),
  run_id TEXT REFERENCES observer_runs(id),reason TEXT NOT NULL CHECK(reason IN (${stateReasons})),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND json_type(policy_json)='object'),
  server_timestamp INTEGER CHECK(server_timestamp BETWEEN 0 AND 4294967295),replay_run_id TEXT REFERENCES observer_runs(id),
  replay_request_id TEXT CHECK(replay_request_id IS NULL OR length(replay_request_id)=36),
  CHECK((request_id IS NULL AND reserved_at IS NULL AND run_id IS NULL) OR (request_id IS NOT NULL AND reserved_at IS NOT NULL AND run_id IS NOT NULL)),
  CHECK(component='guest-login' OR server_timestamp IS NULL),
  CHECK((server_timestamp IS NULL AND replay_run_id IS NULL AND replay_request_id IS NULL)
    OR (server_timestamp IS NOT NULL AND replay_run_id IS NOT NULL AND replay_request_id IS NOT NULL)),
  PRIMARY KEY(observer_public_key,target_public_key,component,variant_key)
) WITHOUT ROWID`;

export const telemetryOwnerInfoMigration = { version: 21, disableForeignKeysForRebuild: true, statements: [
  ownerInfoOutcomes,
  'INSERT INTO telemetry_query_outcomes_v21 SELECT * FROM telemetry_query_outcomes',
  'DROP TABLE telemetry_query_outcomes',
  'ALTER TABLE telemetry_query_outcomes_v21 RENAME TO telemetry_query_outcomes',
  'CREATE INDEX idx_telemetry_outcomes_scope_at ON telemetry_query_outcomes(observer_public_key,target_public_key,component,variant_key,completed_at,request_id)',
  'CREATE INDEX idx_telemetry_outcomes_at ON telemetry_query_outcomes(completed_at,request_id)',
  'CREATE INDEX idx_telemetry_outcomes_run_at ON telemetry_query_outcomes(run_id,completed_at)',
  pollTable,
  'INSERT INTO telemetry_poll_state_v21 SELECT * FROM telemetry_poll_state',
  'DROP TABLE telemetry_poll_state',
  'ALTER TABLE telemetry_poll_state_v21 RENAME TO telemetry_poll_state',
  'CREATE INDEX idx_telemetry_poll_due ON telemetry_poll_state(observer_public_key,next_due_at,target_public_key)',
  'CREATE INDEX idx_telemetry_poll_run ON telemetry_poll_state(run_id)',
  'CREATE INDEX idx_telemetry_poll_replay_run ON telemetry_poll_state(replay_run_id)',
  'CREATE INDEX idx_telemetry_poll_clock ON telemetry_poll_state(last_policy_at)',
  'CREATE UNIQUE INDEX idx_telemetry_poll_request ON telemetry_poll_state(request_id) WHERE request_id IS NOT NULL',
  `CREATE TABLE telemetry_request_diagnostics_v21 (
    request_id TEXT PRIMARY KEY CHECK(length(request_id)=36),run_id TEXT NOT NULL REFERENCES observer_runs(id),
    observer_public_key TEXT NOT NULL CHECK(length(observer_public_key)=64 AND observer_public_key NOT GLOB '*[^0-9A-F]*'),
    target_public_key TEXT NOT NULL CHECK(length(target_public_key)=64 AND target_public_key NOT GLOB '*[^0-9A-F]*'),
    operation TEXT NOT NULL CHECK(operation IN ('guest-login','owner-info','status','telemetry','neighbours')),
    started_at INTEGER NOT NULL CHECK(started_at BETWEEN 0 AND 9007199254740991),
    completed_at INTEGER NOT NULL CHECK(completed_at BETWEEN 0 AND 9007199254740991),
    clock_anomaly INTEGER NOT NULL CHECK(clock_anomaly IN (0,1)),
    status TEXT NOT NULL CHECK(status IN ('deferred','failed','unsupported','completed')),
    reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 64),
    diagnostic_json TEXT NOT NULL CHECK(json_valid(diagnostic_json) AND json_type(diagnostic_json)='object'
      AND length(CAST(diagnostic_json AS BLOB))<=4096
      AND json_extract(diagnostic_json,'$.requestId') IS request_id
      AND json_extract(diagnostic_json,'$.runId') IS run_id
      AND json_extract(diagnostic_json,'$.observerPublicKey') IS observer_public_key
      AND json_extract(diagnostic_json,'$.targetPublicKey') IS target_public_key
      AND json_extract(diagnostic_json,'$.operation') IS operation
      AND json_extract(diagnostic_json,'$.startedAt') IS started_at
      AND json_extract(diagnostic_json,'$.completedAt') IS completed_at
      AND json_extract(diagnostic_json,'$.clockAnomaly') IS (clock_anomaly=1)
      AND json_extract(diagnostic_json,'$.status') IS status AND json_extract(diagnostic_json,'$.reason') IS reason)
  )`,
  'INSERT INTO telemetry_request_diagnostics_v21 SELECT * FROM telemetry_request_diagnostics',
  'DROP TABLE telemetry_request_diagnostics',
  'ALTER TABLE telemetry_request_diagnostics_v21 RENAME TO telemetry_request_diagnostics',
  'CREATE INDEX idx_telemetry_diagnostics_time ON telemetry_request_diagnostics(completed_at DESC,request_id DESC)',
  'CREATE INDEX idx_telemetry_diagnostics_target_time ON telemetry_request_diagnostics(target_public_key,completed_at DESC,request_id DESC)'
] };
