import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { compileSchema } from '../validation/ajv.js';
import { TELEMETRY_POLL_FILE_MAX_BYTES, TELEMETRY_POLL_MAX_TARGETS,
  TELEMETRY_POLL_COMPONENT_DEFAULTS, TELEMETRY_POLL_NEIGHBOUR_DEFAULTS,
  TELEMETRY_POLL_STATUS_DEFAULT, telemetryPollLoadSchema, telemetryPollPolicySchema,
  telemetryPollSecretsSchema, telemetryPollConfigSchema, telemetryPollTargetSchema } from './polling-schemas.js';

const loadValid = compileSchema(telemetryPollLoadSchema);
const policyValid = compileSchema(telemetryPollPolicySchema);
const secretsValid = compileSchema(telemetryPollSecretsSchema);
const configValid = compileSchema(telemetryPollConfigSchema);
const targetValid = compileSchema(telemetryPollTargetSchema);
const credentials = new WeakMap();
const MESSAGES = Object.freeze({
  settings: 'Invalid telemetry polling settings: check configured whole-number bounds and retry maximum >= retry base',
  files: 'Telemetry polling requires policy and secret files together; set PACKETCAPTURE_TELEMETRY_POLL_CONFIG_FILE and PACKETCAPTURE_TELEMETRY_POLL_SECRETS_FILE',
  policy: 'Invalid telemetry polling policy file: use version 1, allowed fields and bounded full public-key target/group assignments',
  secrets: 'Invalid telemetry polling secret file: use version 1, bounded references and guest passwords of 1 to 15 UTF-8 bytes without controls or invalid encoding',
  read: 'Cannot read telemetry polling files: supply readable regular UTF-8 JSON files of at most 65536 bytes',
  assignments: 'Invalid telemetry polling assignments: target and group IDs must be unique, group membership unambiguous and total distinct targets <= 256',
  references: 'Invalid telemetry polling credential references: every default, group and target reference must exist in the secret file',
  components: 'Invalid telemetry polling components: enable at least one of status, sensors or neighbours'
});

export class TelemetryPollingConfigError extends Error {
  constructor(code) {
    super(MESSAGES[code] ?? MESSAGES.settings);
    this.name = 'TelemetryPollingConfigError';
  }
}
const fail = code => { throw new TelemetryPollingConfigError(code); };

// Read at most the approved byte cap plus one overflow byte, even if a file
// grows after fstat. Underlying OS errors, JSON excerpts and filenames never
// escape this boundary. A fixed-size buffer is cleared after decoding.
function readJson(filePath) {
  let fd;
  const bytes = Buffer.alloc(TELEMETRY_POLL_FILE_MAX_BYTES + 1);
  try {
    fd = openSync(filePath, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > TELEMETRY_POLL_FILE_MAX_BYTES) fail('read');
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > TELEMETRY_POLL_FILE_MAX_BYTES) fail('read');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    return JSON.parse(text);
  } catch { fail('read'); }
  finally {
    bytes.fill(0);
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Never expose an OS error containing a private path. */ }
    }
  }
}

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

/** Called only by central configuration, before application startup effects. */
export function loadTelemetryPolling(input) {
  if (!loadValid(input) || input.settings.retryBaseMs > input.settings.retryMaxMs) fail('settings');
  const { settings, policyPath, secretsPath } = input;
  const supplied = policyPath !== null || secretsPath !== null;
  if ((supplied || settings.enabled) && (policyPath === null || secretsPath === null)) fail('files');

  let policy = {};
  let secrets = new Map();
  if (supplied) {
    policy = readJson(policyPath);
    if (!policyValid(policy)) fail('policy');
    const rawSecrets = readJson(secretsPath);
    if (!secretsValid(rawSecrets)) fail('secrets');
    if (Object.values(rawSecrets.secrets).some(password => Buffer.byteLength(password, 'utf8') > 15)) fail('secrets');
    secrets = new Map(Object.entries(rawSecrets.secrets));
  }

  const assigned = new Map();
  const groupIds = new Set();
  const targetKeys = new Set();
  const references = new Set(supplied ? [policy.defaultCredentialRef] : []);
  for (const group of policy.groups ?? []) {
    if (groupIds.has(group.id)) fail('assignments');
    groupIds.add(group.id); references.add(group.credentialRef);
    for (const key of group.targetPublicKeys) {
      if (assigned.has(key)) fail('assignments');
      assigned.set(key, group.credentialRef);
    }
  }
  for (const target of policy.targets ?? []) {
    if (targetKeys.has(target.targetPublicKey)) fail('assignments');
    targetKeys.add(target.targetPublicKey);
    if (target.credentialRef !== undefined) {
      references.add(target.credentialRef);
      assigned.set(target.targetPublicKey, target.credentialRef);
    } else if (!assigned.has(target.targetPublicKey)) assigned.set(target.targetPublicKey, policy.defaultCredentialRef);
  }
  if (assigned.size > TELEMETRY_POLL_MAX_TARGETS) fail('assignments');
  if ([...references].some(ref => !secrets.has(ref))) fail('references');

  const config = { ...settings,
    components: { ...TELEMETRY_POLL_COMPONENT_DEFAULTS, ...policy.components },
    neighbourParams: { ...TELEMETRY_POLL_NEIGHBOUR_DEFAULTS, ...policy.neighbours },
    statusProfile: { ...TELEMETRY_POLL_STATUS_DEFAULT }, emitterProfile: 'unknown', permissionMask: 0,
    targetProfiles: (policy.targets ?? []).filter(target => target.statusProfile || target.emitterProfile).map(target => ({
      targetPublicKey: target.targetPublicKey, statusProfile: { ...(target.statusProfile ?? TELEMETRY_POLL_STATUS_DEFAULT) },
      emitterProfile: target.emitterProfile ?? 'unknown'
    }))
  };
  if (!Object.values(config.components).some(Boolean)) fail('components');
  if (!configValid(config)) fail('settings');
  freeze(config);
  if (settings.enabled) credentials.set(config, {
    defaultPassword: secrets.get(policy.defaultCredentialRef),
    byTarget: new Map([...assigned].map(([key, ref]) => [key, secrets.get(ref)]))
  });
  return config;
}

/**
 * Narrow private seam for later command preparation, not a public DTO.
 * Cloned/serialized configs cannot recover authority. Consumers are trusted
 * executable dependencies: never return/log a password or secret command.
 * Callback errors are replaced, including async errors that contain secrets.
 */
export async function withTelemetryGuestPassword(config, target, consume) {
  if (!targetValid(target) || typeof consume !== 'function' || !config?.enabled || !credentials.has(config)) {
    throw new Error('Telemetry guest credential unavailable: use the original enabled startup configuration and a full public key');
  }
  const privateState = credentials.get(config);
  const password = privateState.byTarget.get(target.targetPublicKey) ?? privateState.defaultPassword;
  try { return await consume(password); }
  catch { throw new Error('Telemetry guest credential consumer failed'); }
}
