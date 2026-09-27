-- Shared accounts (README "Shared accounts", app/lib/accounts/). Times are
-- epoch milliseconds. No email or name: Shopify owns the customer record.
-- od_sessions.id_hash is SHA-256 of the __Host-od_sid cookie value and is
-- also the `sid` given to chatfpv.com; shopify_id_token is AES-GCM sealed
-- with SESSION_ENC_KEY and used only as the Shopify logout hint.
-- oauth_codes are single use for 60 s; a second use revokes the session.
CREATE TABLE od_accounts (
  id TEXT PRIMARY KEY,
  shopify_gid TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE od_sessions (
  id_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES od_accounts (id) ON DELETE CASCADE,
  shopify_id_token TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX od_sessions_account ON od_sessions (account_id);
CREATE INDEX od_sessions_expires ON od_sessions (expires_at);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  sid TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  nonce TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX oauth_codes_expires ON oauth_codes (expires_at);
