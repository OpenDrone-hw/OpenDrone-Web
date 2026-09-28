-- Data subject requests for shared accounts (app/lib/accounts/rights-queue.ts).
-- Times are epoch milliseconds. A row is written by a Shopify compliance
-- webhook or by the founder CLI (scripts/accounts/rights.mjs); the scheduled
-- job works every 'pending' row. kind: 'erase' | 'export' | 'shop_redact'.
-- status: 'pending' (work or retry owed), 'ready' (export waiting in
-- export_json for the CLI), 'done'. export_json is cleared when the CLI
-- fetches it; 'done' rows are the record of handled requests (Art 5(2) GDPR)
-- and are deleted 3 years after completion.
CREATE TABLE rights_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  shopify_gid TEXT,
  status TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  completed_at INTEGER,
  export_json TEXT
);

CREATE INDEX rights_requests_status ON rights_requests (status, received_at);

-- Durable alert dedupe: one row per alert key per UTC day (YYYY-MM-DD).
CREATE TABLE ops_alerts (
  alert_key TEXT NOT NULL,
  day TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (alert_key, day)
);
