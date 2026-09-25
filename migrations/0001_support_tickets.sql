-- Support tickets (app/lib/support/store.ts). The conversation is worked in
-- Discord; this is the index, the state and the customer-visible copy of
-- each conversation. Rows are deleted 24 months after a ticket closes.

CREATE TABLE support_tickets (
  ref TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  order_number TEXT,
  product TEXT,
  thread_id TEXT NOT NULL,
  cursor TEXT,
  customer_id TEXT,
  customer_match TEXT NOT NULL,
  link_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_customer_at INTEGER NOT NULL,
  last_staff_at INTEGER,
  customer_seen_at INTEGER,
  notified_at INTEGER,
  synced_at INTEGER,
  closed_at INTEGER
);

CREATE INDEX support_tickets_email ON support_tickets (email, created_at);
CREATE INDEX support_tickets_status ON support_tickets (status, updated_at);
CREATE INDEX support_tickets_closed ON support_tickets (closed_at);

CREATE TABLE support_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL,
  discord_id TEXT UNIQUE,
  role TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE INDEX support_messages_ref ON support_messages (ref, seq);
