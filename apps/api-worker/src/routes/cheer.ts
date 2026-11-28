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
  calculateCheerSplit,
} from '@mwar/shared';
import type { CheerAdFormat, CheerTargetType, CheerOption, CheerStatus, CheerResult, CheerUnavailableReason } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { resolveAdValue, logAdImpression, creditEcProgress, ecProgressBpFor, normalizeCountry, utcDateKey } from '../utils/ad-value';
import { getAdConfig, pickDirectLink, valueSlot } from '../utils/ad-networks';
import { applyRewardSplit } from '../utils/reward-split';
import { safeValue } from '../utils/energy-tickets';

type Ctx = Context<{ Bindings: Env; Variables: { user: AuthUserPayload } }>;

/**
 * V1.2: only called with S2S-verified revenue (applyVerifiedVisit); a timer-only claim pays the creator 0.
 * V1.1 exact 100 % Cheer split of a REAL ad's safe value V (Viewer A cheers Creator B):
 *   55 % → B's wallet (CHEER_REWARD) · 15 % → B's 5 uplines (5/4/3/2/1, daily-mission gated, missing →
 *   platform) · 5 % → B's head bounty · 5 % → platform · 20 % → Energy Pool, drawn at once as Viewer A's
 *   EC backing (pending_ec_micro_usd). Creator + uplines + bounty + platform + viewer backing === V.
 * The caller credits A's EC progress with `viewerBackingMicroUsd` (source 'cheer_pool', not from the pool again).
 */
export async function settleCheerRevenue(
  env: Env,
  v: { creatorId: string; viewerId: string; valueMicroUsd: number; sourceId: string; adHaircut?: { safetyReserveMicroUsd: number; bossPoolMicroUsd: number } }
) {
  const V = Math.max(0, Math.floor(v.valueMicroUsd));
  if (V <= 0 || !v.creatorId || v.creatorId === v.viewerId) return { valueMicroUsd: 0, creatorMicroUsd: 0, viewerBackingMicroUsd: 0 };
  const split = await applyRewardSplit(env, {
    earnerId: v.creatorId,
    grossMicroUsd: V,
    actionType: 'CHEER_REWARD',
    sourceId: v.sourceId,
    energyPoolPassThrough: true,
    adHaircut: v.adHaircut,
  });
  return { valueMicroUsd: V, creatorMicroUsd: Number(split.earnerMicroUsd), viewerBackingMicroUsd: Number(split.energyPoolMicroUsd) };
}

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
export async function resolveTarget(
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
export async function loadStatus(c: Ctx, targetType: CheerTargetType, targetId: string | null, targetUserId: string | null): Promise<CheerStatus> {
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
  // Live mode: what a real direct-link visit is worth here (country eCPM × the slot's safety multiplier)
  let liveEcBp: CheerStatus['liveEcBp'];
  const adCfg = await getAdConfig(c);
  const link = pickDirectLink(adCfg);
  if (link) liveEcBp = { video_15s: valueSlot(adCfg, country, link.slot, 15).ecBp, video_30s: valueSlot(adCfg, country, link.slot, 30).ecBp };
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
    ...(liveEcBp ? { liveEcBp } : {}),
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
  // V1.1: never cheer your own post / profile
  if (target.targetUserId && target.targetUserId === me.userId) return c.json({ error: 'You cannot cheer your own content', code: 'SELF_CHEER' }, 400);
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
  if (view.target_user_id && view.target_user_id === me.userId) return c.json({ error: 'You cannot cheer your own content', code: 'SELF_CHEER' }, 400);
  if (view.completed_at) return c.json({ error: 'This cheer was already counted' }, 409);
  const now = nowSec();
  const need = durationOf(view.ad_format) - 1;
  if (now - view.started_at < need) return c.json({ error: 'Ad not finished yet', retryInSeconds: need - (now - view.started_at) }, 425);
  if (now - view.started_at > 30 * 60) return c.json({ error: 'This ad session expired. Please start again.' }, 410);

  const country = cfCountry(c);
  const { bp, valueMicroUsd, source } = await ecBpFor(c, view.ad_format, country);
  const rec = await recordCheer(c, {
    viewId: view.id,
    targetType: view.target_type,
    targetId: view.target_id,
    targetUserId: view.target_user_id,
    format: view.ad_format,
    bp,
    valueMicroUsd,
    country,
    drawEnergyPool: true,
  });
  if (!rec.ok) {
    if (rec.duplicate) return c.json({ error: 'This cheer was already counted' }, 409);
    return c.json({ error: 'Cheer limit reached', code: 'CHEER_LIMIT', reason: rec.reason, retryInSeconds: rec.status.cooldownRemaining, status: rec.status }, 429);
  }
  const { eventId, cheerCount } = rec;

  await logAdImpression(c.env.DB, { userId: me.userId, provider: 'mwar_cheer', country, format: view.ad_format, purpose: 'ec_recharge', microUsd: valueMicroUsd, source: source as any, ecBp: bp });
  // V1.1: this is the in-app (test-mode) sponsor card — no network pays for it, so it creates NO money:
  // the creator gets the cheer count only, and the viewer's EC backing is drawn from the Energy Pool
  // (the 20 % slice a real cheer would give; the whole safe value for an EC-panel cheer), capped by
  // what the pool holds. Real cheers (direct link) pay the creator: see settleCheerRevenue().
  const safeV = safeValue(c.env, valueMicroUsd);
  const wantBacking = view.target_user_id ? Number(calculateCheerSplit(safeV).viewerEcBackingMicroUsd) : safeV;
  const ec = await creditEcProgress(c.env, me.userId, bp, `cheer:${eventId}`, { microUsd: wantBacking, source: 'cheer_pool', country, fromPool: true });

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
    valueMicroUsd: 0,
    creatorMicroUsd: 0,
    ecBackingMicroUsd: ec?.backedAddedMicroUsd ?? 0,
  };
  return c.json(body);
});

/**
 * Count one cheer: the cheer_events row is inserted with every limit checked inside the same
 * INSERT … SELECT (parallel claims can never pass a cap), then the session is closed and the target's
 * cheer_count goes up. Self-cheers are refused inside the same INSERT. Used by the simulated Cheer
 * claim and the direct-link claim (money moves are done by the caller).
 */
export async function recordCheer(
  c: Ctx,
  v: {
    viewId: string;
    targetType: CheerTargetType;
    targetId: string | null;
    targetUserId: string | null;
    format: string;
    bp: number;
    valueMicroUsd: number;
    country: string;
    drawEnergyPool: boolean;
  }
): Promise<
  | { ok: true; eventId: string; cheerCount: number | null }
  | { ok: false; duplicate: true }
  | { ok: false; duplicate?: false; reason: CheerUnavailableReason; status: CheerStatus }
> {
  const me = c.get('user').userId;
  const now = nowSec();
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
      me,
      v.targetType,
      v.targetId,
      v.targetUserId,
      v.format,
      v.viewId,
      v.bp,
      v.valueMicroUsd,
      v.country,
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
  if ((ins as any).duplicate) return { ok: false, duplicate: true };
  if ((ins.meta?.changes ?? 0) !== 1) {
    const status = await loadStatus(c, v.targetType, v.targetId, v.targetUserId);
    const reason: CheerUnavailableReason =
      status.dailyRemaining <= 0 ? 'daily_cap' : v.targetUserId && status.targetUsed >= status.targetCap ? 'target_cap' : v.targetUserId === me ? 'own_content' : 'cooldown';
    return { ok: false, reason, status };
  }

  const stmts = [c.env.DB.prepare('UPDATE ad_video_views SET completed_at = ?1 WHERE id = ?2 AND completed_at IS NULL').bind(now, v.viewId)];
  // V1.1: no blind pool draw here any more — EC backing is drawn (capped by the pool) in creditEcProgress
  void v.drawEnergyPool;
  if (v.targetType === 'post') stmts.push(c.env.DB.prepare('UPDATE social_posts SET cheer_count = cheer_count + 1 WHERE id = ?1').bind(v.targetId));
  if (v.targetUserId) stmts.push(c.env.DB.prepare('UPDATE users SET cheer_count = cheer_count + 1 WHERE id = ?1').bind(v.targetUserId));
  if (v.targetType === 'post') stmts.push(c.env.DB.prepare('SELECT cheer_count AS n FROM social_posts WHERE id = ?1').bind(v.targetId));
  else if (v.targetUserId) stmts.push(c.env.DB.prepare('SELECT cheer_count AS n FROM users WHERE id = ?1').bind(v.targetUserId));
  const res = await c.env.DB.batch(stmts);
  const cheerCount = v.targetUserId ? Number((res[res.length - 1].results?.[0] as any)?.n ?? 0) : null;
  return { ok: true, eventId, cheerCount };
}
