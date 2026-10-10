import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadBrokersConfig, BrokersConfigError } from '../../src/mqtt/brokers-config-loader.js';
import { REGION_PUBLICATION_DEFAULTS } from '../../src/mqtt/region-publication-schemas.js';

test('region publication is disabled with matching code/example defaults; strict overrides are normalized',()=>{
  const [broker]=withTempFile(JSON.stringify([VALID_BROKER]),loadBrokersConfig);
  assert.deepEqual(broker.regionPublication,REGION_PUBLICATION_DEFAULTS);
  const [explicit]=withTempFile(JSON.stringify([{ ...VALID_BROKER,regionPublication:{ enabled:true,retryBaseMs:120000 } }]),loadBrokersConfig);
  assert.deepEqual(explicit.regionPublication,{ ...REGION_PUBLICATION_DEFAULTS,enabled:true,retryBaseMs:120000 });
  for(const example of loadBrokersConfig('brokers.config.example.json')) assert.deepEqual(example.regionPublication,REGION_PUBLICATION_DEFAULTS);
});
test('invalid publication settings and excessive destinations fail before normalization/network activity',()=>{
  for(const regionPublication of [{ enabled:'true' },{ qos:0 },{ publishTimeoutMs:5001 },{ tickIntervalMs:0 },
    { retryBaseMs:4000000 },{ retryMaxMs:0 },{ retryBaseMs:null }]) {
    assert.throws(()=>withTempFile(JSON.stringify([{ ...VALID_BROKER,regionPublication }]),loadBrokersConfig),BrokersConfigError);
  }
  const brokers=Array.from({ length:65 },(_,i)=>({ ...VALID_BROKER,id:'b'+i,regionPublication:{ enabled:true } }));
  assert.throws(()=>withTempFile(JSON.stringify(brokers),loadBrokersConfig),BrokersConfigError);
  brokers[0].enabled=false;assert.equal(withTempFile(JSON.stringify(brokers),loadBrokersConfig).length,65);
});

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

test('broker configuration example validates token, password, and anonymous auth examples', () => {
  const examplePath = fileURLToPath(new URL('../../brokers.config.example.json', import.meta.url));
  const brokers = loadBrokersConfig(examplePath);
  const okimeshBrokers = brokers.filter((broker) => broker.id.startsWith('okimesh-'));

  assert.deepEqual(
    okimeshBrokers.map(({ id, host, auth }) => ({ id, host, method: auth.method })),
    [
      {
        id: 'okimesh-mqtt1',
        host: 'mqtt1.okimesh.org',
        method: 'none'
      },
      {
        id: 'okimesh-mqtt2',
        host: 'mqtt2.okimesh.org',
        method: 'none'
      }
    ]
  );
  const meshmapper = brokers.find((broker) => broker.id === 'meshmapper');
  assert.equal(meshmapper.host, 'mqtt.meshmapper.net');
  assert.equal(meshmapper.port, 443);
  assert.equal(meshmapper.transport, 'wss');
  assert.equal(meshmapper.tls, true);
  assert.equal(meshmapper.auth.method, 'token');
  assert.equal(meshmapper.auth.audience, 'mqtt.meshmapper.net');

  const letsmesh = brokers.find((broker) => broker.id === 'letsmesh');
  assert.equal(letsmesh.host, 'mqtt-us-v1.letsmesh.net');
  assert.equal(letsmesh.port, 443);
  assert.equal(letsmesh.transport, 'wss');
  assert.equal(letsmesh.tls, true);
  assert.equal(letsmesh.auth.method, 'token');
  assert.equal(letsmesh.auth.audience, 'letsmesh');

  const passwordBrokers = brokers.filter((broker) => broker.id.startsWith('password-broker-'));
  assert.deepEqual(
    passwordBrokers.map(({ id, host, port, tls, auth }) => ({
      id,
      host,
      port,
      tls,
      method: auth.method,
      username: auth.username,
      passwordEnv: auth.passwordEnv
    })),
    [
      {
        id: 'password-broker-1',
        host: 'mqtt1.example.com',
        port: 8883,
        tls: true,
        method: 'password',
        username: 'observer-1',
        passwordEnv: 'MQTT1_EXAMPLE_PASSWORD'
      },
      {
        id: 'password-broker-2',
        host: 'mqtt2.example.com',
        port: 8883,
        tls: true,
        method: 'password',
        username: 'observer-2',
        passwordEnv: 'MQTT2_EXAMPLE_PASSWORD'
      }
    ]
  );
});

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

test('accepts and preserves a named password environment variable for central resolution', () => {
  const broker = {
    ...VALID_BROKER,
    id: 'private',
    auth: { method: 'password', username: 'bot', passwordEnv: 'MQTT_PRIVATE_PASSWORD' }
  };
  const [result] = withTempFile(JSON.stringify([broker]), (filePath) => loadBrokersConfig(filePath));
  assert.equal(result.auth.passwordEnv, 'MQTT_PRIVATE_PASSWORD');
  assert.equal(result.auth.password, null);
});

test('rejects malformed named password environment variable names', () => {
  for (const passwordEnv of ['mqtt_password', '1MQTT_PASSWORD', 'MQTT-PASSWORD', '']) {
    const broker = { ...VALID_BROKER, auth: { method: 'password', username: 'bot', passwordEnv } };
    assert.throws(
      () => withTempFile(JSON.stringify([broker]), (filePath) => loadBrokersConfig(filePath)),
      BrokersConfigError,
      `expected ${JSON.stringify(passwordEnv)} to be rejected`
    );
  }
});

test('rejects passwordEnv when the broker does not use password authentication', () => {
  for (const method of ['none', 'token']) {
    const broker = { ...VALID_BROKER, auth: { method, passwordEnv: 'MQTT_PRIVATE_PASSWORD' } };
    assert.throws(
      () => withTempFile(JSON.stringify([broker]), (filePath) => loadBrokersConfig(filePath)),
      BrokersConfigError,
      `expected ${method} auth to reject passwordEnv`
    );
  }
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
