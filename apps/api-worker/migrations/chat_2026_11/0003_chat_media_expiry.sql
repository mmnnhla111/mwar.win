-- Chat photos / videos: stored in R2 under chat-media/YYYY/MM/DD/<uuid>.<ext>, deleted after 7 days.
-- The message text stays; only media_key is cleared when the file expires.
ALTER TABLE direct_messages ADD COLUMN media_key TEXT;
ALTER TABLE direct_messages ADD COLUMN media_type TEXT;          -- 'image' | 'video'
ALTER TABLE direct_messages ADD COLUMN media_expires_at INTEGER; -- created_at + 604800
CREATE INDEX IF NOT EXISTS idx_chat_media_expiry ON direct_messages(media_expires_at) WHERE media_key IS NOT NULL;
