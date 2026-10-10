// Migration 16 is an immutable storage contract. No observations are inferred
// from older inventories, counters, logs or region data.
export const telemetryMigration = {
  version: 16,
  statements: [
    `CREATE TABLE telemetry_query_outcomes (
      request_id TEXT PRIMARY KEY CHECK(length(request_id)=36),
      run_id TEXT NOT NULL REFERENCES observer_runs(id),
      observer_public_key TEXT NOT NULL CHECK(length(observer_public_key)=64 AND observer_public_key NOT GLOB '*[^0-9A-F]*'),
      target_public_key TEXT NOT NULL CHECK(length(target_public_key)=64 AND target_public_key NOT GLOB '*[^0-9A-F]*'),
      component TEXT NOT NULL CHECK(component IN ('status','sensors','neighbours')),
      variant_key TEXT NOT NULL CHECK(length(variant_key) BETWEEN 1 AND 100),
      variant_json TEXT NOT NULL CHECK(json_valid(variant_json) AND json_type(variant_json)='object'
        AND json_type(variant_json,'$.params') IS 'object'
        AND json_extract(variant_json,'$.component') IS component),
      decoder_version INTEGER NOT NULL CHECK(decoder_version=1),
      started_at INTEGER NOT NULL CHECK(started_at BETWEEN 0 AND 9007199254740991),
      completed_at INTEGER NOT NULL CHECK(completed_at BETWEEN 0 AND 9007199254740991),
      received_at INTEGER CHECK(received_at BETWEEN 0 AND 9007199254740991),
      clock_anomaly INTEGER NOT NULL CHECK(clock_anomaly IN (0,1)),
      tag INTEGER CHECK(tag BETWEEN 0 AND 4294967295),route TEXT CHECK(route IN ('direct','flood')),
      status TEXT NOT NULL CHECK(status IN ('answered','partial','failed','unsupported')),reason TEXT,
      CHECK((status IN ('answered','partial') AND reason IS NULL AND received_at IS NOT NULL AND tag IS NOT NULL AND route IS NOT NULL)
        OR (status='failed' AND reason IS NOT NULL AND reason IN
          ('disconnected','stopped','command-error','ack-timeout','response-timeout','write-error',
           'protocol-error','retired-tag','route-mismatch','malformed-response'))
        OR (status='unsupported' AND reason IS NOT NULL AND reason IN ('unsupported','unsupported-layout','unsupported-profile'))),
      CHECK(clock_anomaly=1 OR (completed_at>=started_at AND
        (received_at IS NULL OR received_at BETWEEN started_at AND completed_at))),
      UNIQUE(request_id,observer_public_key,target_public_key,component,variant_key,status,received_at)
    )`,
    'CREATE INDEX idx_telemetry_outcomes_scope_at ON telemetry_query_outcomes(observer_public_key,target_public_key,component,variant_key,completed_at,request_id)',
    'CREATE INDEX idx_telemetry_outcomes_at ON telemetry_query_outcomes(completed_at,request_id)',
    'CREATE INDEX idx_telemetry_outcomes_run_at ON telemetry_query_outcomes(run_id,completed_at)',
    `CREATE TABLE telemetry_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,
      observer_public_key TEXT NOT NULL,target_public_key TEXT NOT NULL,component TEXT NOT NULL,variant_key TEXT NOT NULL,
      outcome_status TEXT NOT NULL CHECK(outcome_status IN ('answered','partial')),
      observed_at INTEGER NOT NULL CHECK(observed_at BETWEEN 0 AND 9007199254740991),
      quality TEXT NOT NULL CHECK(quality IN ('decoded','prefix-only','partial')),
      normalized_json TEXT NOT NULL CHECK(json_valid(normalized_json) AND json_type(normalized_json)='object'
        AND length(CAST(normalized_json AS BLOB))<=16384
        AND json_type(normalized_json,'$.observedAt') IS 'integer'
        AND json_extract(normalized_json,'$.observedAt') IS observed_at
        AND json_extract(normalized_json,'$.quality') IS quality
        AND json_extract(normalized_json,'$.variant.component') IS component
        AND json_extract(normalized_json,'$.decoderVersion') IS 1
        AND json_extract(normalized_json,'$.coverage') IS 'response-only'
        AND json_extract(normalized_json,'$.provenance') IS 'companion-tag-attributed'),
      latest_eligible INTEGER NOT NULL CHECK(latest_eligible IN (0,1)),
      observation_time_conflict INTEGER NOT NULL DEFAULT 0 CHECK(observation_time_conflict IN (0,1)),
      CHECK((outcome_status='answered' AND quality='decoded') OR (outcome_status='partial' AND quality IN ('prefix-only','partial'))),
      FOREIGN KEY(request_id,observer_public_key,target_public_key,component,variant_key,outcome_status,observed_at)
        REFERENCES telemetry_query_outcomes(request_id,observer_public_key,target_public_key,component,variant_key,status,received_at),
      UNIQUE(id,observer_public_key,target_public_key,component,variant_key,latest_eligible),
      UNIQUE(id,observer_public_key,target_public_key,component,variant_key,latest_eligible,quality)
    )`,
    'CREATE INDEX idx_telemetry_observations_scope_at ON telemetry_observations(observer_public_key,target_public_key,component,variant_key,observed_at,request_id)',
    'CREATE INDEX idx_telemetry_observations_at ON telemetry_observations(observed_at,id)',
    `CREATE TABLE telemetry_latest (
      observer_public_key TEXT NOT NULL,target_public_key TEXT NOT NULL,component TEXT NOT NULL,variant_key TEXT NOT NULL,
      observation_id INTEGER NOT NULL,decoded_observation_id INTEGER,
      latest_eligible INTEGER NOT NULL DEFAULT 1 CHECK(latest_eligible=1),
      decoded_quality TEXT NOT NULL DEFAULT 'decoded' CHECK(decoded_quality='decoded'),
      PRIMARY KEY(observer_public_key,target_public_key,component,variant_key),
      FOREIGN KEY(observation_id,observer_public_key,target_public_key,component,variant_key,latest_eligible)
        REFERENCES telemetry_observations(id,observer_public_key,target_public_key,component,variant_key,latest_eligible),
      FOREIGN KEY(decoded_observation_id,observer_public_key,target_public_key,component,variant_key,latest_eligible,decoded_quality)
        REFERENCES telemetry_observations(id,observer_public_key,target_public_key,component,variant_key,latest_eligible,quality)
    ) WITHOUT ROWID`,
    'CREATE INDEX idx_telemetry_latest_observation ON telemetry_latest(observation_id)',
    'CREATE INDEX idx_telemetry_latest_decoded ON telemetry_latest(decoded_observation_id)'
  ]
};
