-- ============================================================================
-- MWAR core_db migration 0023 (V1.1 Round 2) — Paid-EC death prompt + Fast & Mini 90/10 banner pot
--  1. arena_entries.room_code / prev_entry_id: "Play again (-1 EC)" locks a NEW ticket for a NEW entry
--     that names the entry it follows. The partial UNIQUE index makes every entry followable at most once,
--     so one death can never lock two tickets (a retried request gets the same entry's token back).
--  2. fast_mini_pots: one row per Fast & Mini entry (0 EC, no ticket). The pot is funded ONLY by the
--     safe (after-haircut) value of that player's own verified banner impressions (50 % of each banner;
--     the other 50 % is normal EC backing — the same µUSD is never used twice).
--  3. fast_mini_pot_credits: one row per verified banner credit into a pot. A kill settles the victim's
--     open credits up to the moment of death (status open → paid, CHECK-guarded: a credit can be paid at
--     most once), 90 % to the shooter / 10 % to the platform. Credits still open when the pot closes
--     (player left, AFK, room closed, stale) go to the platform (forfeited).
--  4. Seeded rooms: Fast & Mini entry = 0 EC; room rules describe the new death flow.
-- Nothing is dropped; no existing migration is edited.
-- ============================================================================

ALTER TABLE arena_entries ADD COLUMN room_code TEXT;
ALTER TABLE arena_entries ADD COLUMN prev_entry_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_arena_entries_prev ON arena_entries (prev_entry_id) WHERE prev_entry_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fast_mini_pots (
    id TEXT PRIMARY KEY,                                   -- the Fast & Mini entry id (eid in the signed token)
    user_id TEXT NOT NULL,
    room_code TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    funded_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (funded_micro_usd >= 0),
    paid_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (paid_micro_usd >= 0),        -- settled by kills (shooter + platform)
    forfeited_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (forfeited_micro_usd >= 0), -- open credits at close → platform
    kills_paid INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    close_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_fast_mini_pots_user ON fast_mini_pots (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fast_mini_pots_status ON fast_mini_pots (status, created_at);

CREATE TABLE IF NOT EXISTS fast_mini_pot_credits (
    id TEXT PRIMARY KEY,                                   -- fmc_<uuid>
    pot_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    micro_usd INTEGER NOT NULL CHECK (micro_usd >= 0),     -- pot share of the banner's safe value
    ec_micro_usd INTEGER NOT NULL DEFAULT 0,               -- the other share (went to EC backing) — audit only
    source TEXT NOT NULL,                                  -- banner_live | banner_sim (pool-backed)
    -- The CHECK is load-bearing: settlement writes 'conflict' for a credit that is not open any more,
    -- which aborts the whole D1 batch → a credit is paid (or forfeited) at most once.
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'forfeited')),
    created_at INTEGER NOT NULL,
    settle_ref TEXT,
    settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fast_mini_credits_pot ON fast_mini_pot_credits (pot_id, status, created_at);

-- Fast & Mini is free: 0 EC entry (the Worker also forces 0 for every fast_mini room)
UPDATE game_server_rooms SET entry_cost_ec = 0 WHERE mode = 'fast_mini';
UPDATE game_server_rooms
   SET rules = '["Close-quarters fights on the 240 m block","Free entry (0 EC) — play again free after each death","Kills pay 90 % of the victim''s banner pot"]'
 WHERE mode = 'fast_mini' AND rules = '["Close-quarters fights on the 240 m block","Respawn 3 s after each death","Kill bounty paid on every elimination"]';
UPDATE game_server_rooms
   SET rules = '["30-player free-for-all on the 240 m map","After each death: play again for 1 EC or back to lobby","Kill bounty paid on every elimination"]'
 WHERE mode = 'skirmish' AND rules = '["30-player free-for-all on the 240 m map","Respawn 3 s after each death","Kill bounty paid on every elimination"]';
