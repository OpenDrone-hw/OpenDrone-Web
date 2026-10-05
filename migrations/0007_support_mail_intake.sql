-- Customer mail intake (app/lib/support/mail.ts). One row per mail message
-- the Gmail poll has looked at: the dedupe key, the Gmail thread for
-- follow-ups, and what became of it. No address, subject or body is stored;
-- message_hash is the SHA-256 of the RFC Message-ID header (the Gmail id
-- when a mail has none).
-- outcome: 'claimed' (being worked), 'retry' (failed, tried again, at most
-- 3 attempts), 'ticket' (opened ticket `ref`), 'reply' (copied into ticket
-- `ref`), 'ignored' (`reason` says why), 'failed' (gave up after 3 attempts).
-- A ticket with a 'ticket' row has source mail. Rows without a ticket are
-- pruned after 30 days; rows of a ticket go with the ticket.
CREATE TABLE support_mail_messages (
  message_hash TEXT PRIMARY KEY,
  gmail_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  ref TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Other Gmail copies of an already handled message (the same Message-ID
-- under another Gmail id), so they are not fetched again. Pruned with the rest.
CREATE TABLE support_mail_copies (
  gmail_id TEXT PRIMARY KEY,
  message_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX support_mail_copies_updated ON support_mail_copies (updated_at);

CREATE INDEX support_mail_messages_gmail_id ON support_mail_messages (gmail_id);
CREATE INDEX support_mail_messages_thread ON support_mail_messages (gmail_thread_id, ref);
CREATE INDEX support_mail_messages_ref ON support_mail_messages (ref);
CREATE INDEX support_mail_messages_updated ON support_mail_messages (updated_at);

CREATE TRIGGER support_mail_messages_ticket_deleted
AFTER DELETE ON support_tickets
BEGIN
  DELETE FROM support_mail_messages WHERE ref = OLD.ref;
END;
