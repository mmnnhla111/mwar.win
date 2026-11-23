import type { FinancialLog } from '@mwar/shared';
import type { Env } from '../types';

export async function logFinancialTransaction(env: Env, log: FinancialLog): Promise<void> {
  // Stamp the event time once so queue + direct deliveries land in the same logs_YYYY_MM table
  if (!log.created_at) log.created_at = new Date().toISOString();
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

  // 2. Fallback to direct HTTP post to local Fastify Log Receiver (for localhost / offline dev)
  if (!queued || env.DEV_MOCK_MODE === 'true') {
    const receiverUrl = env.LOG_RECEIVER_URL || 'http://localhost:3000/api/logs';
    try {
      await fetch(receiverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(env.LOG_INGEST_SECRET ? { 'X-Log-Secret': env.LOG_INGEST_SECRET } : {}) },
        body: JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      }).catch((e) => {
        // Log receiver might be offline, which is expected during resilience tests
        if (env.DEV_MOCK_MODE === 'true') {
          console.log(`[Log Dispatch] Log buffered: ${log.action_type} - ${log.amount_micro_usd.toString()} Micro-USD (${e.message})`);
        }
      });
    } catch {
      // Ignored
    }
  }
}
