import { dropRegionSchema } from './region-downgrade.js';
// Current-schema databases used as synthetic old-version fixtures: remove
// later region children first, then the historical topology schema.
export const dropTopologySchema = `${dropRegionSchema} DROP TABLE topology_capture_samples; DROP TABLE topology_observations;
  DROP TABLE topology_path_hops; DROP TABLE topology_paths;
  DROP INDEX idx_nodes_prefix_1; DROP INDEX idx_nodes_prefix_2; DROP INDEX idx_nodes_prefix_3;`;
