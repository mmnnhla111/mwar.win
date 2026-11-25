-- ============================================================================
-- MWAR core_db migration 0014 (2026-11-25)
--  1. Staff roles (RBAC) + owner bootstrap + staff audit log
--  2. Profile cover photos
--  3. Post audience, edits, multi-media items (1–10 photos / videos), staged uploads, hashtags, blocks
--  4. Notifications table (replaces social_notifications, rows copied)
--  5. Sticky referral attribution by device fingerprint
-- Nothing is dropped. Chat media expiry lives in the chat DB (chat_2026_11 0003).
-- ============================================================================

-- 1. RBAC ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN staff_role TEXT NOT NULL DEFAULT 'user';
-- Old roles keep their access: admin -> admin, auditor -> finance_auditor (read-only)
UPDATE users SET staff_role = CASE role WHEN 'admin' THEN 'admin' WHEN 'auditor' THEN 'finance_auditor' ELSE 'user' END;
-- Platform owner: mmnnhla111 / P-Pen, else the earliest registered real account
UPDATE users SET staff_role = 'super_admin'
WHERE id = COALESCE(
  (SELECT id FROM users WHERE username = 'mmnnhla111' OR display_name = 'P-Pen' ORDER BY created_at ASC LIMIT 1),
  (SELECT id FROM users WHERE id NOT LIKE 'SYSTEM%' AND status != 'banned' ORDER BY created_at ASC LIMIT 1)
);
CREATE INDEX IF NOT EXISTS idx_users_staff_role ON users(staff_role) WHERE staff_role != 'user';

CREATE TABLE IF NOT EXISTS staff_audit_log (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    target_id TEXT,
    action TEXT NOT NULL,              -- 'staff_role' | 'ec_adjust' | 'suspend' | ...
    old_value TEXT,
    new_value TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_staff_audit_created ON staff_audit_log(created_at DESC);
-- Support daily EC limit: SUM over (action, actor, today)
CREATE INDEX IF NOT EXISTS idx_staff_audit_actor ON staff_audit_log(action, actor_id, created_at);

-- 2. Cover photo -----------------------------------------------------------------
ALTER TABLE users ADD COLUMN cover_url TEXT;

-- 3. Posts -----------------------------------------------------------------------
ALTER TABLE social_posts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';   -- 'public' | 'followers' | 'private'
ALTER TABLE social_posts ADD COLUMN media_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE social_posts ADD COLUMN edited_at INTEGER;
ALTER TABLE social_post_comments ADD COLUMN edited_at INTEGER;
-- Author's own feed + followers-only posts of people I follow
CREATE INDEX IF NOT EXISTS idx_social_posts_author_vis ON social_posts(author_id, visibility, id DESC);

CREATE TABLE IF NOT EXISTS social_post_media (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
    media_key TEXT NOT NULL UNIQUE,                 -- R2 (MEDIA_BUCKET): social/YYYY/MM/<uuid>.webp|jpg|mp4|webm
    width INTEGER,
    height INTEGER,
    duration_sec REAL,
    video_tier TEXT CHECK (video_tier IS NULL OR video_tier IN ('hd_sub720', 'sd_480')),
    moderation_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'nsfw_18' | 'rejected'
    content_rating TEXT NOT NULL DEFAULT 'safe',
    nsfw_score REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_post_media_post ON social_post_media(post_id, sort_order);
-- 480p archive sweep: approved HD videos by age
CREATE INDEX IF NOT EXISTS idx_post_media_archive ON social_post_media(media_type, video_tier, created_at);

-- Existing single-media posts become item 0
INSERT OR IGNORE INTO social_post_media (id, post_id, sort_order, media_type, media_key, video_tier, moderation_status, content_rating, nsfw_score, created_at)
SELECT 'm' || id, id, 0, media_type, media_key, CASE WHEN media_type = 'video' THEN 'hd_sub720' END,
       moderation_status, content_rating, nsfw_score, created_at
FROM social_posts WHERE media_key IS NOT NULL AND media_type IN ('image', 'video');
UPDATE social_posts SET media_count = 1 WHERE media_key IS NOT NULL;

-- Moderation jobs now point at one media item and have a type (scan | transcode_480p)
ALTER TABLE moderation_jobs ADD COLUMN media_id TEXT;
ALTER TABLE moderation_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'scan';
UPDATE moderation_jobs SET media_id = 'm' || post_id WHERE media_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_moderation_jobs_media ON moderation_jobs(media_id);

-- Uploads waiting to be attached to a post (cron removes leftovers after 6 h)
CREATE TABLE IF NOT EXISTS social_media_uploads (
    id TEXT PRIMARY KEY,                            -- 'u' + sortable id
    user_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    media_key TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
    width INTEGER,
    height INTEGER,
    duration_sec REAL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_media_uploads_attempt ON social_media_uploads(user_id, attempt_id);
CREATE INDEX IF NOT EXISTS idx_media_uploads_created ON social_media_uploads(created_at);

CREATE TABLE IF NOT EXISTS social_post_hashtags (
    tag TEXT NOT NULL,
    post_id TEXT NOT NULL,
    PRIMARY KEY (tag, post_id)
);
CREATE INDEX IF NOT EXISTS idx_post_hashtags_post ON social_post_hashtags(post_id);

CREATE TABLE IF NOT EXISTS social_blocks (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_social_blocks_blocked ON social_blocks(blocked_id);

-- 4. Notifications -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,                          -- recipient
    actor_id TEXT,                                  -- NULL for system notices
    type TEXT NOT NULL CHECK (type IN ('like', 'comment', 'follow', 'referral_join', 'post_rejected', 'system')),
    target_id TEXT,                                 -- post id / user id to open
    message_key TEXT,
    payload_json TEXT,
    is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_target ON notifications(target_id);
INSERT OR IGNORE INTO notifications (id, user_id, actor_id, type, target_id, is_read, created_at)
SELECT id, user_id, actor_id, CASE type WHEN 'moderation' THEN 'post_rejected' ELSE type END, post_id, is_read, created_at
FROM social_notifications;
-- social_notifications is no longer written (kept until a later cleanup migration)

-- 5. Sticky referral -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_attributions (
    device_fp TEXT PRIMARY KEY,
    ref_code TEXT NOT NULL,
    referrer_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    converted_user_id TEXT
);
