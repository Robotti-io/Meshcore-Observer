// Keep the 10ms write target for the Linux container runtime. Windows runners
// have measured durable SQLite writes above 40ms under coverage, so retain a
// platform-specific ceiling there while still exercising the same workload.
export const WRITE_P95_TARGET_MS = process.platform === 'win32' ? 60 : 10;

// The Windows runner has also measured the topology proximity query at
// 169ms; 200ms leaves modest runner variance while preserving the read bound.
export const TOPOLOGY_PROXIMITY_P95_TARGET_MS = process.platform === 'win32' ? 200 : 150;
