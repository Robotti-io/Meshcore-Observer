import { createHandlerStateCodec } from './handler-state.js';
import { renderResponse } from '../response-template.js';

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
    execute({ command }) {
      return {
        template: command.response,
        overflowTemplate: command.overflowResponse,
        values: {}
      };
    },
    isSatisfactoryResponse({ command, item, responseText, responseSender, maxBytes }) {
      if (command.suppressIfAnswered !== true || !item.sender) return false;
      const data = stateCodec.restore(item.handlerStateJson);
      const action = this.execute({ command, data, now: item.enqueuedAt });
      const { message } = renderResponse({
        template: action.template,
        overflowTemplate: action.overflowTemplate,
        values: {
          sender: item.sender,
          hopCount: item.hopCount,
          path: item.path,
          trigger: item.trigger,
          hash: item.hash,
          ...action.values
        },
        maxBytes
      });
      const reconstructed = responseSender ? `${responseSender}: ${responseText}` : responseText;
      return message.includes(item.sender) && (responseText === message || reconstructed === message);
    }
  };
}
