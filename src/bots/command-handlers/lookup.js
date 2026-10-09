import { createHandlerStateCodec } from './handler-state.js';

const stateCodec = createHandlerStateCodec({
  kind: 'lookup',
  dataSchema: {
    anyOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: { query: { type: 'string' } }
      },
      {
        // Accept persisted v1 lookup snapshots written before actions moved
        // to dispatch. They are re-resolved from the query after recovery.
        type: 'object',
        additionalProperties: false,
        required: ['query', 'outcome', 'name', 'matchCount', 'lastHeardAt', 'nodePrefix', 'repeaterCount'],
        properties: {
          query: { type: 'string' },
          outcome: { enum: ['found', 'not_found', 'ambiguous', 'invalid'] },
          name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          matchCount: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
          lastHeardAt: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          nodePrefix: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          repeaterCount: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] }
        }
      }
    ]
  }
});

function lookupResponseTemplate(command, outcome) {
  switch (outcome) {
    case 'found':
      return command.foundResponse;
    case 'not_found':
      return command.notFoundResponse;
    case 'ambiguous':
      return command.ambiguousResponse;
    default:
      return command.invalidResponse;
  }
}

function formatRelativeAge(timestamp, now) {
  if (timestamp === undefined || timestamp === null) {
    return 'unknown';
  }

  const ageMs = Math.max(0, now - Number(timestamp));
  if (ageMs < 60 * 1000) {
    return 'just now';
  }

  const units = [
    ['y', 365 * 24 * 60 * 60 * 1000],
    ['mo', 30 * 24 * 60 * 60 * 1000],
    ['d', 24 * 60 * 60 * 1000],
    ['h', 60 * 60 * 1000],
    ['m', 60 * 1000]
  ];
  const [unit, durationMs] = units.find(([, duration]) => ageMs >= duration);
  return `${Math.floor(ageMs / durationMs)}${unit} ago`;
}

export function createLookupCommandHandler({ nodeRegistry }) {
  return {
    kind: 'lookup',
    match({ commands, text }) {
      for (const command of commands.filter((candidate) => candidate.kind === 'lookup')) {
        const { trigger } = command;
        let query;
        if (text === trigger) {
          query = '';
        } else if (text.startsWith(`${trigger} `)) {
          query = text.slice(trigger.length + 1).trim();
        } else {
          continue;
        }

        return { command, state: stateCodec.serialize({ query }) };
      }
      return null;
    },
    restore: stateCodec.restore,
    execute({ command, data, now }) {
      const { query } = data;
      if (query.length === 0) {
        return { template: command.invalidResponse, values: { query } };
      }

      const result = nodeRegistry.findByPrefix(query, { type: 'REPEATER' });
      const outcome = result.status;
      const name = result.node ? result.node.name || 'Unnamed' : null;
      const matchCount = result.matchCount ?? null;
      const lastHeardAt = result.node?.lastHeardAt ?? null;
      const nodePrefix =
        result.status === 'found' && query.length < 4
          ? result.node?.publicKeyHex?.slice(0, 4) ?? result.query ?? query
          : result.query ?? query;
      const repeaterCount = result.status === 'not_found' ? nodeRegistry.countRepeaters() : null;

      return {
        template: lookupResponseTemplate(command, outcome),
        values: {
          query,
          name,
          matchCount,
          lastHeard: formatRelativeAge(lastHeardAt, now),
          nodePrefix: nodePrefix ?? query,
          repeaterCount: repeaterCount ?? undefined
        }
      };
    }
  };
}
