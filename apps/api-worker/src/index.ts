import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { authRouter } from './routes/auth';
import { socialAuthRouter, referralRouter } from './routes/auth-social';
import { networkRouter } from './routes/network';
import { walletRouter } from './routes/wallet';
import { marketplaceRouter, releaseMarketplaceEscrow } from './routes/marketplace';
import { adsRouter } from './routes/ads';
import { cheerRouter } from './routes/cheer';
import { adNetworksRouter } from './routes/ad-networks';
import { adminAdsRouter } from './routes/admin-ads';
import { gameRouter } from './routes/game';
import { chatRouter, serveChatMedia, pruneChatMedia } from './routes/chat';
import { auditRouter } from './routes/audit';
import { questsRouter, settleDailyMlm, authorizeSettlement, yesterdayUtcDateKey } from './routes/quests';

import { consumeAuditBatch, flushAuditOutbox, sha256Hex, type AuditQueueMessage } from './utils/audit-logger';
import { runRetentionJobs } from './services/maintenance';
import { nodesRouter } from './routes/nodes';
import { practiceRouter } from './routes/practice';
import { isLocalDev, hasInternalSecret } from './utils/guards';
import { socialRouter, serveMedia, serveSocialMedia, serveCover } from './routes/social';
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
app.route('/api/ads', adNetworksRouter);
app.route('/api/ads', adsRouter);
app.route('/api/game', gameRouter);
app.route('/api/chat', chatRouter);
app.route('/api/referral', referralRouter);
app.route('/api/audit', auditRouter);
app.route('/api/quests', questsRouter);
app.route('/api/nodes', nodesRouter);
app.route('/api/practice', practiceRouter);
app.route('/api/social', socialRouter);
app.route('/api/games', gamesRouter);
app.route('/api/admin/ads', adminAdsRouter);
app.route('/api/admin', adminRouter);
// Self-hosted moderation workers (X-Internal-Secret): claim jobs, fetch media, submit batched results
app.route('/api/moderation', moderationRouter);

// One request for the whole app shell (user, wallet, quest/notification/chat badges)
app.get('/api/bootstrap', authMiddleware, bootstrapHandler);
// Post photos / videos (approved or 18+ only; pending + rejected media are never served)
app.get('/api/media/social/:y/:m/:file', serveSocialMedia);
app.get('/api/media/covers/:y/:m/:file', serveCover);
// Chat photos / videos (signed links; files are deleted after 7 days)
app.get('/api/media/chat-media/:y/:m/:d/:file', serveChatMedia);
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
 * 90-day log archive: the Mini PC log receiver gzips a logs_YYYY_MM table older than 90 days and
 * uploads it here. Stored in R2 (ASSETS_BUCKET) as audit-archives/logs_YYYY_MM.json.gz. The body must
 * match X-Content-Sha256 (R2 re-checks it on write); the stored object is read back and its sha256 is
 * returned so the receiver drops the local table only after a verified upload.
 */
app.put('/api/internal/log-archive/:name', async (c) => {
  if (!hasInternalSecret(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const name = c.req.param('name');
  if (!/^logs_\d{4}_\d{2}\.json\.gz$/.test(name)) return c.json({ error: 'Invalid archive name (logs_YYYY_MM.json.gz)' }, 400);
  const claimed = (c.req.header('X-Content-Sha256') || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(claimed)) return c.json({ error: 'X-Content-Sha256 header required' }, 400);
  const body = await c.req.arrayBuffer();
  const got = await sha256Hex(body);
  if (got !== claimed) return c.json({ error: 'sha256 mismatch: upload corrupted', expected: claimed, received: got }, 422);
  const key = `audit-archives/${name}`;
  await c.env.ASSETS_BUCKET.put(key, body, {
    sha256: claimed,
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { sha256: claimed, rows: c.req.header('X-Row-Count') || '', uploadedAt: new Date().toISOString() },
  });
  const stored = await c.env.ASSETS_BUCKET.get(key);
  if (!stored) return c.json({ error: 'stored object not found after write' }, 500);
  const storedSha = await sha256Hex(await stored.arrayBuffer());
  return c.json({ success: storedSha === claimed, key, bytes: body.byteLength, sha256: storedSha }, storedSha === claimed ? 200 : 500);
});

/** Re-send the D1 audit outbox now (the 10-minute cron does the same). */
app.post('/api/internal/audit-outbox/flush', async (c) => {
  if (!hasInternalSecret(c)) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ success: true, ...(await flushAuditOutbox(c.env)) });
});

/** Run the daily retention jobs on demand. */
app.post('/api/internal/retention/run', async (c) => {
  if (!hasInternalSecret(c)) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ success: true, ...(await runRetentionJobs(c.env)) });
});

/** Chat media expiry on demand (the midnight cron runs the same job). */
app.post('/api/internal/chat-media/prune', async (c) => {
  if (!hasInternalSecret(c)) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ success: true, ...(await pruneChatMedia(c.env)) });
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
   * FINANCIAL_AUDIT_QUEUE consumer → signed (HMAC-SHA256) batch POST to the Mini PC log receiver.
   * Acked only after PostgreSQL stored the batch; otherwise retried with back-off for up to 14 days,
   * and moved to the D1 audit_outbox just before it would expire.
   */
  async queue(batch: { messages: readonly AuditQueueMessage[] }, env: Env): Promise<void> {
    const r = await consumeAuditBatch(batch.messages, env);
    if (r.retried || r.outboxed || r.dropped) console.log('[Audit consumer]', JSON.stringify(r));
  },

  /**
   * Crons: every 10 min → re-send the D1 audit outbox.
   * 00:00 UTC → MLM settlement, marketplace escrow, retention (chat 12 months, oauth_states /
   * ad_click_tokens 7 days, next month's chat schema), moderation + chat-media pruning, outbox.
   */
  async scheduled(event: { cron?: string }, env: Env): Promise<void> {
    if (event?.cron === '*/10 * * * *') {
      await flushAuditOutbox(env).catch((e: unknown) => console.warn('[Cron] audit outbox flush failed', e));
      return;
    }
    await settleDailyMlm(env, yesterdayUtcDateKey());
    await releaseMarketplaceEscrow(env);
    await runRetentionJobs(env).catch((e: unknown) => console.warn('[Cron] retention failed', e));
    // Zero-bloat: finished moderation jobs (7 d), expired reset tokens, rejected posts + their R2 media
    await pruneModerationData(env).catch((e: unknown) => console.warn('[Cron] moderation prune failed', e));
    // Chat photos / videos older than 7 days: R2 files deleted, message text kept
    await pruneChatMedia(env).catch((e: unknown) => console.warn('[Cron] chat media prune failed', e));
    await flushAuditOutbox(env).catch((e: unknown) => console.warn('[Cron] audit outbox flush failed', e));
  },
};
