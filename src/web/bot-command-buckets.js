// Mirrors the packet-type chart's "7 real categories + Other" cap (see
// packet-type-buckets.js and the dataviz skill's series-count ladder: past
// 7-8 slots, fold the tail into "Other" rather than generate more hues).
// Unlike packet types, a bot's trigger set isn't a fixed enum - it's
// whatever that bot's config defines - so slot assignment is stable only
// if it follows the bot's own configured command *order*, never a
// per-request usage ranking (color must follow the entity, not its rank,
// or the same trigger's color would reshuffle every time usage counts
// change between refreshes).
const MAX_PRIMARY_TRIGGERS = 7;
export const OTHER_TRIGGER_LABEL = 'Other';

/**
 * Combines a bot's configured commands (in their stable config-definition
 * order) with this range's counts into a display-ready, stably-ordered row
 * list: at most 7 real triggers plus (only if the bot configures more than
 * 7) one folded "Other" row summing the rest.
 *
 * @param {{trigger: string}[]} commands - a bot's configured commands, in config order.
 * @param {{trigger: string, count: number}[]} counts - this range's per-trigger counts (may omit zero-count triggers).
 * @returns {{trigger: string, count: number}[]}
 */
export function bucketBotCommandCounts(commands, counts) {
  const countsByTrigger = new Map(counts.map((row) => [row.trigger, row.count]));
  const primary = commands.slice(0, MAX_PRIMARY_TRIGGERS);
  const overflow = commands.slice(MAX_PRIMARY_TRIGGERS);

  const rows = primary.map((command) => ({
    trigger: command.trigger,
    count: countsByTrigger.get(command.trigger) ?? 0
  }));

  if (overflow.length > 0) {
    const overflowCount = overflow.reduce((sum, command) => sum + (countsByTrigger.get(command.trigger) ?? 0), 0);
    rows.push({ trigger: OTHER_TRIGGER_LABEL, count: overflowCount });
  }

  return rows;
}
