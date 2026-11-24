-- ============================================================================
-- MWAR core_db Migration 0008 — Social platform (feed, likes, comments, follows,
-- notifications), public profile columns, and password reset tokens.
--
-- Cost notes (D1 bills rows read / written):
--  * Every list query is cursor-paginated (LIMIT 10 + 1) on a covering index.
--  * Counters (likes, comments, followers, following, posts) are denormalised so
--    profile and feed cards never run COUNT(*) scans.
--  * Images are NOT stored here: posts/avatars keep a short R2 media URL only.
-- ============================================================================

-- 1. Public profile columns on users
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN cover_color TEXT NOT NULL DEFAULT 'lemon';
ALTER TABLE users ADD COLUMN total_kills INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN total_matches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN followers_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN following_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN posts_count INTEGER NOT NULL DEFAULT 0;

-- Newest players (right-sidebar suggestions) without a table scan
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC);

-- Backfill: matches already played (paid arena entries)
UPDATE users SET total_matches = (SELECT COUNT(*) FROM arena_entries a WHERE a.user_id = users.id);

-- Note: legacy avatars may be base64 data URLs (up to 512 KB). They are kept, but social queries
-- never return them (masked in SQL) so feed cards stay tiny; new avatars are WebP files in R2.

-- 2. Posts
CREATE TABLE IF NOT EXISTS social_posts (
    id TEXT PRIMARY KEY,                         -- fixed-width time-sortable id: newest = largest
    author_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL DEFAULT '',
    tag TEXT NOT NULL DEFAULT 'General' CHECK (tag IN ('General', 'Highlight', 'LookingForSquad', 'Market')),
    image_url TEXT,                              -- R2 media URL (<= 120 KB WebP), never inline bytes
    like_count INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Global feed pages walk the primary-key index (ORDER BY id DESC); these cover profile + tag feeds
CREATE INDEX IF NOT EXISTS idx_social_posts_author ON social_posts(author_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_social_posts_tag ON social_posts(tag, id DESC);

-- 3. Likes (one row per user per post; PK lookup for "liked by me")
CREATE TABLE IF NOT EXISTS social_post_likes (
    post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (post_id, user_id)
);

-- 4. Comments (lazy-loaded per post, oldest first)
CREATE TABLE IF NOT EXISTS social_post_comments (
    id TEXT PRIMARY KEY,                         -- time-sortable id
    post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_social_comments_post ON social_post_comments(post_id, id ASC);

-- 5. Follows (follower -> followee)
CREATE TABLE IF NOT EXISTS social_follows (
    follower_id TEXT NOT NULL REFERENCES users(id),
    followee_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_social_follows_followee ON social_follows(followee_id, created_at DESC, follower_id DESC);
CREATE INDEX IF NOT EXISTS idx_social_follows_follower ON social_follows(follower_id, created_at DESC, followee_id DESC);

-- 6. Notifications (likes / comments / follows on you)
CREATE TABLE IF NOT EXISTS social_notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),   -- recipient
    actor_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK (type IN ('like', 'comment', 'follow')),
    post_id TEXT,
    is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_social_notif_user ON social_notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_social_notif_unread ON social_notifications(user_id, is_read);

-- 7. Password reset tokens (SHA-256 hash only, 15-minute expiry, single use)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_reset_tokens(user_id, created_at DESC);
