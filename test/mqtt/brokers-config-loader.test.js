import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBrokersConfig, BrokersConfigError } from '../../src/mqtt/brokers-config-loader.js';

function withTempFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'meshcore-brokers-'));
  const filePath = join(dir, 'brokers.config.json');
  if (content !== null) {
    writeFileSync(filePath, content, 'utf8');
  }
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_BROKER = {
  id: 'okimesh',
  enabled: true,
  host: 'mqtt1.okimesh.org',
  port: 1883,
  auth: { method: 'none' }
};

test('returns an empty array when the file does not exist', () => {
  const result = withTempFile(null, (filePath) => loadBrokersConfig(filePath));
  assert.deepEqual(result, []);
});

test('loads and validates a well-formed brokers config file, filling in defaults', () => {
  const result = withTempFile(JSON.stringify([VALID_BROKER]), (filePath) => loadBrokersConfig(filePath));
  assert.equal(result.length, 1);
  const [broker] = result;
  assert.equal(broker.id, 'okimesh');
  assert.equal(broker.transport, 'tcp');
  assert.equal(broker.tls, false);
  assert.equal(broker.websocketPath, null);
  assert.equal(broker.keepalive, 60);
  assert.equal(broker.qos, 0);
  assert.equal(broker.retain, true);
  assert.equal(broker.clientIdPrefix, 'meshcore-observer');
  assert.deepEqual(broker.auth, { method: 'none', username: null, password: null, audience: null, tokenTtlSeconds: null });
});

test('preserves explicit non-default values', () => {
  const broker = {
    ...VALID_BROKER,
    transport: 'wss',
    tls: true,
    websocketPath: '/mqtt',
    keepalive: 30,
    qos: 1,
    retain: false,
    clientIdPrefix: 'custom-prefix'
  };
  const [result] = withTempFile(JSON.stringify([broker]), (filePath) => loadBrokersConfig(filePath));
  assert.equal(result.transport, 'wss');
  assert.equal(result.tls, true);
  assert.equal(result.websocketPath, '/mqtt');
  assert.equal(result.keepalive, 30);
  assert.equal(result.qos, 1);
  assert.equal(result.retain, false);
  assert.equal(result.clientIdPrefix, 'custom-prefix');
});

test('never carries a password through from the file, even if one is (incorrectly) present', () => {
  // additionalProperties: false on auth rejects a stray "password" field
  // outright, rather than silently accepting a secret checked into the file.
  const broker = { ...VALID_BROKER, auth: { method: 'none', password: 'leaked' } };
  assert.throws(() => withTempFile(JSON.stringify([broker]), (filePath) => loadBrokersConfig(filePath)), BrokersConfigError);
});

test('throws BrokersConfigError for invalid JSON', () => {
  assert.throws(() => withTempFile('{ not valid json', (filePath) => loadBrokersConfig(filePath)), BrokersConfigError);
});

test('throws BrokersConfigError when the file fails schema validation', () => {
  const invalid = [{ id: 'okimesh', enabled: true }]; // missing required host/port/auth
  assert.throws(() => withTempFile(JSON.stringify(invalid), (filePath) => loadBrokersConfig(filePath)), BrokersConfigError);
});

test('rejects an unknown property on a broker definition', () => {
  const withExtra = { ...VALID_BROKER, unexpectedField: true };
  assert.throws(() => withTempFile(JSON.stringify([withExtra]), (filePath) => loadBrokersConfig(filePath)), BrokersConfigError);
});

test('throws BrokersConfigError for a duplicate broker id', () => {
  const duplicates = [VALID_BROKER, { ...VALID_BROKER, host: 'mqtt2.okimesh.org' }];
  assert.throws(
    () => withTempFile(JSON.stringify(duplicates), (filePath) => loadBrokersConfig(filePath)),
    /Duplicate broker id "okimesh"/
  );
});

test('rejects a password-auth broker with no username', () => {
  const broker = { ...VALID_BROKER, id: 'private', auth: { method: 'password' } };
  assert.throws(
    () => withTempFile(JSON.stringify([broker]), (filePath) => loadBrokersConfig(filePath)),
    /uses password auth but has no username configured/
  );
});

test('accepts a password-auth broker with a username (the password itself comes from the environment)', () => {
  const broker = { ...VALID_BROKER, id: 'private', auth: { method: 'password', username: 'bot' } };
  const [result] = withTempFile(JSON.stringify([broker]), (filePath) => loadBrokersConfig(filePath));
  assert.equal(result.auth.method, 'password');
  assert.equal(result.auth.username, 'bot');
  assert.equal(result.auth.password, null);
});

test('rejects a token-auth broker with no audience', () => {
  const broker = { ...VALID_BROKER, id: 'letsmesh', auth: { method: 'token' } };
  assert.throws(
    () => withTempFile(JSON.stringify([broker]), (filePath) => loadBrokersConfig(filePath)),
    /uses token auth but has no audience configured/
  );
});

test('accepts a token-auth broker with an audience', () => {
  const broker = { ...VALID_BROKER, id: 'letsmesh', auth: { method: 'token', audience: 'letsmesh' } };
  const [result] = withTempFile(JSON.stringify([broker]), (filePath) => loadBrokersConfig(filePath));
  assert.equal(result.auth.audience, 'letsmesh');
});
