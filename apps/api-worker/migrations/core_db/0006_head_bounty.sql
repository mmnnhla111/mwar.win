-- ============================================================================
-- MWAR Core Database (core_db) - Cloudflare D1 Migration 0006
-- Head bounty for the 100 % reward split (75 % earner · 15 % uplines · 5 % head bounty · 5 % platform)
-- Every reward adds 5 % of V to the earner's own bounty; whoever eliminates them (or opens their
-- suicide / environmental-death bounty chest) claims the whole accumulated bounty.
-- ============================================================================

ALTER TABLE wallets ADD COLUMN bounty_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (bounty_micro_usd >= 0);
