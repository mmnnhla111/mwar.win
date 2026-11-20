-- Financial Audit Log Table for local PostgreSQL
CREATE TABLE IF NOT EXISTS logs_2026_11 (
    id BIGSERIAL PRIMARY KEY,
    transaction_id VARCHAR(64) UNIQUE NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    action_type VARCHAR(32) NOT NULL, -- 'GAME_KILL', 'CHEST_OPEN', 'AD_WATCH', 'MLM_COMMISSION', 'MARKET_BUY', 'CASHOUT_REQUEST'
    amount_micro_usd BIGINT NOT NULL,
    balance_after_micro_usd BIGINT NOT NULL,
    source_game_id VARCHAR(64),
    related_user_id VARCHAR(36),      -- ลูกทีมที่สร้างรายได้ให้
    mlm_level INT CHECK (mlm_level BETWEEN 1 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_user_date ON logs_2026_11(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_action ON logs_2026_11(action_type);
