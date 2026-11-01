export const botReplySuppressionMigration = {
  version: 23,
  statements: [
    'CREATE INDEX idx_bot_replies_pending_channel ON bot_replies(channel, enqueued_at) WHERE status = \'pending\''
  ]
};
