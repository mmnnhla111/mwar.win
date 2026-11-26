-- 0019: Player cashout ($10 minimum) + 3-layer anti-cheat audit.
-- (Lah asked for "0018_withdrawals_and_anticheat_audit.sql"; 0018 was already used by the ad banner gate.)
PRAGMA defer_foreign_keys = true;

-- 1. withdrawal_requests: rebuilt (SQLite can't change a CHECK) with payout methods, net payout,
--    flagged_review status, structured audit report and reviewer trail. Existing rows are kept.
CREATE TABLE withdrawal_requests_v2 (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd >= 10000000),       -- $10.00 minimum
    fee_micro_usd INTEGER NOT NULL DEFAULT 500000 CHECK (fee_micro_usd >= 0),
    net_payout_micro_usd INTEGER NOT NULL CHECK (net_payout_micro_usd > 0),
    payout_method TEXT NOT NULL DEFAULT 'usdt_trc20'
        CHECK (payout_method IN ('usdt_trc20', 'usdt_bep20', 'promptpay', 'bank_transfer')),
    payout_account TEXT NOT NULL,                                                  -- shown masked outside super_admin
    crypto_currency TEXT NOT NULL DEFAULT 'USDT',                                  -- legacy column
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'ai_verifying', 'approved', 'flagged_review', 'rejected')),
    ai_audit_score REAL CHECK (ai_audit_score IS NULL OR (ai_audit_score >= 0 AND ai_audit_score <= 1)),
    audit_report_json TEXT,
    reviewed_by TEXT,
    reject_reason TEXT,
    forfeited_micro_usd INTEGER NOT NULL DEFAULT 0,                                -- collusive earnings kept by the platform on reject
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    processed_at INTEGER
);
INSERT INTO withdrawal_requests_v2 (id, user_id, amount_micro_usd, fee_micro_usd, net_payout_micro_usd, payout_method, payout_account,
                                    crypto_currency, status, ai_audit_score, audit_report_json, created_at, processed_at)
SELECT id, user_id, amount_micro_usd, fee_micro_usd, MAX(1, amount_micro_usd - fee_micro_usd), 'usdt_trc20', payout_address,
       crypto_currency, COALESCE(status, 'pending'), ai_audit_score, audit_reasons, created_at, processed_at
FROM withdrawal_requests;
DROP TABLE withdrawal_requests;
ALTER TABLE withdrawal_requests_v2 RENAME TO withdrawal_requests;
CREATE INDEX IF NOT EXISTS idx_withdrawal_status ON withdrawal_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_withdrawal_user ON withdrawal_requests(user_id, created_at);

-- 2. Anti-cheat flags (layer 1 ledger mismatch, layer 2 behaviour, layer 3 collusion)
CREATE TABLE IF NOT EXISTS anticheat_flags (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    layer INTEGER NOT NULL CHECK (layer IN (1, 2, 3)),
    flag_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'critical')),
    details_json TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_anticheat_user ON anticheat_flags(user_id, resolved, created_at);

-- 3. Layer 1 source of truth in D1: every wallet balance change writes one signed row in the same
--    D1 batch as the wallet UPDATE. A balance edited outside the app no longer matches the sum.
CREATE TABLE IF NOT EXISTS wallet_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    delta_micro_usd INTEGER NOT NULL,                 -- + credit / − debit
    action_type TEXT NOT NULL,                        -- GAME_KILL, CHEST_OPEN, MLM_COMMISSION, CASHOUT_REQUEST, MARKET_BUY …
    ref_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user ON wallet_ledger(user_id, created_at);
-- Opening balance for every existing wallet (history before this migration is not in D1)
INSERT INTO wallet_ledger (id, user_id, delta_micro_usd, action_type, ref_id, created_at)
SELECT 'led_open_' || user_id, user_id, balance_micro_usd, 'OPENING_BALANCE', '0019', unixepoch()
FROM wallets WHERE balance_micro_usd <> 0;

-- 4. Layer 2/3 telemetry: one row per paid kill / chest from the game server batch payout
CREATE TABLE IF NOT EXISTS combat_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (action_type IN ('GAME_KILL', 'CHEST_OPEN')),
    victim_id TEXT,
    gross_micro_usd INTEGER NOT NULL DEFAULT 0,
    earner_micro_usd INTEGER NOT NULL DEFAULT 0,
    session_hits INTEGER,                             -- shooter's session totals at that moment (game server meta)
    session_headshots INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_combat_user ON combat_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_combat_game ON combat_events(game_id, action_type);
CREATE INDEX IF NOT EXISTS idx_combat_victim ON combat_events(victim_id, created_at);

-- 5. Layer 3: hashed IPs / device fingerprints seen per account (never raw IPs)
CREATE TABLE IF NOT EXISTS user_device_links (
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ip', 'fp')),
    hash TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, kind, hash)
);
CREATE INDEX IF NOT EXISTS idx_device_links_hash ON user_device_links(kind, hash);
