import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeRegistry } from '../../src/nodes/node-registry.js';

function silentLogger() {
  const calls = { debug: [], info: [], warn: [] };
  return {
    calls,
    debug: (source, message, meta) => calls.debug.push({ source, message, meta }),
    info: (source, message, meta) => calls.info.push({ source, message, meta }),
    warn: (source, message, meta) => calls.warn.push({ source, message, meta }),
    error: () => {}
  };
}

function fakeAdvert({ publicKeyHex, name, type = 'REPEATER', verified = true }) {
  return {
    publicKey: Buffer.from(publicKeyHex, 'hex'),
    parsed: { name, type },
    isVerified: async () => verified
  };
}

// Every test injects its own `parseAdvert` (a decoded-packet -> advert
// stub) rather than real over-the-air bytes - node-registry.js's own
// contract with advert-parser.js is exercised separately in
// advert-parser.test.js, and real ed25519-signed fixtures aren't needed to
// test the registry's storage/lookup logic in isolation.
function stubParseAdvert(decodedPacket) {
  return decodedPacket.__advert ?? null;
}

function sequentialClock(startIso = '2026-01-01T00:00:00.000Z') {
  let current = new Date(startIso).getTime();
  return () => {
    const iso = new Date(current).toISOString();
    current += 1000;
    return iso;
  };
}

function newRegistry(overrides = {}) {
  return new NodeRegistry({
    logger: silentLogger(),
    parseAdvert: stubParseAdvert,
    now: sequentialClock(),
    ...overrides
  });
}

test('ignores a packet that is not a parseable advert', async () => {
  const registry = newRegistry();
  await registry.recordFromDecodedPacket({ __advert: null });
  assert.equal(registry.size(), 0);
});

test('ignores an advert with no name set', async () => {
  const registry = newRegistry();
  await registry.recordFromDecodedPacket({ __advert: fakeAdvert({ publicKeyHex: 'E85C'.repeat(16), name: null }) });
  assert.equal(registry.size(), 0);
});

test('drops and warns on an advert with a name whose signature does not verify', async () => {
  const logger = silentLogger();
  const registry = newRegistry({ logger });
  await registry.recordFromDecodedPacket({
    __advert: fakeAdvert({ publicKeyHex: 'E85C'.repeat(16), name: 'Spoofed', verified: false })
  });

  assert.equal(registry.size(), 0);
  assert.ok(logger.calls.warn.some((call) => call.message.includes('did not verify')));
});

test('stores a verified, named advert, keyed by its full uppercase public key', async () => {
  const registry = newRegistry();
  const publicKeyHex = 'e85c'.repeat(16);
  await registry.recordFromDecodedPacket({ __advert: fakeAdvert({ publicKeyHex, name: 'Summit Repeater' }) });

  assert.equal(registry.size(), 1);
  const [node] = registry.entries();
  assert.equal(node.publicKeyHex, publicKeyHex.toUpperCase());
  assert.equal(node.name, 'Summit Repeater');
  assert.equal(node.type, 'REPEATER');
  assert.ok(node.lastHeardAt);
});

test('a later verified advert for the same key overwrites the name and refreshes lastHeardAt', async () => {
  const registry = newRegistry();
  const publicKeyHex = 'E85C'.repeat(16);
  await registry.recordFromDecodedPacket({ __advert: fakeAdvert({ publicKeyHex, name: 'Old Name' }) });
  const firstHeardAt = registry.entries()[0].lastHeardAt;

  await registry.recordFromDecodedPacket({ __advert: fakeAdvert({ publicKeyHex, name: 'New Name' }) });

  assert.equal(registry.size(), 1);
  const [node] = registry.entries();
  assert.equal(node.name, 'New Name');
  assert.ok(node.lastHeardAt > firstHeardAt);
});

test('findByPrefix rejects queries shorter than 1 byte, non-hex characters, and overlong queries', async () => {
  const registry = newRegistry();
  await registry.recordFromDecodedPacket({ __advert: fakeAdvert({ publicKeyHex: 'E85C'.repeat(16), name: 'Repeater' }) });

  assert.equal(registry.findByPrefix('').status, 'invalid');
  assert.equal(registry.findByPrefix('E').status, 'invalid');
  assert.equal(registry.findByPrefix('ZZ').status, 'invalid');
  assert.equal(registry.findByPrefix('E8'.repeat(40)).status, 'invalid');
});

test('findByPrefix allows an odd (non-byte-aligned) hex length beyond the 1-byte floor', async () => {
  const registry = newRegistry();
  const publicKeyHex = 'E85C'.repeat(16);
  await registry.recordFromDecodedPacket({ __advert: fakeAdvert({ publicKeyHex, name: 'Repeater' }) });

  const result = registry.findByPrefix('E85');
  assert.equal(result.status, 'found');
  assert.equal(result.node.name, 'Repeater');
});

test('findByPrefix matches case-insensitively and supports a full-key exact match', async () => {
  const registry = newRegistry();
  const publicKeyHex = 'E85C'.repeat(16);
  await registry.recordFromDecodedPacket({ __advert: fakeAdvert({ publicKeyHex, name: 'Repeater' }) });

  assert.equal(registry.findByPrefix('e85c').status, 'found');
  assert.equal(registry.findByPrefix(publicKeyHex.toLowerCase()).status, 'found');
});

test('findByPrefix returns not_found for a valid query with zero matches', async () => {
  const registry = newRegistry();
  assert.deepEqual(registry.findByPrefix('E85C'), { status: 'not_found', query: 'E85C' });
});

test('findByPrefix with a type filter excludes a matching node of a different type', async () => {
  const registry = newRegistry();
  await registry.recordFromDecodedPacket({
    __advert: fakeAdvert({ publicKeyHex: 'E85C'.repeat(16), name: 'Chat Node', type: 'CHAT' })
  });

  const withoutFilter = registry.findByPrefix('E85C');
  assert.equal(withoutFilter.status, 'found');

  const withFilter = registry.findByPrefix('E85C', { type: 'REPEATER' });
  assert.equal(withFilter.status, 'not_found');
});

test('findByPrefix returns ambiguous with a count and the most-recently-heard match when more than one node matches', async () => {
  const registry = newRegistry();
  await registry.recordFromDecodedPacket({
    __advert: fakeAdvert({ publicKeyHex: 'E85C1111'.padEnd(64, '0'), name: 'Older Repeater' })
  });
  await registry.recordFromDecodedPacket({
    __advert: fakeAdvert({ publicKeyHex: 'E85C2222'.padEnd(64, '0'), name: 'Newer Repeater' })
  });

  const result = registry.findByPrefix('E85C');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.matchCount, 2);
  assert.equal(result.node.name, 'Newer Repeater');
});

test('findByPrefix ambiguity is decided after any type filter is applied', async () => {
  const registry = newRegistry();
  await registry.recordFromDecodedPacket({
    __advert: fakeAdvert({ publicKeyHex: 'E85C1111'.padEnd(64, '0'), name: 'Repeater', type: 'REPEATER' })
  });
  await registry.recordFromDecodedPacket({
    __advert: fakeAdvert({ publicKeyHex: 'E85C2222'.padEnd(64, '0'), name: 'Chat Node', type: 'CHAT' })
  });

  const result = registry.findByPrefix('E85C', { type: 'REPEATER' });
  assert.equal(result.status, 'found');
  assert.equal(result.node.name, 'Repeater');
});
