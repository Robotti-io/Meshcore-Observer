import { randomUUID } from 'node:crypto';
import { MetricsStore } from '../../src/metrics/store.js';
import { parseRegionResponseBody } from '../../src/regions/region-response-parser.js';

// Local IPC-only crash fixture. No radio, broker, UI or network transport.
const store = new MetricsStore({ dbPath: process.argv[2] });
const run = store.beginObserverRun({ runId: randomUUID(), startedAt: 0, observedAt: 0, observedDurationMs: 0,
  appVersion: '2.4.0', nodeVersion: process.version, platform: process.platform, architecture: process.arch });
store.recordRegionResult({ outcome: { requestId: randomUUID(), runId: run.runId, observerPublicKey: 'BE'.repeat(32),
  targetPublicKey: 'AC'.repeat(32), startedAt: 0, completedAt: 1010, clockAnomaly: false,
  status: 'answered', reason: null, route: 'direct' },
answer: { ...parseRegionResponseBody({ body: [0,0,0,0] }).answer, observedAt: 1000 }, brokerIds: ['first','second'] });
const claim = store.claimRegionPublication({ brokerId: 'first', runId: run.runId, now: 2000 });
if (process.argv[3] === 'published') store.resolveRegionPublication({ answerId: claim.answerId, brokerId: 'first',
  runId: run.runId, claimToken: claim.claimToken, resolvedAt: 2001, status: 'published' });
// The other mode models transport acceptance before its local ack is saved.
process.send({ runId: run.runId, claim });
setInterval(() => {}, 60000); // Parent kills this process without closing its owned store.
