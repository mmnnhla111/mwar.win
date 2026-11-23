-- ============================================================================
-- MWAR Core Database (core_db) - Cloudflare D1 Migration 0005
-- Marketplace escrow release tracking (seller is paid 30 days after a sale)
-- ============================================================================

ALTER TABLE marketplace_listings ADD COLUMN escrow_released_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_market_escrow ON marketplace_listings(status, escrow_release_at);
