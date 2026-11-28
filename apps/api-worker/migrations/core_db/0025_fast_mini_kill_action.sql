-- ============================================================================
-- MWAR core_db migration 0025 (audit M5) — Fast & Mini kills get their own action type
--  combat_events.action_type had CHECK (action_type IN ('GAME_KILL', 'CHEST_OPEN')), so Fast & Mini kills
--  (90 / 10 of the victim's banner pot) were stored as GAME_KILL and looked like wrong 55 % payouts to any
--  reconciliation by action type. SQLite cannot alter a CHECK: the table is rebuilt with 'FAST_MINI_KILL'
--  allowed, every row copied, the indexes recreated. Existing Fast & Mini rows (no settled ticket for that
--  victim / killer / game) are relabelled FAST_MINI_KILL; the matching wallet_ledger rows too.
-- Nothing is dropped except the old copy of combat_events.
-- ============================================================================

CREATE TABLE combat_events_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (action_type IN ('GAME_KILL', 'CHEST_OPEN', 'FAST_MINI_KILL')),
    victim_id TEXT,
    gross_micro_usd INTEGER NOT NULL DEFAULT 0,
    earner_micro_usd INTEGER NOT NULL DEFAULT 0,
    session_hits INTEGER,
    session_headshots INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO combat_events_new (id, user_id, game_id, action_type, victim_id, gross_micro_usd, earner_micro_usd, session_hits, session_headshots, created_at)
SELECT c.id, c.user_id, c.game_id,
       CASE
         WHEN c.action_type = 'GAME_KILL'
          AND EXISTS (SELECT 1 FROM fast_mini_pots p WHERE p.user_id = c.victim_id)
          AND NOT EXISTS (SELECT 1 FROM user_energy_tickets t WHERE t.user_id = c.victim_id AND t.settled_to_user_id = c.user_id AND t.settle_ref = c.game_id)
         THEN 'FAST_MINI_KILL'
         ELSE c.action_type
       END,
       c.victim_id, c.gross_micro_usd, c.earner_micro_usd, c.session_hits, c.session_headshots, c.created_at
FROM combat_events c;

DROP TABLE combat_events;
ALTER TABLE combat_events_new RENAME TO combat_events;
CREATE INDEX IF NOT EXISTS idx_combat_user ON combat_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_combat_game ON combat_events(game_id, action_type);
CREATE INDEX IF NOT EXISTS idx_combat_victim ON combat_events(victim_id, created_at);

-- Fast & Mini wallet credits always carry ref 'fm:<potId>'
UPDATE wallet_ledger SET action_type = 'FAST_MINI_KILL' WHERE action_type = 'GAME_KILL' AND ref_id LIKE 'fm:%';
