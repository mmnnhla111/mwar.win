-- ============================================================================
-- 0020: durable fallback for the financial audit queue.
-- An audit event lands here when the FINANCIAL_AUDIT_QUEUE binding is missing in an environment,
-- when queue.send() fails, or when a queued event is about to expire (14-day retention) because the
-- Mini PC log receiver has been offline. The */10 cron re-sends rows (queue first, else a direct
-- signed delivery) and deletes them once PostgreSQL has stored them. Rows never expire on their own.
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,                -- FinancialAuditEvent (immutable)
  reason TEXT NOT NULL,                      -- no_queue | queue_send_failed | queue_expiring | queue_max_retries
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_outbox_due ON audit_outbox (next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_audit_outbox_user ON audit_outbox (user_id);
