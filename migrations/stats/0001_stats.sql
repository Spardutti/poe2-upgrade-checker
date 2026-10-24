-- Anonymous usage statistics (worker/site-worker.js: /api/ping and /api/stats).
-- One row per install per day; the install id is a hash of the app's random number. No IP addresses.
-- Apply with: npx wrangler d1 migrations apply poe-upgrade-stats --remote -c wrangler.site.jsonc
CREATE TABLE IF NOT EXISTS pings (
  day TEXT NOT NULL,
  install TEXT NOT NULL,
  version TEXT,
  platform TEXT,
  poe1 INTEGER NOT NULL DEFAULT 0,
  poe2 INTEGER NOT NULL DEFAULT 0,
  beta INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT,
  PRIMARY KEY (day, install)
);
CREATE INDEX IF NOT EXISTS pings_install ON pings(install);
-- the private key for the /api/stats page; set it once, by hand:
--   INSERT INTO config (k, v) VALUES ('stats_key', '<a long random string>');
CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL);
