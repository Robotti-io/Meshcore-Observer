import { createHandlerStateCodec } from './handler-state.js';

const stateCodec = createHandlerStateCodec({
  kind: 'exact',
  dataSchema: { type: 'object', additionalProperties: false, maxProperties: 0 }
});

export function createExactCommandHandler() {
  return {
    kind: 'exact',
    match({ commands, text }) {
      const command = commands.find((candidate) => (candidate.kind ?? 'exact') === 'exact' && candidate.trigger === text);
      return command ? { command, state: stateCodec.serialize({}) } : null;
    },
    restore: stateCodec.restore,
    render({ command, sharedReply }) {
      return {
        template: command.response,
        overflowTemplate: command.overflowResponse,
        values: sharedReply
      };
    }
  };
}
