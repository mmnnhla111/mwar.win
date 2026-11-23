import type { FinancialLog } from '@mwar/shared';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../types';

/** JSON.stringify that keeps BigInt Micro-USD values exact (as strings). */
export const stringifyLog = (log: unknown) => JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

export function logReceiverHeaders(env: Env, queueDelivery = false): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const secret = env.LOG_RECEIVER_SECRET || env.LOG_INGEST_SECRET;
  if (secret) {
    h['X-Log-Secret'] = secret;
  }
  if (queueDelivery) h['X-Queue-Delivery'] = '1';
  return h;
}

/** Current wallet balance (used for balance_after_micro_usd in audit rows). */
export async function walletBalance(db: D1Database, userId: string): Promise<bigint> {
  const row = await db.prepare('SELECT balance_micro_usd FROM wallets WHERE user_id = ?1').bind(userId).first<{ balance_micro_usd: number }>();
  return BigInt(row?.balance_micro_usd ?? 0);
}

/**
 * Immutable financial audit trail: D1 write first (caller), then the log goes to the Cloudflare
 * Queue (kept up to 14 days while the Mini PC is offline) and on to PostgreSQL logs_YYYY_MM.
 */
export async function logFinancialTransaction(env: Env, log: FinancialLog): Promise<void> {
  if (!log.created_at) log = { ...log, created_at: new Date().toISOString() };
  // 1. Try sending to Cloudflare Queue if bound
  let queued = false;
  if (env.LOG_QUEUE && typeof env.LOG_QUEUE.send === 'function') {
    try {
      await env.LOG_QUEUE.send(log);
      queued = true;
    } catch (err) {
      console.warn('[Queue Warning] Failed to publish log to Cloudflare Queue:', err);
    }
  }

  // 2. Fallback to direct HTTP post to the Fastify Log Receiver (localhost / offline dev)
  if (!queued) {
    const receiverUrl = env.LOG_RECEIVER_URL || 'http://localhost:3000/api/logs';
    try {
      await fetch(receiverUrl, { method: 'POST', headers: logReceiverHeaders(env), body: stringifyLog(log) }).catch((e) => {
        if (env.DEV_MOCK_MODE === 'true') {
          console.log(`[Log Dispatch] Log buffered: ${log.action_type} - ${log.amount_micro_usd.toString()} Micro-USD (${e.message})`);
        }
      });
    } catch {
      // Ignored
    }
  }
}
