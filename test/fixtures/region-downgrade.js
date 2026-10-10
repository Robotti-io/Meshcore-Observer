// Remove current region tables only when constructing synthetic older schemas.
export const dropRegionSchema = `DROP TABLE region_publications; DROP TABLE region_latest;
  DROP TABLE region_answers; DROP TABLE region_query_outcomes;`;
