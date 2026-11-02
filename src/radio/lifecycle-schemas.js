const generation = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
function object(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, properties, required };
}

export const radioCommandOptionsSchema = object({ generation, requireReady: { type: 'boolean' },
  timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 } }, []);
export const radioInvalidationSchema = object({
  generation, reason: { enum: ['ack-timeout', 'write-error', 'protocol-error', 'request-cancelled',
    'preflight-timeout', 'preflight-write-error', 'preflight-protocol-error', 'preflight-cancelled',
    'scope-restore-failed', 'scope-command-timeout'] }
});
export const companionIdentitySchema = object({
  name: { type: 'string', minLength: 1, maxLength: 31 },
  generation
});
// Internal test seam, not an additional environment/configuration setting.
export const radioLifecycleOptionsSchema = object({
  closeTimeoutMs: { type: 'integer', minimum: 1, maximum: 5000 }
});
