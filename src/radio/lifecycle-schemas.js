const generation = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
function object(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, properties, required };
}

export const radioCommandOptionsSchema = object({ generation, requireReady: { type: 'boolean' } }, []);
export const radioInvalidationSchema = object({
  generation, reason: { enum: ['ack-timeout', 'write-error', 'protocol-error'] }
});
// Internal test seam, not an additional environment/configuration setting.
export const radioLifecycleOptionsSchema = object({
  closeTimeoutMs: { type: 'integer', minimum: 1, maximum: 5000 }
});
