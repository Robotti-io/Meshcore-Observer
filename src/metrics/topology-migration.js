export const topologyMigration = {
  version: 13,
  statements: [
    `CREATE TABLE topology_paths (
      id INTEGER PRIMARY KEY AUTOINCREMENT,digest TEXT NOT NULL UNIQUE,canonical TEXT NOT NULL,
      observer_public_key TEXT NOT NULL,route INTEGER NOT NULL CHECK(route BETWEEN 0 AND 3),
      kind TEXT NOT NULL CHECK(kind IN ('flood-traversed','direct-remaining')),
      hash_width INTEGER NOT NULL CHECK(hash_width BETWEEN 1 AND 3),transport_code_1 INTEGER,transport_code_2 INTEGER,
      path_hex TEXT NOT NULL,repeated_prefix INTEGER NOT NULL CHECK(repeated_prefix IN (0,1)),
      reception_count INTEGER NOT NULL CHECK(reception_count>0),first_received_at INTEGER NOT NULL,last_received_at INTEGER NOT NULL
    )`,
    'CREATE INDEX idx_topology_paths_observer_kind_at ON topology_paths(observer_public_key,kind,last_received_at)',
    'CREATE INDEX idx_topology_paths_last ON topology_paths(last_received_at)',
    `CREATE TABLE topology_path_hops (
      path_id INTEGER NOT NULL REFERENCES topology_paths(id),position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 62),
      hash_width INTEGER NOT NULL CHECK(hash_width BETWEEN 1 AND 3),prefix TEXT NOT NULL,distance INTEGER,
      PRIMARY KEY(path_id,position)
    ) WITHOUT ROWID`,
    'CREATE INDEX idx_topology_hops_prefix ON topology_path_hops(hash_width,prefix)',
    `CREATE TABLE topology_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,path_id INTEGER NOT NULL REFERENCES topology_paths(id),
      run_id TEXT NOT NULL REFERENCES observer_runs(id),received_at INTEGER NOT NULL
    )`,
    'CREATE INDEX idx_topology_observations_at ON topology_observations(received_at)',
    'CREATE INDEX idx_topology_observations_path_at ON topology_observations(path_id,received_at)',
    'CREATE INDEX idx_topology_observations_run_at ON topology_observations(run_id,received_at)',
    `CREATE TABLE topology_capture_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES observer_runs(id),observer_public_key TEXT NOT NULL,
      sample_at INTEGER NOT NULL,accepted INTEGER NOT NULL CHECK(accepted>=0),suppressed INTEGER NOT NULL CHECK(suppressed>=0),
      failed INTEGER NOT NULL CHECK(failed>=0),malformed INTEGER NOT NULL CHECK(malformed>=0),
      unsupported INTEGER NOT NULL CHECK(unsupported>=0),no_relay INTEGER NOT NULL CHECK(no_relay>=0)
    )`,
    'CREATE INDEX idx_topology_capture_at ON topology_capture_samples(sample_at)',
    'CREATE INDEX idx_topology_capture_run_at ON topology_capture_samples(run_id,sample_at)',
    ...[1, 2, 3].map((width) => `CREATE INDEX idx_nodes_prefix_${width} ON nodes(upper(substr(public_key_hex,1,${width * 2})))`)
  ]
};
