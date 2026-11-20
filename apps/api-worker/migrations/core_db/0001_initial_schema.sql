-- ============================================================================
-- MWAR Core Database (core_db) - Cloudflare D1 Migration 0001
-- ============================================================================

-- 1. Users Table (Argon2id password hashes, WhatsApp phone, Telegram ID, MLM Referrer)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                       -- UUID v4
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    phone_number TEXT UNIQUE,                  -- WhatsApp verified number (E.164)
    telegram_id TEXT UNIQUE,                   -- Telegram user ID
    referrer_id TEXT REFERENCES users(id),     -- Direct Upline (Level 1)
    role TEXT DEFAULT 'player' CHECK (role IN ('player', 'admin', 'auditor')),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id);

-- 2. Wallets Table (Micro-USD Integer Units: $1 = 1,000,000 Micro-USD)
CREATE TABLE IF NOT EXISTS wallets (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    balance_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (balance_micro_usd >= 0),
    total_earned_micro_usd INTEGER NOT NULL DEFAULT 0,
    total_withdrawn_micro_usd INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 3. MLM 5-Level Network Trees Table (Closure Table)
CREATE TABLE IF NOT EXISTS network_trees (
    ancestor_id TEXT NOT NULL REFERENCES users(id),   -- Upline
    descendant_id TEXT NOT NULL REFERENCES users(id), -- Downline
    depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 5), -- Hierarchy Level (1 - 5)
    PRIMARY KEY (ancestor_id, descendant_id)
);

CREATE INDEX IF NOT EXISTS idx_network_descendant ON network_trees(descendant_id);
CREATE INDEX IF NOT EXISTS idx_network_depth ON network_trees(depth);

-- 4. Referral Marketplace Listings Table (30-day warranty escrow)
CREATE TABLE IF NOT EXISTS marketplace_listings (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL REFERENCES users(id),
    target_user_id TEXT NOT NULL REFERENCES users(id), -- Downline member listed for sale
    price_micro_usd INTEGER NOT NULL CHECK (price_micro_usd > 0),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'sold', 'cancelled')),
    buyer_id TEXT REFERENCES users(id),
    escrow_release_at INTEGER,                         -- 30 days after sale
    sold_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_market_status ON marketplace_listings(status);
CREATE INDEX IF NOT EXISTS idx_market_seller ON marketplace_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_market_buyer ON marketplace_listings(buyer_id);

-- 5. Withdrawal Requests Table (Min $10 = 10,000,000 Micro-USD)
CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd >= 10000000),
    fee_micro_usd INTEGER NOT NULL DEFAULT 500000,     -- $0.50 transaction fee
    crypto_currency TEXT NOT NULL DEFAULT 'USDT',
    payout_address TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'ai_verifying', 'approved', 'rejected')),
    ai_audit_score REAL,                               -- AI Trust Score (0.00 - 1.00)
    audit_reasons TEXT,                                -- JSON details of audit check
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    processed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_status ON withdrawal_requests(status);
CREATE INDEX IF NOT EXISTS idx_withdrawal_user ON withdrawal_requests(user_id);
