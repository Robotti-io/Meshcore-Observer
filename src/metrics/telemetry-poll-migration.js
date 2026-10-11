import { TELEMETRY_OWNER_REASONS } from '../telemetry/telemetry-owner-schemas.js';
const reasons = TELEMETRY_OWNER_REASONS.map(reason => `'${reason}'`).join(',');
const stateReasons = [...TELEMETRY_OWNER_REASONS, 'ready', 'reserved', 'answered', 'partial', 'unsupported',
  'exhausted', 'retry', 'authenticated', 'auth-cooldown', 'orphaned'].map(reason => `'${reason}'`).join(',');
const key = name => `${name} TEXT NOT NULL CHECK(length(${name})=64 AND ${name} NOT GLOB '*[^0-9A-F]*')`;
const time = name => `${name} INTEGER NOT NULL CHECK(${name} BETWEEN 0 AND 9007199254740991)`;
// No existing inventory, telemetry result or login audit creates new authority.
export const telemetryPollMigration = { version: 17, statements: [
  `CREATE TABLE telemetry_direct_evidence (
    ${key('observer_public_key')},${key('target_public_key')},run_id TEXT NOT NULL REFERENCES observer_runs(id),
    ${time('received_at')},event_digest TEXT NOT NULL CHECK(length(event_digest)=64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
    provenance TEXT NOT NULL CHECK(provenance='verified-advert'),eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
    PRIMARY KEY(observer_public_key,target_public_key)) WITHOUT ROWID`,
  'CREATE INDEX idx_telemetry_direct_fresh ON telemetry_direct_evidence(observer_public_key,received_at,target_public_key)',
  'CREATE INDEX idx_telemetry_direct_run ON telemetry_direct_evidence(run_id)',
  `CREATE TABLE telemetry_auth_outcomes (
    request_id TEXT PRIMARY KEY CHECK(length(request_id)=36),run_id TEXT NOT NULL REFERENCES observer_runs(id),
    ${key('observer_public_key')},${key('target_public_key')},${time('dispatched_at')},${time('completed_at')},
    generation INTEGER NOT NULL CHECK(generation>0),status TEXT NOT NULL CHECK(status IN ('completed','failed')),
    reason TEXT CHECK(reason IN (${reasons})),route TEXT CHECK(route IN ('direct','flood')),clock_anomaly INTEGER NOT NULL CHECK(clock_anomaly IN (0,1)),
    record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=4096
      AND json_extract(record_json,'$.context.requestId') IS request_id
      AND json_extract(record_json,'$.context.observerPublicKey') IS observer_public_key
      AND json_extract(record_json,'$.context.targetPublicKey') IS target_public_key
      AND json_extract(record_json,'$.context.operation') IS 'guest-login'
      AND json_extract(record_json,'$.context.generation') IS generation
      AND json_extract(record_json,'$.dispatchedAt') IS dispatched_at AND json_extract(record_json,'$.completedAt') IS completed_at
      AND json_extract(record_json,'$.status') IS status AND json_extract(record_json,'$.reason') IS reason AND json_extract(record_json,'$.route') IS route),
    server_timestamp INTEGER CHECK(server_timestamp BETWEEN 0 AND 4294967295),
    CHECK(clock_anomaly=1 OR completed_at>=dispatched_at),
    CHECK((status='failed' AND reason IS NOT NULL) OR (status='completed' AND reason IS NULL AND route='direct'
      AND clock_anomaly=0 AND server_timestamp IS NOT NULL AND json_extract(record_json,'$.proof.status') IS 'guest-proof'
      AND json_extract(record_json,'$.proof.serverTimestamp') IS server_timestamp
      AND json_extract(record_json,'$.proof.permissions') IS 0 AND json_extract(record_json,'$.proof.isAdmin') IS 0
      AND json_extract(record_json,'$.proof.firmwareLevel') IS 2)))`,
  'CREATE INDEX idx_telemetry_auth_scope ON telemetry_auth_outcomes(observer_public_key,target_public_key,completed_at,request_id)',
  'CREATE INDEX idx_telemetry_auth_at ON telemetry_auth_outcomes(completed_at,request_id)',
  'CREATE INDEX idx_telemetry_auth_run ON telemetry_auth_outcomes(run_id)',
  `CREATE TABLE telemetry_poll_state (
    ${key('observer_public_key')},${key('target_public_key')},component TEXT NOT NULL CHECK(component IN ('guest-login','status','sensors','neighbours')),
    variant_key TEXT NOT NULL CHECK(length(variant_key) BETWEEN 1 AND 100),
    variant_json TEXT NOT NULL CHECK(json_valid(variant_json) AND json_type(variant_json)='object'
      AND json_extract(variant_json,'$.component') IS component),
    ${time('next_due_at')},${time('cycle_started_at')},cycle_attempts INTEGER NOT NULL CHECK(cycle_attempts BETWEEN 0 AND 10),
    ${time('last_policy_at')},last_completed_at INTEGER CHECK(last_completed_at BETWEEN 0 AND 9007199254740991),
    request_id TEXT CHECK(request_id IS NULL OR length(request_id)=36),
    reserved_at INTEGER CHECK(reserved_at BETWEEN 0 AND 9007199254740991),run_id TEXT REFERENCES observer_runs(id),
    reason TEXT NOT NULL CHECK(reason IN (${stateReasons})),policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND json_type(policy_json)='object'),
    server_timestamp INTEGER CHECK(server_timestamp BETWEEN 0 AND 4294967295),
    replay_run_id TEXT REFERENCES observer_runs(id),replay_request_id TEXT CHECK(replay_request_id IS NULL OR length(replay_request_id)=36),
    CHECK((request_id IS NULL AND reserved_at IS NULL AND run_id IS NULL) OR
      (request_id IS NOT NULL AND reserved_at IS NOT NULL AND run_id IS NOT NULL)),
    CHECK(component='guest-login' OR server_timestamp IS NULL),
    CHECK((server_timestamp IS NULL AND replay_run_id IS NULL AND replay_request_id IS NULL)
      OR (server_timestamp IS NOT NULL AND replay_run_id IS NOT NULL AND replay_request_id IS NOT NULL)),
    PRIMARY KEY(observer_public_key,target_public_key,component,variant_key)) WITHOUT ROWID`,
  'CREATE INDEX idx_telemetry_poll_due ON telemetry_poll_state(observer_public_key,next_due_at,target_public_key)',
  'CREATE INDEX idx_telemetry_poll_run ON telemetry_poll_state(run_id)',
  'CREATE INDEX idx_telemetry_poll_replay_run ON telemetry_poll_state(replay_run_id)',
  'CREATE INDEX idx_telemetry_poll_clock ON telemetry_poll_state(last_policy_at)',
  'CREATE UNIQUE INDEX idx_telemetry_poll_request ON telemetry_poll_state(request_id) WHERE request_id IS NOT NULL'
] };
