-- 0011: Telegram / LINE as the only way to open an account (anti-sybil: 1 phone = 1 provider account = 1 player)
-- Telegram and LINE each allow one account per phone number, so UNIQUE(provider, provider_user_id)
-- means one Telegram ID or one LINE ID can only ever belong to a single mwar.win user.
-- No phone numbers are collected or stored.

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,            -- 'telegram' | 'line'
  provider_user_id TEXT NOT NULL,
  provider_username TEXT,
  provider_display_name TEXT,
  provider_avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider, provider_user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts(user_id);

-- One link per provider per player (changing Telegram/LINE replaces the row)
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_accounts_user_provider ON oauth_accounts(user_id, provider);

-- username_locked: 1 once the player chose a username (existing accounts chose one at sign-up).
--   Accounts opened through Telegram/LINE start with an auto username (0) and may pick their own once.
-- has_password: 1 when a usable backup password exists (existing accounts signed up with one).
-- password_changed_at: last backup-password change, for the change cooldown.
ALTER TABLE users ADD COLUMN username_locked INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN has_password INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN password_changed_at INTEGER NOT NULL DEFAULT 0;

-- Accounts made by the old Telegram widget endpoint keep their Telegram link
INSERT OR IGNORE INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_username, provider_display_name, provider_avatar_url, created_at, updated_at)
SELECT lower(hex(randomblob(16))), id, 'telegram', telegram_id, NULL, NULL, NULL, created_at, unixepoch()
FROM users WHERE telegram_id IS NOT NULL AND telegram_id != '';

-- Old Telegram / WhatsApp sign-ups got a random password and an auto username
UPDATE users SET has_password = 0, username_locked = 0
WHERE email LIKE '%@telegram.mwar.local' OR email LIKE '%@whatsapp.mwar.local';
