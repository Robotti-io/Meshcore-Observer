// Synthetic old-version test databases only. Drop later children before source
// observations/outcomes/runs; never use this fixture against operator data.
export const dropTelemetryPollSchema = `DROP TABLE IF EXISTS telemetry_poll_state;
  DROP TABLE IF EXISTS telemetry_auth_outcomes; DROP TABLE IF EXISTS telemetry_direct_evidence;`;
export const dropTelemetrySchema = `${dropTelemetryPollSchema} DROP TABLE IF EXISTS telemetry_latest;
  DROP TABLE IF EXISTS telemetry_observations; DROP TABLE IF EXISTS telemetry_query_outcomes;`;
