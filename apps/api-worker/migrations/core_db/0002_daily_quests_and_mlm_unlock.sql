-- ============================================================================
-- MWAR Core Database (core_db) - Cloudflare D1 Migration 0002
-- Daily Quests, Proof-of-Activity MLM Unlock Engine & User Profile Metadata
-- ============================================================================

-- 1. Alter Users table to support Profile Avatar, Rank Badge, Energy, and Rename count
ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT '/images/avatars/avatar_1.png';
ALTER TABLE users ADD COLUMN rank_badge TEXT DEFAULT 'Bronze' CHECK (rank_badge IN ('Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary'));
ALTER TABLE users ADD COLUMN rename_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN energy_tickets INTEGER NOT NULL DEFAULT 6;
ALTER TABLE users ADD COLUMN max_energy_tickets INTEGER NOT NULL DEFAULT 6;
ALTER TABLE users ADD COLUMN last_energy_recharge INTEGER NOT NULL DEFAULT 0;

-- 2. Daily Quest Definitions Table
CREATE TABLE IF NOT EXISTS daily_quest_definitions (
    quest_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    target_count INTEGER NOT NULL DEFAULT 1,
    action_type TEXT NOT NULL,
    reward_coins INTEGER NOT NULL DEFAULT 50,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 3. User Daily Quests Progress Table
CREATE TABLE IF NOT EXISTS user_daily_quests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    date_key TEXT NOT NULL, -- Format: YYYY-MM-DD
    quest_id TEXT NOT NULL REFERENCES daily_quest_definitions(quest_id),
    current_count INTEGER NOT NULL DEFAULT 0,
    is_completed INTEGER NOT NULL DEFAULT 0, -- 0 = false, 1 = true
    is_claimed INTEGER NOT NULL DEFAULT 0,   -- 0 = false, 1 = true
    completed_at INTEGER,
    UNIQUE(user_id, date_key, quest_id)
);

CREATE INDEX IF NOT EXISTS idx_user_daily_quests_lookup ON user_daily_quests(user_id, date_key);

-- 4. Daily MLM Pending Ledger Table (Grey-to-Green Unlock)
CREATE TABLE IF NOT EXISTS daily_mlm_pending_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),          -- Sponsor receiving commission
    date_key TEXT NOT NULL,                              -- Format: YYYY-MM-DD
    downline_user_id TEXT NOT NULL REFERENCES users(id), -- Downline who generated commission
    depth_level INTEGER NOT NULL CHECK (depth_level BETWEEN 1 AND 5),
    amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd >= 0),
    status TEXT NOT NULL DEFAULT 'pending_grey' CHECK (status IN ('pending_grey', 'unlocked_green', 'forfeited_burned', 'settled_paid')),
    source_type TEXT NOT NULL DEFAULT 'AD_WATCH',        -- AD_WATCH, GAME_KILL, CHEST_OPEN
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_daily_mlm_pending_user_date ON daily_mlm_pending_ledger(user_id, date_key, status);
CREATE INDEX IF NOT EXISTS idx_daily_mlm_pending_date ON daily_mlm_pending_ledger(date_key);

-- 5. Seed Daily Quest Definitions
INSERT OR IGNORE INTO daily_quest_definitions (quest_id, title, description, target_count, action_type, reward_coins) VALUES
('Q_DAILY_CHECKIN', 'Daily Check-in', 'Log in and claim your daily reward ticket', 1, 'daily_checkin', 60),
('Q_SPECTATE', 'Spectate a Match (90s)', 'Watch live players in Ghost Spectator mode for 1.5 minutes', 90, 'spectate_timer', 80),
('Q_PLAY_MATCH', 'Fight in 3D Arena', 'Enter and complete at least 1 battle in the arena', 1, 'finish_game_match', 120),
('Q_WATCH_AD', 'Watch 2 Short Video Ads', 'Watch rewarded video sponsor ads to recharge energy', 2, 'watch_rewarded_ad', 100),
('Q_EARN_COINS', 'Earn 200 In-game Coins', 'Accumulate 200 coins through chests, bounties, or ads', 200, 'earn_coins', 90),
('Q_COMMUNITY', 'Community Interaction', 'Send a direct message to a teammate or inspect the network tree', 1, 'send_chat_or_network', 50);
