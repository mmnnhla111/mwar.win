-- Unread badge for /api/bootstrap: COUNT(*) WHERE receiver_id = ? AND is_read = 0 uses this index
-- instead of scanning every message in the month.
CREATE INDEX IF NOT EXISTS idx_chat_unread ON direct_messages(receiver_id, is_read);
