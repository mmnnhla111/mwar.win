import Fastify, { type FastifyRequest } from 'fastify';
import { Pool, type PoolClient } from 'pg';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import zlib from 'zlib';
import crypto from 'crypto';
import type { FinancialAuditEvent, AuditBatchBody, AuditBatchResult } from '@mwar/shared';
import {
  AUDIT_BATCH_MAX,
  AUDIT_SIG_HEADER,
  AUDIT_SIG_MAX_SKEW_SECONDS,
  AUDIT_TS_HEADER,
  LOG_RETENTION_DAYS,
  auditStringToSign,
  isWalletMovingAction,
} from '@mwar/shared';

/**
 * MWAR financial log receiver (Mini PC, spec §8–§9).
 *  - POST /api/logs/batch, POST /api/logs : HMAC-SHA256-signed deliveries from the API worker's queue
 *    consumer / outbox. Inserted in one transaction, idempotent on transaction_id. 503 while
 *    PostgreSQL is down, so the Cloudflare Queue keeps the events and retries (nothing in RAM).
 *  - GET /internal/reconcile/:userId : signed Layer-1 cross-check (net of wallet-moving events).
 *  - Daily maintenance: create this + next month's logs_YYYY_MM, archive tables older than 90 days
 *    to R2 (audit-archives/logs_YYYY_MM.json.gz, sha256-verified) and only then drop them.
 */

for (const candidate of [path.resolve(process.cwd(), '.env'), path.resolve(__dirname, '../.env'), path.resolve(__dirname, '../../.env'), '/opt/mwar-node/.env']) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    console.log(`[Log Receiver] Loaded environment from: ${candidate}`);
    break;
  }
}

const dbUrl = process.env.DATABASE_URL || 'postgresql://log_writer:local_dev_password_2026@localhost:5432/game_audit_logs';
/** HMAC-SHA256 key, same value as the API worker's LOG_RECEIVER_SECRET. Required. */
const LOG_SECRET = process.env.LOG_RECEIVER_SECRET || process.env.LOG_INGEST_SECRET || '';
/** For uploading 90-day archives to R2 through the API worker. */
const WORKER_API_URL = (process.env.WORKER_API_URL || 'https://api.mwar.win').replace(/\/+$/, '');
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';
const ARCHIVE_DIR = process.env.LOG_ARCHIVE_DIR || path.resolve(process.cwd(), 'archive');
const MAINTENANCE_INTERVAL_MS = 24 * 3600_000;

if (!LOG_SECRET) {
  console.error('[Log Receiver] LOG_RECEIVER_SECRET is not set: every request will be refused (401).');
}

const app = Fastify({ logger: true, bodyLimit: 5 * 1024 * 1024 });
// Keep the raw body: the HMAC covers the exact bytes the worker sent
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
  try {
    done(null, body ? JSON.parse(body as string) : {});
  } catch (e) {
    (e as { statusCode?: number }).statusCode = 400;
    done(e as Error, undefined);
  }
});

const pgPool = new Pool({ connectionString: dbUrl, max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 3000 });
let isDbConnected = false;
pgPool.on('error', (err) => {
  console.error('[PostgreSQL Pool Background Error]', err.message);
  isDbConnected = false;
});

// ---- Monthly tables -----------------------------------------------------------------------------

const ensuredTables = new Set<string>();

/** logs_YYYY_MM for a timestamp (UTC). */
export function tableFor(date: Date): string {
  return `logs_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

type Q = { query: (q: string, v?: unknown[]) => Promise<any> };

/**
 * Monthly, append-only table. Row-level UPDATE / DELETE / TRUNCATE are rejected by triggers, so the
 * audit trail is immutable; the only way data leaves is the 90-day archive, which drops the whole table.
 */
export async function ensureTable(client: Q, table: string) {
  if (ensuredTables.has(table)) return;
  if (!/^logs_\d{4}_\d{2}$/.test(table)) throw new Error('bad table name');
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id BIGSERIAL PRIMARY KEY,
      transaction_id VARCHAR(64) UNIQUE NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      action_type VARCHAR(32) NOT NULL,
      amount_micro_usd BIGINT NOT NULL,
      balance_after_micro_usd BIGINT NOT NULL,
      source_game_id VARCHAR(64),
      related_user_id VARCHAR(36),
      mlm_level INT CHECK (mlm_level BETWEEN 1 AND 5),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS idx_${table}_user_date ON ${table}(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_${table}_action ON ${table}(action_type);
    CREATE OR REPLACE FUNCTION mwar_logs_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Financial audit logs are immutable (% blocked)', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS ${table}_no_update ON ${table};
    CREATE TRIGGER ${table}_no_update BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION mwar_logs_immutable();
    DROP TRIGGER IF EXISTS ${table}_no_truncate ON ${table};
    CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION mwar_logs_immutable();
  `);
  ensuredTables.add(table);
}

/** This month and next month (so a midnight-of-the-month burst never waits on DDL). */
export async function prepareMonthlyTables(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const tables = [tableFor(now), tableFor(next)];
  for (const t of tables) await ensureTable(pgPool, t);
  return tables;
}

// ---- Validation + insert ------------------------------------------------------------------------

const DIGITS = /^-?\d{1,19}$/;
function validEvent(e: any): e is FinancialAuditEvent {
  return (
    e &&
    typeof e.transaction_id === 'string' && e.transaction_id.length > 0 && e.transaction_id.length <= 64 &&
    typeof e.user_id === 'string' && e.user_id.length > 0 && e.user_id.length <= 36 &&
    typeof e.action_type === 'string' && /^[A-Z_]{2,32}$/.test(e.action_type) &&
    DIGITS.test(String(e.amount_micro_usd)) &&
    DIGITS.test(String(e.balance_after_micro_usd ?? '0')) &&
    !isNaN(new Date(e.created_at).getTime())
  );
}

async function insertEvent(client: Q, e: FinancialAuditEvent): Promise<boolean> {
  const when = new Date(e.created_at);
  const table = tableFor(when);
  await ensureTable(client, table);
  const r = await client.query(
    `INSERT INTO ${table} (transaction_id, user_id, action_type, amount_micro_usd, balance_after_micro_usd, source_game_id, related_user_id, mlm_level, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (transaction_id) DO NOTHING`,
    [
      e.transaction_id,
      e.user_id,
      e.action_type,
      String(e.amount_micro_usd),
      String(e.balance_after_micro_usd ?? '0'),
      e.source_game_id ? String(e.source_game_id).slice(0, 64) : null,
      e.related_user_id ? String(e.related_user_id).slice(0, 36) : null,
      e.mlm_level && e.mlm_level >= 1 && e.mlm_level <= 5 ? e.mlm_level : null,
      when.toISOString(),
    ]
  );
  return r.rowCount === 1;
}

/** All-or-nothing: the worker acks the batch only when every event is stored (or already was). */
export async function insertBatch(events: FinancialAuditEvent[]): Promise<AuditBatchResult> {
  const client: PoolClient = await pgPool.connect();
  try {
    await client.query('BEGIN');
    let stored = 0;
    for (const e of events) if (await insertEvent(client, e)) stored++;
    await client.query('COMMIT');
    return { success: true, received: events.length, stored, duplicates: events.length - stored };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // DDL inside a rolled-back transaction is undone too
    ensuredTables.clear();
    throw err;
  } finally {
    client.release();
  }
}

// ---- HMAC-SHA256 --------------------------------------------------------------------------------

export function verifySignature(method: string, url: string, headers: Record<string, unknown>, rawBody: string, nowSec = Math.floor(Date.now() / 1000)): { ok: true } | { ok: false; error: string } {
  if (!LOG_SECRET) return { ok: false, error: 'receiver has no LOG_RECEIVER_SECRET' };
  const ts = String(headers[AUDIT_TS_HEADER] ?? '');
  const sig = String(headers[AUDIT_SIG_HEADER] ?? '').toLowerCase();
  if (!/^\d{9,11}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, error: 'missing signature' };
  if (Math.abs(nowSec - Number(ts)) > AUDIT_SIG_MAX_SKEW_SECONDS) return { ok: false, error: 'stale signature' };
  const bodyHash = crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex');
  const expected = crypto.createHmac('sha256', LOG_SECRET).update(auditStringToSign(ts, method, url, bodyHash)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) return { ok: false, error: 'bad signature' };
  return { ok: true };
}

app.addHook('preHandler', async (request, reply) => {
  if (request.url === '/health') return;
  const raw = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
  const v = verifySignature(request.method, request.url, request.headers as Record<string, unknown>, raw);
  if (!v.ok) return reply.status(401).send({ error: v.error });
});

// ---- Routes -------------------------------------------------------------------------------------

app.get('/health', async () => ({ status: 'ok', service: 'MWAR financial log receiver', isDbConnected, timestamp: new Date().toISOString() }));

async function handleEvents(events: unknown, reply: any) {
  if (!Array.isArray(events) || !events.length || events.length > AUDIT_BATCH_MAX) return reply.status(400).send({ error: `events must be 1–${AUDIT_BATCH_MAX} items` });
  const bad = events.findIndex((e) => !validEvent(e));
  if (bad >= 0) return reply.status(400).send({ error: `invalid event at index ${bad}` });
  if (!isDbConnected) return reply.status(503).send({ error: 'postgres_offline', retry: true });
  try {
    return reply.send(await insertBatch(events as FinancialAuditEvent[]));
  } catch (err: any) {
    return reply.status(503).send({ error: 'db_write_error', retry: true, details: err.message });
  }
}

app.post<{ Body: AuditBatchBody }>('/api/logs/batch', async (request, reply) => handleEvents(request.body?.events, reply));
/** Single event (same signature rules). */
app.post<{ Body: FinancialAuditEvent }>('/api/logs', async (request, reply) => handleEvents([request.body], reply));

/** Monthly tables that may hold rows between two instants. */
export function tablesBetween(start: Date, end: Date) {
  const out: string[] = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (d <= end) {
    out.push(tableFor(d));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/**
 * Layer-1 cross-check for a cashout audit: net (Σ signed amounts) and count of wallet-moving events
 * with amount ≠ 0 for [since, until) (unix seconds). Inflow types add, outflow types subtract.
 */
app.get<{ Params: { userId: string }; Querystring: { since?: string; until?: string } }>('/internal/reconcile/:userId', async (request, reply) => {
  const { userId } = request.params;
  const nowSec = Math.floor(Date.now() / 1000);
  const until = Number(request.query.until) || nowSec;
  const since = Number(request.query.since) || nowSec - LOG_RETENTION_DAYS * 86_400;
  if (!isDbConnected) return reply.status(503).send({ error: 'postgres_offline' });
  try {
    const wanted = tablesBetween(new Date(since * 1000), new Date(until * 1000));
    const existing = await pgPool.query(`SELECT tablename FROM pg_tables WHERE tablename = ANY($1)`, [wanted]);
    const tables: string[] = existing.rows.map((r: { tablename: string }) => r.tablename).sort();
    let net = 0n;
    let events = 0;
    if (tables.length) {
      const union = tables.map((t) => `SELECT action_type, amount_micro_usd FROM ${t} WHERE user_id = $1 AND created_at >= to_timestamp($2) AND created_at < to_timestamp($3) AND amount_micro_usd <> 0`).join(' UNION ALL ');
      const res = await pgPool.query(`SELECT action_type, COALESCE(SUM(amount_micro_usd), 0)::text AS total, COUNT(*)::int AS n FROM (${union}) l GROUP BY action_type`, [userId, since, until]);
      const outflow = new Set(['CASHOUT_REQUEST', 'MARKET_BUY', 'AFK_FORFEIT']);
      for (const r of res.rows as { action_type: string; total: string; n: number }[]) {
        if (!isWalletMovingAction(r.action_type)) continue;
        net += outflow.has(r.action_type) ? -BigInt(r.total) : BigInt(r.total);
        events += r.n;
      }
    }
    return reply.send({ userId, since, until, netMicroUsd: net.toString(), events, tables, source: 'postgresql' });
  } catch (err: any) {
    return reply.status(500).send({ error: 'Failed to query audit logs', details: err.message });
  }
});

// ---- 90-day archive → R2 ------------------------------------------------------------------------

/**
 * A monthly table whose LAST day is older than 90 days is exported as a JSON array, gzipped, checked
 * (gunzip + row count), uploaded to R2 via the worker (sha256 verified on both ends) and only then
 * dropped. Without INTERNAL_API_SECRET the archive is written to disk and the table is kept.
 */
export async function archiveExpiredTables(now = new Date()) {
  if (!isDbConnected) return { archived: [] as string[], kept: [] as string[] };
  const res = await pgPool.query(`SELECT tablename FROM pg_tables WHERE tablename ~ '^logs_[0-9]{4}_[0-9]{2}$' ORDER BY tablename`);
  const archived: string[] = [];
  const kept: string[] = [];
  for (const { tablename } of res.rows as { tablename: string }[]) {
    const [, y, m] = tablename.split('_').map(Number);
    const monthEnd = Date.UTC(y, m, 1); // first instant of the next month
    if (now.getTime() - monthEnd < LOG_RETENTION_DAYS * 86_400_000) continue;
    try {
      const rows = (await pgPool.query(`SELECT * FROM ${tablename} ORDER BY id`)).rows;
      const json = JSON.stringify(rows);
      const gz = zlib.gzipSync(Buffer.from(json), { level: 9 });
      const check = JSON.parse(zlib.gunzipSync(gz).toString('utf8')) as unknown[];
      if (check.length !== rows.length) throw new Error('gzip self-check failed');
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const name = `${tablename}.json.gz`;
      fs.writeFileSync(path.join(ARCHIVE_DIR, name), gz);
      if (!INTERNAL_API_SECRET) {
        console.warn(`[Archive] ${name} written locally; set INTERNAL_API_SECRET to upload to R2 and drop ${tablename}`);
        kept.push(tablename);
        continue;
      }
      const sha = crypto.createHash('sha256').update(gz).digest('hex');
      const up = await fetch(`${WORKER_API_URL}/api/internal/log-archive/${name}`, {
        method: 'PUT',
        headers: { 'X-Internal-Secret': INTERNAL_API_SECRET, 'Content-Type': 'application/gzip', 'X-Content-Sha256': sha, 'X-Row-Count': String(rows.length) },
        body: gz,
      });
      const body = (await up.json().catch(() => ({}))) as { success?: boolean; sha256?: string; bytes?: number; key?: string };
      if (!up.ok || !body.success || body.sha256 !== sha || body.bytes !== gz.length) {
        console.warn(`[Archive] R2 upload not verified for ${tablename} (HTTP ${up.status}); table kept`);
        kept.push(tablename);
        continue;
      }
      await pgPool.query(`DROP TABLE ${tablename}`);
      ensuredTables.delete(tablename);
      archived.push(tablename);
      console.log(`[Archive] ${tablename} → R2 ${body.key} (${rows.length} rows, ${gz.length} bytes, sha256 ${sha}); local table dropped`);
    } catch (e: any) {
      console.warn(`[Archive] ${tablename} failed: ${e.message}; table kept`);
      kept.push(tablename);
    }
  }
  return { archived, kept };
}

export async function runDailyMaintenance(now = new Date()) {
  const tables = await prepareMonthlyTables(now);
  const archive = await archiveExpiredTables(now);
  return { prepared: tables, ...archive };
}

/** Signed on-demand run (ops / tests). Optional ?now=ISO to simulate a date. */
app.post<{ Querystring: { now?: string } }>('/internal/maintenance/run', async (request, reply) => {
  if (!isDbConnected) return reply.status(503).send({ error: 'postgres_offline' });
  const now = request.query.now ? new Date(request.query.now) : new Date();
  if (isNaN(now.getTime())) return reply.status(400).send({ error: 'bad now' });
  return reply.send({ success: true, ...(await runDailyMaintenance(now)) });
});

// ---- Startup ------------------------------------------------------------------------------------

async function checkDbConnection() {
  try {
    const client = await pgPool.connect();
    client.release();
    if (!isDbConnected) {
      isDbConnected = true;
      await prepareMonthlyTables();
      console.log('[Log Receiver] PostgreSQL connected; monthly tables ready');
    }
  } catch (err: any) {
    isDbConnected = false;
    console.warn(`[Log Receiver DB Check] PostgreSQL not reachable yet: ${err.message}`);
  }
}
setInterval(checkDbConnection, 10_000);

const start = async () => {
  try {
    await checkDbConnection();
    const port = Number(process.env.LOG_PORT || process.env.PORT) || 3000;
    await app.listen({ port, host: '0.0.0.0' });
    setTimeout(() => void runDailyMaintenance().catch((e) => console.warn('[Maintenance]', e.message)), 60_000);
    setInterval(() => void runDailyMaintenance().catch((e) => console.warn('[Maintenance]', e.message)), MAINTENANCE_INTERVAL_MS);
  } catch (err) {
    console.error('[Log Receiver Fatal Startup Error]', err);
    process.exit(1);
  }
};
start();
