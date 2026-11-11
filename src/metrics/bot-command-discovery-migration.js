export const botCommandDiscoveryMigration = {
  version: 25,
  statements: [
    `CREATE TABLE bot_command_discoveries (
      channel TEXT NOT NULL,
      trigger TEXT NOT NULL,
      discovered_at INTEGER NOT NULL CHECK(discovered_at BETWEEN 0 AND 9007199254740991),
      PRIMARY KEY(channel, trigger)
    ) WITHOUT ROWID`,
    `INSERT INTO bot_command_discoveries (channel, trigger, discovered_at)
     SELECT channel, trigger, MIN(enqueued_at) FROM bot_replies
     WHERE channel IS NOT NULL AND enqueued_at IS NOT NULL GROUP BY channel, trigger`,
    `CREATE TABLE bot_command_list_cooldowns (
      channel TEXT PRIMARY KEY,
      last_requested_at INTEGER NOT NULL CHECK(last_requested_at BETWEEN 0 AND 9007199254740991)
    ) WITHOUT ROWID`
  ]
};
