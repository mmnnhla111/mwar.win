-- ============================================================================
-- MWAR core_db migration 0027 (V1.2 Round C, part 1) — spectator gifts, launch promo codes,
-- Streamer Showcase Rooms, cold-start / live-economy settings
--  1. spectator_gifts catalog + gift_transactions ledger (70 % receiver / 30 % platform, idempotent per
--     (sender, client_request_id); the status CHECK is load-bearing: the last statement of a gift batch writes
--     'conflict' when any guarded step changed no row → the whole D1 batch rolls back)
--  2. promo_codes / promo_redemptions (1 per user, 1 per device fingerprint, max 500 per code; tickets backed
--     from system_balances.marketing_pool_micro_usd, guarded so the pool never goes below 0)
--  3. game_server_rooms: streamer columns; ad_click_tokens: the watched room + the streamer share applied
--  4. platform_settings defaults (bot fill, Happy Hour 20:00–21:00 Asia/Bangkok, streamer 40 %, skin fee 10 %)
-- Nothing is dropped.
-- ============================================================================

-- 1. Spectator gifts -------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spectator_gifts (
    code TEXT PRIMARY KEY,                                -- 'ammo_box_ad' | 'golden_grenade_100' | 'champion_crown_500'
    price_micro_usd INTEGER NOT NULL CHECK (price_micro_usd >= 0),
    receiver_pct INTEGER NOT NULL DEFAULT 70 CHECK (receiver_pct BETWEEN 0 AND 100),
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 100
);
INSERT OR IGNORE INTO spectator_gifts (code, price_micro_usd, receiver_pct, sort_order) VALUES
  ('ammo_box_ad', 0, 0, 10),
  ('golden_grenade_100', 10000, 70, 20),
  ('champion_crown_500', 50000, 70, 30);

CREATE TABLE IF NOT EXISTS gift_transactions (
    id TEXT PRIMARY KEY,                                  -- gft_<uuid>
    sender_id TEXT NOT NULL,
    receiver_id TEXT,                                     -- NULL only for an untargeted Ammo Box
    room_id TEXT NOT NULL,                                -- Colyseus room id
    room_code TEXT,
    gift_code TEXT NOT NULL,
    gross_micro_usd INTEGER NOT NULL CHECK (gross_micro_usd >= 0),
    receiver_micro_usd INTEGER NOT NULL CHECK (receiver_micro_usd >= 0),
    platform_micro_usd INTEGER NOT NULL CHECK (platform_micro_usd >= 0),
    client_request_id TEXT NOT NULL,
    ad_token TEXT,                                        -- the dl_ visit that paid for an Ammo Box
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK (receiver_micro_usd + platform_micro_usd = gross_micro_usd)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_tx_request ON gift_transactions (sender_id, client_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_tx_ad_token ON gift_transactions (ad_token) WHERE ad_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gift_tx_receiver ON gift_transactions (receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gift_tx_room ON gift_transactions (room_id, created_at DESC);

-- 2. Launch promo codes -------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promo_codes (
    code TEXT PRIMARY KEY,
    backed_micro_usd_per_ticket INTEGER NOT NULL CHECK (backed_micro_usd_per_ticket >= 0),
    max_redemptions INTEGER NOT NULL DEFAULT 500 CHECK (max_redemptions BETWEEN 1 AND 500),
    redeemed_count INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK (redeemed_count >= 0 AND redeemed_count <= max_redemptions)
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
    code TEXT NOT NULL,
    user_id TEXT NOT NULL,
    device_fp TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    backed_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (backed_micro_usd >= 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
    redeemed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (code, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_redemptions_device ON promo_redemptions (code, device_fp);

-- 3. Streamer Showcase Rooms ----------------------------------------------------------------------------
ALTER TABLE game_server_rooms ADD COLUMN is_streamer_room INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_server_rooms ADD COLUMN streamer_user_id TEXT;
ALTER TABLE game_server_rooms ADD COLUMN expires_at INTEGER;
-- one open streamer room per streamer
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_rooms_streamer_live ON game_server_rooms (streamer_user_id) WHERE is_streamer_room = 1 AND is_active = 1;

ALTER TABLE ad_click_tokens ADD COLUMN room_code TEXT;                  -- registry room the viewer watched
ALTER TABLE ad_click_tokens ADD COLUMN streamer_user_id TEXT;           -- streamer credited from the VERIFIED value
ALTER TABLE ad_click_tokens ADD COLUMN streamer_micro_usd INTEGER;      -- what the streamer got (once)

-- 4. Settings -------------------------------------------------------------------------------------------
INSERT OR IGNORE INTO platform_settings (key, value, updated_at, updated_by) VALUES
  ('cold_start_bot_fill_enabled', '0', unixepoch(), NULL),
  ('cold_start_target_bots', '8', unixepoch(), NULL),
  ('happy_hour_enabled', '0', unixepoch(), NULL),
  ('happy_hour_schedule', '{"start":"20:00","end":"21:00","tzOffsetMinutes":420}', unixepoch(), NULL),
  ('streamer_ad_share_pct', '40', unixepoch(), NULL),
  ('skin_market_fee_pct', '10', unixepoch(), NULL);
