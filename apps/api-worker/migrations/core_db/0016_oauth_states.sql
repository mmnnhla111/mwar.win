-- 0016: server-side OAuth state for LINE Login and the Telegram bot deep link.
-- Mobile app switches (browser → LINE / Telegram app → back) often land in a new tab or an in-app
-- browser with empty sessionStorage; keeping the state in D1 makes the callback work anywhere.
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,                       -- 'line' | 'telegram_bot'
  purpose TEXT NOT NULL DEFAULT 'login',        -- 'login' | 'link' | 'switch'
  user_id TEXT,                                 -- signed-in player who started a link / switch from /settings
  referral_code TEXT,
  redirect_uri TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'approved' | 'consumed'
  telegram_payload_json TEXT,                   -- message.from of the /start auth_<state> update
  exchange_token TEXT UNIQUE,                   -- single-use token behind the bot's "back to mwar.win" button
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  device_fp TEXT,                               -- sticky-referral device hash of the browser that started it
  exchanged_at INTEGER,                         -- bot button used (single use)
  polled_at INTEGER                             -- waiting tab picked the session up (single use)
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_states_exchange ON oauth_states(exchange_token);
