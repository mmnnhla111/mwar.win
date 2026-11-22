import Fastify from 'fastify';
import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import type { FinancialLog } from '@mwar/shared';

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

// Offline Memory Buffer (Downtime resilience buffer when Mini PC PostgreSQL is offline)
const memoryBuffer: FinancialLog[] = [];
let isDbConnected = false;

// Auto-reconnect & table check
async function checkDbConnection() {
  try {
    const client = await pgPool.connect();
    isDbConnected = true;

    // Ensure logs_2026_11 exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS logs_2026_11 (
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
      CREATE INDEX IF NOT EXISTS idx_logs_user_date ON logs_2026_11(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_action ON logs_2026_11(action_type);
    `);

    // Flush any pending memory buffer
    if (memoryBuffer.length > 0) {
      console.log(`[Buffer Drain] Flushing ${memoryBuffer.length} buffered logs to PostgreSQL...`);
      const batch = memoryBuffer.splice(0, memoryBuffer.length);
      for (const log of batch) {
        await client.query(
          `INSERT INTO logs_2026_11 (transaction_id, user_id, action_type, amount_micro_usd, balance_after_micro_usd, source_game_id, related_user_id, mlm_level)
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
  const log = request.body;

  if (!log.transaction_id || !log.user_id || !log.action_type) {
    return reply.status(400).send({ error: 'Missing required log fields' });
  }

  if (isDbConnected) {
    try {
      await pgPool.query(
        `INSERT INTO logs_2026_11 (transaction_id, user_id, action_type, amount_micro_usd, balance_after_micro_usd, source_game_id, related_user_id, mlm_level)
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
  const { userId } = request.params;

  if (!isDbConnected) {
    // Compute from memory buffer if DB offline
    let calculatedBalance = 0n;
    for (const l of memoryBuffer.filter((x) => x.user_id === userId)) {
      const amt = BigInt(l.amount_micro_usd);
      if (['GAME_KILL', 'CHEST_OPEN', 'AD_WATCH', 'MLM_COMMISSION', 'DEV_MOCK_FAUCET', 'CASHOUT_REJECT_REFUND'].includes(l.action_type)) {
        calculatedBalance += amt;
      } else if (['CASHOUT_REQUEST', 'MARKET_BUY'].includes(l.action_type)) {
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
    const res = await pgPool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN action_type IN ('GAME_KILL', 'CHEST_OPEN', 'AD_WATCH', 'MLM_COMMISSION', 'DEV_MOCK_FAUCET', 'CASHOUT_REJECT_REFUND') THEN amount_micro_usd ELSE 0 END), 0) AS total_inflow,
         COALESCE(SUM(CASE WHEN action_type IN ('CASHOUT_REQUEST', 'MARKET_BUY') THEN amount_micro_usd ELSE 0 END), 0) AS total_outflow
       FROM logs_2026_11
       WHERE user_id = $1`,
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
