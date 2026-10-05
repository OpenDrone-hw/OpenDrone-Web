-- Customer mail is answered by a Gmail draft reply, not a ticket
-- (app/lib/support/mail.ts). outcome 'drafted' replaces 'ticket' and
-- 'reply': a Gmail draft was created in the mail's thread and
-- gmail_draft_id names it. Still no address, subject or body stored.
-- The ref column of 0007 stays unused; the ticket linking it served is gone.
ALTER TABLE support_mail_messages ADD COLUMN gmail_draft_id TEXT;

DROP TRIGGER IF EXISTS support_mail_messages_ticket_deleted;
DROP INDEX IF EXISTS support_mail_messages_thread;
DROP INDEX IF EXISTS support_mail_messages_ref;
