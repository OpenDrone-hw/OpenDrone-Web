-- Order-number misses in "find my ticket", per email (an HMAC of it, never
-- the address). A leaky bucket: each miss adds one, and one drains every
-- few hours, so guessing order numbers for one email from many IPs stops
-- after a handful of tries. Rows are deleted once drained.
CREATE TABLE support_find_misses (
  key TEXT PRIMARY KEY,
  level REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX support_find_misses_updated ON support_find_misses (updated_at);
