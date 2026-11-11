export const qccTombChallengeMigration = {
  version: 26,
  statements: [
    `CREATE TABLE qcc_tomb_players (
      contact_fingerprint TEXT PRIMARY KEY
        CHECK(length(contact_fingerprint)=64 AND contact_fingerprint NOT GLOB '*[^0-9A-F]*'),
      question_index INTEGER NOT NULL CHECK(question_index BETWEEN 0 AND 64),
      updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),
      completed_at INTEGER CHECK(completed_at IS NULL OR completed_at BETWEEN 0 AND 9007199254740991)
    ) WITHOUT ROWID`,
    `CREATE TABLE bot_hint_cooldowns (
      channel TEXT PRIMARY KEY CHECK(length(channel) BETWEEN 1 AND 128),
      last_hint_at INTEGER NOT NULL CHECK(last_hint_at BETWEEN 0 AND 9007199254740991)
    ) WITHOUT ROWID`
  ]
};
