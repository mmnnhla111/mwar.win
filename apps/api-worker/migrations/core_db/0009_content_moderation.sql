-- ============================================================================
-- MWAR core_db Migration 0009 — Content policy, 18+ age gate, moderation queue
-- and takedown reports (builds on 0008_social_platform.sql).
--
-- Policy: weapons / blood / violence are rejected and their media purged from R2.
-- Nudity is allowed but categorised as nsfw_18 and only returned to viewers with
-- users.show_nsfw = 1 (default OFF).
--
-- Cost notes: media bytes never live in D1 (only a compact R2 key such as
-- social/2026/11/<uuid>.webp). Finished moderation jobs, expired reset tokens and
-- rejected posts are pruned by the 00:00 UTC cron.
-- ============================================================================

-- 1. Viewer preference: show 18+ content (OFF by default)
ALTER TABLE users ADD COLUMN show_nsfw INTEGER NOT NULL DEFAULT 0;

-- 2. Media + moderation fields on posts
ALTER TABLE social_posts ADD COLUMN media_type TEXT NOT NULL DEFAULT 'none';        -- 'none' | 'image' | 'video'
ALTER TABLE social_posts ADD COLUMN media_key TEXT;                                  -- R2 key: social/YYYY/MM/<uuid>.webp|.mp4|.webm
ALTER TABLE social_posts ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'safe';    -- 'safe' | 'nsfw_18'
ALTER TABLE social_posts ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'approved'; -- 'pending' | 'approved' | 'nsfw_18' | 'rejected'
ALTER TABLE social_posts ADD COLUMN moderation_reason TEXT;
ALTER TABLE social_posts ADD COLUMN nsfw_score REAL NOT NULL DEFAULT 0;
ALTER TABLE social_posts ADD COLUMN author_marked_nsfw INTEGER NOT NULL DEFAULT 0;

-- Legacy photo posts (0008 stored a media URL in image_url) keep working as approved images
UPDATE social_posts SET media_type = 'image' WHERE image_url IS NOT NULL AND media_type = 'none';

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_posts_media_key ON social_posts(media_key) WHERE media_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_social_posts_created ON social_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_posts_user_created ON social_posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_posts_rating ON social_posts(content_rating, moderation_status, created_at DESC);
-- "My pending / removed posts" strip (author view) without scanning all of an author's posts
CREATE INDEX IF NOT EXISTS idx_social_posts_author_status ON social_posts(author_id, moderation_status, id DESC);

-- 3. Moderation job queue (claimed in batches by 1..N Ubuntu moderation workers)
CREATE TABLE IF NOT EXISTS moderation_jobs (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    media_key TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    worker_node_id TEXT,
    locked_until INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    result_action TEXT,                          -- 'approve_safe' | 'mark_nsfw_18' | 'reject_prohibited'
    result_reason TEXT,
    result_score REAL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_moderation_jobs_claim ON moderation_jobs(status, locked_until, created_at);
CREATE INDEX IF NOT EXISTS idx_moderation_jobs_post ON moderation_jobs(post_id);

-- 4. Report / takedown requests
CREATE TABLE IF NOT EXISTS content_reports (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    reporter_user_id TEXT NOT NULL REFERENCES users(id),
    reporter_contact TEXT CHECK (reporter_contact IS NULL OR length(reporter_contact) <= 120),
    reason_category TEXT NOT NULL CHECK (reason_category IN ('violence', 'privacy', 'copyright', 'unlabeled_18', 'other')),
    details TEXT CHECK (details IS NULL OR length(details) <= 500),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deleted', 'reclassified', 'dismissed')),
    resolved_by TEXT,
    resolved_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_reports_post ON content_reports(post_id, status);
CREATE INDEX IF NOT EXISTS idx_content_reports_reporter ON content_reports(reporter_user_id, created_at DESC);

-- 5. Notifications: add the 'moderation' type ("your media was removed because ...").
--    SQLite cannot alter a CHECK constraint, so the table is rebuilt (rows and indexes kept).
CREATE TABLE IF NOT EXISTS social_notifications_v2 (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    actor_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK (type IN ('like', 'comment', 'follow', 'moderation')),
    post_id TEXT,
    is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO social_notifications_v2 (id, user_id, actor_id, type, post_id, is_read, created_at)
    SELECT id, user_id, actor_id, type, post_id, is_read, created_at FROM social_notifications;
DROP TABLE social_notifications;
ALTER TABLE social_notifications_v2 RENAME TO social_notifications;
CREATE INDEX IF NOT EXISTS idx_social_notif_user ON social_notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_social_notif_unread ON social_notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_social_notif_post ON social_notifications(post_id);

-- 6. Cron pruning helper
CREATE INDEX IF NOT EXISTS idx_pwreset_expires ON password_reset_tokens(expires_at);
