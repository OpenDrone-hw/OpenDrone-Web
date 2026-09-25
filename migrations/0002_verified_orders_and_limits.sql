-- An order number typed into the form is only a claim until Shopify confirms
-- it belongs to the ticket's email (order_verified = 1). Only a verified
-- ticket is linked to a Shopify customer.
ALTER TABLE support_tickets ADD COLUMN order_verified INTEGER NOT NULL DEFAULT 0;

-- The team locked or deleted the Discord thread: no more replies.
ALTER TABLE support_tickets ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
-- The staff-metadata post (name, email), deleted with the ticket.
ALTER TABLE support_tickets ADD COLUMN meta_message_id TEXT;
-- The opening words of the first message, for ticket lists.
ALTER TABLE support_tickets ADD COLUMN preview TEXT NOT NULL DEFAULT '';

-- Fixed-window abuse counters shared by every isolate. Keys are HMACs of
-- (kind, IP, email), never the raw values; rows older than a day are
-- deleted by the scheduled job.
CREATE TABLE support_rate (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE INDEX support_rate_window ON support_rate (window_start);
