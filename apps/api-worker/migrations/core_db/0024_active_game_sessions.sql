-- ============================================================================
-- MWAR core_db migration 0024 (V1.1 Round 3) — disconnected bodies stay in the arena + Rejoin
--  game_active_sessions: one row per alive life (entry) in a live PvP room (Paid-EC / Fast & Mini),
--  reported by the game server with every 10 s batch-payout POST (snapshot + room heartbeat) and ended
--  at the moment the character actually dies (same request as the death's settlement items), leaves dead,
--  is AFK-kicked or the room shuts down.
--  A row is "live" for GET /api/game/active-session only while ended_at IS NULL, its room heart-beat in
--  the last 90 s AND its stake is still open (ticket in_match for this entry / Fast & Mini pot open) —
--  so a settled ticket can never be shown or rejoined even if an end report were lost.
--  No money lives here: settlement stays in user_energy_tickets / fast_mini_pots / wallet_ledger.
-- Nothing is dropped; no existing migration is edited.
-- ============================================================================

CREATE TABLE IF NOT EXISTS game_active_sessions (
    entry_id TEXT PRIMARY KEY,                 -- arena entry id (= signed token eid; Fast & Mini: the pot id)
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,                     -- Colyseus room id (Rejoin joins it by id)
    room_code TEXT,                            -- admin registry code (TH-02 …), NULL for legacy rooms
    mode TEXT NOT NULL,                        -- mini_30 | standard_100 | fast_mini
    map_name TEXT NOT NULL DEFAULT 'small',    -- small (240 m) | large (960 m)
    server_url TEXT,                           -- public ws(s):// origin of the hosting game server
    game_id TEXT,
    ticket_id TEXT,                            -- Paid-EC: first ticket of the stake (NULL in Fast & Mini)
    pot_id TEXT,                               -- Fast & Mini: the seat's banner pot (NULL in Paid-EC)
    hp INTEGER NOT NULL DEFAULT 100,
    is_prop_hidden INTEGER NOT NULL DEFAULT 0,
    prop_type TEXT,
    is_disconnected INTEGER NOT NULL DEFAULT 0,
    life_started_at INTEGER NOT NULL,          -- ms; a late snapshot of an older life never revives an ended row
    entered_at INTEGER NOT NULL,               -- unix seconds
    heartbeat_at INTEGER NOT NULL,             -- unix seconds of the last room report
    ended_at INTEGER,                          -- ms; set at death / leave dead / AFK kick / room shutdown
    end_reason TEXT,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_active_sessions_user ON game_active_sessions (user_id, ended_at, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_game_active_sessions_room ON game_active_sessions (room_id, ended_at);
