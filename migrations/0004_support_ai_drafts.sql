-- ChatFPV drafts posted into ticket threads (app/lib/support/ai-drafts.ts).
-- A draft reaches the customer only after a support-role approve reaction.
-- outcome_posted 0 means ChatFPV has not yet accepted the decision; the
-- scheduled sync retries those rows. final_text keeps the delivered staff
-- text of a replaced draft for that retry.
CREATE TABLE support_ai_drafts (
  draft_id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  discord_message_id TEXT UNIQUE,
  body TEXT NOT NULL,
  citations TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'replaced', 'rejected', 'superseded')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  final_text TEXT,
  outcome_posted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX support_ai_drafts_ref ON support_ai_drafts (ref, status);
CREATE INDEX support_ai_drafts_outcome ON support_ai_drafts (outcome_posted, status);
