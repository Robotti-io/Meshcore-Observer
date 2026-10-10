import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, ConfigError } from '../../src/config/index.js';
import { REMOTE_REQUEST_DEFAULTS, REMOTE_REQUEST_ENV_KEYS } from '../../src/radio/remote-coordinator-schemas.js';
import { REGION_ANSWER_FRESHNESS_ENV_KEY, REGION_ANSWER_FRESHNESS_DEFAULT_HOURS } from '../../src/regions/region-schemas.js';
import { REGION_QUERY_DEFAULTS, REGION_QUERY_ENABLED_ENV_KEY, REGION_QUERY_NUMERIC_SETTINGS } from '../../src/regions/region-query-schemas.js';
import { compileSchema } from '../../src/validation/ajv.js';
import { configSchema } from '../../src/config/schema.js';

function withTempBotsFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'meshcore-config-'));
  const filePath = join(dir, 'bots.config.json');
  if (content !== null) {
    writeFileSync(filePath, content, 'utf8');
  }
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTempBrokersFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'meshcore-config-'));
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

// baseEnv() always points PACKETCAPTURE_BOTS_CONFIG_FILE/PACKETCAPTURE_
// BROKERS_CONFIG_FILE at real, empty files explicitly, rather than relying
// on the default paths being absent from the current working directory - a
// real bots.config.json/brokers.config.json can legitimately exist there
// for local use (see .gitignore), and this must stay deterministic
// regardless.
const emptyBotsDir = mkdtempSync(join(tmpdir(), 'meshcore-config-empty-bots-'));
const emptyBotsFile = join(emptyBotsDir, 'bots.config.json');
writeFileSync(emptyBotsFile, '[]', 'utf8');

const emptyBrokersDir = mkdtempSync(join(tmpdir(), 'meshcore-config-empty-brokers-'));
const emptyBrokersFile = join(emptyBrokersDir, 'brokers.config.json');
writeFileSync(emptyBrokersFile, '[]', 'utf8');

afterAll(() => {
  rmSync(emptyBotsDir, { recursive: true, force: true });
  rmSync(emptyBrokersDir, { recursive: true, force: true });
});

function baseEnv(overrides = {}) {
  return {
    PACKETCAPTURE_CONNECTION_TYPE: 'serial',
    PACKETCAPTURE_SERIAL_PORTS: 'COM3',
    PACKETCAPTURE_IATA: 'CVG',
    PACKETCAPTURE_BOTS_CONFIG_FILE: emptyBotsFile,
    PACKETCAPTURE_BROKERS_CONFIG_FILE: emptyBrokersFile,
    ...overrides
  };
}

test('region-answer freshness defaults and example agree, accept whole-hour boundaries and stay independent', () => {
  const defaults = loadConfig(baseEnv()); assert.equal(defaults.regions.answerFreshnessWindowMs, 72 * 3600000);
  assert.equal(REGION_ANSWER_FRESHNESS_DEFAULT_HOURS, 72);
  const matches = [...readFileSync('.env.example','utf8').matchAll(new RegExp(`^${REGION_ANSWER_FRESHNESS_ENV_KEY}=(\\d+)$`, 'gm'))];
  assert.equal(matches.length, 1); assert.equal(Number(matches[0][1]), 72);
  for (const hours of [1,72,8760]) assert.equal(loadConfig(baseEnv({ [REGION_ANSWER_FRESHNESS_ENV_KEY]: ` ${hours} ` })).regions.answerFreshnessWindowMs, hours * 3600000);
  const custom = loadConfig(baseEnv({ [REGION_ANSWER_FRESHNESS_ENV_KEY]: '96' }));
  assert.equal(custom.nodeObservations.directHeardWindowMs, defaults.nodeObservations.directHeardWindowMs);
  assert.deepEqual(custom.topology, defaults.topology); assert.deepEqual(custom.remoteRequests, defaults.remoteRequests);
  assert.equal(custom.metricsUi.retentionDays, 0); assert.equal(custom.metricsUi.enabled, false); assert.deepEqual(custom.brokers, []);
});

test('region raw and normalized configuration reject explicit invalid values before use without echoing secrets', () => {
  for (const value of ['', ' ', '0', '-1', '8761', '1.5', '1e2', 'Infinity', 'SECRET-INVALID', null, 72, {}, '9'.repeat(33)]) {
    assert.throws(() => loadConfig(baseEnv({ [REGION_ANSWER_FRESHNESS_ENV_KEY]: value })),
      error => error instanceof ConfigError && !error.message.includes('SECRET-INVALID'));
  }
  const valid = compileSchema(configSchema), config = loadConfig(baseEnv());
  for (const regions of [{ answerFreshnessWindowMs: 0 }, { answerFreshnessWindowMs: 3600001 },
    { answerFreshnessWindowMs: 8761 * 3600000 }, { answerFreshnessWindowMs: '72' },
    { answerFreshnessWindowMs: 72 * 3600000, unexpected: true }]) assert.equal(valid({ ...config, regions: { ...config.regions,...regions } }), false);
  assert.equal(valid({ ...config, regions: {} }),false);
});

test('discovery remains disabled by default and every documented default has matching units', () => {
  const expected = { discoveryEnabled:false,queryRefreshIntervalMs:86400000,queryRetryBaseMs:900000,
    queryRetryMaxMs:21600000,queryMaxAttempts:3,queryTickIntervalMs:10000,queryStartupDelayMs:60000,queryPreflightTimeoutMs:5000 };
  assert.deepEqual(REGION_QUERY_DEFAULTS,expected);
  assert.deepEqual(loadConfig(baseEnv()).regions,{ ...expected,answerFreshnessWindowMs:259200000 });
  const example=readFileSync('.env.example','utf8'), overrides={};
  for(const key of [REGION_QUERY_ENABLED_ENV_KEY,...REGION_QUERY_NUMERIC_SETTINGS.map(item=>item.key)]) {
    const matches=[...example.matchAll(new RegExp(`^${key}=(.+)$`,'gm'))]; assert.equal(matches.length,1); overrides[key]=matches[0][1].trim();
  }
  assert.equal(overrides[REGION_QUERY_ENABLED_ENV_KEY],'false');
  assert.deepEqual(loadConfig(baseEnv(overrides)).regions,loadConfig(baseEnv()).regions);
});

for(const { field,key,scale,min,max } of REGION_QUERY_NUMERIC_SETTINGS) test(`discovery ${key} accepts boundaries and rejects malformed/unsafe explicit values while off`, () => {
  for(const raw of [min,max]) {
    const overrides={ [key]:` ${raw} ` };
    if(field==='queryRetryBaseMs') overrides.PACKETCAPTURE_REGION_QUERY_RETRY_MAX_HOURS='24';
    assert.equal(loadConfig(baseEnv(overrides)).regions[field],raw*scale);
  }
  for(const raw of ['', ' ',String(min-1),String(max+1),'1.5','1e3','0x10','Infinity','SECRET-INVALID',null,5,{},'9'.repeat(33)]) {
    assert.throws(()=>loadConfig(baseEnv({ [key]:raw })),error=>error instanceof ConfigError && !error.message.includes('SECRET-INVALID'));
  }
});

test('discovery boolean spelling is strict and opt-in does not change shared limits or freshness settings', () => {
  const baseline=loadConfig(baseEnv());
  for(const [raw,expected] of [['true',true],[' TRUE ',true],['false',false],[' FaLsE ',false]]) {
    const config=loadConfig(baseEnv({ [REGION_QUERY_ENABLED_ENV_KEY]:raw }));assert.equal(config.regions.discoveryEnabled,expected);
    for(const field of ['remoteRequests','nodeObservations','brokers','metricsUi'])assert.deepEqual(config[field],baseline[field]);
    assert.equal(config.regions.answerFreshnessWindowMs,baseline.regions.answerFreshnessWindowMs);
  }
  for(const raw of ['', ' ', '1','0','yes','false\ntrue',true,null,{},'SECRET-INVALID']) {
    assert.throws(()=>loadConfig(baseEnv({ [REGION_QUERY_ENABLED_ENV_KEY]:raw })),error=>error instanceof ConfigError && !error.message.includes('SECRET-INVALID'));
  }
});

test('discovery retry maximum must cover its base, including while disabled', () => {
  for(const enabled of ['true','false']) {
    const env=baseEnv({ [REGION_QUERY_ENABLED_ENV_KEY]:enabled,PACKETCAPTURE_REGION_QUERY_RETRY_BASE_MINUTES:'61',PACKETCAPTURE_REGION_QUERY_RETRY_MAX_HOURS:'1' });
    assert.throws(()=>loadConfig(env),ConfigError);
    assert.equal(loadConfig({ ...env,PACKETCAPTURE_REGION_QUERY_RETRY_BASE_MINUTES:'60' }).regions.queryRetryBaseMs,3600000);
  }
});

test('normalized discovery config is strict, complete and respects integer units', () => {
  const valid=compileSchema(configSchema),config=loadConfig(baseEnv());
  for(const { field,scale,min,max } of REGION_QUERY_NUMERIC_SETTINGS) {
    for(const value of [min*scale-1,max*scale+1,'1',NaN])assert.equal(valid({ ...config,regions:{ ...config.regions,[field]:value } }),false);
    const missing={ ...config.regions };delete missing[field];assert.equal(valid({ ...config,regions:missing }),false);
  }
  assert.equal(valid({ ...config,regions:{ ...config.regions,discoveryEnabled:'false' } }),false);
  assert.equal(valid({ ...config,regions:{ ...config.regions,unexpected:true } }),false);
  assert.equal(valid(config),true);
});

test('remote request defaults agree in normalized configuration and the example, and accept every boundary', () => {
  assert.deepEqual(loadConfig(baseEnv()).remoteRequests, REMOTE_REQUEST_DEFAULTS);
  const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const exampleEnv = {};
  for (const [field, key] of Object.entries(REMOTE_REQUEST_ENV_KEYS)) {
    const matches = [...example.matchAll(new RegExp(`^${key}=(\\d+)$`, 'gm'))];
    assert.equal(matches.length, 1); exampleEnv[key] = matches[0][1];
    assert.equal(Number(matches[0][1]), REMOTE_REQUEST_DEFAULTS[field]);
  }
  assert.deepEqual(loadConfig(baseEnv(exampleEnv)).remoteRequests, REMOTE_REQUEST_DEFAULTS);
  for (const [field, values] of Object.entries({ ackTimeoutMs: [1000, 30000], responseTimeoutMaxMs: [1000, 120000],
    minIntervalMs: [10000, 3600000], maxPerMinute: [1, 6] })) {
    for (const value of values) assert.equal(loadConfig(baseEnv({ [REMOTE_REQUEST_ENV_KEYS[field]]: ` ${value} ` })).remoteRequests[field], value);
  }
});

test('remote request overrides strictly reject blanks, fractions, types and out-of-range values without echoing content', () => {
  for (const [field, outOfRange] of Object.entries({ ackTimeoutMs: [999, 30001], responseTimeoutMaxMs: [999, 120001],
    minIntervalMs: [9999, 3600001], maxPerMinute: [0, 7] })) {
    const key = REMOTE_REQUEST_ENV_KEYS[field];
    for (const value of ['', ' ', '-1', '0', '1.5', '1e4', 'Infinity', 'SECRET-NOT-AN-INTEGER', null, 123, {}, ...outOfRange.map(String)]) {
      assert.throws(() => loadConfig(baseEnv({ [key]: value })), error => error instanceof ConfigError && !error.message.includes('SECRET-NOT-AN-INTEGER'));
    }
  }
});

test('topology settings default independently, match example configuration and accept whole-unit overrides', () => {
  assert.deepEqual(loadConfig(baseEnv()).topology, { freshnessWindowMs: 72 * 3600000, maxObservationsPerMinute: 600, pruneAfterDays: 0 });
  assert.deepEqual(loadConfig(baseEnv({ PACKETCAPTURE_TOPOLOGY_FRESHNESS_HOURS: '96',
    PACKETCAPTURE_TOPOLOGY_MAX_OBSERVATIONS_PER_MINUTE: '6000', PACKETCAPTURE_TOPOLOGY_PRUNE_AFTER_DAYS: '7' })).topology,
  { freshnessWindowMs: 96 * 3600000, maxObservationsPerMinute: 6000, pruneAfterDays: 7 });
  const example = readFileSync('.env.example', 'utf8');
  for (const setting of ['PACKETCAPTURE_TOPOLOGY_FRESHNESS_HOURS=72', 'PACKETCAPTURE_TOPOLOGY_MAX_OBSERVATIONS_PER_MINUTE=600',
    'PACKETCAPTURE_TOPOLOGY_PRUNE_AFTER_DAYS=0']) assert.ok(example.includes(setting));
});
test('topology configuration rejects explicit blanks, fractions, unsafe values and bounds', () => {
  for (const [key, invalid] of [
    ['PACKETCAPTURE_TOPOLOGY_FRESHNESS_HOURS', ['0', '8761']],
    ['PACKETCAPTURE_TOPOLOGY_MAX_OBSERVATIONS_PER_MINUTE', ['0', '6001']],
    ['PACKETCAPTURE_TOPOLOGY_PRUNE_AFTER_DAYS', ['-1', '36501']]
  ]) for (const value of ['', ' ', '1.5', 'text', '90071992547409999', ...invalid]) {
    assert.throws(() => loadConfig(baseEnv({ [key]: value })), ConfigError);
  }
});

test('normalizes a minimal valid serial configuration with defaults', () => {
  const config = loadConfig(baseEnv());

  assert.equal(config.radio.type, 'serial');
  assert.deepEqual(config.radio.serialPorts, ['COM3']);
  assert.equal(config.radio.reconnect.maxRetries, 0);
  assert.equal(config.radio.reconnect.initialDelayMs, 3000);
  assert.equal(config.radio.reconnect.maxDelayMs, 15000);
  assert.equal(config.observer.iata, 'CVG');
  assert.equal(config.logging.level, 'info');
  assert.deepEqual(config.floodAdvert, { intervalHours: 47 });
  assert.deepEqual(config.brokers, []);
  assert.deepEqual(config.bots, []);
});

test('direct-heard fallback matches the example; valid whole-hour overrides win with dashboard disabled', () => {
  const key = 'PACKETCAPTURE_DIRECT_HEARD_WINDOW_HOURS';
  const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const hours = Number(example.match(/^PACKETCAPTURE_DIRECT_HEARD_WINDOW_HOURS=(\d+)$/m)[1]);
  const defaults = loadConfig(baseEnv());
  assert.equal(hours, 72);
  assert.equal(defaults.nodeObservations.directHeardWindowMs, hours * 3600000);
  assert.equal(defaults.metricsUi.enabled, false);
  for (const override of ['1', '96', '8760']) {
    assert.equal(loadConfig(baseEnv({ [key]: override })).nodeObservations.directHeardWindowMs, Number(override) * 3600000);
  }
});

test('fingerprint pruning defaults off in example and code; day overrides work without dashboard or brokers', () => {
  const key = 'PACKETCAPTURE_REPEATER_FINGERPRINT_PRUNE_AFTER_DAYS';
  const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const days = Number(example.match(/^PACKETCAPTURE_REPEATER_FINGERPRINT_PRUNE_AFTER_DAYS=(\d+)$/m)[1]);
  const defaults = loadConfig(baseEnv());
  assert.equal(days, 0);
  assert.equal(defaults.nodeObservations.repeaterFingerprintPruneAfterDays, days);
  assert.equal(defaults.metricsUi.enabled, false);
  assert.deepEqual(defaults.brokers, []);
  for (const override of ['0', '7', '36500']) {
    assert.equal(loadConfig(baseEnv({ [key]: override })).nodeObservations.repeaterFingerprintPruneAfterDays, Number(override));
  }
});

test('invalid explicit fingerprint pruning settings fail instead of silently selecting a default', () => {
  const key = 'PACKETCAPTURE_REPEATER_FINGERPRINT_PRUNE_AFTER_DAYS';
  for (const value of ['', ' ', '-1', '7.5', '36501', 'Infinity', 'seven']) {
    assert.throws(() => loadConfig(baseEnv({ [key]: value })), ConfigError);
  }
});

test('invalid explicit direct-heard windows fail configuration instead of silently using the fallback', () => {
  for (const value of ['', ' ', '0', '-1', '8761', '1.5', '24hours', 'NaN', 'Infinity']) {
    assert.throws(() => loadConfig(baseEnv({ PACKETCAPTURE_DIRECT_HEARD_WINDOW_HOURS: value })), ConfigError);
  }
});

test('accepts startup-only and 47-to-168-hour flood advert intervals', () => {
  assert.equal(loadConfig(baseEnv({ PACKETCAPTURE_FLOOD_ADVERT_INTERVAL_HOURS: '0' })).floodAdvert.intervalHours, 0);
  assert.equal(loadConfig(baseEnv({ PACKETCAPTURE_FLOOD_ADVERT_INTERVAL_HOURS: '47' })).floodAdvert.intervalHours, 47);
  assert.equal(loadConfig(baseEnv({ PACKETCAPTURE_FLOOD_ADVERT_INTERVAL_HOURS: '168' })).floodAdvert.intervalHours, 168);
});

test('rejects flood advert intervals below 47 hours except zero and above 168 hours', () => {
  for (const value of ['-1', '1', '2', '3', '46', '169', '47.5', 'hourly']) {
    assert.throws(
      () => loadConfig(baseEnv({ PACKETCAPTURE_FLOOD_ADVERT_INTERVAL_HOURS: value })),
      ConfigError,
      `expected ${value} to be rejected`
    );
  }
});

test('parses a comma-separated serial port list', () => {
  const config = loadConfig(baseEnv({ PACKETCAPTURE_SERIAL_PORTS: 'COM3, COM4' }));
  assert.deepEqual(config.radio.serialPorts, ['COM3', 'COM4']);
});

test('accepts a tcp configuration when host and port are set', () => {
  const config = loadConfig(
    baseEnv({
      PACKETCAPTURE_CONNECTION_TYPE: 'tcp',
      PACKETCAPTURE_SERIAL_PORTS: '',
      PACKETCAPTURE_TCP_HOST: 'radio.example.internal',
      PACKETCAPTURE_TCP_PORT: '5000'
    })
  );
  assert.equal(config.radio.type, 'tcp');
  assert.equal(config.radio.tcpHost, 'radio.example.internal');
  assert.equal(config.radio.tcpPort, 5000);
});

test('rejects serial configuration with no ports', () => {
  assert.throws(
    () => loadConfig(baseEnv({ PACKETCAPTURE_SERIAL_PORTS: '' })),
    ConfigError
  );
});

test('rejects tcp configuration missing host/port', () => {
  assert.throws(
    () =>
      loadConfig(
        baseEnv({ PACKETCAPTURE_CONNECTION_TYPE: 'tcp', PACKETCAPTURE_SERIAL_PORTS: '' })
      ),
    ConfigError
  );
});

test('rejects configuration missing observer IATA code', () => {
  assert.throws(() => loadConfig(baseEnv({ PACKETCAPTURE_IATA: '' })), ConfigError);
});

test('rejects a non-integer retry delay', () => {
  assert.throws(
    () => loadConfig(baseEnv({ PACKETCAPTURE_CONNECTION_RETRY_DELAY: 'soon' })),
    ConfigError
  );
});

test('rejects an integer with a non-numeric suffix rather than truncating it', () => {
  assert.throws(
    () => loadConfig(baseEnv({ PACKETCAPTURE_CONNECTION_RETRY_DELAY: '3000ms' })),
    ConfigError
  );
});

test('rejects a boolean value that is not exactly "true" or "false"', () => {
  assert.throws(
    () => loadConfig(baseEnv({ PACKETCAPTURE_METRICS_UI_ENABLED: 'tru' })),
    ConfigError
  );
});

test('accepts "false" (not just an absent/empty value) as an explicit boolean', () => {
  const config = loadConfig(baseEnv({ PACKETCAPTURE_METRICS_UI_ENABLED: 'false' }));
  assert.equal(config.metricsUi.enabled, false);
});

test('rejects an unknown radio connection type via schema validation', () => {
  assert.throws(
    () => loadConfig(baseEnv({ PACKETCAPTURE_CONNECTION_TYPE: 'bluetooth' })),
    ConfigError
  );
});

test('reads a single broker from the config file with defaults', () => {
  withTempBrokersFile(
    JSON.stringify([{ id: 'okimesh', enabled: true, host: 'mqtt1.okimesh.org', port: 1883, auth: { method: 'none' } }]),
    (filePath) => {
      const config = loadConfig(baseEnv({ PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath }));

      assert.equal(config.brokers.length, 1);
      const [broker] = config.brokers;
      assert.equal(broker.id, 'okimesh');
      assert.equal(broker.enabled, true);
      assert.equal(broker.host, 'mqtt1.okimesh.org');
      assert.equal(broker.port, 1883);
      assert.equal(broker.transport, 'tcp');
      assert.equal(broker.tls, false);
      assert.equal(broker.auth.method, 'none');
    }
  );
});

test('reads multiple brokers independently, including a token-authenticated broker', () => {
  const brokers = [
    {
      id: 'letsmesh',
      enabled: true,
      host: 'mqtt-us-v1.letsmesh.net',
      port: 443,
      transport: 'wss',
      tls: true,
      auth: { method: 'token', audience: 'letsmesh' }
    },
    { id: 'okimesh', enabled: true, host: 'mqtt1.okimesh.org', port: 1883, auth: { method: 'none' } }
  ];

  withTempBrokersFile(JSON.stringify(brokers), (filePath) => {
    const config = loadConfig(baseEnv({ PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath }));

    assert.equal(config.brokers.length, 2);
    const letsmesh = config.brokers.find((b) => b.id === 'letsmesh');
    const okimesh = config.brokers.find((b) => b.id === 'okimesh');
    assert.equal(letsmesh.transport, 'wss');
    assert.equal(letsmesh.tls, true);
    assert.equal(letsmesh.auth.method, 'token');
    assert.equal(letsmesh.auth.audience, 'letsmesh');
    assert.equal(okimesh.transport, 'tcp');
    assert.equal(okimesh.auth.method, 'none');
  });
});

test('rejects a broker with no host (schema requires one, enabled or not)', () => {
  withTempBrokersFile(JSON.stringify([{ id: 'okimesh', enabled: true, port: 1883, auth: { method: 'none' } }]), (filePath) => {
    assert.throws(() => loadConfig(baseEnv({ PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath })), ConfigError);
  });
});

test('rejects a brokers config file with duplicate broker ids', () => {
  const brokers = [
    { id: 'okimesh', enabled: true, host: 'mqtt1.okimesh.org', port: 1883, auth: { method: 'none' } },
    { id: 'okimesh', enabled: false, host: 'mqtt2.okimesh.org', port: 1883, auth: { method: 'none' } }
  ];
  withTempBrokersFile(JSON.stringify(brokers), (filePath) => {
    assert.throws(() => loadConfig(baseEnv({ PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath })), ConfigError);
  });
});

test('rejects a password-auth broker with no username in the config file', () => {
  const brokers = [{ id: 'private', enabled: true, host: 'mqtt.example.com', port: 1883, auth: { method: 'password' } }];
  withTempBrokersFile(JSON.stringify(brokers), (filePath) => {
    assert.throws(() => loadConfig(baseEnv({ PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath })), ConfigError);
  });
});

test('rejects a token-auth broker with no audience in the config file', () => {
  const brokers = [{ id: 'letsmesh', enabled: true, host: 'mqtt.example.com', port: 443, auth: { method: 'token' } }];
  withTempBrokersFile(JSON.stringify(brokers), (filePath) => {
    assert.throws(() => loadConfig(baseEnv({ PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath })), ConfigError);
  });
});

test('rejects a password-auth broker whose position-numbered PASSWORD env var is unset', () => {
  const brokers = [
    { id: 'private', enabled: true, host: 'mqtt.example.com', port: 1883, auth: { method: 'password', username: 'bot' } }
  ];
  withTempBrokersFile(JSON.stringify(brokers), (filePath) => {
    assert.throws(() => loadConfig(baseEnv({ PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath })), ConfigError);
  });
});

test('reads a password-auth broker password from PACKETCAPTURE_MQTT<n>_PASSWORD by array position', () => {
  const brokers = [
    { id: 'first', enabled: true, host: 'mqtt.example.com', port: 1883, auth: { method: 'none' } },
    { id: 'second', enabled: true, host: 'mqtt2.example.com', port: 1883, auth: { method: 'password', username: 'bot' } }
  ];
  withTempBrokersFile(JSON.stringify(brokers), (filePath) => {
    const config = loadConfig(
      baseEnv({ PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath, PACKETCAPTURE_MQTT2_PASSWORD: 'super-secret' })
    );
    const second = config.brokers.find((b) => b.id === 'second');
    assert.equal(second.auth.username, 'bot');
    assert.equal(second.auth.password, 'super-secret');
  });
});

test('resolves named broker passwords independently of array order and strips selectors from runtime config', () => {
  const brokers = [
    {
      id: 'alpha', enabled: true, host: 'mqtt.example.com', port: 1883,
      auth: { method: 'password', username: 'alpha-user', passwordEnv: 'MQTT_ALPHA_PASSWORD' }
    },
    {
      id: 'beta', enabled: true, host: 'mqtt2.example.com', port: 1883,
      auth: { method: 'password', username: 'beta-user', passwordEnv: 'MQTT_BETA_PASSWORD' }
    }
  ];
  const env = {
    PACKETCAPTURE_MQTT1_PASSWORD: 'wrong-first-position',
    PACKETCAPTURE_MQTT2_PASSWORD: 'wrong-second-position',
    MQTT_ALPHA_PASSWORD: 'alpha-secret',
    MQTT_BETA_PASSWORD: 'beta-secret'
  };

  for (const orderedBrokers of [brokers, [...brokers].reverse()]) {
    withTempBrokersFile(JSON.stringify(orderedBrokers), (filePath) => {
      const config = loadConfig(baseEnv({ ...env, PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath }));
      assert.equal(config.brokers.find((broker) => broker.id === 'alpha').auth.password, 'alpha-secret');
      assert.equal(config.brokers.find((broker) => broker.id === 'beta').auth.password, 'beta-secret');
      assert.equal('passwordEnv' in config.brokers[0].auth, false);
    });
  }
});

test('supports mixed named and legacy password mappings and permits shared named variables', () => {
  const brokers = [
    {
      id: 'named-one', enabled: true, host: 'mqtt.example.com', port: 1883,
      auth: { method: 'password', username: 'one', passwordEnv: 'MQTT_SHARED_PASSWORD' }
    },
    {
      id: 'named-two', enabled: true, host: 'mqtt2.example.com', port: 1883,
      auth: { method: 'password', username: 'two', passwordEnv: 'MQTT_SHARED_PASSWORD' }
    },
    { id: 'legacy', enabled: true, host: 'mqtt3.example.com', port: 1883, auth: { method: 'password', username: 'old' } }
  ];

  withTempBrokersFile(JSON.stringify(brokers), (filePath) => {
    const config = loadConfig(baseEnv({
      PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath,
      MQTT_SHARED_PASSWORD: 'shared-secret',
      PACKETCAPTURE_MQTT3_PASSWORD: 'legacy-secret'
    }));
    assert.equal(config.brokers.find((broker) => broker.id === 'named-one').auth.password, 'shared-secret');
    assert.equal(config.brokers.find((broker) => broker.id === 'named-two').auth.password, 'shared-secret');
    assert.equal(config.brokers.find((broker) => broker.id === 'legacy').auth.password, 'legacy-secret');
  });
});

test('does not fall back to a positional password when the named variable is missing or empty', () => {
  const brokers = [{
    id: 'private', enabled: true, host: 'mqtt.example.com', port: 1883,
    auth: { method: 'password', username: 'bot', passwordEnv: 'MQTT_PRIVATE_PASSWORD' }
  }];

  for (const namedValue of [undefined, '']) {
    const secretInLegacyVariable = 'legacy-secret-must-not-be-used-or-reported';
    withTempBrokersFile(JSON.stringify(brokers), (filePath) => {
      assert.throws(
        () => loadConfig(baseEnv({
          PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath,
          PACKETCAPTURE_MQTT1_PASSWORD: secretInLegacyVariable,
          ...(namedValue === undefined ? {} : { MQTT_PRIVATE_PASSWORD: namedValue })
        })),
        (error) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /MQTT_PRIVATE_PASSWORD/);
          assert.doesNotMatch(error.message, new RegExp(secretInLegacyVariable));
          return true;
        }
      );
    });
  }
});

test('requires a named password for disabled password-auth brokers as before', () => {
  const brokers = [{
    id: 'private', enabled: false, host: 'mqtt.example.com', port: 1883,
    auth: { method: 'password', username: 'bot', passwordEnv: 'MQTT_PRIVATE_PASSWORD' }
  }];
  withTempBrokersFile(JSON.stringify(brokers), (filePath) => {
    assert.throws(() => loadConfig(baseEnv({ PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath })), /MQTT_PRIVATE_PASSWORD/);
  });
});

test('preserves password whitespace exactly instead of trimming the secret', () => {
  const brokers = [{
    id: 'private', enabled: true, host: 'mqtt.example.com', port: 1883,
    auth: { method: 'password', username: 'bot', passwordEnv: 'MQTT_PRIVATE_PASSWORD' }
  }];
  withTempBrokersFile(JSON.stringify(brokers), (filePath) => {
    const config = loadConfig(baseEnv({
      PACKETCAPTURE_BROKERS_CONFIG_FILE: filePath,
      MQTT_PRIVATE_PASSWORD: '  literal password  '
    }));
    assert.equal(config.brokers[0].auth.password, '  literal password  ');
  });
});

test('loads bots from an explicitly configured bots config file', () => {
  const bots = [
    {
      name: 'echo',
      channel: '#echo',
      enabled: true,
      minHops: 1,
      commands: [{ trigger: '!echo', response: '🔁 {sender} {hopCount} {path}' }]
    }
  ];

  withTempBotsFile(JSON.stringify(bots), (filePath) => {
    const config = loadConfig(baseEnv({ PACKETCAPTURE_BOTS_CONFIG_FILE: filePath }));
    assert.equal(config.bots.length, 1);
    assert.equal(config.bots[0].name, 'echo');
    assert.equal(config.bots[0].commands[0].trigger, '!echo');
  });
});

test('loads a bot command with an overflowResponse through the full loadConfig pipeline', () => {
  // Regression coverage: loadBotsConfig() validates against
  // bots/schemas.js's botsConfigSchema, and loadConfig() then re-validates
  // the whole assembled config, including bots, against config/schema.js's
  // `bots` property - which is the same shared botConfigSchema object
  // (see the comment above it), not a hand-maintained mirror, so a field
  // like overflowResponse can't pass one and fail the other.
  const bots = [
    {
      name: 'echo',
      channel: '#echo',
      enabled: true,
      minHops: 1,
      commands: [
        {
          trigger: '!echo',
          response: '🔁 {sender} {hopCount} {path}',
          overflowResponse: '🔁 {sender} {hopCount} {hash}'
        }
      ]
    }
  ];

  withTempBotsFile(JSON.stringify(bots), (filePath) => {
    const config = loadConfig(baseEnv({ PACKETCAPTURE_BOTS_CONFIG_FILE: filePath }));
    assert.equal(config.bots[0].commands[0].overflowResponse, '🔁 {sender} {hopCount} {hash}');
  });
});

test('rejects an explicitly configured bots config file path that does not exist', () => {
  assert.throws(
    () => loadConfig(baseEnv({ PACKETCAPTURE_BOTS_CONFIG_FILE: 'does-not-exist.json' })),
    ConfigError
  );
});

test('rejects a malformed bots config file', () => {
  withTempBotsFile('not valid json', (filePath) => {
    assert.throws(() => loadConfig(baseEnv({ PACKETCAPTURE_BOTS_CONFIG_FILE: filePath })), ConfigError);
  });
});

test('defaults metricsUi to disabled and loopback-only', () => {
  const config = loadConfig(baseEnv());
  assert.deepEqual(config.metricsUi, {
    enabled: false,
    host: '127.0.0.1',
    port: 8090,
    sampleIntervalMs: 10000,
    dbPath: 'data/metrics.sqlite3',
    retentionDays: 0,
    maxChartBuckets: 180,
    runtimeEventMaxPerMinute: 60
  });
});

test('reads metricsUi overrides from the environment', () => {
  const config = loadConfig(
    baseEnv({
      PACKETCAPTURE_METRICS_UI_ENABLED: 'true',
      PACKETCAPTURE_METRICS_UI_HOST: '0.0.0.0',
      PACKETCAPTURE_METRICS_UI_PORT: '9000',
      PACKETCAPTURE_METRICS_UI_SAMPLE_INTERVAL_MS: '5000',
      PACKETCAPTURE_METRICS_UI_DB_PATH: 'var/custom-metrics.sqlite3',
      PACKETCAPTURE_METRICS_UI_RETENTION_DAYS: '30',
      PACKETCAPTURE_METRICS_UI_MAX_CHART_BUCKETS: '90',
      PACKETCAPTURE_RUNTIME_EVENT_MAX_PER_MINUTE: '120'
    })
  );
  assert.deepEqual(config.metricsUi, {
    enabled: true,
    host: '0.0.0.0',
    port: 9000,
    sampleIntervalMs: 5000,
    dbPath: 'var/custom-metrics.sqlite3',
    retentionDays: 30,
    maxChartBuckets: 90,
    runtimeEventMaxPerMinute: 120
  });
});

test('rejects a negative metricsUi retention window', () => {
  assert.throws(
    () => loadConfig(baseEnv({ PACKETCAPTURE_METRICS_UI_RETENTION_DAYS: '-1' })),
    ConfigError
  );
});

test('runtime event budget defaults match the example and rejects invalid explicit values', () => {
  const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const value = example.match(/^PACKETCAPTURE_RUNTIME_EVENT_MAX_PER_MINUTE=(\d+)$/m)?.[1];
  assert.equal(Number(value), loadConfig(baseEnv()).metricsUi.runtimeEventMaxPerMinute);
  for (const input of ['0', '-1', '601', '1.5', 'no', '']) {
    assert.throws(() => loadConfig(baseEnv({ PACKETCAPTURE_RUNTIME_EVENT_MAX_PER_MINUTE: input })), ConfigError);
  }
  assert.equal(loadConfig(baseEnv({ PACKETCAPTURE_RUNTIME_EVENT_MAX_PER_MINUTE: '1' })).metricsUi.runtimeEventMaxPerMinute, 1);
  assert.equal(loadConfig(baseEnv({ PACKETCAPTURE_RUNTIME_EVENT_MAX_PER_MINUTE: '600' })).metricsUi.runtimeEventMaxPerMinute, 600);
});

test('rejects a metricsUi max chart bucket count below the schema minimum', () => {
  assert.throws(
    () => loadConfig(baseEnv({ PACKETCAPTURE_METRICS_UI_MAX_CHART_BUCKETS: '1' })),
    ConfigError
  );
});

test('defaults botReplyQueue to a 5s quiet window, 60s TTL, and a 10s repeat-check timeout', () => {
  const config = loadConfig(baseEnv());
  assert.deepEqual(config.botReplyQueue, { quietMs: 5000, ttlMs: 60000, repeatCheckTimeoutMs: 10000 });
});

test('reads botReplyQueue overrides from the environment, including disabling the quiet requirement with 0', () => {
  const config = loadConfig(
    baseEnv({
      PACKETCAPTURE_BOT_REPLY_QUIET_MS: '0',
      PACKETCAPTURE_BOT_REPLY_TTL_MS: '10000',
      PACKETCAPTURE_BOT_REPLY_REPEAT_CHECK_MS: '15000'
    })
  );
  assert.deepEqual(config.botReplyQueue, { quietMs: 0, ttlMs: 10000, repeatCheckTimeoutMs: 15000 });
});

test('accepts a zero repeat-check timeout', () => {
  const config = loadConfig(baseEnv({ PACKETCAPTURE_BOT_REPLY_REPEAT_CHECK_MS: '0' }));
  assert.equal(config.botReplyQueue.repeatCheckTimeoutMs, 0);
});

test('rejects a botReplyQueue TTL shorter than its quiet window', () => {
  assert.throws(
    () =>
      loadConfig(
        baseEnv({
          PACKETCAPTURE_BOT_REPLY_QUIET_MS: '5000',
          PACKETCAPTURE_BOT_REPLY_TTL_MS: '1000'
        })
      ),
    ConfigError
  );
});

test('rejects a negative botReplyQueue bound', () => {
  assert.throws(
    () => loadConfig(baseEnv({ PACKETCAPTURE_BOT_REPLY_QUIET_MS: '-1' })),
    ConfigError
  );
});
