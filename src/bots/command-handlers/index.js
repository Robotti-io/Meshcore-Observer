import { createExactCommandHandler } from './exact.js';
import { createLookupCommandHandler } from './lookup.js';
import { createStatsCommandHandler } from './stats.js';
import { createDiscoveryCommandHandler } from './discovery.js';
import { createHintCommandHandler } from './hint.js';
import { createOnboardingCommandHandler } from './onboarding.js';

/** Explicit built-in handler map; shared ChannelBot lifecycle stays outside handlers. */
export function createDefaultCommandHandlers({ nodeRegistry, statsReporter, commandDiscovery, hintChallenge }) {
  const handlers = [
    ['exact', createExactCommandHandler()],
    ['lookup', createLookupCommandHandler({ nodeRegistry })],
    ['stats', createStatsCommandHandler({ statsReporter })],
    ['onboarding', createOnboardingCommandHandler()]
  ];
  if (commandDiscovery) {
    handlers.push(['discovery', createDiscoveryCommandHandler(commandDiscovery)]);
  }
  if (hintChallenge) {
    handlers.push(['hint', createHintCommandHandler(hintChallenge)]);
  }
  return new Map(handlers);
}
