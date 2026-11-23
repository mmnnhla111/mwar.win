import Fastify from 'fastify';
import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import zlib from 'zlib';
import crypto from 'crypto';
import type { FinancialLog } from '@mwar/shared';
import { LEDGER_INFLOW_ACTIONS, LEDGER_OUTFLOW_ACTIONS, LOG_RETENTION_DAYS } from '@mwar/shared';

// Attempt to load .env from multiple candidate locations
const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../.env'),
  '/opt/mwar-node/.env',
];

for (const candidate of envCandidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    console.log(`[Log Receiver] Loaded environment from: ${candidate}`);
    break;
  }
}

const app = Fastify({ logger: true });

const dbUrl = process.env.DATABASE_URL || 'postgresql://log_writer:local_dev_password_2026@localhost:5432/game_audit_logs';
/** Shared secret the API worker sends as X-Log-Secret (set the same value as LOG_RECEIVER_SECRET there). */
const LOG_SECRET = process.env.LOG_RECEIVER_SECRET || process.env.LOG_INGEST_SECRET || '';
/** For uploading 90-day archives to R2 through the API worker. */
const WORKER_API_URL = process.env.WORKER_API_URL || 'https://api.mwar.win';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';
const ARCHIVE_DIR = process.env.LOG_ARCHIVE_DIR || path.resolve(process.cwd(), 'archive');

const pgPool = new Pool({
  connectionString: dbUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 3000,
});

pgPool.on('error', (err) => {
  console.error('[PostgreSQL Pool Background Error]', err.message);
  isDbConnected = false;
});

// Offline memory buffer — only for direct (non-queue) posts. Queue deliveries get 503 instead, so the
// Cloudflare Queue keeps them (up to 14 days) and retries: nothing is lost if the Mini PC reboots.
const memoryBuffer: FinancialLog[] = [];
let isDbConnected = false;
const ensuredTables = new Set<string>();

/** logs_YYYY_MM for a timestamp (UTC). */
export function tableFor(date: Date): string {
  return `logs_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Monthly, append-only table. Row-level UPDATE / DELETE / TRUNCATE are rejected by triggers, so the
 * audit trail is immutable; the only way data leaves is the 90-day archive, which drops the whole table.
 */
async function ensureTable(client: { query: (q: string) => Promise<unknown> }, table: string) {
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
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

async function insertLog(client: { query: (q: string, v?: unknown[]) => Promise<unknown> }, log: FinancialLog) {
  const created = log.created_at ? new Date(log.created_at) : new Date();
  const when = isNaN(created.getTime()) ? new Date() : created;
  const table = tableFor(when);
  await ensureTable(client, table);
  await client.query(
    `INSERT INTO ${table} (transaction_id, user_id, action_type, amount_micro_usd, balance_after_micro_usd, source_game_id, related_user_id, mlm_level, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (transaction_id) DO NOTHING`,
    [
      String(log.transaction_id).slice(0, 64),
      String(log.user_id).slice(0, 36),
      String(log.action_type).slice(0, 32),
      String(log.amount_micro_usd ?? 0),
      String(log.balance_after_micro_usd ?? 0),
      log.source_game_id ? String(log.source_game_id).slice(0, 64) : null,
      log.related_user_id ? String(log.related_user_id).slice(0, 36) : null,
      log.mlm_level || null,
      when.toISOString(),
    ]
  );
}

// Auto-reconnect & buffer drain
async function checkDbConnection() {
  try {
    const client = await pgPool.connect();
    isDbConnected = true;
    await ensureTable(client, tableFor(new Date()));
    if (memoryBuffer.length > 0) {
      console.log(`[Buffer Drain] Flushing ${memoryBuffer.length} buffered logs to PostgreSQL...`);
      const batch = memoryBuffer.splice(0, memoryBuffer.length);
      for (const log of batch) await insertLog(client, log);
    }
    client.release();
  } catch (err: any) {
    isDbConnected = false;
    console.warn(`[Log Receiver DB Check] PostgreSQL not reachable yet: ${err.message}`);
  }
}

setInterval(checkDbConnection, 10000);
checkDbConnection();

function authorized(headers: Record<string, unknown>) {
  if (!LOG_SECRET) return true; // local dev
  const got = String(headers['x-log-secret'] ?? '');
  return got.length === LOG_SECRET.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(LOG_SECRET));
}

// Health Endpoint
app.get('/health', async () => {
  return {
    status: 'ok',
    service: 'Fastify Financial Log Receiver',
    isDbConnected,
    bufferedLogsCount: memoryBuffer.length,
    timestamp: new Date().toISOString(),
  };
});

// Receive Financial Log (append-only)
app.post<{ Body: FinancialLog }>('/api/logs', async (request, reply) => {
  if (!authorized(request.headers)) return reply.status(401).send({ error: 'Invalid log secret' });
  const log = request.body;
  const fromQueue = request.headers['x-queue-delivery'] === '1';

  if (!log || !log.transaction_id || !log.user_id || !log.action_type) {
    return reply.status(400).send({ error: 'Missing required log fields' });
  }

  if (isDbConnected) {
    try {
      await insertLog(pgPool, log);
      return reply.send({ success: true, stored: 'postgresql' });
    } catch (err: any) {
      if (fromQueue) return reply.status(503).send({ error: 'db_write_error', retry: true, details: err.message });
      memoryBuffer.push(log);
      return reply.send({ success: true, stored: 'memory_buffer', reason: 'db_write_error' });
    }
  }
  if (fromQueue) return reply.status(503).send({ error: 'postgres_offline', retry: true });
  memoryBuffer.push(log);
  return reply.send({ success: true, stored: 'memory_buffer', bufferSize: memoryBuffer.length });
});

/** Monthly tables that may hold rows from the last `days` days. */
function tablesForWindow(days: number, now = new Date()) {
  const out: string[] = [];
  const start = new Date(now.getTime() - days * 86_400_000);
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (d <= now) {
    out.push(tableFor(d));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

// Layer 1 Audit: 90-day ledger summation = Σ earnings − Σ withdrawals − Σ purchases (+ AFK claw-backs)
app.get<{ Params: { userId: string } }>('/api/logs/summary/:userId', async (request, reply) => {
  if (!authorized(request.headers)) return reply.status(401).send({ error: 'Invalid log secret' });
  const { userId } = request.params;
  const inflow = LEDGER_INFLOW_ACTIONS as string[];
  const outflow = LEDGER_OUTFLOW_ACTIONS as string[];

  if (!isDbConnected) {
    let calculatedBalance = 0n;
    for (const l of memoryBuffer.filter((x) => x.user_id === userId)) {
      const amt = BigInt(l.amount_micro_usd);
      if (inflow.includes(l.action_type)) calculatedBalance += amt;
      else if (outflow.includes(l.action_type)) calculatedBalance -= amt;
    }
    return reply.status(503).send({ userId, calculatedBalanceMicroUsd: calculatedBalance.toString(), source: 'memory_buffer', partial: true });
  }

  try {
    const existing = await pgPool.query(`SELECT tablename FROM pg_tables WHERE tablename = ANY($1)`, [tablesForWindow(LOG_RETENTION_DAYS)]);
    const tables: string[] = existing.rows.map((r: { tablename: string }) => r.tablename);
    if (!tables.length) {
      return reply.send({ userId, totalInflowMicroUsd: '0', totalOutflowMicroUsd: '0', calculatedBalanceMicroUsd: '0', source: 'postgresql' });
    }
    const union = tables.map((t) => `SELECT action_type, amount_micro_usd FROM ${t} WHERE user_id = $1`).join(' UNION ALL ');
    const res = await pgPool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN action_type = ANY($2) THEN amount_micro_usd ELSE 0 END), 0) AS total_inflow,
         COALESCE(SUM(CASE WHEN action_type = ANY($3) THEN amount_micro_usd ELSE 0 END), 0) AS total_outflow
       FROM (${union}) AS ledger`,
      [userId, inflow, outflow]
    );
    const inSum = BigInt(res.rows[0].total_inflow);
    const outSum = BigInt(res.rows[0].total_outflow);
    return reply.send({
      userId,
      totalInflowMicroUsd: inSum.toString(),
      totalOutflowMicroUsd: outSum.toString(),
      calculatedBalanceMicroUsd: (inSum - outSum).toString(),
      tables,
      source: 'postgresql',
    });
  } catch (err: any) {
    return reply.status(500).send({ error: 'Failed to query audit logs', details: err.message });
  }
});

/**
 * 90-day retention: a monthly table whose LAST day is older than 90 days is exported to gzip JSONL,
 * uploaded to R2 (via the API worker's /api/internal/log-archive) and only then dropped locally.
 * Without INTERNAL_API_SECRET the archive stays on disk and the table is kept.
 */
export async function archiveExpiredTables(now = new Date()) {
  if (!isDbConnected) return [];
  const res = await pgPool.query(`SELECT tablename FROM pg_tables WHERE tablename ~ '^logs_[0-9]{4}_[0-9]{2}$' ORDER BY tablename`);
  const done: string[] = [];
  for (const { tablename } of res.rows as { tablename: string }[]) {
    const [, y, m] = tablename.split('_').map(Number);
    const monthEnd = Date.UTC(y, m, 1); // first instant of the next month
    if (now.getTime() - monthEnd < LOG_RETENTION_DAYS * 86_400_000) continue;
    const rows = await pgPool.query(`SELECT * FROM ${tablename} ORDER BY id`);
    const jsonl = rows.rows.map((r) => JSON.stringify(r)).join('\n');
    const gz = zlib.gzipSync(Buffer.from(jsonl));
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const file = path.join(ARCHIVE_DIR, `${tablename}.jsonl.gz`);
    fs.writeFileSync(file, gz);
    if (!INTERNAL_API_SECRET) {
      console.warn(`[Archive] ${file} written; set INTERNAL_API_SECRET to upload to R2 and drop ${tablename}`);
      continue;
    }
    const sha = crypto.createHash('sha256').update(gz).digest('hex');
    const up = await fetch(`${WORKER_API_URL}/api/internal/log-archive/${tablename}.jsonl.gz`, {
      method: 'PUT',
      headers: { 'X-Internal-Secret': INTERNAL_API_SECRET, 'Content-Type': 'application/gzip', 'X-Content-Sha256': sha },
      body: gz,
    }).catch((e) => ({ ok: false, status: 0, statusText: String(e) }) as const);
    if (!up.ok) {
      console.warn(`[Archive] R2 upload failed for ${tablename} (${up.status}); table kept`);
      continue;
    }
    await pgPool.query(`DROP TABLE ${tablename}`);
    ensuredTables.delete(tablename);
    done.push(tablename);
    console.log(`[Archive] ${tablename} → R2 audit-archive/ (${gz.length} bytes, sha256 ${sha}); local table dropped`);
  }
  return done;
}
setInterval(() => void archiveExpiredTables().catch((e) => console.warn('[Archive]', e.message)), 6 * 3600_000);
setTimeout(() => void archiveExpiredTables().catch(() => {}), 60_000);

const start = async () => {
  try {
    const port = Number(process.env.LOG_PORT || process.env.PORT) || 3000;
    const host = '0.0.0.0';
    console.log(`[Log Receiver] Starting Fastify log server on ${host}:${port}...`);
    await app.listen({ port, host });
    console.log(`[Log Receiver] Running on http://${host}:${port}`);
    console.log(`[Log Receiver] Healthcheck endpoint: http://${host}:${port}/health`);
  } catch (err) {
    console.error('[Log Receiver Fatal Startup Error]', err);
    app.log.error(err);
    process.exit(1);
  }
};

start();
