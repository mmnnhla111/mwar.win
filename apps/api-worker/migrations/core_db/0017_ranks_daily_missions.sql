-- 0017: player rank (EXP), game coins (฿, not withdrawable), daily mission summary + MLM lock.

-- Rank progression: EXP = 20 per paid match entered + 5 per kill (backfilled from the existing totals)
ALTER TABLE users ADD COLUMN exp INTEGER DEFAULT 0;
UPDATE users SET exp = COALESCE(total_matches, 0) * 20 + COALESCE(total_kills, 0) * 5;

-- ฿ game coins: daily mission rewards now go here instead of the cash wallet (no inflation of real money)
ALTER TABLE users ADD COLUMN coins INTEGER NOT NULL DEFAULT 0;

-- Per-day summary of the 5 daily missions (UTC day = resets 07:00 ICT). 4/5 done unlocks the
-- 5-level upline share for that day. Kept in sync by the quest engine (user_daily_quests).
CREATE TABLE IF NOT EXISTS user_missions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  date_str TEXT NOT NULL,                       -- e.g. "2026-11-26" (resets daily at 07:00 ICT)
  checkin_done INTEGER NOT NULL DEFAULT 0,
  community_done INTEGER NOT NULL DEFAULT 0,
  match_done INTEGER NOT NULL DEFAULT 0,
  spectate_done INTEGER NOT NULL DEFAULT 0,
  ads_watched INTEGER NOT NULL DEFAULT 0,       -- target 1 (informational, not one of the 5 missions)
  unlock_status INTEGER NOT NULL DEFAULT 0,     -- 0: Locked, 1: Unlocked
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  coins_done INTEGER NOT NULL DEFAULT 0,        -- "สะสม 200 เหรียญ" mission
  UNIQUE(user_id, date_str),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_missions_user_date ON user_missions(user_id, date_str);

-- The 5 daily missions: check-in, community, 200 coins, 3D match, spectate 90 s.
-- The ad-watch quest leaves the unlock set (ads stay an EC recharge, not a requirement).
ALTER TABLE daily_quest_definitions ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
UPDATE daily_quest_definitions SET is_active = 0 WHERE quest_id = 'Q_WATCH_AD';
