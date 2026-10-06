-- The opt-in pilot map (app/lib/pilot-map.ts, README "Owners map"): one row
-- per owner who chose to appear. Only the ~10 km grid cell is stored, never
-- the point that was clicked. shopify_gid is the erase key: customers/redact,
-- customers/delete and the idle-account purge delete the row by it, and a
-- withdrawal deletes it at once.
CREATE TABLE IF NOT EXISTS pilot_map_pins (
  shopify_gid     TEXT PRIMARY KEY,
  discord_id      TEXT NOT NULL,
  discord_name    TEXT NOT NULL,
  cell_id         TEXT NOT NULL,
  cell_lat        REAL NOT NULL,
  cell_lon        REAL NOT NULL,
  consent_at      INTEGER NOT NULL,
  consent_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pilot_map_pins_consent ON pilot_map_pins (consent_at);
