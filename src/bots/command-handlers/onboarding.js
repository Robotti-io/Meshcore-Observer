import { createHandlerStateCodec } from './handler-state.js';

export const ONBOARDING_TRIGGER = '__qcc_onboarding__';

const stateCodec = createHandlerStateCodec({
  kind: 'onboarding',
  dataSchema: {
    type: 'object', additionalProperties: false,
    required: ['message'],
    properties: { message: { type: 'string', minLength: 1, maxLength: 512 } }
  }
});

export function createOnboardingCommandHandler() {
  return {
    kind: 'onboarding',
    match() {
      return null;
    },
    restore: stateCodec.restore,
    prepare(message) {
      return stateCodec.serialize({ message });
    },
    execute({ data }) {
      return { message: data.message, values: {} };
    }
  };
}
