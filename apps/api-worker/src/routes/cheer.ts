import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  CHEER_AD_FORMATS,
  CHEER_BANNER_SECONDS,
  CHEER_COOLDOWN_SECONDS,
  CHEER_DAILY_CAP,
  CHEER_PER_TARGET_DAILY_CAP,
  CheerStartSchema,
  CheerCompleteSchema,
  AD_VIDEO_EC_BP,
  AD_VIDEO_SECONDS,
  EC_PROGRESS_BP_PER_TICKET,
  MAX_ENERGY_TICKETS,
  INITIAL_ENERGY_TICKETS,
  getStatisticalAdMicroUsd,
} from '@mwar/shared';
import type { CheerAdFormat, CheerTargetType, CheerOption, CheerStatus, CheerResult, CheerUnavailableReason } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { resolveAdValue, logAdImpression, creditEcProgress, ecProgressBpFor, normalizeCountry, utcDateKey } from '../utils/ad-value';
import { logFinancialTransaction } from '../utils/audit-logger';
import { ENERGY_POOL_ACCOUNT_ID } from '../utils/guards';

type Ctx = Context<{ Bindings: Env; Variables: { user: AuthUserPayload } }>;

/**
 * "ให้กำลังใจ" Cheer — support a post / creator (or just recharge from the EC panel) by watching an ad.
 * The cheerer earns EC progress (30 s video = +1 EC, 15 s = +50 %, banner boost = banner parity), the
 * target's cheer_count goes up. Every limit is enforced in D1, never only in the client:
 *   · CHEER_COOLDOWN_SECONDS between two completed cheers of one user
 *   · CHEER_DAILY_CAP cheers per user per UTC day
 *   · CHEER_PER_TARGET_DAILY_CAP cheers from one user to the same creator per UTC day
 * Requests happen only when the player opens the modal / finishes an ad (no polling).
 */
export const cheerRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();
cheerRouter.use('*', authMiddleware);

const nowSec = () => Math.floor(Date.now() / 1000);
const dayKey = (offsetDays = 0) => utcDateKey(new Date(Date.now() + offsetDays * 86_400_000));

function cfCountry(c: Ctx): string {
  return normalizeCountry((c.req.raw as unknown as { cf?: { country?: string } }).cf?.country);
}

function durationOf(format: CheerAdFormat): number {
  return format === 'banner' ? CHEER_BANNER_SECONDS : AD_VIDEO_SECONDS[format];
}

function disabledFormats(env: Env): Set<string> {
  return new Set((env.CHEER_DISABLED_FORMATS || '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** EC progress for a cheer format, with the same banner revenue-parity rule as the EC recharge banner. */
async function ecBpFor(c: Ctx, format: CheerAdFormat, country: string): Promise<{ bp: number; valueMicroUsd: number; source: string }> {
  const value = await resolveAdValue(c.env.DB, { country, format });
  if (format === 'banner') {
    return { bp: ecProgressBpFor('banner', value.microUsd, country, getStatisticalAdMicroUsd(country, 'video_30s')), valueMicroUsd: value.microUsd, source: value.source };
  }
  return { bp: AD_VIDEO_EC_BP[format], valueMicroUsd: value.microUsd, source: value.source };
}

/** Who receives the cheer: the post's author or the profile owner. `null` userId for the EC panel. */
async function resolveTarget(
  c: Ctx,
  targetType: CheerTargetType,
  targetId: string | null | undefined
): Promise<{ ok: true; targetId: string | null; targetUserId: string | null } | { ok: false; status: 404; error: string }> {
  if (targetType === 'energy') return { ok: true, targetId: null, targetUserId: null };
  const id = String(targetId || '').trim();
  if (targetType === 'post') {
    const p = await c.env.DB
      .prepare("SELECT id, author_id FROM social_posts WHERE id = ?1 AND moderation_status IN ('approved', 'nsfw_18')")
      .bind(id)
      .first<{ id: string; author_id: string }>();
    return p ? { ok: true, targetId: p.id, targetUserId: p.author_id } : { ok: false, status: 404, error: 'Post not found' };
  }
  const u = await c.env.DB
    .prepare("SELECT id FROM users WHERE (id = ?1 OR username = ?1) AND status = 'active' LIMIT 1")
    .bind(id)
    .first<{ id: string }>();
  return u ? { ok: true, targetId: u.id, targetUserId: u.id } : { ok: false, status: 404, error: 'Player not found' };
}

/** Counts + EC for the status card: one D1 batch. */
async function loadStatus(c: Ctx, targetType: CheerTargetType, targetId: string | null, targetUserId: string | null): Promise<CheerStatus> {
  const me = c.get('user').userId;
  const today = dayKey();
  const res = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM cheer_events WHERE user_id = ?1 AND date_key = ?2').bind(me, today),
    c.env.DB.prepare('SELECT MAX(created_at) AS t FROM cheer_events WHERE user_id = ?1 AND date_key IN (?2, ?3)').bind(me, today, dayKey(-1)),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM cheer_events WHERE user_id = ?1 AND target_user_id = ?2 AND date_key = ?3').bind(me, targetUserId || '', today),
    c.env.DB.prepare('SELECT energy_tickets FROM users WHERE id = ?1').bind(me),
  ]);
  const dailyUsed = Number((res[0].results?.[0] as any)?.n ?? 0);
  const last = Number((res[1].results?.[0] as any)?.t ?? 0);
  const targetUsed = targetUserId ? Number((res[2].results?.[0] as any)?.n ?? 0) : 0;
  const energyTickets = Number((res[3].results?.[0] as any)?.energy_tickets ?? INITIAL_ENERGY_TICKETS);
  const cooldownRemaining = last ? Math.max(0, CHEER_COOLDOWN_SECONDS - (nowSec() - last)) : 0;

  const country = cfCountry(c);
  const off = disabledFormats(c.env);
  const own = !!targetUserId && targetUserId === me;
  const options: CheerOption[] = [];
  for (const format of CHEER_AD_FORMATS) {
    const durationSeconds = durationOf(format);
    const { bp } = await ecBpFor(c, format, country);
    let reason: CheerUnavailableReason | undefined;
    if (off.has(format)) reason = 'disabled';
    else if (own) reason = 'own_content';
    else if (dailyUsed >= CHEER_DAILY_CAP) reason = 'daily_cap';
    else if (targetUserId && targetUsed >= CHEER_PER_TARGET_DAILY_CAP) reason = 'target_cap';
    // An ad may start during the cooldown as long as it cannot finish before the cooldown ends
    else if (cooldownRemaining > durationSeconds) reason = 'cooldown';
    options.push({ format, ecBp: bp, durationSeconds, available: !reason, ...(reason ? { reason } : {}) });
  }
  return {
    targetType,
    targetId,
    dailyUsed,
    dailyCap: CHEER_DAILY_CAP,
    dailyRemaining: Math.max(0, CHEER_DAILY_CAP - dailyUsed),
    targetUsed,
    targetCap: CHEER_PER_TARGET_DAILY_CAP,
    cooldownSeconds: CHEER_COOLDOWN_SECONDS,
    cooldownRemaining,
    energyTickets,
    maxEnergyTickets: MAX_ENERGY_TICKETS,
    options,
  };
}

const TARGET_TYPES = new Set(['post', 'profile', 'energy']);

/** GET /api/ads/cheer/status?targetType=post|profile|energy&targetId= — what the modal can offer now. */
cheerRouter.get('/status', async (c) => {
  const targetType = (TARGET_TYPES.has(c.req.query('targetType') || '') ? c.req.query('targetType') : 'energy') as CheerTargetType;
  const target = await resolveTarget(c, targetType, c.req.query('targetId'));
  if (!target.ok) return c.json({ error: target.error }, target.status);
  return c.json(await loadStatus(c, targetType, target.targetId, target.targetUserId));
});

/** POST /api/ads/cheer/start { format, targetType, targetId } — opens a server-timed ad session. */
cheerRouter.post('/start', async (c) => {
  const me = c.get('user');
  const parsed = CheerStartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid cheer' }, 400);
  const { format, targetType } = parsed.data;
  const target = await resolveTarget(c, targetType, parsed.data.targetId);
  if (!target.ok) return c.json({ error: target.error }, target.status);
  const status = await loadStatus(c, targetType, target.targetId, target.targetUserId);
  const opt = status.options.find((o) => o.format === format)!;
  if (!opt.available) return c.json({ error: 'This cheer is not available right now', code: 'CHEER_LIMIT', reason: opt.reason, status }, 429);
  // At most 3 unfinished cheer sessions in the last 2 minutes (stops session spraying)
  const open = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM ad_video_views WHERE user_id = ?1 AND purpose = 'cheer' AND completed_at IS NULL AND started_at >= ?2")
    .bind(me.userId, nowSec() - 120)
    .first<{ n: number }>();
  if (Number(open?.n || 0) >= 3) return c.json({ error: 'Finish the ad you already started first', code: 'CHEER_LIMIT', reason: 'cooldown', status }, 429);

  const id = `cheer_${crypto.randomUUID()}`;
  const now = nowSec();
  await c.env.DB
    .prepare(
      `INSERT INTO ad_video_views (id, user_id, ad_format, purpose, started_at, target_type, target_id, target_user_id)
       VALUES (?1, ?2, ?3, 'cheer', ?4, ?5, ?6, ?7)`
    )
    .bind(id, me.userId, format, now, targetType, target.targetId, target.targetUserId)
    .run();
  return c.json({ success: true, viewId: id, format, durationSeconds: opt.durationSeconds, startedAt: now, ecBp: opt.ecBp });
});

/**
 * POST /api/ads/cheer { viewId } — claim a finished cheer ad. The cheer row is inserted with every
 * limit checked inside the same INSERT … SELECT, so parallel claims can never pass a cap.
 */
cheerRouter.post('/', async (c) => {
  const me = c.get('user');
  const parsed = CheerCompleteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Unknown cheer session' }, 400);
  const view = await c.env.DB
    .prepare(
      `SELECT id, ad_format, started_at, completed_at, target_type, target_id, target_user_id
       FROM ad_video_views WHERE id = ?1 AND user_id = ?2 AND purpose = 'cheer'`
    )
    .bind(parsed.data.viewId, me.userId)
    .first<{ id: string; ad_format: CheerAdFormat; started_at: number; completed_at: number | null; target_type: CheerTargetType; target_id: string | null; target_user_id: string | null }>();
  if (!view) return c.json({ error: 'Unknown cheer session — start the ad first' }, 400);
  if (view.completed_at) return c.json({ error: 'This cheer was already counted' }, 409);
  const now = nowSec();
  const need = durationOf(view.ad_format) - 1;
  if (now - view.started_at < need) return c.json({ error: 'Ad not finished yet', retryInSeconds: need - (now - view.started_at) }, 425);
  if (now - view.started_at > 30 * 60) return c.json({ error: 'This ad session expired. Please start again.' }, 410);

  const country = cfCountry(c);
  const { bp, valueMicroUsd, source } = await ecBpFor(c, view.ad_format, country);
  const today = dayKey();
  const eventId = `chr_${now.toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const ins = await c.env.DB
    .prepare(
      `INSERT INTO cheer_events (id, user_id, target_type, target_id, target_user_id, ad_format, view_id, ec_progress_bp, value_micro_usd, country_code, date_key, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
       WHERE (SELECT COUNT(*) FROM cheer_events WHERE user_id = ?2 AND date_key = ?11) < ?13
         AND NOT EXISTS (SELECT 1 FROM cheer_events WHERE user_id = ?2 AND date_key IN (?11, ?16) AND created_at > ?12 - ?14)
         AND (?5 IS NULL OR (?5 <> ?2 AND (SELECT COUNT(*) FROM cheer_events WHERE user_id = ?2 AND target_user_id = ?5 AND date_key = ?11) < ?15))`
    )
    .bind(
      eventId,
      me.userId,
      view.target_type,
      view.target_id,
      view.target_user_id,
      view.ad_format,
      view.id,
      bp,
      valueMicroUsd,
      country,
      today,
      now,
      CHEER_DAILY_CAP,
      CHEER_COOLDOWN_SECONDS,
      CHEER_PER_TARGET_DAILY_CAP,
      dayKey(-1)
    )
    .run()
    .catch((err: unknown) => {
      if (String(err).includes('UNIQUE')) return { meta: { changes: 0 }, duplicate: true } as any;
      throw err;
    });
  if ((ins as any).duplicate) return c.json({ error: 'This cheer was already counted' }, 409);
  if ((ins.meta?.changes ?? 0) !== 1) {
    const status = await loadStatus(c, view.target_type, view.target_id, view.target_user_id);
    const reason: CheerUnavailableReason =
      status.dailyRemaining <= 0 ? 'daily_cap' : view.target_user_id && status.targetUsed >= status.targetCap ? 'target_cap' : view.target_user_id === me.userId ? 'own_content' : 'cooldown';
    return c.json({ error: 'Cheer limit reached', code: 'CHEER_LIMIT', reason, retryInSeconds: status.cooldownRemaining, status }, 429);
  }

  // Counted: close the session, bump the counters, back it with the Energy Pool (one batch)
  const stmts = [
    c.env.DB.prepare('UPDATE ad_video_views SET completed_at = ?1 WHERE id = ?2 AND completed_at IS NULL').bind(now, view.id),
    c.env.DB.prepare(
      `INSERT INTO system_balances (id, energy_pool_drawn_micro_usd, updated_at) VALUES ('global', ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET energy_pool_drawn_micro_usd = energy_pool_drawn_micro_usd + ?1, updated_at = ?2`
    ).bind(valueMicroUsd, now),
  ];
  if (view.target_type === 'post') stmts.push(c.env.DB.prepare('UPDATE social_posts SET cheer_count = cheer_count + 1 WHERE id = ?1').bind(view.target_id));
  if (view.target_user_id) stmts.push(c.env.DB.prepare('UPDATE users SET cheer_count = cheer_count + 1 WHERE id = ?1').bind(view.target_user_id));
  if (view.target_type === 'post') stmts.push(c.env.DB.prepare('SELECT cheer_count AS n FROM social_posts WHERE id = ?1').bind(view.target_id));
  else if (view.target_user_id) stmts.push(c.env.DB.prepare('SELECT cheer_count AS n FROM users WHERE id = ?1').bind(view.target_user_id));
  const res = await c.env.DB.batch(stmts);
  const cheerCount = view.target_user_id ? Number((res[res.length - 1].results?.[0] as any)?.n ?? 0) : null;

  await logAdImpression(c.env.DB, { userId: me.userId, provider: 'mwar_cheer', country, format: view.ad_format, purpose: 'ec_recharge', microUsd: valueMicroUsd, source: source as any, ecBp: bp });
  const ec = await creditEcProgress(c.env, me.userId, bp, `cheer:${view.target_type}:${view.target_id || '-'}:${view.ad_format}`);
  await logFinancialTransaction(c.env, {
    transaction_id: `tx_cheer_${now}_${crypto.randomUUID().slice(0, 8)}`,
    user_id: ENERGY_POOL_ACCOUNT_ID,
    action_type: 'ENERGY_POOL_DRAW',
    amount_micro_usd: BigInt(valueMicroUsd),
    balance_after_micro_usd: 0n,
    source_game_id: `cheer:${eventId}`,
    related_user_id: me.userId,
  });

  const status = await loadStatus(c, view.target_type, view.target_id, view.target_user_id);
  const body: CheerResult = {
    success: true,
    format: view.ad_format,
    ecProgressAddedPct: bp / (EC_PROGRESS_BP_PER_TICKET / 100),
    energyTickets: ec?.energyTickets ?? status.energyTickets,
    maxEnergyTickets: MAX_ENERGY_TICKETS,
    energyProgressPct: ec?.energyProgressPct ?? 0,
    ticketsAwarded: ec?.ticketsAwarded ?? 0,
    cheerCount,
    status,
  };
  return c.json(body);
});
