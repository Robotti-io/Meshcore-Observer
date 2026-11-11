import { resolveStatsRange } from '../stats-range.js';
import { createHandlerStateCodec } from './handler-state.js';
import { matchCommandPrefix } from './command-matching.js';

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
        const match = matchCommandPrefix(trigger, text);
        if (match) return { command, state: stateCodec.serialize({ query: match.argument }) };
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
