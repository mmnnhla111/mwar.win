import type { FinancialLog, FinancialAuditEvent, AuditBatchResult } from '@mwar/shared';
import { AUDIT_BATCH_MAX, AUDIT_EVENT_VERSION, AUDIT_SIG_HEADER, AUDIT_TS_HEADER, QUEUE_RETENTION_SECONDS, auditStringToSign } from '@mwar/shared';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../types';

/**
 * Resilient financial audit trail (spec §8):
 *   D1 write (caller) → FINANCIAL_AUDIT_QUEUE → queue() consumer → signed POST → Mini PC PostgreSQL.
 * Fallback: when the queue binding is missing, queue.send() fails, or a queued event nears the 14-day
 * retention limit, the event goes to the D1 audit_outbox; the 10-minute cron re-sends it. No financial
 * mutation ever fails because of logging.
 */

/** JSON.stringify that keeps BigInt Micro-USD values exact (as strings). */
export const stringifyLog = (log: unknown) => JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** Current wallet balance (used for balance_after_micro_usd in audit rows). */
export async function walletBalance(db: D1Database, userId: string): Promise<bigint> {
  const row = await db.prepare('SELECT balance_micro_usd FROM wallets WHERE user_id = ?1').bind(userId).first<{ balance_micro_usd: number }>();
  return BigInt(row?.balance_micro_usd ?? 0);
}

type AuditQueue = { send(body: unknown, opts?: { contentType?: string }): Promise<void>; sendBatch(msgs: Iterable<{ body: unknown; contentType?: string }>): Promise<void> };

/** FINANCIAL_AUDIT_QUEUE (or the legacy LOG_QUEUE name) when bound in this environment. */
export function auditQueue(env: Env): AuditQueue | null {
  const q = (env.FINANCIAL_AUDIT_QUEUE || env.LOG_QUEUE) as unknown as AuditQueue | undefined;
  return q && typeof q.send === 'function' ? q : null;
}

const str = (v: unknown) => (v === null || v === undefined ? '0' : typeof v === 'bigint' ? v.toString() : String(Math.trunc(Number(v)) || 0));

/** Normalise a FinancialLog into the frozen, versioned queue event. */
export function toAuditEvent(log: FinancialLog): FinancialAuditEvent {
  const created = log.created_at ? new Date(log.created_at as string) : new Date();
  return Object.freeze({
    v: AUDIT_EVENT_VERSION,
    transaction_id: String(log.transaction_id).slice(0, 64),
    user_id: String(log.user_id).slice(0, 36),
    action_type: log.action_type,
    amount_micro_usd: str(log.amount_micro_usd),
    balance_after_micro_usd: str(log.balance_after_micro_usd),
    source_game_id: log.source_game_id ? String(log.source_game_id).slice(0, 64) : null,
    related_user_id: log.related_user_id ? String(log.related_user_id).slice(0, 36) : null,
    mlm_level: log.mlm_level ? Number(log.mlm_level) : null,
    created_at: (isNaN(created.getTime()) ? new Date() : created).toISOString(),
  });
}

/** Durable D1 fallback. Idempotent on transaction_id. */
export async function putInOutbox(db: D1Database, events: FinancialAuditEvent[], reason: string, error?: string): Promise<void> {
  if (!events.length) return;
  const now = Math.floor(Date.now() / 1000);
  const stmts = events.map((e) =>
    db
      .prepare(
        `INSERT INTO audit_outbox (transaction_id, user_id, payload_json, reason, last_error, next_attempt_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) ON CONFLICT(transaction_id) DO NOTHING`
      )
      .bind(e.transaction_id, e.user_id, JSON.stringify(e), reason, error ? error.slice(0, 300) : null, now)
  );
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}

/**
 * Immutable financial audit trail: call AFTER the D1 balance write succeeded. Never throws.
 */
export async function logFinancialTransaction(env: Env, log: FinancialLog): Promise<void> {
  const event = toAuditEvent(log);
  const q = auditQueue(env);
  if (q) {
    try {
      await q.send(event, { contentType: 'json' });
      return;
    } catch (err: any) {
      console.warn('[Audit] queue send failed, using D1 outbox:', err?.message || err);
      await putInOutbox(env.DB, [event], 'queue_send_failed', String(err?.message || err)).catch((e) => console.error('[Audit] outbox write failed', e, event));
      return;
    }
  }
  await putInOutbox(env.DB, [event], 'no_queue').catch((e) => console.error('[Audit] outbox write failed', e, event));
}

// ---- HMAC-SHA256 signing ------------------------------------------------------------------------

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
}
export function logReceiverSecret(env: Env): string {
  return env.LOG_RECEIVER_SECRET || env.LOG_INGEST_SECRET || '';
}

/** Headers for a signed request to the log receiver (method + path + query + body hash). */
export async function signedHeaders(secret: string, method: string, pathWithQuery: string, body = ''): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = hex(await crypto.subtle.sign('HMAC', key, enc.encode(auditStringToSign(ts, method, pathWithQuery, await sha256Hex(body)))));
  return { [AUDIT_TS_HEADER]: String(ts), [AUDIT_SIG_HEADER]: sig, ...(body ? { 'Content-Type': 'application/json' } : {}) };
}

/** Log receiver origin (LOG_RECEIVER_URL may be given as https://logs.mwar.win or …/api/logs). */
export function logReceiverBase(env: Env): string | null {
  const u = env.LOG_RECEIVER_URL?.trim();
  if (!u) return null;
  return u.replace(/\/api\/logs\/?$/, '').replace(/\/+$/, '');
}

/** One signed batch delivery. ok only when PostgreSQL committed every event (new or duplicate). */
export async function deliverAuditBatch(env: Env, events: FinancialAuditEvent[]): Promise<{ ok: boolean; status: number; result?: AuditBatchResult; error?: string }> {
  const base = logReceiverBase(env);
  const secret = logReceiverSecret(env);
  if (!base) return { ok: false, status: 0, error: 'LOG_RECEIVER_URL not set' };
  if (!secret) return { ok: false, status: 0, error: 'LOG_RECEIVER_SECRET not set' };
  const path = '/api/logs/batch';
  const body = JSON.stringify({ events });
  try {
    const res = await fetch(base + path, { method: 'POST', headers: await signedHeaders(secret, 'POST', path, body), body, signal: AbortSignal.timeout(15_000) });
    const result = (await res.json().catch(() => null)) as AuditBatchResult | null;
    if (res.ok && result?.success && result.stored + result.duplicates === events.length) return { ok: true, status: res.status, result };
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, status: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

// ---- Queue consumer -----------------------------------------------------------------------------

export interface AuditQueueMessage {
  id: string;
  timestamp: Date;
  body: unknown;
  attempts: number;
  ack(): void;
  retry(o?: { delaySeconds?: number }): void;
}

/** Keep this in sync with max_retries in wrangler.toml. */
export const QUEUE_MAX_RETRIES = 100;
/** Back-off: 1 min, 2, 4 … capped at 4 h → 100 retries cover the full 14-day retention. */
export const retryDelaySeconds = (attempts: number) => Math.min(4 * 3600, 60 * 2 ** Math.max(0, Math.min(8, attempts - 1)));
/** Hand an event to the D1 outbox once it is this close to the queue's 14-day expiry. */
const EXPIRY_MARGIN_SECONDS = 12 * 3600;

/** Older payloads were plain FinancialLog objects (LOG_QUEUE); normalise both shapes. */
function bodyToEvent(body: unknown): FinancialAuditEvent | null {
  const b = body as any;
  if (!b || typeof b !== 'object' || !b.transaction_id || !b.user_id || !b.action_type) return null;
  return b.v === AUDIT_EVENT_VERSION ? (b as FinancialAuditEvent) : toAuditEvent(b as FinancialLog);
}

/**
 * queue() consumer: one signed delivery per batch (chunks of 100). Success → ack all. Failure →
 * retry with back-off; events that are near expiry or out of retries move to the D1 outbox first.
 */
export async function consumeAuditBatch(messages: readonly AuditQueueMessage[], env: Env): Promise<{ delivered: number; retried: number; outboxed: number; dropped: number }> {
  const stats = { delivered: 0, retried: 0, outboxed: 0, dropped: 0 };
  const valid: Array<{ m: AuditQueueMessage; e: FinancialAuditEvent }> = [];
  for (const m of messages) {
    const e = bodyToEvent(m.body);
    if (!e) {
      console.error('[Audit consumer] malformed message dropped', m.id, m.body);
      m.ack();
      stats.dropped++;
    } else valid.push({ m, e });
  }
  for (let i = 0; i < valid.length; i += AUDIT_BATCH_MAX) {
    const chunk = valid.slice(i, i + AUDIT_BATCH_MAX);
    const r = await deliverAuditBatch(env, chunk.map((x) => x.e));
    if (r.ok) {
      chunk.forEach((x) => x.m.ack());
      stats.delivered += chunk.length;
      continue;
    }
    console.warn(`[Audit consumer] delivery failed (${r.error}); ${chunk.length} events will retry`);
    const now = Date.now();
    const expiring = chunk.filter(
      (x) => (now - new Date(x.m.timestamp).getTime()) / 1000 > QUEUE_RETENTION_SECONDS - EXPIRY_MARGIN_SECONDS || x.m.attempts >= QUEUE_MAX_RETRIES
    );
    let outboxed = false;
    if (expiring.length) {
      try {
        await putInOutbox(env.DB, expiring.map((x) => x.e), expiring.some((x) => x.m.attempts >= QUEUE_MAX_RETRIES) ? 'queue_max_retries' : 'queue_expiring', r.error);
        expiring.forEach((x) => x.m.ack());
        stats.outboxed += expiring.length;
        outboxed = true;
      } catch (e) {
        console.error('[Audit consumer] outbox write failed; keeping in queue', e);
      }
    }
    for (const x of chunk) {
      if (outboxed && expiring.includes(x)) continue;
      x.m.retry({ delaySeconds: retryDelaySeconds(x.m.attempts) });
      stats.retried++;
    }
  }
  return stats;
}

// ---- Outbox flush (cron */10) -------------------------------------------------------------------

/**
 * Re-send outbox rows: into the queue when it is bound (the consumer then delivers), otherwise
 * directly to the receiver. A row is deleted only after the queue accepted it or PostgreSQL stored it.
 */
export async function flushAuditOutbox(env: Env, limit = 500): Promise<{ sent: number; viaQueue: boolean; failed: number; remaining: number }> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare('SELECT id, payload_json, attempts FROM audit_outbox WHERE next_attempt_at <= ?1 ORDER BY id LIMIT ?2')
    .bind(now, limit)
    .all<{ id: number; payload_json: string; attempts: number }>();
  const list = rows.results || [];
  const q = auditQueue(env);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < list.length; i += AUDIT_BATCH_MAX) {
    const chunk = list.slice(i, i + AUDIT_BATCH_MAX);
    const events = chunk.map((r) => JSON.parse(r.payload_json) as FinancialAuditEvent);
    let ok = false;
    let error = '';
    if (q) {
      try {
        await q.sendBatch(events.map((body) => ({ body, contentType: 'json' })));
        ok = true;
      } catch (e: any) {
        error = `queue: ${e?.message || e}`;
      }
    }
    if (!ok) {
      const r = await deliverAuditBatch(env, events);
      ok = r.ok;
      error = [error, r.error].filter(Boolean).join('; ');
    }
    const ids = chunk.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    if (ok) {
      await env.DB.prepare(`DELETE FROM audit_outbox WHERE id IN (${marks})`).bind(...ids).run();
      sent += chunk.length;
    } else {
      failed += chunk.length;
      const attempts = Math.max(...chunk.map((r) => r.attempts)) + 1;
      await env.DB.prepare(`UPDATE audit_outbox SET attempts = attempts + 1, last_error = ?1, next_attempt_at = ?2 WHERE id IN (${marks})`)
        .bind(error.slice(0, 300), now + Math.min(6 * 3600, 300 * 2 ** Math.min(6, attempts - 1)), ...ids)
        .run();
      break; // receiver down: don't hammer it with the rest
    }
  }
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_outbox').first<{ n: number }>();
  return { sent, viaQueue: !!q, failed, remaining: left?.n ?? 0 };
}
