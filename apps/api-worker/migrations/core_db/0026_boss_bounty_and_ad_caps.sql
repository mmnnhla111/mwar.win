-- ============================================================================
-- MWAR core_db migration 0026 (V1.2 Round B) — verified-ad-only cash, 3 % safety haircut,
-- 10 % (5 % + 5 %) Boss Bounty Pool, Golden Boss reservations, banner daily cap, atomic MLM settlement
--  1. system_balances: Boss Bounty Pool + Platform Safety Reserve (+ marketing pool, spec §4.3)
--  2. platform_settings: admin-controlled economy switches (redirect_platform_fee_to_boss, default ON)
--  3. boss_bounty_reservations: a Golden Boss draw moved out of the pool until it is claimed or released —
--     the CHECK on status is load-bearing (a settle of a row that is not 'reserved' writes 'conflict' and
--     rolls the whole D1 batch back), so a reservation is paid or returned exactly once
--  4. users.banner_day / banner_day_count: MAX_DAILY_BANNER_IMPRESSIONS (60) per user per UTC day
--  5. ad_click_tokens: the S2S-verified revenue of a direct-link visit, applied once (timer claim → postback)
--  6. daily_mlm_pending_ledger.settle_id: the settlement batch credits exactly the rows it flipped
--  7. Conservative launch ad multipliers (audit H3) on the default config row — only where the stored value
--     is still the old default (an admin-tuned value is left alone)
-- Nothing is dropped.
-- ============================================================================

-- 1. Pools -----------------------------------------------------------------------------------------
ALTER TABLE system_balances ADD COLUMN boss_bounty_pool_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (boss_bounty_pool_micro_usd >= 0);
ALTER TABLE system_balances ADD COLUMN safety_reserve_micro_usd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE system_balances ADD COLUMN marketing_pool_micro_usd INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO system_balances (id) VALUES ('global');

-- 2. Economy settings ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_by TEXT
);
INSERT OR IGNORE INTO platform_settings (key, value, updated_at, updated_by) VALUES ('redirect_platform_fee_to_boss', '1', unixepoch(), NULL);

-- 3. Golden Boss reservations ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boss_bounty_reservations (
    id TEXT PRIMARY KEY,                                   -- bbr_<uuid>
    game_id TEXT NOT NULL,                                 -- the game server's room game id
    room_id TEXT,
    target_user_id TEXT NOT NULL,                          -- the Golden Boss
    target_entry_id TEXT,                                  -- the boss's paid entry (life) at draw time
    amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd > 0),
    status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'claimed', 'released')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,                           -- the cron returns it to the pool after this
    settled_at INTEGER,
    claimed_by_user_id TEXT,
    settle_ref TEXT                                        -- release reason / payout id
);
-- one live Golden Boss per game room
CREATE UNIQUE INDEX IF NOT EXISTS idx_boss_res_live_game ON boss_bounty_reservations (game_id) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS idx_boss_res_status_exp ON boss_bounty_reservations (status, expires_at);

-- 4. Banner daily cap -------------------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN banner_day TEXT;
ALTER TABLE users ADD COLUMN banner_day_count INTEGER NOT NULL DEFAULT 0;

-- 5. Verified direct-link revenue -------------------------------------------------------------------------
ALTER TABLE ad_click_tokens ADD COLUMN verified_gross_micro_usd INTEGER;   -- P1 estimated_price × 1e6 from the S2S postback
ALTER TABLE ad_click_tokens ADD COLUMN postback_at INTEGER;
ALTER TABLE ad_click_tokens ADD COLUMN verified_at INTEGER;                -- when that revenue was applied (once)

-- 6. Atomic MLM settlement ----------------------------------------------------------------------------------
ALTER TABLE daily_mlm_pending_ledger ADD COLUMN settle_id TEXT;
CREATE INDEX IF NOT EXISTS idx_daily_mlm_settle_id ON daily_mlm_pending_ledger (settle_id);

-- 7. Conservative launch multipliers -------------------------------------------------------------------------
UPDATE ad_network_configs SET mult_adsterra_300x250_pct = 60 WHERE id = 'default' AND mult_adsterra_300x250_pct = 100;
UPDATE ad_network_configs SET mult_adsterra_320x50_pct = 60 WHERE id = 'default' AND mult_adsterra_320x50_pct = 85;
UPDATE ad_network_configs SET mult_monetag_direct_pct = 35 WHERE id = 'default' AND mult_monetag_direct_pct = 50;
UPDATE ad_network_configs SET mult_adsterra_smartlink_pct = 35 WHERE id = 'default' AND mult_adsterra_smartlink_pct = 45;
