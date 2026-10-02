import { resolveStatsRange } from '../stats-range.js';
import { createHandlerStateCodec } from './handler-state.js';

const stateCodec = createHandlerStateCodec({
  kind: 'stats',
  dataSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: { query: { type: 'string' } }
  }
});

export function createStatsCommandHandler({ statsReporter }) {
  return {
    kind: 'stats',
    match({ commands, text }) {
      for (const command of commands.filter((candidate) => candidate.kind === 'stats')) {
        const { trigger } = command;
        if (text === trigger) {
          return { command, state: stateCodec.serialize({ query: '' }) };
        }
        if (text.startsWith(`${trigger} `)) {
          return { command, state: stateCodec.serialize({ query: text.slice(trigger.length + 1).trim() }) };
        }
      }
      return null;
    },
    restore: stateCodec.restore,
    execute({ command, data, now }) {
      const resolved = resolveStatsRange(data.query, { now, earliestSampleAt: statsReporter.earliestSampleAt() });
      if (!resolved) {
        return { template: command.usageResponse, values: { query: data.query } };
      }
      return {
        template: command.response,
        overflowTemplate: command.overflowResponse,
        values: { range: data.query, ...statsReporter.summarize(resolved) }
      };
    }
  };
}
