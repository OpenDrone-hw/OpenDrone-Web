-- The public owners map (app/lib/owner-map.ts, README "Owners map"): one
-- snapshot of already suppressed aggregate buckets, never orders or
-- addresses. Rows:
--   region 'DE', 'US-CA'  bucket = index 0..7 into 1-4, 5-9, 10-24, 25-49,
--                         50-99, 100-249, 250-499, 500+
--   region '_total'      bucket = owners rounded down to 10 (0 = hidden)
--   region '_countries'  bucket = countries with at least one owner
--   region '_attempt'    generated_at = last refresh try, so a failing
--                        refresh waits before it asks Shopify again
-- A refresh replaces every row except '_attempt' in one batch.
CREATE TABLE IF NOT EXISTS owner_map_snapshot (
  region       TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL,
  bucket       INTEGER NOT NULL
);
