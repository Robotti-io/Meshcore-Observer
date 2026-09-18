import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, ConfigError } from '../../src/config/index.js';

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

// baseEnv() always points PACKETCAPTURE_BOTS_CONFIG_FILE at a real, empty
// bots file explicitly, rather than relying on the default path being
// absent from the current working directory - a real bots.config.json can
// legitimately exist there for local use (see .gitignore), and this must
// stay deterministic regardless.
const emptyBotsDir = mkdtempSync(join(tmpdir(), 'meshcore-config-empty-bots-'));
const emptyBotsFile = join(emptyBotsDir, 'bots.config.json');
writeFileSync(emptyBotsFile, '[]', 'utf8');
after(() => rmSync(emptyBotsDir, { recursive: true, force: true }));

function baseEnv(overrides = {}) {
  return {
    PACKETCAPTURE_CONNECTION_TYPE: 'serial',
    PACKETCAPTURE_SERIAL_PORTS: 'COM3',
    PACKETCAPTURE_IATA: 'CVG',
    PACKETCAPTURE_BOTS_CONFIG_FILE: emptyBotsFile,
    ...overrides
  };
}

test('normalizes a minimal valid serial configuration with defaults', () => {
  const config = loadConfig(baseEnv());

  assert.equal(config.radio.type, 'serial');
  assert.deepEqual(config.radio.serialPorts, ['COM3']);
  assert.equal(config.radio.reconnect.maxRetries, 0);
  assert.equal(config.radio.reconnect.initialDelayMs, 3000);
  assert.equal(config.radio.reconnect.maxDelayMs, 15000);
  assert.equal(config.observer.iata, 'CVG');
  assert.equal(config.logging.level, 'info');
  assert.deepEqual(config.brokers, []);
  assert.deepEqual(config.bots, []);
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

test('rejects an unknown radio connection type via schema validation', () => {
  assert.throws(
    () => loadConfig(baseEnv({ PACKETCAPTURE_CONNECTION_TYPE: 'bluetooth' })),
    ConfigError
  );
});

test('reads a single broker slot with defaults', () => {
  const config = loadConfig(
    baseEnv({
      PACKETCAPTURE_MQTT1_ENABLED: 'true',
      PACKETCAPTURE_MQTT1_HOST: 'mqtt1.okimesh.org',
      PACKETCAPTURE_MQTT1_PORT: '1883'
    })
  );

  assert.equal(config.brokers.length, 1);
  const [broker] = config.brokers;
  assert.equal(broker.id, 'mqtt1');
  assert.equal(broker.enabled, true);
  assert.equal(broker.host, 'mqtt1.okimesh.org');
  assert.equal(broker.port, 1883);
  assert.equal(broker.transport, 'tcp');
  assert.equal(broker.tls, false);
  assert.equal(broker.auth.method, 'none');
});

test('reads multiple broker slots independently, including a token-authenticated broker', () => {
  const config = loadConfig(
    baseEnv({
      PACKETCAPTURE_MQTT1_ID: 'letsmesh',
      PACKETCAPTURE_MQTT1_ENABLED: 'true',
      PACKETCAPTURE_MQTT1_HOST: 'mqtt-us-v1.letsmesh.net',
      PACKETCAPTURE_MQTT1_PORT: '443',
      PACKETCAPTURE_MQTT1_TRANSPORT: 'wss',
      PACKETCAPTURE_MQTT1_TLS: 'true',
      PACKETCAPTURE_MQTT1_AUTH_METHOD: 'token',
      PACKETCAPTURE_MQTT1_TOKEN_AUDIENCE: 'letsmesh',
      PACKETCAPTURE_MQTT2_ID: 'okimesh',
      PACKETCAPTURE_MQTT2_ENABLED: 'true',
      PACKETCAPTURE_MQTT2_HOST: 'mqtt1.okimesh.org',
      PACKETCAPTURE_MQTT2_PORT: '1883'
    })
  );

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

test('rejects an enabled broker with no host', () => {
  assert.throws(
    () =>
      loadConfig(
        baseEnv({
          PACKETCAPTURE_MQTT1_ENABLED: 'true',
          PACKETCAPTURE_MQTT1_PORT: '1883'
        })
      ),
    ConfigError
  );
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
