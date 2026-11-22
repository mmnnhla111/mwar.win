-- ============================================================================
-- MWAR Core Database (core_db) - Cloudflare D1 Migration 0004
-- Practice Mode Energy Ticket (EC) Progress & Anti-Cheat Validation
-- ============================================================================

ALTER TABLE users ADD COLUMN energy_progress_pct INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_practice_claim INTEGER NOT NULL DEFAULT 0;
