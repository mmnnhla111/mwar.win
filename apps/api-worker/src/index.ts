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

// Cron endpoints (Direct trigger or Cloudflare Scheduled Event)
app.post('/api/cron/settle-daily-mlm', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dateKey = body.dateKey || getUtcDateKey();
  const targetUserId = body.targetUserId;
  const result = await settleDailyMlm(c.env, dateKey, targetUserId);
  return c.json(result);
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

  async queue(batch: { messages: Array<{ body: FinancialLog }> }, env: Env): Promise<void> {
    const receiverUrl = env.LOG_RECEIVER_URL || 'http://localhost:3000/api/logs';
    for (const msg of batch.messages) {
      try {
        await fetch(receiverUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg.body),
        });
      } catch (err) {
        console.error('[Queue Consumer] Failed to deliver message to Log Receiver:', err);
        // Throwing will cause Cloudflare Queues to retry with exponential backoff
        throw err;
      }
    }
  },
};
