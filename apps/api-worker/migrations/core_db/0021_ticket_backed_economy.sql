-- ============================================================================
-- MWAR core_db migration 0021 (V1.1 Round 1) — zero-deficit ticket-backed economy
--  1. user_energy_tickets: every Energy Ticket (1 EC) is a row carrying the REAL µUSD that backs it
--     (ad revenue after the 90–95 % safety haircut, a cheer's 20 % slice, or 0 for promo/admin tickets).
--     A kill (or the opening of a suicide chest) pays exactly the victim's ticket value — never a constant.
--  2. users.pending_ec_micro_usd: backing collected while the EC progress bar goes 0 → 100 %.
--  3. Backfill: existing EC balances become ticket rows. They get a conservative country floor value
--     (1 800 µUSD = lowest 30 s video in the eCPM table (BD/PK 2 000) × 0.90) ONLY if the Energy Pool's
--     unspent balance can cover all of them — the value is then drawn from the pool, so nothing is
--     created from thin air. Otherwise they are backfilled at 0 (promo value).
-- users.energy_tickets stays as the cached count of 'available' rows (kept in step by the Worker).
-- Nothing is dropped.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_energy_tickets (
    id TEXT PRIMARY KEY,                                   -- tkt_<uuid>
    user_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('ad_charge', 'cheer_pool', 'signup_promo', 'admin_grant')),
    country_code TEXT NOT NULL DEFAULT 'GLOBAL',           -- request.cf.country at charge time
    backed_micro_usd INTEGER NOT NULL CHECK (backed_micro_usd >= 0),
    -- The CHECK on status is load-bearing: settlement writes 'conflict' when a ticket is not in_match,
    -- which aborts (rolls back) the whole D1 payout batch → a ticket can be paid out at most once.
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'in_match', 'settled')),
    match_id TEXT,                                         -- arena_entries.id of the paid entry
    created_at INTEGER NOT NULL,
    consumed_at INTEGER,                                   -- locked into a match (POST /api/game/enter)
    settled_at INTEGER,
    settle_action TEXT,                                    -- GAME_KILL | CHEST_OPEN | TICKET_FORFEIT | STALE_FORFEIT | ADMIN_REVOKE
    settled_to_user_id TEXT,                               -- killer / chest opener (NULL = platform)
    settled_micro_usd INTEGER,                             -- value paid out through the 55/15/5/5/20 split
    settle_ref TEXT                                        -- game id
);
-- FIFO pick of the oldest available ticket + per-user counts
CREATE INDEX IF NOT EXISTS idx_energy_tickets_user_status ON user_energy_tickets (user_id, status, created_at ASC);
-- Settlement by entry (one entry may lock several tickets when a room costs > 1 EC)
CREATE INDEX IF NOT EXISTS idx_energy_tickets_match ON user_energy_tickets (match_id);
-- Stale in_match sweep
CREATE INDEX IF NOT EXISTS idx_energy_tickets_status_consumed ON user_energy_tickets (status, consumed_at);

ALTER TABLE users ADD COLUMN pending_ec_micro_usd INTEGER NOT NULL DEFAULT 0;

-- Idempotency of game-server payout items that are not tied to a ticket (BOUNTY_CLAIM, AFK_FORFEIT):
-- the game server re-sends a failed batch, every item carries a unique metadata.pid.
CREATE TABLE IF NOT EXISTS game_payout_receipts (
    payout_id TEXT PRIMARY KEY,
    game_id TEXT,
    created_at INTEGER NOT NULL
);

-- ---- Backfill ---------------------------------------------------------------------------------
INSERT OR IGNORE INTO system_balances (id) VALUES ('global');

WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 300),
pool AS (
    SELECT CASE
             WHEN (SELECT energy_pool_micro_usd - energy_pool_drawn_micro_usd FROM system_balances WHERE id = 'global')
                  >= 1800 * (SELECT COALESCE(SUM(MIN(MAX(COALESCE(energy_tickets, 0), 0), 300)), 0) FROM users)
             THEN 1800 ELSE 0
           END AS v
)
INSERT INTO user_energy_tickets (id, user_id, source_type, country_code, backed_micro_usd, status, created_at)
SELECT 'tkt_bf_' || u.id || '_' || seq.n,
       u.id,
       CASE WHEN (SELECT v FROM pool) > 0 THEN 'admin_grant' ELSE 'signup_promo' END,
       'GLOBAL',
       (SELECT v FROM pool),
       'available',
       COALESCE(u.created_at, unixepoch())
FROM users u
JOIN seq ON seq.n <= MIN(MAX(COALESCE(u.energy_tickets, 0), 0), 300);

-- The backfilled value (if any) is drawn from the Energy Pool, so pool − drawn stays >= 0
UPDATE system_balances
   SET energy_pool_drawn_micro_usd = energy_pool_drawn_micro_usd
         + (SELECT COALESCE(SUM(backed_micro_usd), 0) FROM user_energy_tickets WHERE id LIKE 'tkt_bf_%'),
       updated_at = unixepoch()
 WHERE id = 'global';

-- Cached count = available rows
UPDATE users SET energy_tickets = (SELECT COUNT(*) FROM user_energy_tickets t WHERE t.user_id = users.id AND t.status = 'available')
 WHERE energy_tickets IS NOT NULL;
