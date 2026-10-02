import { createExactCommandHandler } from './exact.js';
import { createLookupCommandHandler } from './lookup.js';
import { createStatsCommandHandler } from './stats.js';

/** Explicit built-in handler map; shared ChannelBot lifecycle stays outside handlers. */
export function createDefaultCommandHandlers({ nodeRegistry, statsReporter }) {
  return new Map([
    ['exact', createExactCommandHandler()],
    ['lookup', createLookupCommandHandler({ nodeRegistry })],
    ['stats', createStatsCommandHandler({ statsReporter })]
  ]);
}
