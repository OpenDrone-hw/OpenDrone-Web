-- Support CRM (app/lib/support/crm.ts, community.ts, staff-api.ts). Fields the
-- internal app works with, the community route to the public #help forum,
-- internal notes, saved replies and an audit trail of staff writes.
-- thread_id stays NOT NULL: '' means the ticket has no Discord staff thread
-- (SUPPORT_CRM_API on). Attachments of such tickets are objects in the R2
-- bucket SUPPORT_FILES under "<ref>/<attachment id>"; the ticket row's 24-month
-- deletion removes the objects too.

ALTER TABLE support_tickets ADD COLUMN assignee TEXT;
ALTER TABLE support_tickets ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE support_tickets ADD COLUMN route TEXT NOT NULL DEFAULT 'team';
ALTER TABLE support_tickets ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
-- The customer ticked the community checkbox on the form (consent to post an anonymised question).
ALTER TABLE support_tickets ADD COLUMN community_consent INTEGER NOT NULL DEFAULT 0;
-- Id of the forum post in the public help channel (a forum post is a thread).
ALTER TABLE support_tickets ADD COLUMN community_post_id TEXT;
ALTER TABLE support_tickets ADD COLUMN community_cursor TEXT;
ALTER TABLE support_tickets ADD COLUMN community_synced_at INTEGER;
ALTER TABLE support_tickets ADD COLUMN last_community_at INTEGER;

CREATE INDEX support_tickets_queue ON support_tickets (route, status, updated_at);
CREATE INDEX support_tickets_assignee ON support_tickets (assignee, status);

-- 1 on the community reply a person marked as the answer.
ALTER TABLE support_messages ADD COLUMN answer INTEGER NOT NULL DEFAULT 0;

CREATE TABLE support_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX support_notes_ref ON support_notes (ref, id);

CREATE TABLE support_saved_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per staff write. detail names fields and ids, never message text,
-- names or addresses. Rows of a ticket go with the ticket; the others after 24 months.
CREATE TABLE support_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  ref TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX support_audit_ref ON support_audit (ref, id);
CREATE INDEX support_audit_at ON support_audit (at);
