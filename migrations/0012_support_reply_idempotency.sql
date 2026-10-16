-- Keep successful reply results for the ticket's lifetime (at least 24 hours).
-- Keys and request content are hashed; the result has the ticket's retention.
CREATE TABLE support_reply_idempotency (
  key_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  ref TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX support_reply_idempotency_ref ON support_reply_idempotency (ref);
