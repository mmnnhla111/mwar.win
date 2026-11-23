import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { FinancialLog } from '@mwar/shared';
import type { Env } from './types';
import { authRouter } from './routes/auth';
import { networkRouter } from './routes/network';
import { walletRouter } from './routes/wallet';
import { marketplaceRouter } from './routes/marketplace';
import { adsRouter } from './routes/ads';
import { gameRouter } from './routes/game';
import { chatRouter } from './routes/chat';
import { auditRouter } from './routes/audit';
import { questsRouter, settleDailyMlm, getUtcDateKey } from './routes/quests';
import { nodesRouter } from './routes/nodes';
import { practiceRouter } from './routes/practice';
import { releaseMarketplaceEscrow } from './routes/marketplace';
import { hasInternalSecret } from './utils/guards';

/** Daily 00:00 UTC job: settle *yesterday's* MLM ledger, then release matured marketplace escrow. */
async function runDailyJobs(env: Env, dateKey?: string, targetUserId?: string) {
  const key = dateKey || getUtcDateKey(new Date(Date.now() - 86_400_000));
  const mlm = await settleDailyMlm(env, key, targetUserId);
  const escrow = await releaseMarketplaceEscrow(env);
  return { ...mlm, escrowReleased: escrow.released };
}

const app = new Hono<{ Bindings: Env }>();

// Configure CORS for Local Development and Production
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return '*';
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return origin;
    if (origin.endsWith('.mwar.win') || origin === 'https://mwar.win') return origin;
    return origin;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
}));

// Root Status & Health
app.get('/', (c) => {
  return c.json({
    project: 'MWAR Core API Worker',
    domain: 'mwar.win',
    environment: c.env.DEV_MOCK_MODE === 'true' ? 'local_mock_dev' : 'production',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

// Mount Module Routers
app.route('/api/auth', authRouter);
app.route('/api/network', networkRouter);
app.route('/api/wallet', walletRouter);
app.route('/api/marketplace', marketplaceRouter);
app.route('/api/ads', adsRouter);
app.route('/api/game', gameRouter);
app.route('/api/chat', chatRouter);
app.route('/api/audit', auditRouter);
app.route('/api/quests', questsRouter);
app.route('/api/nodes', nodesRouter);
app.route('/api/practice', practiceRouter);

// Cron endpoints (Direct trigger or Cloudflare Scheduled Event)
// Manual trigger requires the internal secret (it moves money).
app.post('/api/cron/settle-daily-mlm', async (c) => {
  if (!hasInternalSecret(c)) return c.json({ error: 'Unauthorized: X-Internal-Secret required' }, 401);
  const body = await c.req.json().catch(() => ({}));
  return c.json(await runDailyJobs(c.env, body.dateKey, body.targetUserId));
});

// Global Error Handler
app.onError((err, c) => {
  console.error('[Worker Error]', err);
  return c.json({
    error: 'Internal Server Error',
    message: err.message,
    stack: c.env.DEV_MOCK_MODE === 'true' ? err.stack : undefined,
  }, 500);
});

// Cloudflare Queue Consumer Export
export default {
  fetch: app.fetch,

  // Cloudflare Cron Trigger (wrangler.toml [triggers] crons = ["0 0 * * *"])
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(
      runDailyJobs(env).then(
        (r) => console.log('[Cron] daily settlement', JSON.stringify(r)),
        (e) => console.error('[Cron] daily settlement failed', e)
      )
    );
  },

  // Spec §8: if the Mini PC is offline, logs must stay in the queue (up to 14 days) and be
  // replayed FIFO when it returns — so failed deliveries are retried with back-off, never dropped.
  async queue(
    batch: { messages: Array<{ body: FinancialLog; attempts?: number; ack?: () => void; retry?: (o?: { delaySeconds?: number }) => void }> },
    env: Env
  ): Promise<void> {
    const receiverUrl = env.LOG_RECEIVER_URL || 'http://localhost:3000/api/logs';
    for (const msg of batch.messages) {
      const retry = () => msg.retry?.({ delaySeconds: Math.min(43_200, 60 * 2 ** Math.min(10, msg.attempts ?? 1)) });
      try {
        const res = await fetch(receiverUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(env.LOG_INGEST_SECRET ? { 'X-Log-Secret': env.LOG_INGEST_SECRET } : {}) },
          body: JSON.stringify(msg.body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        });
        if (!res.ok) {
          console.warn(`[Queue Consumer] Log receiver returned status ${res.status} — will retry`);
          retry();
        } else {
          msg.ack?.();
        }
      } catch (err: any) {
        retry();
        // Graceful fallback: when Mini PC / tunnel is not connected yet,
        // avoid crashing queue consumer loop
        console.warn(`[Queue Consumer Fallback] Log receiver offline (${receiverUrl}): ${err.message}. Message buffered in Cloudflare Queue.`);
      }
    }
  },
};
