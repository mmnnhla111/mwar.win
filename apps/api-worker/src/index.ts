import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { FinancialLog } from '@mwar/shared';
import { CHAT_RETENTION_MONTHS } from '@mwar/shared';
import type { Env } from './types';
import { authRouter } from './routes/auth';
import { socialAuthRouter } from './routes/auth-social';
import { networkRouter } from './routes/network';
import { walletRouter } from './routes/wallet';
import { marketplaceRouter, releaseMarketplaceEscrow } from './routes/marketplace';
import { adsRouter } from './routes/ads';
import { cheerRouter } from './routes/cheer';
import { gameRouter } from './routes/game';
import { chatRouter } from './routes/chat';
import { auditRouter } from './routes/audit';
import { questsRouter, settleDailyMlm, authorizeSettlement, yesterdayUtcDateKey } from './routes/quests';

import { stringifyLog, logReceiverHeaders } from './utils/audit-logger';
import { nodesRouter } from './routes/nodes';
import { practiceRouter } from './routes/practice';
import { isLocalDev, hasInternalSecret } from './utils/guards';
import { socialRouter, serveMedia, serveSocialMedia } from './routes/social';
import { moderationRouter, pruneModerationData } from './routes/moderation';
import { gamesRouter } from './routes/games';
import { adminRouter } from './routes/admin';
import { bootstrapHandler } from './routes/bootstrap';
import { authMiddleware } from './middleware/auth';

const app = new Hono<{ Bindings: Env }>();

// Configure CORS for Local Development and Production
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return '*';
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return origin;
    if (origin.endsWith('.mwar.win') || origin === 'https://mwar.win') return origin;
    return origin;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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
app.route('/api/auth', socialAuthRouter);
app.route('/api/auth', authRouter);
app.route('/api/network', networkRouter);
app.route('/api/wallet', walletRouter);
app.route('/api/marketplace', marketplaceRouter);
app.route('/api/ads/cheer', cheerRouter);
app.route('/api/ads', adsRouter);
app.route('/api/game', gameRouter);
app.route('/api/chat', chatRouter);
app.route('/api/audit', auditRouter);
app.route('/api/quests', questsRouter);
app.route('/api/nodes', nodesRouter);
app.route('/api/practice', practiceRouter);
app.route('/api/social', socialRouter);
app.route('/api/games', gamesRouter);
app.route('/api/admin', adminRouter);
// Self-hosted moderation workers (X-Internal-Secret): claim jobs, fetch media, submit batched results
app.route('/api/moderation', moderationRouter);

// One request for the whole app shell (user, wallet, quest/notification/chat badges)
app.get('/api/bootstrap', authMiddleware, bootstrapHandler);
// Post photos / videos (approved or 18+ only; pending + rejected media are never served)
app.get('/api/media/social/:y/:m/:file', serveSocialMedia);
// Public, immutable WebP media (avatars + legacy post photos) from R2
app.get('/api/media/:uid/:file', serveMedia);

// Cron endpoints (Direct trigger or Cloudflare Scheduled Event)
app.post('/api/cron/settle-daily-mlm', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const check = authorizeSettlement(c.env, isLocalDev(c), c.req.header('X-Internal-Secret'), body);
  if (!check.ok) return c.json({ error: check.error }, check.status);
  const result = await settleDailyMlm(c.env, check.dateKey, body.targetUserId);
  return c.json(result);
});

/**
 * 90-day log archive: the Mini PC log receiver gzips a closed logs_YYYY_MM table and uploads it
 * here; it is stored in R2 (ASSETS_BUCKET) under audit-archive/ before the local table is dropped.
 */
app.put('/api/internal/log-archive/:name', async (c) => {
  if (!hasInternalSecret(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const name = c.req.param('name');
  if (!/^logs_\d{4}_\d{2}\.jsonl\.gz$/.test(name)) return c.json({ error: 'Invalid archive name' }, 400);
  const body = await c.req.arrayBuffer();
  await c.env.ASSETS_BUCKET.put(`audit-archive/${name}`, body, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { sha256: c.req.header('X-Content-Sha256') || '' },
  });
  return c.json({ success: true, key: `audit-archive/${name}`, bytes: body.byteLength });
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

  /**
   * Queue consumer → logs.mwar.win. A message is acked only when PostgreSQL stored it; otherwise it
   * is retried with back-off and stays in the queue (retention up to 14 days) until the Mini PC is back.
   */
  async queue(
    batch: { messages: Array<{ body: FinancialLog; ack(): void; retry(o?: { delaySeconds?: number }): void; attempts?: number }> },
    env: Env
  ): Promise<void> {
    const receiverUrl = env.LOG_RECEIVER_URL || 'http://localhost:3000/api/logs';
    for (const msg of batch.messages) {
      try {
        const res = await fetch(receiverUrl, {
          method: 'POST',
          headers: logReceiverHeaders(env, true),
          body: stringifyLog(msg.body),
        });
        if (res.ok) msg.ack();
        else msg.retry({ delaySeconds: Math.min(3600, 30 * 2 ** Math.min(7, msg.attempts ?? 1)) });
      } catch (err: any) {
        console.warn(`[Queue Consumer] Log receiver offline (${receiverUrl}): ${err.message}. Retrying later.`);
        msg.retry({ delaySeconds: Math.min(3600, 30 * 2 ** Math.min(7, msg.attempts ?? 1)) });
      }
    }
  },

  /** Cron 00:00 UTC: settle yesterday's MLM ledger (4-quest rule) and release due marketplace escrow. */
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await settleDailyMlm(env, yesterdayUtcDateKey());
    await releaseMarketplaceEscrow(env);
    // chat_YYYY_MM retention: direct messages are deleted after 12 months
    await env.CHAT_DB.prepare('DELETE FROM direct_messages WHERE created_at < ?1')
      .bind(Math.floor(Date.now() / 1000) - CHAT_RETENTION_MONTHS * 30 * 86_400)
      .run()
      .catch((e: unknown) => console.warn('[Cron] chat retention failed', e));
    // Zero-bloat: finished moderation jobs (7 d), expired reset tokens, rejected posts + their R2 media
    await pruneModerationData(env).catch((e: unknown) => console.warn('[Cron] moderation prune failed', e));
  },
};
