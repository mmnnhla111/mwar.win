-- 0015: real ad networks (Adsterra + Monetag), test/live mode, anti-loss eCPM multipliers,
-- direct-link click tokens and S2S postback dedupe.
-- The real zone keys / URLs are NOT in this file: they are applied from the gitignored
-- Ads/seed_ad_networks.sql on the remote core_db only.

CREATE TABLE IF NOT EXISTS ad_network_configs (
  id TEXT PRIMARY KEY,                                   -- singleton 'default'
  ad_mode TEXT NOT NULL DEFAULT 'test' CHECK (ad_mode IN ('test', 'live')),
  adsterra_enabled INTEGER NOT NULL DEFAULT 1,
  adsterra_banner_300x250 TEXT,
  adsterra_banner_320x50 TEXT,
  adsterra_smartlink_url TEXT,
  monetag_enabled INTEGER NOT NULL DEFAULT 1,
  monetag_inpage_zone_id TEXT,
  monetag_inpage_script TEXT,
  monetag_direct_link_url TEXT,
  -- Safety multipliers (percent, 10–150) on the statistical country eCPM of each slot's format
  mult_adsterra_300x250_pct INTEGER NOT NULL DEFAULT 100 CHECK (mult_adsterra_300x250_pct BETWEEN 10 AND 150),   -- banner
  mult_adsterra_320x50_pct INTEGER NOT NULL DEFAULT 85 CHECK (mult_adsterra_320x50_pct BETWEEN 10 AND 150),      -- banner
  mult_monetag_inpage_pct INTEGER NOT NULL DEFAULT 50 CHECK (mult_monetag_inpage_pct BETWEEN 10 AND 150),        -- video_5s
  mult_monetag_direct_pct INTEGER NOT NULL DEFAULT 50 CHECK (mult_monetag_direct_pct BETWEEN 10 AND 150),        -- video_15s
  mult_adsterra_smartlink_pct INTEGER NOT NULL DEFAULT 45 CHECK (mult_adsterra_smartlink_pct BETWEEN 10 AND 150),-- video_15s
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
INSERT OR IGNORE INTO ad_network_configs (id, ad_mode, updated_at) VALUES ('default', 'test', unixepoch());

-- Direct-link visits (Path A): one single-use token per visit, valued at the server's cf country.
CREATE TABLE IF NOT EXISTS ad_click_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('monetag', 'adsterra')),
  purpose TEXT NOT NULL CHECK (purpose IN ('ec_recharge', 'cheer')),
  target_type TEXT,                                      -- cheer: post | profile | energy
  target_id TEXT,
  target_user_id TEXT,
  country_code TEXT NOT NULL,
  required_seconds INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  claimed_at INTEGER,
  claimed_via TEXT,                                      -- 'timer' | 'postback'
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'expired'))
);
CREATE INDEX IF NOT EXISTS idx_ad_click_tokens_user ON ad_click_tokens (user_id, started_at);

-- Which real slot an impression came from (adsterra_320x50, monetag_direct, ...) for admin stats
ALTER TABLE ad_impressions ADD COLUMN ad_slot TEXT;
CREATE INDEX IF NOT EXISTS idx_ad_impr_date ON ad_impressions (date_key, provider);
