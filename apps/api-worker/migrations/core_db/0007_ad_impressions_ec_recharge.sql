-- 0007: Ad impression ledger (three-tier ad value) + ad-driven EC recharge
-- Bot kills no longer recharge EC. EC progress now comes from banner impressions and rewarded videos.

-- Every ad event (banner, video_5s/15s/30s, S2S postback) with the value used for it:
--   value_source = 'network'        exact payout reported by the ad network (P1)
--                  'yesterday_avg'  yesterday's average network payout for country + format (P2)
--                  'country_ecpm'   statistical country eCPM table in @mwar/shared (P3)
CREATE TABLE IF NOT EXISTS ad_impressions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'GLOBAL',
  ad_format TEXT NOT NULL,            -- banner | video_5s | video_15s | video_30s
  purpose TEXT NOT NULL,              -- ec_recharge | monetized
  amount_micro_usd INTEGER NOT NULL DEFAULT 0,
  value_source TEXT NOT NULL,
  ec_progress_bp INTEGER NOT NULL DEFAULT 0,
  date_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ad_impr_value ON ad_impressions (date_key, country_code, ad_format, value_source);
CREATE INDEX IF NOT EXISTS idx_ad_impr_user ON ad_impressions (user_id, ad_format, created_at);

-- Rewarded video sessions: the server only credits a view after the full 15 s / 30 s has elapsed.
CREATE TABLE IF NOT EXISTS ad_video_views (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ad_format TEXT NOT NULL,
  purpose TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ad_video_user ON ad_video_views (user_id, started_at);

-- Fine-grained EC progress (10 000 bp = 1 EC); energy_progress_pct stays in sync for the UI.
ALTER TABLE users ADD COLUMN energy_progress_bp INTEGER NOT NULL DEFAULT 0;
UPDATE users SET energy_progress_bp = MIN(9999, energy_progress_pct * 100);
