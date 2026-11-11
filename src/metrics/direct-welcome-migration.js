export const directWelcomeMigration = {
  version: 24,
  statements: [
    `CREATE TABLE direct_welcome_contacts (
      contact_fingerprint TEXT PRIMARY KEY
        CHECK(length(contact_fingerprint)=64 AND contact_fingerprint NOT GLOB '*[^0-9A-F]*'),
      completed_at INTEGER NOT NULL CHECK(completed_at BETWEEN 0 AND 9007199254740991)
    ) WITHOUT ROWID`
  ]
};
