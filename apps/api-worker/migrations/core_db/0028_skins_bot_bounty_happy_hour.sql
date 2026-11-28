-- ============================================================================
-- MWAR core_db migration 0028 (V1.2 Round C, part 2) — cosmetic skins + P2P skin market, cold-start bot
-- bounties, Happy Hour 2x bonuses
--  1. user_skins (weapon finishes + outfits, common/rare/epic/legendary) + users.skin_fragments + equipped skins
--  2. skin_market_listings: min 50 C; status CHECK is load-bearing (a purchase of a listing that is not 'active'
--     writes 'conflict' → the whole D1 batch rolls back → never a double sale)
--  3. bot_bounty_reservations: a bot's bounty moved out of the Boss Bounty Pool until claimed / released, once
--  4. happy_hour_bonuses: the 2x extra of one payout (UNIQUE source_ref → paid at most once), from the boss pool
-- Nothing is dropped.
-- ============================================================================

-- 1. Skins --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_skins (
    id TEXT PRIMARY KEY,                                  -- skn_<uuid>
    owner_id TEXT NOT NULL,
    skin_slug TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('weapon_finish', 'outfit')),
    rarity TEXT NOT NULL CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
    is_tradeable INTEGER NOT NULL DEFAULT 1,
    is_listed INTEGER NOT NULL DEFAULT 0,
    acquired_from TEXT NOT NULL,                          -- 'mission_crate' | 'p2p_market' | 'admin_grant'
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_user_skins_owner ON user_skins (owner_id);

ALTER TABLE users ADD COLUMN skin_fragments INTEGER NOT NULL DEFAULT 0 CHECK (skin_fragments >= 0);
ALTER TABLE users ADD COLUMN equipped_weapon_skin_id TEXT;
ALTER TABLE users ADD COLUMN equipped_outfit_skin_id TEXT;

CREATE TABLE IF NOT EXISTS skin_market_listings (
    id TEXT PRIMARY KEY,                                  -- skl_<uuid>
    skin_id TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    price_micro_usd INTEGER NOT NULL CHECK (price_micro_usd >= 5000),
    fee_pct INTEGER,                                      -- fee applied at sale time
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'cancelled')),
    buyer_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    sold_at INTEGER
);
-- one live listing per skin
CREATE UNIQUE INDEX IF NOT EXISTS idx_skin_market_live_skin ON skin_market_listings (skin_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_skin_market_status ON skin_market_listings (status, created_at DESC);

-- 2. Cold-start bot bounties ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bot_bounty_reservations (
    id TEXT PRIMARY KEY,                                  -- bot_<uuid>
    game_id TEXT NOT NULL,
    room_id TEXT,
    bot_id TEXT NOT NULL,
    amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd > 0),
    status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'claimed', 'released')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    settled_at INTEGER,
    claimed_by_user_id TEXT,
    settle_ref TEXT
);
-- one live bounty per bot of a room
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_res_live_bot ON bot_bounty_reservations (game_id, bot_id) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS idx_bot_res_status_exp ON bot_bounty_reservations (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_bot_res_game ON bot_bounty_reservations (game_id, created_at);

-- 3. Happy Hour 2x bonuses ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS happy_hour_bonuses (
    source_ref TEXT PRIMARY KEY,                          -- the payout it doubles (ticket match / reservation id)
    user_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd > 0),
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_happy_hour_user ON happy_hour_bonuses (user_id, created_at);
