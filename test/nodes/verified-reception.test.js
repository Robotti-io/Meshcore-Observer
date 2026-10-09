import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { NodeRegistry } from '../../src/nodes/node-registry.js';
import { parseAdvertReceptionFromPacket } from '../../src/nodes/advert-parser.js';
import { MetricsStore } from '../../src/metrics/store.js';
import { PacketPipeline } from '../../src/packets/packet-pipeline.js';
import { advertSigner, signedAdvertPacket } from '../fixtures/signed-advert.js';

const HOUR = 3600000;
const RANGE = { start: 0, end: 10000 };
const stores = new Set();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); });
function setup(overrides = {}) {
  const store = new MetricsStore({ dbPath: ':memory:' });
  stores.add(store);
  const warnings = [];
  const logger = { debug() {}, info() {}, error() {}, warn: (...args) => warnings.push(args) };
  const registry = new NodeRegistry({ logger, store, directHeardWindowMs: 72 * HOUR, now: () => 1000, ...overrides });
  return { registry, store, warnings, logger };
}

test('genuine unnamed adverts verify, persist and participate in identity-based reporting', async () => {
  const { registry, store } = setup();
  for (const type of [1, 2]) {
    const signer = advertSigner();
    await registry.recordFromDecodedPacket(signedAdvertPacket(signer.payload({ name: null, type })));
    assert.equal(registry.findByPrefix(signer.publicKeyHex).node.name, null);
    assert.equal(registry.getDirectHeardEligibility(signer.publicKeyHex).eligible, type === 2);
  }
  assert.deepEqual(store.queryAdvertTotals(RANGE), {
    events: 2, distinctNodes: 2, newDiscoveries: 2, rehears: 0, earliestEventAt: 1000
  });
});

test('tampered signatures and malformed reception timestamps change no trusted state', async () => {
  const { registry, store, warnings } = setup();
  const signer = advertSigner();
  const payload = signer.payload({ name: null });
  payload[40] ^= 1;
  await registry.recordFromDecodedPacket(signedAdvertPacket(payload));
  await registry.recordFromDecodedPacket({ ...signedAdvertPacket(signer.payload()), timestamp: 'invalid' });
  const missingTime = signedAdvertPacket(signer.payload());
  delete missingTime.timestamp;
  await registry.recordFromDecodedPacket(missingTime);
  await registry.recordFromDecodedPacket({ raw: 'xyz', timestamp: new Date(1000).toISOString() });
  assert.equal(registry.findByPrefix(signer.publicKeyHex).status, 'not_found');
  assert.equal(store.queryAdvertTotals(RANGE).events, 0);
  assert.equal(registry.getDirectHeardEligibility(signer.publicKeyHex).eligible, false);
  assert.equal(warnings.length, 3);
});

test('a genuine relayed duplicate followed by zero-hop flood refreshes only reception evidence', async () => {
  const { registry, store } = setup({ now: () => 3000 });
  const signer = advertSigner();
  const payload = signer.payload();
  await registry.recordFromDecodedPacket(signedAdvertPacket(payload, { hops: ['aabb'], pathHashSize: 2 }));
  assert.equal(registry.getDirectHeardEligibility(signer.publicKeyHex).eligible, false);
  await registry.recordFromDecodedPacket(signedAdvertPacket(payload, { receivedAt: 3000 }));
  assert.equal(store.queryAdvertTotals(RANGE).events, 1);
  assert.deepEqual(registry.getDirectHeardEligibility(signer.publicKeyHex), { lastDirectHeardAt: 3000, eligible: true });
});

test('asynchronous verification uses captured reception time and preserves latest known name', async () => {
  const releases = new Map();
  const { registry, store } = setup({
    parseAdvert(packet) {
      const reception = parseAdvertReceptionFromPacket(packet);
      const verify = reception.advert.isVerified.bind(reception.advert);
      reception.advert.isVerified = async () => {
        await new Promise((resolve) => releases.set(packet.timestamp, resolve));
        return verify();
      };
      return reception;
    }
  });
  const signer = advertSigner();
  const packets = [
    signedAdvertPacket(signer.payload({ name: 'Original', timestamp: 1 }), { receivedAt: 1000 }),
    signedAdvertPacket(signer.payload({ name: 'Renamed', timestamp: 2 }), { receivedAt: 2000 }),
    signedAdvertPacket(signer.payload({ name: null, timestamp: 3 }), { receivedAt: 3000 })
  ];
  const pending = packets.map((packet) => registry.recordFromDecodedPacket(packet));
  // Even if another consumer mutates a packet, evidence was already captured.
  const originalTimestamp = packets[0].timestamp;
  packets[0].timestamp = new Date(9000).toISOString();
  releases.get(packets[2].timestamp)(); await pending[2];
  releases.get(packets[1].timestamp)(); await pending[1];
  releases.get(originalTimestamp)(); await pending[0];
  const node = registry.findByPrefix(signer.publicKeyHex).node;
  assert.equal(node.name, 'Renamed');
  assert.equal(node.firstHeardAt, 1000);
  assert.equal(node.lastHeardAt, 3000);
  assert.equal(store.queryAdvertTotals({ start: 1000, end: 2000 }).newDiscoveries, 1);
  assert.deepEqual(store.queryAdvertTotals(RANGE), {
    events: 3, distinctNodes: 1, newDiscoveries: 1, rehears: 2, earliestEventAt: 1000
  });
});

test('packet capture publishes every genuine advert reception while registry failure is isolated', async () => {
  const { registry, logger, warnings } = setup({ store: { recordVerifiedAdvert() { throw new Error('disk full'); } } });
  const pipeline = new PacketPipeline({ logger,
    getObserverIdentity: () => ({ origin: 'Observer', originId: 'abc123' }) });
  const pending = []; const published = [];
  pipeline.on('packet', (packet) => pending.push(registry.recordFromDecodedPacket(packet)));
  pipeline.on('packet', (packet) => published.push(packet));
  const payload = advertSigner().payload();
  for (const hops of [[], ['aa'], ['bb']]) {
    const packet = signedAdvertPacket(payload, { hops });
    pipeline.handleRawPacket({ lastSnr: -1, lastRssi: -100, raw: Buffer.from(packet.raw, 'hex') });
  }
  await Promise.all(pending);
  assert.equal(published.length, 3);
  assert.equal(new Set(published.map((packet) => packet.hash)).size, 1);
  assert.equal(warnings.filter((entry) => entry[1].includes('failed to persist')).length, 3);
  for (const packet of published) {
    assert.equal(packet.eventDigest, undefined);
    assert.equal(packet.hopCount, undefined);
  }
});
