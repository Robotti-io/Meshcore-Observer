// Migration 14 is a fixed storage contract. Later policy/schema additions
// require their own migration; never infer declarations from legacy inventory.
export const regionMigration = {
  version: 14,
  statements: [
    `CREATE TABLE region_query_outcomes (
      request_id TEXT PRIMARY KEY CHECK(length(request_id)=36),
      run_id TEXT NOT NULL REFERENCES observer_runs(id),
      observer_public_key TEXT NOT NULL CHECK(length(observer_public_key)=64 AND observer_public_key NOT GLOB '*[^0-9A-F]*'),
      target_public_key TEXT NOT NULL CHECK(length(target_public_key)=64 AND target_public_key NOT GLOB '*[^0-9A-F]*'),
      started_at INTEGER NOT NULL CHECK(started_at>=0),completed_at INTEGER NOT NULL CHECK(completed_at>=0),
      clock_anomaly INTEGER NOT NULL CHECK(clock_anomaly IN (0,1)),
      status TEXT NOT NULL CHECK(status IN ('answered','failed','unsupported')),reason TEXT,
      route TEXT CHECK(route IN ('direct','flood')),
      CHECK((status='answered' AND reason IS NULL AND route IS NOT NULL AND route='direct')
        OR (status='failed' AND reason IS NOT NULL AND reason IN
          ('eligibility-error','disconnected','stopped','command-error','ack-timeout','response-timeout',
           'write-error','protocol-error','retired-tag','route-mismatch','malformed-response'))
        OR (status='unsupported' AND reason IS NOT NULL AND reason IN ('unsupported','anonymous-adapter-unavailable'))),
      CHECK(clock_anomaly=1 OR completed_at>=started_at),
      UNIQUE(request_id,observer_public_key,target_public_key,status)
    )`,
    'CREATE INDEX idx_region_outcomes_scope_at ON region_query_outcomes(observer_public_key,target_public_key,completed_at,request_id)',
    'CREATE INDEX idx_region_outcomes_at ON region_query_outcomes(completed_at)',
    'CREATE INDEX idx_region_outcomes_run_at ON region_query_outcomes(run_id,completed_at)',
    `CREATE TABLE region_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,
      observer_public_key TEXT NOT NULL,target_public_key TEXT NOT NULL,
      outcome_status TEXT NOT NULL DEFAULT 'answered' CHECK(outcome_status='answered'),
      observed_at INTEGER NOT NULL CHECK(observed_at>=0),
      regions_json TEXT NOT NULL CHECK(json_valid(regions_json) AND json_type(regions_json)='array' AND json_array_length(regions_json)<=83),
      repeater_clock INTEGER CHECK(repeater_clock BETWEEN 0 AND 4294967295),
      body_bytes INTEGER NOT NULL CHECK(body_bytes BETWEEN 4 AND 170),
      csv_bytes INTEGER NOT NULL CHECK(csv_bytes BETWEEN 0 AND 166 AND body_bytes>=csv_bytes+4),
      parser_version INTEGER NOT NULL CHECK(parser_version=1),
      completeness TEXT NOT NULL CHECK(completeness='unknown'),
      provenance TEXT NOT NULL CHECK(provenance='companion-tag-attributed'),
      observation_time_conflict INTEGER NOT NULL DEFAULT 0 CHECK(observation_time_conflict IN (0,1)),
      FOREIGN KEY(request_id,observer_public_key,target_public_key,outcome_status)
        REFERENCES region_query_outcomes(request_id,observer_public_key,target_public_key,status),
      UNIQUE(id,observer_public_key,target_public_key)
    )`,
    'CREATE INDEX idx_region_answers_scope_at ON region_answers(observer_public_key,target_public_key,observed_at,id)',
    'CREATE INDEX idx_region_answers_at ON region_answers(observed_at)',
    `CREATE TABLE region_latest (
      observer_public_key TEXT NOT NULL,target_public_key TEXT NOT NULL,answer_id INTEGER NOT NULL,
      PRIMARY KEY(observer_public_key,target_public_key),
      FOREIGN KEY(answer_id,observer_public_key,target_public_key)
        REFERENCES region_answers(id,observer_public_key,target_public_key)
    ) WITHOUT ROWID`,
    `CREATE TABLE region_publications (
      answer_id INTEGER NOT NULL REFERENCES region_answers(id),broker_id TEXT NOT NULL CHECK(length(broker_id) BETWEEN 1 AND 256),
      state TEXT NOT NULL CHECK(state IN ('pending','publishing','published')),
      attempt_count INTEGER NOT NULL CHECK(attempt_count>=0),
      last_attempt_at INTEGER CHECK(last_attempt_at>=0),last_result_at INTEGER CHECK(last_result_at>=0),
      next_due_at INTEGER NOT NULL CHECK(next_due_at>=0),
      last_error TEXT CHECK(last_error IN ('publish-failed','broker-unavailable','broker-disabled','identity-unavailable')),
      claim_run_id TEXT REFERENCES observer_runs(id),claim_token TEXT CHECK(length(claim_token)=36),
      PRIMARY KEY(answer_id,broker_id),
      CHECK((state='publishing' AND claim_run_id IS NOT NULL AND claim_token IS NOT NULL)
        OR (state IN ('pending','published') AND claim_run_id IS NULL AND claim_token IS NULL))
    ) WITHOUT ROWID`,
    'CREATE INDEX idx_region_publications_due ON region_publications(broker_id,state,next_due_at,answer_id)',
    'CREATE INDEX idx_region_publications_claim_run ON region_publications(claim_run_id)'
  ]
};
