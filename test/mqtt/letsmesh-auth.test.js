import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LetsMeshAuth, LetsMeshAuthError } from '../../src/mqtt/letsmesh-auth.js';

function base64urlDecode(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (segment.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function decodeToken(token) {
  const [headerEncoded, payloadEncoded, signatureHex] = token.split('.');
  return {
    header: JSON.parse(base64urlDecode(headerEncoded)),
    payload: JSON.parse(base64urlDecode(payloadEncoded)),
    signatureHex,
    signingInput: `${headerEncoded}.${payloadEncoded}`
  };
}

function silentLogger() {
  const calls = { info: [] };
  return {
    calls,
    debug: () => {},
    info: (source, message, meta) => calls.info.push({ source, message, meta }),
    warn: () => {},
    error: () => {}
  };
}

const FAKE_SIGNATURE = Buffer.from('aa'.repeat(64), 'hex'); // 64 bytes, all 0xaa

function fakeRadioManager({ connected = true, signImpl = async () => FAKE_SIGNATURE } = {}) {
  const signCalls = [];
  return {
    signCalls,
    getDeviceInfo: () => (connected ? { publicKey: 'deadbeef', name: 'Test Node' } : null),
    runCommand: async (fn) => {
      const connection = {
        sign: async (data) => {
          signCalls.push(data);
          return signImpl(data);
        }
      };
      return fn(connection);
    }
  };
}

test('createToken throws before the radio device identity is known', async () => {
  const auth = new LetsMeshAuth({ radioManager: fakeRadioManager({ connected: false }), logger: silentLogger() });
  await assert.rejects(auth.createToken(), LetsMeshAuthError);
});

test('createToken builds the LetsMesh-specific header, uppercases publicKey, and hex-encodes the signature', async () => {
  const radioManager = fakeRadioManager();
  const auth = new LetsMeshAuth({ radioManager, ttlSeconds: 3600, logger: silentLogger() });

  const before = Math.floor(Date.now() / 1000);
  const token = await auth.createToken();
  const after = Math.floor(Date.now() / 1000);

  const { header, payload, signatureHex, signingInput } = decodeToken(token);

  assert.deepEqual(header, { alg: 'Ed25519', typ: 'JWT' });
  assert.equal(payload.publicKey, 'DEADBEEF');
  assert.ok(payload.iat >= before && payload.iat <= after);
  assert.equal(payload.exp, payload.iat + 3600);
  assert.equal(signatureHex, FAKE_SIGNATURE.toString('hex'));

  // The device must be asked to sign exactly the JWT signing input bytes,
  // not something else (e.g. a pre-hash).
  assert.equal(radioManager.signCalls.length, 1);
  assert.equal(Buffer.from(radioManager.signCalls[0]).toString('utf8'), signingInput);
});

test('omits aud/owner/email/client claims when not configured, includes them when configured', async () => {
  const bare = await new LetsMeshAuth({ radioManager: fakeRadioManager(), logger: silentLogger() }).createToken();
  assert.deepEqual(Object.keys(decodeToken(bare).payload).sort(), ['exp', 'iat', 'publicKey']);

  const full = await new LetsMeshAuth({
    radioManager: fakeRadioManager(),
    audience: 'letsmesh',
    owner: 'OWNERPUBKEY',
    email: 'owner@example.com',
    client: 'meshcore-observer/1.0.0',
    logger: silentLogger()
  }).createToken();
  const { payload } = decodeToken(full);
  assert.equal(payload.aud, 'letsmesh');
  assert.equal(payload.owner, 'OWNERPUBKEY');
  assert.equal(payload.email, 'owner@example.com');
  assert.equal(payload.client, 'meshcore-observer/1.0.0');
});

test('getExpiration is null before any token exists, then reflects the latest token', async () => {
  const auth = new LetsMeshAuth({ radioManager: fakeRadioManager(), ttlSeconds: 100, logger: silentLogger() });
  assert.equal(auth.getExpiration(), null);
  await auth.createToken();
  assert.ok(auth.getExpiration() > Math.floor(Date.now() / 1000));
});

test('refreshIfNeeded reuses a token that is far from expiry without re-signing', async () => {
  const radioManager = fakeRadioManager();
  const auth = new LetsMeshAuth({ radioManager, ttlSeconds: 86400, logger: silentLogger() });

  const first = await auth.createToken();
  assert.equal(radioManager.signCalls.length, 1);

  const reused = await auth.refreshIfNeeded();
  assert.equal(reused, first);
  assert.equal(radioManager.signCalls.length, 1, 'must not sign again when the cached token is still valid');
});

test('refreshIfNeeded signs a new token when none exists yet, or the cached one is within the threshold', async () => {
  const radioManager = fakeRadioManager();
  const auth = new LetsMeshAuth({ radioManager, ttlSeconds: 200, logger: silentLogger() });

  await auth.refreshIfNeeded({ thresholdSeconds: 300 });
  assert.equal(radioManager.signCalls.length, 1);

  // ttlSeconds (200) < thresholdSeconds (300), so the token is always
  // "within the renewal threshold" and every call must sign a fresh one -
  // even if the resulting token happens to be textually identical because
  // both calls landed within the same iat second.
  await auth.refreshIfNeeded({ thresholdSeconds: 300 });
  assert.equal(radioManager.signCalls.length, 2, 'must sign again since the cached token is within the threshold');
});

test('propagates on-device signing failure as LetsMeshAuthError without caching a broken token', async () => {
  const radioManager = fakeRadioManager({
    signImpl: async () => {
      throw new Error('device rejected sign request');
    }
  });
  const auth = new LetsMeshAuth({ radioManager, logger: silentLogger() });

  await assert.rejects(auth.createToken(), LetsMeshAuthError);
  assert.equal(auth.getExpiration(), null);
});

test('never logs the token or signature, only metadata', async () => {
  const logger = silentLogger();
  const auth = new LetsMeshAuth({ radioManager: fakeRadioManager(), audience: 'letsmesh', logger });

  const token = await auth.createToken();
  const serializedLogs = JSON.stringify(logger.calls.info);

  assert.ok(!serializedLogs.includes(token));
  assert.ok(!serializedLogs.includes(FAKE_SIGNATURE.toString('hex')));
  assert.equal(logger.calls.info.length, 1);
  assert.equal(logger.calls.info[0].meta.audience, 'letsmesh');
  assert.ok(logger.calls.info[0].meta.expiresAt);
});
