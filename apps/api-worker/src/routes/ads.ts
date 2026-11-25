import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  formatMicroUsd,
  getStatisticalAdMicroUsd,
  type AdFormat,
  AD_BANNER_MIN_GAP_SECONDS,
  AD_VIDEO_SECONDS,
  AD_VIDEO_EC_DAILY_CAP,
  EC_PROGRESS_BP_PER_TICKET,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { applyRewardSplit } from '../utils/reward-split';
import { trackQuestAction, getUtcDateKey } from './quests';
import { isLocalDev, safeEqual } from '../utils/guards';
import { getStaffRole } from '../middleware/staff';
import { authMiddleware } from '../middleware/auth';
import { resolveAdValue, logAdImpression, creditEcProgress, ecProgressBpFor, normalizeCountry, parseAdFormat, utcDateKey, type AdValueSource } from '../utils/ad-value';

export const adsRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

// S2S Postback Processor Helper
async function processAdReward(
  env: Env,
  userId: string,
  provider: string,
  country: string,
  providerTxId: string,
  opts: { payoutUsd?: number | string | null; format?: AdFormat } = {},
  dateKey = getUtcDateKey()
) {
  // Three-tier value: P1 exact network payout → P2 yesterday's average (country + format) → P3 country eCPM
  const format = opts.format ?? 'video_30s';
  const countryCode = normalizeCountry(country);
  const value = await resolveAdValue(env.DB, { payoutUsd: opts.payoutUsd, country: countryCode, format });
  const grossReward = value.microUsd;
  const now = Math.floor(Date.now() / 1000);

  // 0. Replay protection: each provider transaction id credits exactly once; unknown users are ignored
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(userId).first<{ id: string }>();
  if (!user) return { success: false, error: 'Unknown user' };
  const ins = await env.DB
    .prepare('INSERT OR IGNORE INTO ad_postbacks (provider, provider_tx_id, user_id, amount_micro_usd, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(provider, providerTxId, userId, grossReward, now)
    .run();
  if ((ins.meta?.changes ?? 0) === 0) return { success: true, duplicate: true };
  await logAdImpression(env.DB, { userId, provider, country: countryCode, format, purpose: 'monetized', microUsd: grossReward, source: value.source });

  // 1–5. 100 % revenue split of V: 55 % watcher · 15 % uplines (5/4/3/2/1) · 5 % watcher's head
  //      bounty · 5 % platform · 20 % Energy Recharge Pool (missing upline levels roll over to the platform)
  const split = await applyRewardSplit(env, {
    earnerId: userId,
    grossMicroUsd: grossReward,
    actionType: 'AD_WATCH',
    sourceId: `${provider}:${providerTxId}`,
    dateKey,
  });

  // 5. Track daily quests for watcher
  await trackQuestAction(env.DB, userId, 'watch_rewarded_ad', 1, dateKey);
  return {
    success: true,
    grossRewardMicroUsd: grossReward,
    valueSource: value.source,
    country: countryCode,
    format,
    formattedReward: formatMicroUsd(grossReward),
    split: {
      watcher: formatMicroUsd(split.earnerMicroUsd),
      uplines: split.uplinePayouts.length,
      headBounty: formatMicroUsd(split.bountyMicroUsd),
      platform: formatMicroUsd(split.platformTotalMicroUsd),
      energyPool: formatMicroUsd(split.energyPoolMicroUsd),
    },
  };
}

/** S2S postbacks must carry the shared secret configured in the ad network dashboard. */
function postbackAuthorized(env: Env, query: Record<string, string>, localDev: boolean): boolean {
  const secret = env.AD_POSTBACK_SECRET || env.ADS_POSTBACK_SECRET;
  if (secret) return safeEqual(query.secret, secret) || safeEqual(query.token, secret);
  return localDev;
}

/** P1 payout (USD) + ad format reported by the network in the postback query. */
function postbackValue(query: Record<string, string>) {
  return { payoutUsd: query.reward_usd ?? query.payout ?? null, format: parseAdFormat(query.format || query.ad_format, 'video_30s') };
}

// 1. AdswedMedia S2S Postback
adsRouter.all('/postback/adswedmedia', async (c) => {
  const query = c.req.query();
  if (!postbackAuthorized(c.env, query, isLocalDev(c))) return c.json({ error: 'Invalid postback secret' }, 403);
  const userId = query.user_id || query.subid;
  const country = query.country || 'GLOBAL';
  const txId = query.transaction_id || query.tx_id || query.click_id;

  if (!userId || !txId) {
    return c.json({ error: 'Missing user_id or transaction_id in postback' }, 400);
  }

  const result = await processAdReward(c.env, userId, 'adswedmedia', country, txId, postbackValue(query));
  return c.json(result);
});

// 2. OnClickA S2S Postback
adsRouter.all('/postback/onclicka', async (c) => {
  const query = c.req.query();
  if (!postbackAuthorized(c.env, query, isLocalDev(c))) return c.json({ error: 'Invalid postback secret' }, 403);
  const userId = query.user_id || query.click_id;
  const country = query.country || 'GLOBAL';
  const txId = query.transaction_id || query.tx_id || query.click_id;

  if (!userId || !txId) {
    return c.json({ error: 'Missing user_id or transaction_id in postback' }, 400);
  }

  const result = await processAdReward(c.env, userId, 'onclicka', country, txId, postbackValue(query));
  return c.json(result);
});

// 3. Dev Mock Simulation Endpoint (for Dev Panel UI) — local `wrangler dev` only (mints money)
adsRouter.post('/dev/simulate-watch', async (c) => {
  if (!isLocalDev(c)) return c.json({ error: 'Available only on local dev' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const userId = body.userId;
  const country = (body.country || 'US').toUpperCase();
  const provider = body.provider || 'adswedmedia';

  if (!userId) {
    return c.json({ error: 'Missing userId in simulation body' }, 400);
  }

  const result = await processAdReward(c.env, userId, provider, country, `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  return c.json({
    simulation: true,
    countryTier: country,
    provider,
    ...result,
  });
});

// ---- Ad Simulation Engine + EC recharge ---------------------------------------------------------
type AdCtx = Context<{ Bindings: Env; Variables: { user: AuthUserPayload } }>;

function cfCountry(c: AdCtx): string {
  return normalizeCountry((c.req.raw as unknown as { cf?: { country?: string } }).cf?.country);
}

/** Monetized simulations mint real wallet money: admin / auditor accounts or local `wrangler dev` only. */
async function canSimulateMonetized(c: AdCtx) {
  if (isLocalDev(c)) return true;
  if (!c.get('user')) return false;
  return ['super_admin', 'admin', 'finance_auditor'].includes(await getStaffRole(c));
}

/** Start a rewarded video (15 s / 30 s). The server credits it only after the full duration. */
adsRouter.post('/video/start', authMiddleware, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const format = parseAdFormat(body.format, 'video_30s');
  if (format === 'banner') return c.json({ error: 'Banners do not use a video session' }, 400);
  const purpose = body.purpose === 'monetized' ? 'monetized' : 'ec_recharge';
  if (purpose === 'monetized' && !(await canSimulateMonetized(c))) return c.json({ error: 'Monetized ad simulation is limited to admin / auditor accounts' }, 403);
  const now = Math.floor(Date.now() / 1000);
  if (purpose === 'ec_recharge') {
    const dayStart = Math.floor(Date.parse(`${utcDateKey()}T00:00:00Z`) / 1000);
    const count = await c.env.DB
      .prepare("SELECT COUNT(*) AS n FROM ad_video_views WHERE user_id = ?1 AND purpose = 'ec_recharge' AND completed_at IS NOT NULL AND started_at >= ?2")
      .bind(user.userId, dayStart)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= AD_VIDEO_EC_DAILY_CAP) return c.json({ error: `Daily limit reached (${AD_VIDEO_EC_DAILY_CAP} recharge videos per day)` }, 429);
  }
  const id = `vid_${crypto.randomUUID()}`;
  await c.env.DB
    .prepare('INSERT INTO ad_video_views (id, user_id, ad_format, purpose, started_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, user.userId, format, purpose, now)
    .run();
  return c.json({ success: true, viewId: id, format, purpose, durationSeconds: AD_VIDEO_SECONDS[format as keyof typeof AD_VIDEO_SECONDS], startedAt: now });
});

/**
 * Simulated ad view (banner impression or completed rewarded video):
 *  · detects the country (request.cf.country → GLOBAL), values it with P1/P2/P3 and logs the impression
 *  · purpose 'ec_recharge' (default): credits EC % to the real D1 EC balance (no money moves)
 *  · purpose 'monetized': "Monetized Ad Postback Test" — 55 / 15 (5-4-3-2-1) / 5 / 5 / 20 split (admin only)
 */
adsRouter.post('/simulate-view', authMiddleware, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const format = parseAdFormat(body.format, 'banner');
  const purpose: 'ec_recharge' | 'monetized' = body.purpose === 'monetized' ? 'monetized' : 'ec_recharge';
  if (purpose === 'monetized' && !(await canSimulateMonetized(c))) return c.json({ error: 'Monetized ad simulation is limited to admin / auditor accounts' }, 403);
  // Admins may test other countries; everyone else is valued at their real Cloudflare country
  const country = (await canSimulateMonetized(c)) && typeof body.country === 'string' ? normalizeCountry(body.country) : cfCountry(c);
  const now = Math.floor(Date.now() / 1000);
  const provider = 'mwar_simulated';

  // Banner impressions are batched client-side (up to 10 completed impressions per request)
  const count = format === 'banner' ? Math.floor(Number(body.count ?? 1)) : 1;
  if (format === 'banner' && (!Number.isFinite(count) || count < 1 || count > 10)) {
    return c.json({ error: 'count must be 1..10' }, 400);
  }
  if (format === 'banner') {
    // Passive banner: at most one verified impression per ~20 s per user (tab must be visible client-side).
    // A batch of N needs N × the minimum gap since the last credited banner.
    const last = await c.env.DB
      .prepare("SELECT MAX(created_at) AS t FROM ad_impressions WHERE user_id = ?1 AND ad_format = 'banner'")
      .bind(user.userId)
      .first<{ t: number | null }>();
    const need = count * AD_BANNER_MIN_GAP_SECONDS;
    if (last?.t && now - last.t < need) {
      return c.json({ error: 'Banner impressions too soon', retryInSeconds: need - (now - last.t) }, 429);
    }
  } else {
    const viewId = typeof body.viewId === 'string' ? body.viewId : '';
    const view = await c.env.DB
      .prepare('SELECT id, ad_format, purpose, started_at, completed_at FROM ad_video_views WHERE id = ?1 AND user_id = ?2')
      .bind(viewId, user.userId)
      .first<{ id: string; ad_format: string; purpose: string; started_at: number; completed_at: number | null }>();
    if (!view || view.ad_format !== format || view.purpose !== purpose) return c.json({ error: 'Unknown video session — start the video first' }, 400);
    if (view.completed_at) return c.json({ error: 'This video was already credited' }, 409);
    const need = AD_VIDEO_SECONDS[format as keyof typeof AD_VIDEO_SECONDS] - 1;
    if (now - view.started_at < need) return c.json({ error: 'Video not finished yet', retryInSeconds: need - (now - view.started_at) }, 425);
    const done = await c.env.DB
      .prepare('UPDATE ad_video_views SET completed_at = ?1 WHERE id = ?2 AND completed_at IS NULL')
      .bind(now, view.id)
      .run();
    if ((done.meta?.changes ?? 0) !== 1) return c.json({ error: 'This video was already credited' }, 409);
  }

  if (purpose === 'monetized') {
    const txId = `sim_${now}_${crypto.randomUUID().slice(0, 8)}`;
    const result = await processAdReward(c.env, user.userId, provider, country, txId, { format, payoutUsd: body.payoutUsd ?? null });
    return c.json({ simulation: true, purpose, ...result });
  }

  const value: { microUsd: number; source: AdValueSource } = await resolveAdValue(c.env.DB, { country, format });
  // Banner parity uses the 30 s video value from the same tier: yesterday's averages when the banner
  // came from yesterday's average, otherwise the country table for both (no mixed-tier ratios).
  let video30Ref: number | undefined;
  let parityValue = value.microUsd;
  if (format === 'banner') {
    video30Ref = getStatisticalAdMicroUsd(country, 'video_30s');
    if (value.source === 'yesterday_avg') {
      const v = await resolveAdValue(c.env.DB, { country, format: 'video_30s' });
      if (v.source === 'yesterday_avg') video30Ref = v.microUsd;
      else parityValue = getStatisticalAdMicroUsd(country, 'banner');
    }
  }
  const ecBpEach = format === 'video_5s' ? 0 : ecProgressBpFor(format, parityValue, country, video30Ref);
  await logAdImpression(c.env.DB, { userId: user.userId, provider, country, format, purpose, microUsd: value.microUsd, source: value.source, ecBp: ecBpEach }, count);
  const ecBp = ecBpEach * count;
  const ec = ecBp > 0 ? await creditEcProgress(c.env, user.userId, ecBp, `${provider}:${format}${count > 1 ? `x${count}` : ''}`) : null;
  return c.json({
    success: true,
    simulation: true,
    purpose,
    country,
    format,
    adValueMicroUsd: value.microUsd,
    valueSource: value.source,
    impressions: count,
    ecProgressAddedPct: ecBp / (EC_PROGRESS_BP_PER_TICKET / 100),
    energy_tickets: ec?.energyTickets,
    max_energy_tickets: ec?.maxEnergyTickets,
    energy_progress_pct: ec?.energyProgressPct,
    ticketsAwarded: ec?.ticketsAwarded ?? 0,
    ticketsFull: ec?.full ?? false,
  });
});
