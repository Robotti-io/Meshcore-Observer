import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { NodeRegistry } from '../../src/nodes/node-registry.js';
import { parseAdvertReceptionFromPacket } from '../../src/nodes/advert-parser.js';
import { MetricsStore } from '../../src/metrics/store.js';
import { startTelemetryRun, TELEMETRY_OBSERVER as OBSERVER } from '../fixtures/telemetry-store.js';
import { signedAdvertPacket, advertSigner } from '../fixtures/signed-advert.js';

const active = [];
afterEach(() => { for (const f of active.splice(0)) f.store.close(); });
function rig(options = {}) {
  const store = new MetricsStore({ dbPath: ':memory:' }), run = startTelemetryRun(store);
  const warnings = [], logger = { warn: (...args) => warnings.push(args) };
  const f = { store, run, warnings }; active.push(f);
  f.registry = new NodeRegistry({ store, runId: run.runId, logger, directHeardWindowMs: 72 * 3600000, ...options });
  f.eligible = (target, observer = OBSERVER) => store.getTelemetryEligibility({ observerPublicKey: observer,
    targetPublicKey: target, now: 10000, windowMs: 72 * 3600000, radius: 2 });
  return f;
}
const packet = (signer, options, observer = OBSERVER) => ({ ...signedAdvertPacket(signer.payload(), options), origin_id: observer });

test('new verified zero-hop repeater reception supplies reporter-scoped eligibility even without a poll producer', async () => {
  const f = rig(), signer = advertSigner(); await f.registry.recordFromDecodedPacket(packet(signer));
  assert.equal(f.eligible(signer.publicKeyHex).receivedAt, 1000);
  assert.equal(f.eligible(signer.publicKeyHex, 'EF'.repeat(32)), null);
  assert.equal(f.store.queryAdvertTotals({ start: 0, end: 10000 }).events, 1);
});
test('reporter and original receipt are captured before asynchronous verification or another packet consumer can mutate them', async () => {
  let release;
  const f = rig({ parseAdvert(value) { const reception = parseAdvertReceptionFromPacket(value);
    const verify = reception.advert.isVerified.bind(reception.advert);
    reception.advert.isVerified = async () => { await new Promise(resolve => { release = resolve; }); return verify(); };
    return reception; } });
  const signer = advertSigner(), original = packet(signer), pending = f.registry.recordFromDecodedPacket(original);
  original.origin_id = 'EF'.repeat(32); original.timestamp = new Date(9000).toISOString();
  release(); await pending;
  assert.equal(f.eligible(signer.publicKeyHex).receivedAt, 1000); assert.equal(f.eligible(signer.publicKeyHex, original.origin_id), null);
});
test('a repeated verified payload refreshes direct receipt without increasing advert event totals', async () => {
  const f = rig(), signer = advertSigner(), payload = signer.payload();
  for (const receivedAt of [1000, 3000, 2000]) await f.registry.recordFromDecodedPacket({
    ...signedAdvertPacket(payload, { receivedAt }), origin_id: OBSERVER });
  assert.equal(f.eligible(signer.publicKeyHex).receivedAt, 3000);
  assert.equal(f.store.queryAdvertTotals({ start: 0, end: 10000 }).events, 1);
});
for (const kind of ['relayed', 'chat', 'invalid-signature', 'invalid-reporter', 'missing-reporter']) test(`${kind} cannot create trusted direct eligibility`, async () => {
  const f = rig(), signer = advertSigner(); let value = packet(signer, kind === 'relayed' ? { hops: ['AA'] } : undefined);
  if (kind === 'chat') value = { ...signedAdvertPacket(signer.payload({ type: 1 })), origin_id: OBSERVER };
  if (kind === 'invalid-signature') { const payload = signer.payload(); payload[40] ^= 1; value = { ...signedAdvertPacket(payload), origin_id: OBSERVER }; }
  if (kind === 'invalid-reporter') value.origin_id = 'bad';
  if (kind === 'missing-reporter') delete value.origin_id;
  await f.registry.recordFromDecodedPacket(value); assert.equal(f.eligible(signer.publicKeyHex), null);
});
test('direct-marker failure leaves ordinary inventory/history/capture independent and logs a fixed safe explanation', async () => {
  const f = rig(), signer = advertSigner(); f.store.recordTelemetryDirectEvidence = () => { throw new Error('PRIVATE-SECRET'); };
  await f.registry.recordFromDecodedPacket(packet(signer));
  assert.equal(f.store.countNodesByType('REPEATER'), 1); assert.equal(f.store.queryAdvertTotals({ start: 0, end: 10000 }).events, 1);
  assert.equal(f.eligible(signer.publicKeyHex), null); assert.match(f.warnings[0][1], /cannot grant telemetry eligibility/);
  assert.doesNotMatch(JSON.stringify(f.warnings), /PRIVATE-SECRET/);
});
test('pending verification completes while the owned store is still open during producer drain', async () => {
  let release;
  const f = rig({ parseAdvert(value) { const reception = parseAdvertReceptionFromPacket(value);
    const verify = reception.advert.isVerified.bind(reception.advert);
    reception.advert.isVerified = async () => { await new Promise(resolve => { release = resolve; }); return verify(); };
    return reception; } });
  const signer = advertSigner(), pending = f.registry.recordFromDecodedPacket(packet(signer));
  release(); await Promise.allSettled([pending]); assert.ok(f.eligible(signer.publicKeyHex));
  f.store.endObserverRun({ runId: f.run.runId, observedAt: 10000, observedDurationMs: 10000, reason: 'SIGINT' });
});
