// Migration 22 extends the existing durable interaction row. Legacy rows
// keep their IDs, handler state, timestamps, retention, and region scope;
// their policy snapshot means the v2.4 channel behavior they already had.
const replies = `CREATE TABLE bot_replies_v22 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_name TEXT NOT NULL,channel TEXT,trigger TEXT NOT NULL,sender TEXT,hop_count INTEGER,path TEXT,hash TEXT,
  handler_state_json TEXT NOT NULL CHECK(json_valid(handler_state_json)),
  enqueued_at INTEGER,expires_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending','dispatching','sent','failed','expired','cancelled','suppressed','delivery-unknown')),
  resolved_at INTEGER,queued_ms INTEGER,
  sender_identifier TEXT,sender_identifier_kind TEXT,sender_identifier_source TEXT,
  region_scope TEXT CHECK(region_scope IS NULL OR length(region_scope) BETWEEN 1 AND 31),
  delivery_policy_json TEXT NOT NULL DEFAULT '{"version":1,"transport":"channel","scope":{"mode":"device-default"},"fallback":{"mode":"none"},"maxAttempts":1}'
    CHECK(json_valid(delivery_policy_json) AND json_type(delivery_policy_json)='object'),
  recipient_public_key TEXT CHECK(recipient_public_key IS NULL OR (length(recipient_public_key)=64 AND recipient_public_key NOT GLOB '*[^0-9A-F]*')),
  dispatch_started_at INTEGER CHECK(dispatch_started_at BETWEEN 0 AND 9007199254740991),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 2),
  outcome_reason TEXT CHECK(outcome_reason IS NULL OR outcome_reason IN
    ('send-failed','expired-before-dispatch','satisfactory-response','process-restart','recipient-unavailable','scope-unavailable','unsupported-policy')),
  ack_status TEXT NOT NULL DEFAULT 'not-applicable' CHECK(ack_status IN ('not-applicable','waiting','acknowledged','timed-out')),
  ack_at INTEGER CHECK(ack_at BETWEEN 0 AND 9007199254740991),
  ack_latency_ms INTEGER CHECK(ack_latency_ms BETWEEN 0 AND 9007199254740991),
  CHECK((ack_status IN ('acknowledged','timed-out') AND ack_at IS NOT NULL AND ack_latency_ms IS NOT NULL)
    OR (ack_status IN ('not-applicable','waiting') AND ack_at IS NULL AND ack_latency_ms IS NULL)),
  CHECK(status!='dispatching' OR dispatch_started_at IS NOT NULL),
  CHECK(json_extract(delivery_policy_json,'$.transport')!='private' OR status NOT IN ('pending','dispatching') OR recipient_public_key IS NOT NULL),
  CHECK(status NOT IN ('suppressed','delivery-unknown') OR outcome_reason IS NOT NULL),
  CHECK(status NOT IN ('sent','failed','expired','cancelled','suppressed','delivery-unknown') OR recipient_public_key IS NULL)
)`;

const legacyPolicy = `json_object('version',1,'transport','channel',
  'scope',CASE WHEN region_scope IS NULL THEN json_object('mode','device-default')
    ELSE json_object('mode','region','region',region_scope) END,
  'fallback',json_object('mode','none'),'maxAttempts',1)`;

export const botReplyLifecycleMigration = { version: 22, statements: [
  replies,
  `INSERT INTO bot_replies_v22 (
    id,bot_name,channel,trigger,sender,hop_count,path,hash,handler_state_json,enqueued_at,expires_at,status,resolved_at,queued_ms,
    sender_identifier,sender_identifier_kind,sender_identifier_source,region_scope,delivery_policy_json
  ) SELECT id,bot_name,channel,trigger,sender,hop_count,path,hash,handler_state_json,enqueued_at,expires_at,status,resolved_at,queued_ms,
    sender_identifier,sender_identifier_kind,sender_identifier_source,region_scope,${legacyPolicy} FROM bot_replies`,
  'DROP TABLE bot_replies',
  'ALTER TABLE bot_replies_v22 RENAME TO bot_replies',
  'CREATE INDEX idx_bot_replies_status_enqueued ON bot_replies(status,enqueued_at)',
  'CREATE INDEX idx_bot_replies_status_resolved ON bot_replies(status,resolved_at)',
  'CREATE INDEX idx_bot_replies_bot_status_resolved ON bot_replies(bot_name,status,resolved_at)',
  'CREATE INDEX idx_bot_replies_accepted ON bot_replies(enqueued_at,bot_name) WHERE enqueued_at IS NOT NULL'
] };
