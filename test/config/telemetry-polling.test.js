import { test, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { spawnSync } from 'node:child_process';
import { loadConfig, ConfigError } from '../../src/config/index.js';
import { configSchema } from '../../src/config/schema.js';
import { compileSchema } from '../../src/validation/ajv.js';
import { createLogger } from '../../src/logging/logger.js';
import { withTelemetryGuestPassword, loadTelemetryPolling } from '../../src/telemetry/polling-config.js';
import { TELEMETRY_POLL_DEFAULTS, TELEMETRY_POLL_NUMERIC_SETTINGS, TELEMETRY_POLL_COMPONENT_DEFAULTS,
  TELEMETRY_POLL_NEIGHBOUR_DEFAULTS, TELEMETRY_POLL_STATUS_DEFAULT, TELEMETRY_POLL_ENABLED_ENV_KEY,
  TELEMETRY_POLL_CONFIG_ENV_KEY, TELEMETRY_POLL_SECRETS_ENV_KEY, TELEMETRY_POLL_FILE_MAX_BYTES,
  telemetryPollConfigSchema } from '../../src/telemetry/polling-schemas.js';
import { remoteRequestSchema } from '../../src/radio/remote-request-schemas.js';
import { telemetryOutcomeSchema } from '../../src/telemetry/telemetry-schemas.js';

const root = mkdtempSync(join(tmpdir(), 'meshcore-telemetry-poll-config-'));
const bots = join(root, 'bots.json'), brokers = join(root, 'brokers.json');
writeFileSync(bots, '[]'); writeFileSync(brokers, '[]');
afterAll(() => {
  // Verify the absolute generated target stays inside the intended temp root.
  assert.ok(realpathSync(root).startsWith(realpathSync(tmpdir()) + sep));
  assert.ok(resolve(root).includes('meshcore-telemetry-poll-config-'));
  rmSync(root, { recursive: true, force: true });
});
const A = 'A'.repeat(64), B = 'B'.repeat(64), C = 'C'.repeat(64), D = 'D'.repeat(64);
const policy = () => ({ version: 1, defaultCredentialRef: 'defaultPrivateRef',
  groups: [{ id: 'privateGroup', credentialRef: 'groupPrivateRef', targetPublicKeys: [A, B] }],
  targets: [{ targetPublicKey: A, credentialRef: 'targetPrivateRef' },
    { targetPublicKey: B, emitterProfile: 'positive-channels' },
    { targetPublicKey: C, statusProfile: { layout: 'current56', evidence: 'established' } }] });
const secretFile = () => ({ version: 1, secrets: {
  defaultPrivateRef: 'DEFAULT-7', groupPrivateRef: 'GROUP-7', targetPrivateRef: 'TARGET-7'
} });
let sequence = 0;
function files(p = policy(), s = secretFile()) {
  const policyPath = join(root, `private-policy-${sequence++}.json`);
  const secretsPath = join(root, `private-secrets-${sequence++}.json`);
  writeFileSync(policyPath, typeof p === 'string' || Buffer.isBuffer(p) ? p : JSON.stringify(p));
  writeFileSync(secretsPath, typeof s === 'string' || Buffer.isBuffer(s) ? s : JSON.stringify(s));
  return { [TELEMETRY_POLL_CONFIG_ENV_KEY]: policyPath, [TELEMETRY_POLL_SECRETS_ENV_KEY]: secretsPath };
}
const base = overrides => ({ PACKETCAPTURE_CONNECTION_TYPE: 'serial', PACKETCAPTURE_SERIAL_PORTS: 'COM3',
  PACKETCAPTURE_IATA: 'CVG', PACKETCAPTURE_BOTS_CONFIG_FILE: bots, PACKETCAPTURE_BROKERS_CONFIG_FILE: brokers,
  ...overrides });
const enabled = overrides => loadConfig(base({ [TELEMETRY_POLL_ENABLED_ENV_KEY]: 'true', ...files(), ...overrides })).telemetryPolling;
const safeError = action => assert.throws(action, error => error instanceof ConfigError
  && /telemetry polling/i.test(error.message)
  && !/private-policy|private-secrets|PrivateRef|privateGroup|DEFAULT-7|GROUP-7|TARGET-7|SECRET-SENTINEL/.test(inspect(error)));
const samplePassword = (config, key) => withTelemetryGuestPassword(config, { targetPublicKey: key }, password => password);

test('disabled defaults are inert, secret-free and independent of existing telemetry/region/retention settings', async () => {
  const config = loadConfig(base());
  assert.deepEqual(config.telemetryPolling, { ...TELEMETRY_POLL_DEFAULTS,
    components: TELEMETRY_POLL_COMPONENT_DEFAULTS, neighbourParams: TELEMETRY_POLL_NEIGHBOUR_DEFAULTS,
    statusProfile: TELEMETRY_POLL_STATUS_DEFAULT, emitterProfile: 'unknown', permissionMask: 0, targetProfiles: [] });
  assert.deepEqual(config.telemetry, { freshnessWindowMs: 72 * 3600000 });
  assert.equal(config.metricsUi.retentionDays, 0);
  assert.equal(config.telemetryPolling.enabled, false);
  assert.equal(Object.isFrozen(config.telemetryPolling.neighbourParams), true);
  const consume = vi.fn();
  await assert.rejects(withTelemetryGuestPassword(config.telemetryPolling, { targetPublicKey: A }, consume), /unavailable/);
  assert.equal(consume.mock.calls.length, 0);
});

test('every code/example default matches and boundary overrides remain independent', () => {
  const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const defaults = loadConfig(base());
  for (const { field, key, scale, min, max } of TELEMETRY_POLL_NUMERIC_SETTINGS) {
    assert.match(example, new RegExp(`^${key}=${TELEMETRY_POLL_DEFAULTS[field] / scale}$`, 'm'));
    for (const value of [min, max]) {
      const changes = { [key]: ` ${value} ` };
      if (field === 'retryBaseMs') changes.PACKETCAPTURE_TELEMETRY_POLL_RETRY_MAX_MINUTES = String(max);
      if (field === 'retryMaxMs') changes.PACKETCAPTURE_TELEMETRY_POLL_RETRY_BASE_MINUTES = '1';
      const config = loadConfig(base(changes));
      assert.equal(config.telemetryPolling[field], value * scale);
      assert.deepEqual(config.telemetry, defaults.telemetry);
      assert.deepEqual(config.regions, defaults.regions);
      assert.deepEqual(config.remoteRequests, defaults.remoteRequests);
      assert.equal(config.metricsUi.retentionDays, defaults.metricsUi.retentionDays);
    }
  }
  assert.match(example, new RegExp(`^${TELEMETRY_POLL_ENABLED_ENV_KEY}=false$`, 'm'));
});

test('all invalid explicit polling numbers/paths/booleans fail safely, including while disabled', () => {
  for (const { key, min, max } of TELEMETRY_POLL_NUMERIC_SETTINGS) {
    for (const raw of ['', ' ', '-1', String(min - 1), String(max + 1), '1.5', '1e2', '0x10',
      '10junk', '9'.repeat(33), 'SECRET-SENTINEL', null, 1, {}]) safeError(() => loadConfig(base({ [key]: raw })));
  }
  for (const raw of ['', ' ', 'yes', 'SECRET-SENTINEL', null, true, {}]) {
    safeError(() => loadConfig(base({ [TELEMETRY_POLL_ENABLED_ENV_KEY]: raw })));
  }
  for (const key of [TELEMETRY_POLL_CONFIG_ENV_KEY, TELEMETRY_POLL_SECRETS_ENV_KEY]) {
    for (const raw of ['', ' ', '\u0000SECRET-SENTINEL', 'x'.repeat(4097), null, true, {}]) {
      safeError(() => loadConfig(base({ [key]: raw })));
    }
  }
  safeError(() => loadConfig(base({ PACKETCAPTURE_TELEMETRY_POLL_RETRY_BASE_MINUTES: '361' })));
  assert.equal(loadConfig(base({ PACKETCAPTURE_TELEMETRY_POLL_ENABLED: ' FALSE ' })).telemetryPolling.enabled, false);
});

test('enabled or explicit disabled configuration requires both protected files', () => {
  safeError(() => loadConfig(base({ [TELEMETRY_POLL_ENABLED_ENV_KEY]: 'true' })));
  const paths = files();
  for (const key of Object.keys(paths)) for (const flag of ['true', 'false']) {
    safeError(() => loadConfig(base({ [TELEMETRY_POLL_ENABLED_ENV_KEY]: flag, [key]: paths[key] })));
  }
});

test('default/group/full-key precedence and profile-only inheritance do not guess another credential', async () => {
  const config = enabled();
  assert.equal(await samplePassword(config, A), 'TARGET-7');
  assert.equal(await samplePassword(config, B), 'GROUP-7');
  assert.equal(await samplePassword(config, C), 'DEFAULT-7');
  assert.equal(await samplePassword(config, D), 'DEFAULT-7');
  assert.deepEqual(config.targetProfiles, [
    { targetPublicKey: B, statusProfile: TELEMETRY_POLL_STATUS_DEFAULT, emitterProfile: 'positive-channels' },
    { targetPublicKey: C, statusProfile: { layout: 'current56', evidence: 'established' }, emitterProfile: 'unknown' }
  ]);
  assert.deepEqual(config.statusProfile, TELEMETRY_POLL_STATUS_DEFAULT);
  assert.equal(config.permissionMask, 0);
});

test('explicit disabled files are fully validated but retain no usable credentials', async () => {
  const config = loadConfig(base(files())).telemetryPolling;
  const consume = vi.fn();
  await assert.rejects(withTelemetryGuestPassword(config, { targetPublicKey: A }, consume), /unavailable/);
  assert.equal(consume.mock.calls.length, 0);
  const p = policy(); p.targets.push({ targetPublicKey: A });
  safeError(() => loadConfig(base(files(p))));
});

test('original immutable config is required; serialization, mutation and invalid target data cannot recover credentials', async () => {
  const config = enabled(); const consume = vi.fn();
  for (const clone of [{ ...config }, JSON.parse(JSON.stringify(config)), null]) {
    await assert.rejects(withTelemetryGuestPassword(clone, { targetPublicKey: A }, consume), /unavailable/);
  }
  for (const target of [{ targetPublicKey: 'repeater-name' }, { targetPublicKey: A.toLowerCase() },
    { targetPublicKey: A, credentialRef: 'targetPrivateRef' }, {}, null]) {
    await assert.rejects(withTelemetryGuestPassword(config, target, consume), /unavailable/);
  }
  await assert.rejects(withTelemetryGuestPassword(config, { targetPublicKey: A }, null), /unavailable/);
  assert.equal(consume.mock.calls.length, 0);
  assert.throws(() => { config.enabled = false; }, TypeError);
  assert.throws(() => { config.targetProfiles[0].statusProfile.evidence = 'established'; }, TypeError);
});

test('private configuration, async/sync consumer failures and ordinary logging never expose paths/references/passwords', async () => {
  const config = enabled();
  const lines = []; const out = vi.spyOn(console, 'log').mockImplementation(line => lines.push(line));
  const err = vi.spyOn(console, 'error').mockImplementation(line => lines.push(line));
  try {
    createLogger({ level: 'debug' }).info('services.telemetry', 'configuration validated', { polling: config });
    for (const consumer of [password => { throw new Error(password + ':targetPrivateRef'); },
      async password => { throw new Error(password + ':private-secrets'); }]) {
      await assert.rejects(withTelemetryGuestPassword(config, { targetPublicKey: A }, consumer), error => {
        createLogger().warn('services.telemetry', error.message);
        return error.message === 'Telemetry guest credential consumer failed' && !('cause' in error);
      });
    }
  } finally { out.mockRestore(); err.mockRestore(); }
  for (const value of [JSON.stringify(config), inspect(config, { showHidden: true, depth: null }), ...lines]) {
    assert.doesNotMatch(value, /PrivateRef|privateGroup|DEFAULT-7|GROUP-7|TARGET-7|private-policy|private-secrets/);
  }
});

test('missing, directory, oversized, malformed and invalid UTF-8 files produce fixed errors without excerpts', () => {
  const directory = join(root, 'SECRET-SENTINEL-directory'); mkdirSync(directory);
  const corruptions = [join(root, 'SECRET-SENTINEL-missing'), directory];
  for (const key of [TELEMETRY_POLL_CONFIG_ENV_KEY, TELEMETRY_POLL_SECRETS_ENV_KEY]) {
    for (const path of corruptions) safeError(() => enabled({ [key]: path }));
  }
  for (const content of ['{"SECRET-SENTINEL":', Buffer.from([0xC3, 0x28]), 'SECRET-SENTINEL'.repeat(6000)]) {
    safeError(() => enabled(files(content, secretFile())));
    safeError(() => enabled(files(policy(), content)));
  }
  const minimal = JSON.stringify({ version: 1, defaultCredentialRef: 'defaultPrivateRef' });
  const exact = minimal + ' '.repeat(TELEMETRY_POLL_FILE_MAX_BYTES - Buffer.byteLength(minimal));
  assert.equal(enabled(files(exact)).enabled, true);
  safeError(() => enabled(files(exact + ' ')));
});

test('unknown/private fields and malformed shapes are rejected before resolution', () => {
  const variants = [null, [], {}, { ...policy(), version: 2 }, { ...policy(), password: 'SECRET-SENTINEL' },
    { ...policy(), components: { status: 1 } }, { ...policy(), components: { all: true } },
    { ...policy(), groups: [{ id: 'g', credentialRef: 'groupPrivateRef', targetPublicKeys: [A], password: 'SECRET-SENTINEL' }] },
    { ...policy(), targets: [{ targetPublicKey: A, management: true }] },
    { ...policy(), targets: [{ targetPublicKey: 'prefix' }] },
    { ...policy(), targets: [{ targetPublicKey: A.toLowerCase() }] }];
  for (const p of variants) safeError(() => enabled(files(p)));
  for (const s of [null, [], {}, { ...secretFile(), version: 2 }, { ...secretFile(), password: 'SECRET-SENTINEL' },
    { version: 1, secrets: {} }, { version: 1, secrets: { 'bad.reference': 'DEFAULT-7' } },
    { version: 1, secrets: { defaultPrivateRef: { password: 'SECRET-SENTINEL' } } }]) safeError(() => enabled(files(policy(), s)));
});

test('duplicates, overlapping groups and missing references including shadowed/unused references fail closed', () => {
  const variants = [];
  let p = policy(); p.targets.push({ targetPublicKey: A }); variants.push(p);
  p = policy(); p.groups.push({ id: 'other', credentialRef: 'groupPrivateRef', targetPublicKeys: [A] }); variants.push(p);
  p = policy(); p.groups.push({ id: 'privateGroup', credentialRef: 'groupPrivateRef', targetPublicKeys: [D] }); variants.push(p);
  p = policy(); p.groups[0].targetPublicKeys.push(A); variants.push(p);
  for (const source of ['default', 'group', 'target']) {
    p = policy();
    if (source === 'default') p.defaultCredentialRef = 'SECRET-SENTINEL';
    if (source === 'group') p.groups[0].credentialRef = 'SECRET-SENTINEL';
    if (source === 'target') p.targets[0].credentialRef = 'SECRET-SENTINEL';
    variants.push(p);
  }
  for (const item of variants) safeError(() => enabled(files(item)));
});

test('bounded references/groups/total assignments reject excess while accepting the maximum distinct set', () => {
  const keys = Array.from({ length: 257 }, (_, index) => index.toString(16).padStart(64, '0').toUpperCase());
  const p = { version: 1, defaultCredentialRef: 'defaultPrivateRef',
    groups: [{ id: 'g', credentialRef: 'groupPrivateRef', targetPublicKeys: keys.slice(0, 256) }] };
  assert.equal(enabled(files(p)).enabled, true);
  safeError(() => enabled(files({ ...p, targets: [{ targetPublicKey: keys[256] }] })));
  safeError(() => enabled(files({ ...p, targets: keys.map(targetPublicKey => ({ targetPublicKey })) })));
  safeError(() => enabled(files({ ...p, groups: Array.from({ length: 17 }, (_, i) =>
    ({ id: 'group' + i, credentialRef: 'defaultPrivateRef', targetPublicKeys: [keys[i]] })) })));
  safeError(() => enabled(files(policy(), { version: 1, secrets: Object.fromEntries(
    Array.from({ length: 33 }, (_, i) => ['ref' + i, 'DEFAULT-7'])) })));
  safeError(() => enabled(files({ ...policy(), defaultCredentialRef: 'x'.repeat(33) })));
});

test('guest password byte limits reject controls, invalid Unicode, blank, oversize and unused invalid values without truncation', async () => {
  for (const password of ['', ' ', ' '.repeat(15), 'a'.repeat(16), '😀'.repeat(4), 'é'.repeat(8), '\u0000', 'ok\n',
    'ok\t', 'ok\u007F', 'ok\u0080', '\uD800', '\uDC00', 'x\uD800y', null, 7]) {
    const s = secretFile(); s.secrets.unused = password;
    safeError(() => enabled(files(policy(), s)));
  }
  for (const password of ['x', 'x'.repeat(15), 'é'.repeat(7) + 'x', '😀😀😀abc', ' guest value ']) {
    const s = secretFile(); s.secrets.defaultPrivateRef = password;
    const config = enabled(files(policy(), s));
    assert.equal(await samplePassword(config, D), password);
  }
});

test('component/page/profile choices are strict and unknown interpretations remain conservative', () => {
  const p = { version: 1, defaultCredentialRef: 'defaultPrivateRef', components: { sensors: false },
    neighbours: { count: 1, offset: 65535, orderBy: 3 } };
  const config = enabled(files(p));
  assert.deepEqual(config.components, { status: true, sensors: false, neighbours: true });
  assert.deepEqual(config.neighbourParams, { version: 0, count: 1, offset: 65535, orderBy: 3, prefixLength: 32 });
  for (const component of [{ status: false, sensors: false, neighbours: false }, { sensors: 'false' }]) {
    safeError(() => enabled(files({ ...p, components: component })));
  }
  for (const neighbours of [{ count: 0 }, { count: 4 }, { version: 1 }, { prefixLength: 4 }, { offset: -1 }, { orderBy: 4 }]) {
    safeError(() => enabled(files({ ...p, neighbours })));
  }
  for (const override of [{ statusProfile: { layout: 'current56', evidence: 'unknown' } },
    { statusProfile: { layout: 'auto', evidence: 'established' } }, { emitterProfile: 'unknown' },
    { emitterProfile: 'positive-channels', password: 'SECRET-SENTINEL' }]) {
    safeError(() => enabled(files({ ...p, targets: [{ targetPublicKey: A, ...override }] })));
  }
});

test('synthetic examples validate without inspecting operator files and edits require a new startup snapshot', async () => {
  const p = readFileSync(new URL('../../telemetry.config.example.json', import.meta.url), 'utf8');
  const s = readFileSync(new URL('../../telemetry.secrets.example.json', import.meta.url), 'utf8');
  const paths = files(p, s); const config = enabled(paths);
  assert.equal(await samplePassword(config, A), 'EXAMPLE-GROUP');
  assert.equal(await samplePassword(config, B), 'EXAMPLE-TARGET');
  assert.equal(await samplePassword(config, D), 'EXAMPLE-ONLY');
  writeFileSync(paths[TELEMETRY_POLL_SECRETS_ENV_KEY], s.replace('EXAMPLE-ONLY', 'CHANGED-ONLY'));
  assert.equal(await samplePassword(config, D), 'EXAMPLE-ONLY');
  assert.equal(await samplePassword(enabled(paths), D), 'CHANGED-ONLY');
});

test('public config/request/saved-outcome schemas reject every credential field instead of serializing it', () => {
  const config = loadConfig(base()); const validConfig = compileSchema(configSchema);
  const pollValid = compileSchema(telemetryPollConfigSchema);
  const requestValid = compileSchema(remoteRequestSchema), outcomeValid = compileSchema(telemetryOutcomeSchema);
  const requestId = '11111111-1111-4111-8111-111111111111';
  const request = { requestId, targetPublicKey: A, operation: 'telemetry', params: { permissionMask: 0 } };
  const outcome = { requestId, runId: requestId, observerPublicKey: B, targetPublicKey: A,
    variant: { component: 'sensors', params: { permissionMask: 0 } }, startedAt: 1, completedAt: 2,
    receivedAt: null, clockAnomaly: false, tag: null, route: null, status: 'failed', reason: 'response-timeout' };
  assert.equal(validConfig(config), true); assert.equal(requestValid(request), true); assert.equal(outcomeValid(outcome), true);
  for (const key of ['password', 'secret', 'credentialRef', 'credentialHash', 'secretsPath']) {
    assert.equal(pollValid({ ...config.telemetryPolling, [key]: 'SECRET-SENTINEL' }), false);
    assert.equal(validConfig({ ...config, telemetryPolling: { ...config.telemetryPolling, [key]: 'SECRET-SENTINEL' } }), false);
    assert.equal(requestValid({ ...request, [key]: 'SECRET-SENTINEL' }), false);
    assert.equal(outcomeValid({ ...outcome, [key]: 'SECRET-SENTINEL' }), false);
  }
  assert.throws(() => loadTelemetryPolling({ settings: { ...TELEMETRY_POLL_DEFAULTS }, policyPath: null,
    secretsPath: null, password: 'SECRET-SENTINEL' }), /Invalid telemetry polling settings/);
});

test('real entrypoint rejects polling errors before creating the owned store or starting radio/network work', () => {
  const paths = files();
  const invalids = [{ PACKETCAPTURE_TELEMETRY_POLL_RADIUS: '0' },
    { ...paths, [TELEMETRY_POLL_ENABLED_ENV_KEY]: 'true', [TELEMETRY_POLL_SECRETS_ENV_KEY]: join(root, 'SECRET-SENTINEL-missing') },
    { ...files(policy(), '{"SECRET-SENTINEL":'), [TELEMETRY_POLL_ENABLED_ENV_KEY]: 'false' }];
  for (const overrides of invalids) {
    const dbPath = join(root, `uncreated-${sequence++}.sqlite`);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PACKETCAPTURE_')));
    const result = spawnSync(process.execPath, [resolve('src/index.js')], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
      env: { ...inherited, ...base(overrides), PACKETCAPTURE_METRICS_UI_DB_PATH: dbPath } });
    assert.equal(result.status, 1, result.error?.message);
    assert.match(result.stderr, /Configuration error:.*telemetry polling/i);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET-SENTINEL|private-policy|private-secrets|meshcore-observer starting|tcp connection|serial connection/);
    assert.equal(existsSync(dbPath), false);
  }
});
