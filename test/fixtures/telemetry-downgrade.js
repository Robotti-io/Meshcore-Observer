// Synthetic old-version test databases only. Drop later children before source
// observations/outcomes/runs; never use this fixture against operator data.
export const dropTelemetrySchema = `DROP TABLE IF EXISTS telemetry_latest;
  DROP TABLE IF EXISTS telemetry_observations; DROP TABLE IF EXISTS telemetry_query_outcomes;`;
