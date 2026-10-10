// Remove current region tables only when constructing synthetic older schemas.
export const dropRegionSchema = `DROP TABLE IF EXISTS region_poll_state; DROP INDEX IF EXISTS idx_nodes_type_key;
  DROP TABLE region_publications; DROP TABLE region_latest;
  DROP TABLE region_answers; DROP TABLE region_query_outcomes;`;
