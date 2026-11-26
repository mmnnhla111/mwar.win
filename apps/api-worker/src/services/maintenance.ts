import type { D1Database } from '@cloudflare/workers-types';
import { CHAT_RETENTION_SECONDS, SHORT_LIVED_ROW_RETENTION_SECONDS } from '@mwar/shared';
import type { Env } from '../types';

/**
 * Daily data-retention jobs (spec §3): chat 12-month purge, short-lived auth/ad rows, and the
 * next month's chat schema on a pre-bound monthly chat database.
 *
 * Monthly chat databases are optional bindings named CHAT_DB_YYYY_MM (e.g. CHAT_DB_2026_12) next
 * to the current CHAT_DB. Every bound chat database gets the 12-month purge.
 */
const CHAT_BINDING = /^CHAT_DB(_\d{4}_\d{2})?$/;

export function chatDatabases(env: Env): Array<{ binding: string; db: D1Database }> {
  return Object.entries(env as unknown as Record<string, unknown>)
    .filter(([k, v]) => CHAT_BINDING.test(k) && v && typeof (v as D1Database).prepare === 'function')
    .map(([binding, db]) => ({ binding, db: db as D1Database }));
}

/** CHAT_DB_YYYY_MM for the month after `now` (UTC). */
export function nextMonthChatBinding(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return `CHAT_DB_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Same schema as migrations/chat_2026_11 0001–0003 (idempotent). */
const CHAT_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS direct_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    message_text TEXT,
    media_r2_url TEXT,
    is_read INTEGER DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    media_key TEXT,
    media_type TEXT,
    media_expires_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS idx_chat_dialog ON direct_messages(sender_id, receiver_id)',
  'CREATE INDEX IF NOT EXISTS idx_chat_created ON direct_messages(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_chat_unread ON direct_messages(receiver_id, is_read)',
  'CREATE INDEX IF NOT EXISTS idx_chat_media_expiry ON direct_messages(media_expires_at) WHERE media_key IS NOT NULL',
];

export interface RetentionReport {
  chatPurged: Record<string, number>;
  nextMonthChat: { binding: string; prepared: boolean };
  oauthStatesPruned: number;
  adClickTokensPruned: number;
  errors: string[];
}

export async function runRetentionJobs(env: Env, nowMs = Date.now()): Promise<RetentionReport> {
  const now = Math.floor(nowMs / 1000);
  const report: RetentionReport = { chatPurged: {}, nextMonthChat: { binding: nextMonthChatBinding(new Date(nowMs)), prepared: false }, oauthStatesPruned: 0, adClickTokensPruned: 0, errors: [] };
  const chats = chatDatabases(env);

  // 1. Direct messages older than 12 months (365 days)
  for (const { binding, db } of chats) {
    try {
      const r = await db.prepare('DELETE FROM direct_messages WHERE created_at < ?1').bind(now - CHAT_RETENTION_SECONDS).run();
      report.chatPurged[binding] = r.meta?.changes ?? 0;
    } catch (e: any) {
      report.errors.push(`${binding}: ${e?.message || e}`);
    }
  }

  // 2. Short-lived rows older than 7 days
  try {
    const r = await env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?1').bind(now - SHORT_LIVED_ROW_RETENTION_SECONDS).run();
    report.oauthStatesPruned = r.meta?.changes ?? 0;
  } catch (e: any) {
    report.errors.push(`oauth_states: ${e?.message || e}`);
  }
  try {
    const r = await env.DB.prepare('DELETE FROM ad_click_tokens WHERE started_at < ?1').bind(now - SHORT_LIVED_ROW_RETENTION_SECONDS).run();
    report.adClickTokensPruned = r.meta?.changes ?? 0;
  } catch (e: any) {
    report.errors.push(`ad_click_tokens: ${e?.message || e}`);
  }

  // 3. Next month's chat schema, when its database is already bound
  const next = chats.find((c) => c.binding === report.nextMonthChat.binding);
  if (next) {
    try {
      await next.db.batch(CHAT_SCHEMA.map((q) => next.db.prepare(q)));
      report.nextMonthChat.prepared = true;
    } catch (e: any) {
      report.errors.push(`${next.binding} schema: ${e?.message || e}`);
    }
  }
  if (report.errors.length) console.warn('[Cron] retention errors', report.errors);
  return report;
}
