-- ============================================================================
-- MWAR core_db migration 0022 (V1.1 round 5) — multi-role staff + moderation/log node telemetry
--  1. user_staff_roles: one account can hold several staff roles; effective powers = union of rows.
--     users.staff_role stays as the "primary" (most senior) role for display / legacy checks and is kept in
--     step by the API. super_admin is NOT stored here (owner = SUPER_ADMIN_USERNAMES var / users.staff_role).
--  2. Existing single-role staff (users.staff_role admin / moderator / support / finance_auditor) are copied
--     into user_staff_roles so nobody loses access ('admin' is kept as a legacy key).
--  3. game_nodes: optional telemetry reported by moderation / log nodes in their heartbeat.
-- Nothing is dropped.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_staff_roles (
    user_id TEXT NOT NULL,
    role_key TEXT NOT NULL,                 -- moderator | support | finance_auditor | ops_manager | admin (legacy)
    granted_by TEXT NOT NULL,               -- actor user id ('migration' for rows copied from users.staff_role)
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, role_key)
);
CREATE INDEX IF NOT EXISTS idx_user_staff_roles_role ON user_staff_roles(role_key);

INSERT OR IGNORE INTO user_staff_roles (user_id, role_key, granted_by, created_at)
SELECT id, staff_role, 'migration', unixepoch()
FROM users
WHERE staff_role IN ('admin', 'moderator', 'support', 'finance_auditor');

ALTER TABLE game_nodes ADD COLUMN mod_pending INTEGER;      -- moderation queue size reported by a moderator node
ALTER TABLE game_nodes ADD COLUMN mod_processed INTEGER;    -- items scanned since the node started
ALTER TABLE game_nodes ADD COLUMN pg_status TEXT;           -- 'ok' | 'down' | NULL (log nodes: PostgreSQL)
