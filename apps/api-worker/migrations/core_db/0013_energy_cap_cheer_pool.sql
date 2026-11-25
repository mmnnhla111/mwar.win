-- ============================================================================
-- MWAR core_db migration 0013 (2026-11-25) — EC cap 300, no passive regen, Energy Pool, "ให้กำลังใจ" Cheer
--  1. Energy cap 30 -> 300 for every account (EC balances are NOT changed; no regen is granted)
--  2. system_balances: Energy Recharge Reserve Pool (20 % of every reward split) + platform total
--  3. Cheer counters on posts / creators, cheer ad sessions, cheer events (rate limits in D1)
-- Nothing is dropped. users.last_energy_recharge is no longer read or written (kept for history).
-- ============================================================================

-- 1. EC cap ---------------------------------------------------------------------------
UPDATE users SET max_energy_tickets = 300 WHERE max_energy_tickets IS NULL OR max_energy_tickets <> 300;

-- 2. System balances (one row) ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_balances (
    id TEXT PRIMARY KEY,                                 -- 'global'
    energy_pool_micro_usd INTEGER NOT NULL DEFAULT 0,    -- 20 % share credited by every reward split
    energy_pool_drawn_micro_usd INTEGER NOT NULL DEFAULT 0, -- ad value of EC recharges backed by the pool
    platform_micro_usd INTEGER NOT NULL DEFAULT 0,       -- 5 % fee + missing upline tiers + rounding
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO system_balances (id) VALUES ('global');

-- 3. Cheer -------------------------------------------------------------------------------
ALTER TABLE social_posts ADD COLUMN cheer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN cheer_count INTEGER NOT NULL DEFAULT 0;     -- cheers received (posts + profile)

-- Cheer ad sessions reuse ad_video_views (purpose = 'cheer'); the target is fixed when the ad starts
ALTER TABLE ad_video_views ADD COLUMN target_type TEXT;                  -- 'post' | 'profile' | 'energy'
ALTER TABLE ad_video_views ADD COLUMN target_id TEXT;
ALTER TABLE ad_video_views ADD COLUMN target_user_id TEXT;

CREATE TABLE IF NOT EXISTS cheer_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,                               -- the cheerer (gets the EC progress)
    target_type TEXT NOT NULL CHECK (target_type IN ('post', 'profile', 'energy')),
    target_id TEXT,
    target_user_id TEXT,                                 -- creator cheered (NULL for the EC panel)
    ad_format TEXT NOT NULL,
    view_id TEXT NOT NULL UNIQUE,                        -- one claim per ad session
    ec_progress_bp INTEGER NOT NULL DEFAULT 0,
    value_micro_usd INTEGER NOT NULL DEFAULT 0,
    country_code TEXT NOT NULL DEFAULT 'GLOBAL',
    date_key TEXT NOT NULL,                              -- UTC YYYY-MM-DD
    created_at INTEGER NOT NULL
);
-- Daily cap + cooldown: (user, day) and latest per user
CREATE INDEX IF NOT EXISTS idx_cheer_user_day ON cheer_events (user_id, date_key, created_at);
-- Per-creator cap
CREATE INDEX IF NOT EXISTS idx_cheer_user_target_day ON cheer_events (user_id, target_user_id, date_key);
