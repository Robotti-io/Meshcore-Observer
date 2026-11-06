// The observer is deployed in Linux containers. Keep absolute performance
// budgets meaningful there; other platforms still run the same workload and
// correctness checks but only report timing, since hosted-runner variance is
// large enough to swamp the budgets (e.g. 856ms for a topology write p95).
export const ENFORCE_PERFORMANCE_TARGETS = process.platform === 'linux';
export const WRITE_P95_TARGET_MS = 10;
export const TOPOLOGY_PROXIMITY_P95_TARGET_MS = 150;

// The large fixture builds and measures several SQLite datasets. Windows
// runners need more time to complete that work under coverage instrumentation.
export const COST_TEST_TIMEOUT_MS = process.platform === 'win32' ? 120000 : 30000;
