-- ============================================================================
-- MWAR Core Database (core_db) - Cloudflare D1 Migration 0005
-- Economy & spec audit fixes (docs/ECONOMY_AND_SPEC_AUDIT.md)
-- ============================================================================

-- Q_SPECTATE heartbeats are rate limited by wall-clock time between reports
ALTER TABLE user_daily_quests ADD COLUMN last_progress_at INTEGER NOT NULL DEFAULT 0;

-- Marketplace: seller is paid only when the 30-day escrow is released (once)
ALTER TABLE marketplace_listings ADD COLUMN escrow_released_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_market_escrow ON marketplace_listings(status, escrow_released_at, escrow_release_at);

-- Ad network S2S postbacks: each provider transaction id may credit the wallet only once
CREATE TABLE IF NOT EXISTS ad_postbacks (
    provider TEXT NOT NULL,
    provider_tx_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    amount_micro_usd INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (provider, provider_tx_id)
);

-- Paid arena entries (1 EC each) — the game server only pays out to holders of a valid entry
CREATE TABLE IF NOT EXISTS arena_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    room_mode TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_arena_entries_user ON arena_entries(user_id, created_at);

-- Auth hardening: WhatsApp OTPs are stored hashed with expiry + attempt counter (production mode)
CREATE TABLE IF NOT EXISTS otp_codes (
    phone_number TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Login brute-force limiter: failed password attempts per account in a sliding 15-minute window
CREATE TABLE IF NOT EXISTS login_failures (
    login_key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL
);
