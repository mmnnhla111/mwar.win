import Fastify from 'fastify';
import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import type { FinancialLog } from '@mwar/shared';
import { LEDGER_INFLOW_ACTIONS, LEDGER_OUTFLOW_ACTIONS } from '@mwar/shared';

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

/**
 * Monthly partitioned audit tables (spec §3/§4.3: logs_YYYY_MM). Each log goes to the table of its
 * own UTC month; the table is created on first use.
 */
function tableFor(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `logs_${y}_${m}`;
}
const ensuredTables = new Set<string>();
async function ensureTable(client: { query: (q: string) => Promise<unknown> }, table: string) {
  if (ensuredTables.has(table)) return;
  if (!/^logs_\d{4}_\d{2}$/.test(table)) throw new Error(`Bad table name ${table}`);
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
  `);
  ensuredTables.add(table);
}
function logTable(log: FinancialLog): string {
  const d = log.created_at ? new Date(log.created_at) : new Date();
  return tableFor(isNaN(d.getTime()) ? new Date() : d);
}
async function insertLog(client: { query: (q: string, v?: unknown[]) => Promise<unknown> }, log: FinancialLog) {
  const table = logTable(log);
  await ensureTable(client, table);
  await client.query(
    `INSERT INTO ${table} (transaction_id, user_id, action_type, amount_micro_usd, balance_after_micro_usd, source_game_id, related_user_id, mlm_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (transaction_id) DO NOTHING`,
    [
      log.transaction_id,
      log.user_id,
      log.action_type,
      log.amount_micro_usd.toString(),
      log.balance_after_micro_usd.toString(),
      log.source_game_id || null,
      log.related_user_id || null,
      log.mlm_level || null,
    ]
  );
}

/** Shared ingest secret (X-Log-Secret). When LOG_INGEST_SECRET is set, unsigned requests are rejected. */
const INGEST_SECRET = process.env.LOG_INGEST_SECRET || '';
if (!INGEST_SECRET) console.warn('[Log Receiver] LOG_INGEST_SECRET is not set — accepting unsigned log writes (set it in production).');
function authorized(headers: Record<string, unknown>): boolean {
  if (!INGEST_SECRET) return true;
  const got = String(headers['x-log-secret'] || '');
  if (got.length !== INGEST_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ INGEST_SECRET.charCodeAt(i);
  return diff === 0;
}

const INFLOW = new Set<string>(LEDGER_INFLOW_ACTIONS);
const OUTFLOW = new Set<string>(LEDGER_OUTFLOW_ACTIONS);
const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

// Offline Memory Buffer (Downtime resilience buffer when Mini PC PostgreSQL is offline)
const memoryBuffer: FinancialLog[] = [];
let isDbConnected = false;

// Auto-reconnect & table check
async function checkDbConnection() {
  try {
    const client = await pgPool.connect();
    isDbConnected = true;

    // Ensure the current month's table exists
    await ensureTable(client, tableFor());

    // Flush any pending memory buffer (in FIFO order, each into its own month table)
    if (memoryBuffer.length > 0) {
      console.log(`[Buffer Drain] Flushing ${memoryBuffer.length} buffered logs to PostgreSQL...`);
      const batch = memoryBuffer.splice(0, memoryBuffer.length);
      for (const log of batch) {
        try {
          await insertLog(client, log);
        } catch (e) {
          memoryBuffer.push(log);
          throw e;
        }
      }
    }

    client.release();
  } catch (err: any) {
    isDbConnected = false;
    console.warn(`[Log Receiver DB Check] PostgreSQL not reachable yet: ${err.message}`);
  }
}

// Check DB every 10 seconds
setInterval(checkDbConnection, 10000);
checkDbConnection();

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

// Receive Financial Log
app.post<{ Body: FinancialLog }>('/api/logs', async (request, reply) => {
  if (!authorized(request.headers as Record<string, unknown>)) {
    return reply.status(401).send({ error: 'Invalid or missing X-Log-Secret' });
  }
  const log = request.body;

  if (!log.transaction_id || !log.user_id || !log.action_type) {
    return reply.status(400).send({ error: 'Missing required log fields' });
  }

  if (isDbConnected) {
    try {
      await insertLog(pgPool, log);
      return reply.send({ success: true, stored: 'postgresql' });
    } catch {
      // Fallback to buffer
      memoryBuffer.push(log);
      return reply.send({ success: true, stored: 'memory_buffer', reason: 'db_write_error' });
    }
  } else {
    // Mini PC is offline: buffer safely
    memoryBuffer.push(log);
    return reply.send({ success: true, stored: 'memory_buffer', bufferSize: memoryBuffer.length });
  }
});

// Layer 1 Audit: Calculate Ledger Summation
app.get<{ Params: { userId: string } }>('/api/logs/summary/:userId', async (request, reply) => {
  if (!authorized(request.headers as Record<string, unknown>)) {
    return reply.status(401).send({ error: 'Invalid or missing X-Log-Secret' });
  }
  const { userId } = request.params;

  if (!isDbConnected) {
    // Compute from memory buffer if DB offline
    let calculatedBalance = 0n;
    for (const l of memoryBuffer.filter((x) => x.user_id === userId)) {
      const amt = BigInt(l.amount_micro_usd);
      if (INFLOW.has(l.action_type)) {
        calculatedBalance += amt;
      } else if (OUTFLOW.has(l.action_type)) {
        calculatedBalance -= amt;
      }
    }
    return reply.send({
      userId,
      calculatedBalanceMicroUsd: calculatedBalance.toString(),
      source: 'memory_buffer',
    });
  }

  try {
    // Sum across every monthly table (logs_YYYY_MM) still held in PostgreSQL
    const tables = await pgPool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~ '^logs_[0-9]{4}_[0-9]{2}$'`
    );
    const names: string[] = tables.rows.map((r: { table_name: string }) => r.table_name);
    if (names.length === 0) names.push(tableFor());
    const union = names.map((t) => `SELECT action_type, amount_micro_usd FROM ${t} WHERE user_id = $1`).join(' UNION ALL ');
    const res = await pgPool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN action_type IN (${sqlList(LEDGER_INFLOW_ACTIONS)}) THEN amount_micro_usd ELSE 0 END), 0) AS total_inflow,
         COALESCE(SUM(CASE WHEN action_type IN (${sqlList(LEDGER_OUTFLOW_ACTIONS)}) THEN amount_micro_usd ELSE 0 END), 0) AS total_outflow
       FROM (${union}) AS all_logs`,
      [userId]
    );

    const inflow = BigInt(res.rows[0].total_inflow);
    const outflow = BigInt(res.rows[0].total_outflow);
    const calculatedBalance = inflow - outflow;

    return reply.send({
      userId,
      totalInflowMicroUsd: inflow.toString(),
      totalOutflowMicroUsd: outflow.toString(),
      calculatedBalanceMicroUsd: calculatedBalance.toString(),
      source: 'postgresql_16',
    });
  } catch (err: any) {
    return reply.status(500).send({ error: 'Failed to query audit logs', details: err.message });
  }
});

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
