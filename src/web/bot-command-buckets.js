/**
 * Combines a bot's configured commands (in their stable config-definition
 * order) with this range's counts into a display-ready row list. Every
 * configured command is retained individually so new commands need no
 * dashboard-specific reporting mapping.
 *
 * @param {{trigger: string}[]} commands - a bot's configured commands, in config order.
 * @param {{trigger: string, count: number}[]} counts - this range's per-trigger counts (may omit zero-count triggers).
 * @returns {{trigger: string, count: number}[]}
 */
export function bucketBotCommandCounts(commands, counts) {
  const countsByTrigger = new Map(counts.map((row) => [row.trigger, row.count]));
  return commands.map((command) => ({
    trigger: command.trigger,
    count: countsByTrigger.get(command.trigger) ?? 0
  }));
}
