import { compileSchema, formatErrors } from '../../validation/ajv.js';

const MAX_HANDLER_STATE_BYTES = 4096;

/**
 * Creates a handler-owned codec for its versioned durable context. The
 * schema remains with the handler, while the common envelope, size bound,
 * and failure behavior stay consistent across command kinds.
 */
export function createHandlerStateCodec({ kind, dataSchema }) {
  const validate = compileSchema({
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'version', 'data'],
    properties: {
      kind: { const: kind },
      version: { const: 1 },
      data: dataSchema
    }
  });

  function assertValid(state, failurePrefix) {
    if (!validate(state)) {
      throw new Error(`${failurePrefix}: ${formatErrors(validate.errors)}`);
    }
  }

  return {
    serialize(data) {
      const state = { kind, version: 1, data };
      assertValid(state, `invalid ${kind} command handler state`);
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_HANDLER_STATE_BYTES) {
        throw new Error('command handler state exceeds the maximum serialized size');
      }
      return serialized;
    },

    restore(serialized) {
      if (typeof serialized !== 'string') {
        throw new Error('queued command handler state is not a string');
      }
      if (Buffer.byteLength(serialized, 'utf8') > MAX_HANDLER_STATE_BYTES) {
        throw new Error('queued command handler state exceeds the maximum serialized size');
      }

      let state;
      try {
        state = JSON.parse(serialized);
      } catch {
        throw new Error('queued command handler state is not valid JSON');
      }

      assertValid(state, 'queued command handler state is invalid');
      return state.data;
    }
  };
}
