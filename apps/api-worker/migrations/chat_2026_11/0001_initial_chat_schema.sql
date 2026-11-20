-- ============================================================================
-- MWAR Chat Database (chat_2026_11) - Cloudflare D1 Migration 0001
-- ============================================================================

CREATE TABLE IF NOT EXISTS direct_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    message_text TEXT,
    media_r2_url TEXT,
    is_read INTEGER DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_chat_dialog ON direct_messages(sender_id, receiver_id);
CREATE INDEX IF NOT EXISTS idx_chat_created ON direct_messages(created_at DESC);
