import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  AD_VIDEO_EC_DAILY_CAP,
  DIRECT_LINK_COOLDOWN_SECONDS,
  DIRECT_LINK_TOKEN_TTL_SECONDS,
  DirectLinkClaimSchema,
  DirectLinkStartSchema,
  EC_PROGRESS_BP_PER_TICKET,
  MAX_ENERGY_TICKETS,
  type AdSlot,
  type CheerTargetType,
  type DirectLinkStart,
  type PublicAdConfig,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { edgeCachedValue } from '../utils/edge-cache';
import { creditEcProgress, logAdImpression, normalizeCountry, utcDateKey } from '../utils/ad-value';
import { AD_CONFIG_CACHE_KEY, cfCountryOf, getAdConfig, pickDirectLink, toPublicAdConfig, valueFromNetworkPrice, valueSlot } from '../utils/ad-networks';
import { isLocalDev, safeEqual } from '../utils/guards';
import { bannerIdleMs, claimBannerGate, idlePausedBody } from '../utils/ad-activity';
import { loadStatus, recordCheer, resolveTarget, settleCheerRevenue } from './cheer';
import { safeValue } from '../utils/energy-tickets';
import { getStatisticalAdMicroUsd, type AdFormat } from '@mwar/shared';

/**
 * V1.1: gross revenue that may back EC — the slot value, but never above the statistical eCPM of its
 * format (an admin multiplier > 100 % only tunes EC %, it can never create backing above the table).
 */
function backingGross(country: string, v: { format: string; effectiveMicroUsd: number }): number {
  return Math.min(v.effectiveMicroUsd, getStatisticalAdMicroUsd(country, v.format as AdFormat));
}

type Ctx = Context<{ Bindings: Env; Variables: { user: AuthUserPayload } }>;

/**
 * Real ad networks (Adsterra + Monetag), mounted at /api/ads:
 *   GET  /config                 public, sanitized, edge-cached 60 s (mode, enabled flags, banner keys, in-page zone)
 *   POST /impression             live Adsterra banner impression ping (30–45 s, visible tab) → EC progress + backing
 *   POST /direct-link/start      Path A: open a Monetag Direct Link (Adsterra Smartlink fallback) with a token
 *   POST /direct-link/claim      Path A: claim after required_seconds (server clock) → EC progress / Cheer
 *   ALL  /postback/monetag       Path B: Monetag S2S postback (secret) → P1 value from estimated_price
 * Ads credit non-withdrawable EC only (cap 300). Withdrawable USD comes only from game rooms.
 */
export const adNetworksRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

const nowSec = () => Math.floor(Date.now() / 1000);
const dayStartSec = () => Math.floor(Date.parse(`${utcDateKey()}T00:00:00Z`) / 1000);

adNetworksRouter.get('/config', async (c) => {
  const body = await edgeCachedValue<PublicAdConfig>(c, `${AD_CONFIG_CACHE_KEY}:public`, 60, async () => toPublicAdConfig(await getAdConfig(c)));
  c.header('Cache-Control', 'public, max-age=60');
  return c.json(body);
});

/** POST /api/ads/impression { slot: 'adsterra_320x50' | 'adsterra_300x250', count 1..10, lastActiveAt, clientNow } */
adNetworksRouter.post('/impression', authMiddleware, async (c) => {
  const me = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const slot: AdSlot = body.slot === 'adsterra_300x250' ? 'adsterra_300x250' : 'adsterra_320x50';
  const count = Math.floor(Number(body.count ?? 1));
  if (!Number.isFinite(count) || count < 1 || count > 10) return c.json({ error: 'count must be 1..10' }, 400);
  const cfg = await getAdConfig(c);
  const pub = toPublicAdConfig(cfg);
  if (!(slot === 'adsterra_320x50' ? pub.banner320x50 : pub.banner300x250)) return c.json({ error: 'This ad slot is not live', code: 'AD_SLOT_OFF' }, 409);

  // Anti-AFK: the player must have touched / moved / typed within the last 40 s
  const idle = bannerIdleMs(body);
  if (idle !== null) return c.json(idlePausedBody(idle), 400);
  // At most one accepted banner request per 28 s per user across every banner (a batch of N needs
  // N gaps), claimed atomically in D1 so parallel / scripted pings can't slip through
  const wait = await claimBannerGate(c.env.DB, me.userId, count);
  if (wait !== null) return c.json({ error: 'Banner impressions too soon', code: 'too_soon', retryInSeconds: wait }, 429);

  const country = cfCountryOf(c);
  const v = valueSlot(cfg, country, slot);
  await logAdImpression(
    c.env.DB,
    { userId: me.userId, provider: v.network, country, format: v.format, purpose: 'ec_recharge', microUsd: v.effectiveMicroUsd, source: 'country_ecpm_mult', ecBp: v.ecBp, slot },
    count
  );
  // V1.1: a live banner impression is real ad revenue → floor(gross × 0.90–0.95) backs the EC it charges
  const backed = safeValue(c.env, backingGross(country, v)) * count;
  const ec = v.ecBp > 0 ? await creditEcProgress(c.env, me.userId, v.ecBp * count, `${slot}x${count}`, { microUsd: backed, source: 'ad_charge', country }) : null;
  return c.json({
    success: true,
    format: 'banner',
    backedMicroUsd: ec?.backedAddedMicroUsd ?? 0,
    pendingEcMicroUsd: ec?.pendingEcMicroUsd,
    slot,
    country,
    impressions: count,
    adValueMicroUsd: v.effectiveMicroUsd,
    ecProgressAddedPct: (v.ecBp * count) / (EC_PROGRESS_BP_PER_TICKET / 100),
    energy_tickets: ec?.energyTickets,
    max_energy_tickets: ec?.maxEnergyTickets,
    energy_progress_pct: ec?.energyProgressPct,
    ticketsAwarded: ec?.ticketsAwarded ?? 0,
    ticketsFull: ec?.full ?? false,
  });
});

/** POST /api/ads/direct-link/start { purpose, seconds: 15|30, targetType?, targetId? } */
adNetworksRouter.post('/direct-link/start', authMiddleware, async (c) => {
  const me = c.get('user');
  const parsed = DirectLinkStartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, 400);
  const { purpose, seconds } = parsed.data;
  if (purpose === 'cheer' && parsed.data.targetType && parsed.data.targetType !== 'energy') {
    // V1.1: never cheer your own post / profile (checked before anything else)
    const t = await resolveTarget(c, parsed.data.targetType as CheerTargetType, parsed.data.targetId);
    if (t.ok && t.targetUserId === me.userId) return c.json({ error: 'You cannot cheer your own content', code: 'SELF_CHEER' }, 400);
  }
  const cfg = await getAdConfig(c);
  if (cfg.adMode !== 'live') return c.json({ error: 'Real ads are in test mode', code: 'AD_MODE_TEST', adMode: cfg.adMode }, 409);
  const link = pickDirectLink(cfg);
  if (!link) return c.json({ error: 'No direct link is configured', code: 'AD_SLOT_OFF' }, 503);

  const now = nowSec();
  const recent = await c.env.DB.batch([
    c.env.DB.prepare('SELECT MAX(started_at) AS t FROM ad_click_tokens WHERE user_id = ?1').bind(me.userId),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM ad_click_tokens WHERE user_id = ?1 AND purpose = 'ec_recharge' AND status = 'claimed' AND started_at >= ?2").bind(me.userId, dayStartSec()),
  ]);
  const lastStart = Number((recent[0].results?.[0] as any)?.t || 0);
  if (lastStart && now - lastStart < DIRECT_LINK_COOLDOWN_SECONDS) {
    return c.json({ error: 'Please wait before the next ad', code: 'AD_COOLDOWN', retryInSeconds: DIRECT_LINK_COOLDOWN_SECONDS - (now - lastStart) }, 429);
  }

  let target: { targetType: CheerTargetType | null; targetId: string | null; targetUserId: string | null } = { targetType: null, targetId: null, targetUserId: null };
  if (purpose === 'ec_recharge') {
    if (Number((recent[1].results?.[0] as any)?.n || 0) >= AD_VIDEO_EC_DAILY_CAP) {
      return c.json({ error: `Daily limit reached (${AD_VIDEO_EC_DAILY_CAP} ads per day)`, code: 'AD_DAILY_CAP' }, 429);
    }
  } else {
    const targetType = parsed.data.targetType as CheerTargetType;
    const t = await resolveTarget(c, targetType, parsed.data.targetId);
    if (!t.ok) return c.json({ error: t.error }, t.status);
    const status = await loadStatus(c, targetType, t.targetId, t.targetUserId);
    const opt = status.options.find((o) => o.format === (seconds === 30 ? 'video_30s' : 'video_15s'));
    if (!opt?.available) return c.json({ error: 'This cheer is not available right now', code: 'CHEER_LIMIT', reason: opt?.reason, status }, 429);
    target = { targetType, targetId: t.targetId, targetUserId: t.targetUserId };
  }

  const token = `dl_${crypto.randomUUID()}`;
  const country = cfCountryOf(c);
  await c.env.DB
    .prepare(
      `INSERT INTO ad_click_tokens (token, user_id, network, purpose, target_type, target_id, target_user_id, country_code, required_seconds, started_at, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending')`
    )
    .bind(token, me.userId, link.network, purpose, target.targetType, target.targetId, target.targetUserId, country, seconds, now)
    .run();

  // Monetag direct links forward `ymid` to the S2S postback, so the postback can find this token
  let launchUrl = link.url;
  if (link.network === 'monetag') {
    const u = new URL(link.url);
    u.searchParams.set('ymid', token);
    launchUrl = u.toString();
  }
  const out: DirectLinkStart = { token, launchUrl, requiredSeconds: seconds, network: link.network, adMode: cfg.adMode };
  return c.json(out);
});

/** POST /api/ads/direct-link/claim { token } — own, pending, single-use, at least required_seconds old. */
adNetworksRouter.post('/direct-link/claim', authMiddleware, async (c) => {
  const me = c.get('user');
  const parsed = DirectLinkClaimSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Unknown ad visit' }, 400);
  const row = await c.env.DB
    .prepare('SELECT * FROM ad_click_tokens WHERE token = ?1 AND user_id = ?2')
    .bind(parsed.data.token, me.userId)
    .first<any>();
  if (!row) return c.json({ error: 'Unknown ad visit' }, 404);
  if (row.status === 'claimed') return c.json({ error: 'This ad was already counted', code: 'AD_ALREADY_CLAIMED' }, 409);
  const now = nowSec();
  const age = now - Number(row.started_at);
  if (row.status !== 'pending' || age > DIRECT_LINK_TOKEN_TTL_SECONDS) {
    await c.env.DB.prepare("UPDATE ad_click_tokens SET status = 'expired' WHERE token = ?1 AND status = 'pending'").bind(row.token).run();
    return c.json({ error: 'This ad visit expired. Please start again.', code: 'AD_EXPIRED' }, 410);
  }
  if (age < Number(row.required_seconds)) {
    return c.json({ error: 'Ad not finished yet', code: 'AD_TOO_EARLY', retryInSeconds: Number(row.required_seconds) - age }, 400);
  }
  const upd = await c.env.DB
    .prepare("UPDATE ad_click_tokens SET status = 'claimed', claimed_at = ?1, claimed_via = 'timer' WHERE token = ?2 AND status = 'pending'")
    .bind(now, row.token)
    .run();
  if ((upd.meta?.changes ?? 0) !== 1) return c.json({ error: 'This ad was already counted', code: 'AD_ALREADY_CLAIMED' }, 409);

  const cfg = await getAdConfig(c);
  const slot: AdSlot = row.network === 'monetag' ? 'monetag_direct' : 'adsterra_smartlink';
  const country = normalizeCountry(row.country_code);
  const v = valueSlot(cfg, country, slot, Number(row.required_seconds));

  let cheerCount: number | null = null;
  let cheerStatus = null;
  let cheerSplit: Awaited<ReturnType<typeof settleCheerRevenue>> | null = null;
  if (row.purpose === 'cheer' && row.target_user_id && row.target_user_id === me.userId) {
    await c.env.DB.prepare("UPDATE ad_click_tokens SET status = 'expired' WHERE token = ?1").bind(row.token).run();
    return c.json({ error: 'You cannot cheer your own content', code: 'SELF_CHEER' }, 400);
  }
  if (row.purpose === 'cheer') {
    const rec = await recordCheer(c, {
      viewId: row.token,
      targetType: row.target_type,
      targetId: row.target_id,
      targetUserId: row.target_user_id,
      format: v.format,
      bp: v.ecBp,
      valueMicroUsd: v.effectiveMicroUsd,
      country,
      drawEnergyPool: false, // a real network ad: the network pays, the Energy Pool is not drawn
    });
    if (!rec.ok) {
      await c.env.DB.prepare("UPDATE ad_click_tokens SET status = 'expired' WHERE token = ?1").bind(row.token).run();
      if (rec.duplicate) return c.json({ error: 'This ad was already counted', code: 'AD_ALREADY_CLAIMED' }, 409);
      return c.json({ error: 'Cheer limit reached', code: 'CHEER_LIMIT', reason: rec.reason, status: rec.status }, 429);
    }
    cheerCount = rec.cheerCount;
  }
  // V1.1: a real direct-link visit is real revenue. Safe value V = floor(gross × 0.90–0.95):
  //   ec_recharge / energy cheer → 100 % of V backs the viewer's EC
  //   creator cheer → 55 / 15 / 5 / 5 to the creator side, the 20 % slice backs the viewer's EC
  const safeV = safeValue(c.env, backingGross(country, v));
  let viewerBacking = safeV;
  let backingSource: 'ad_charge' | 'cheer_pool' = 'ad_charge';
  if (row.purpose === 'cheer' && row.target_user_id) {
    cheerSplit = await settleCheerRevenue(c.env, { creatorId: row.target_user_id, viewerId: me.userId, valueMicroUsd: safeV, sourceId: `cheer:${row.token}` });
    viewerBacking = cheerSplit.viewerBackingMicroUsd;
    backingSource = 'cheer_pool';
  }

  await logAdImpression(c.env.DB, {
    userId: me.userId,
    provider: v.network,
    country,
    format: v.format,
    purpose: row.purpose === 'cheer' ? 'cheer' : 'ec_recharge',
    microUsd: v.effectiveMicroUsd,
    source: 'country_ecpm_mult',
    ecBp: v.ecBp,
    slot,
  });
  const ec = v.ecBp > 0 ? await creditEcProgress(c.env, me.userId, v.ecBp, `direct:${slot}:${row.token}`, { microUsd: viewerBacking, source: backingSource, country }) : null;
  if (row.purpose === 'cheer') cheerStatus = await loadStatus(c, row.target_type, row.target_id, row.target_user_id);
  return c.json({
    success: true,
    network: v.network,
    slot,
    country,
    format: v.format,
    effectiveMicroUsd: v.effectiveMicroUsd,
    ecProgressPct: v.ecProgressPct,
    ecProgressAddedPct: v.ecBp / (EC_PROGRESS_BP_PER_TICKET / 100),
    energyTickets: ec?.energyTickets,
    maxEnergyTickets: ec?.maxEnergyTickets ?? MAX_ENERGY_TICKETS,
    energyProgressPct: ec?.energyProgressPct ?? 0,
    ticketsAwarded: ec?.ticketsAwarded ?? 0,
    cheerCount,
    status: cheerStatus,
    valueMicroUsd: safeV,
    creatorMicroUsd: cheerSplit?.creatorMicroUsd ?? 0,
    ecBackingMicroUsd: ec?.backedAddedMicroUsd ?? 0,
  });
});

/** Constant-time check of the shared postback secret (query `secret` or header `X-Postback-Secret`). */
function postbackSecretOk(c: Context<any>, q: Record<string, string>): boolean {
  const secret = c.env.AD_POSTBACK_SECRET || c.env.ADS_POSTBACK_SECRET;
  if (!secret) return false;
  return safeEqual(q.secret, secret) || safeEqual(c.req.header('X-Postback-Secret'), secret);
}

async function postbackParams(c: Context<any>): Promise<Record<string, string>> {
  const q: Record<string, string> = { ...c.req.query() };
  if (c.req.method === 'POST') {
    const ct = c.req.header('Content-Type') || '';
    try {
      const b: Record<string, unknown> = ct.includes('application/json') ? await c.req.json() : ((await c.req.parseBody()) as Record<string, unknown>);
      for (const [k, v] of Object.entries(b || {})) if (q[k] === undefined && (typeof v === 'string' || typeof v === 'number')) q[k] = String(v);
    } catch {
      /* empty / odd body: query only */
    }
  }
  return q;
}

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Path B — Monetag S2S postback:
 *   https://api.mwar.win/api/ads/postback/monetag?secret=…&ymid={ymid}&estimated_price={estimated_price}&zone_id={zone_id}
 * ymid = a direct-link token (dl_…) or a user id. Deduped by click / transaction id (or the token).
 * Value P1 = estimated_price (USD) → micro-USD; without a price, the slot's country eCPM × multiplier.
 * Always answers 200 once authorized so the network does not retry forever.
 */
adNetworksRouter.all('/postback/monetag', async (c) => {
  const q = await postbackParams(c);
  if (!postbackSecretOk(c, q) && !(isLocalDev(c) && !(c.env.AD_POSTBACK_SECRET || c.env.ADS_POSTBACK_SECRET))) {
    return c.json({ error: 'Invalid postback secret' }, 403);
  }
  const ymid = String(q.ymid || q.subid || '').trim();
  if (!ymid || ymid.length > 80) return c.json({ ok: false, error: 'Missing ymid' }, 200);
  const zoneId = String(q.zone_id || q.zone || '').trim();
  const eventType = String(q.reward_event_type || q.event_type || '').toLowerCase();
  const price = Number(q.estimated_price);

  // Resolve the user (and the visit, when ymid is a direct-link token)
  const isToken = /^dl_[a-f0-9-]{36}$/.test(ymid);
  const tokenRow = isToken ? await c.env.DB.prepare('SELECT * FROM ad_click_tokens WHERE token = ?1').bind(ymid).first<any>() : null;
  const userId = tokenRow ? tokenRow.user_id : isToken ? null : ymid;
  const user = userId ? await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(userId).first<{ id: string }>() : null;
  if (!user) return c.json({ ok: true, ignored: 'unknown_user' }, 200);

  const txId =
    String(q.click_id || q.transaction_id || q.tx_id || q.request_var || '').slice(0, 128) ||
    (isToken ? `tok:${ymid}` : `h:${await sha256Hex(JSON.stringify(Object.entries(q).filter(([k]) => k !== 'secret').sort()))}`);

  const cfg = await getAdConfig(c);
  const country = tokenRow ? normalizeCountry(tokenRow.country_code) : normalizeCountry(q.geo || q.country);
  const slot: AdSlot = zoneId && zoneId === cfg.monetagInpageZoneId ? 'monetag_inpage' : 'monetag_direct';
  const p1 = Number.isFinite(price) && price > 0 && price < 5;
  const value = p1 ? { ...valueFromNetworkPrice(country, price), format: slot === 'monetag_inpage' ? 'video_5s' : 'video_15s' } : valueSlot(cfg, country, slot, tokenRow ? Number(tokenRow.required_seconds) : undefined);

  const ins = await c.env.DB
    .prepare('INSERT OR IGNORE INTO ad_postbacks (provider, provider_tx_id, user_id, amount_micro_usd, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind('monetag', txId, user.id, value.effectiveMicroUsd, nowSec())
    .run();
  if ((ins.meta?.changes ?? 0) === 0) return c.json({ ok: true, duplicate: true }, 200);

  // Decide whether this postback credits EC (never twice for one visit, never above the daily cap)
  let creditBp = value.ecBp;
  let note = 'credited';
  if (eventType === 'not_valued' || eventType === 'non_valued' || eventType === 'invalid') {
    creditBp = 0;
    note = 'not_valued';
  } else if (tokenRow) {
    if (tokenRow.purpose === 'cheer') {
      creditBp = 0; // the in-app timer claim counts the cheer; the postback records the real revenue
      note = 'cheer_revenue_only';
    } else {
      const upd = await c.env.DB
        .prepare("UPDATE ad_click_tokens SET status = 'claimed', claimed_at = ?1, claimed_via = 'postback' WHERE token = ?2 AND status = 'pending'")
        .bind(nowSec(), tokenRow.token)
        .run();
      if ((upd.meta?.changes ?? 0) !== 1) {
        creditBp = 0;
        note = 'already_claimed';
      }
    }
  } else {
    const n = await c.env.DB
      .prepare("SELECT COUNT(*) AS n FROM ad_impressions WHERE user_id = ?1 AND provider = 'monetag' AND date_key = ?2 AND ec_progress_bp > 0")
      .bind(user.id, utcDateKey())
      .first<{ n: number }>();
    if (Number(n?.n || 0) >= AD_VIDEO_EC_DAILY_CAP) {
      creditBp = 0;
      note = 'daily_cap';
    }
  }

  await logAdImpression(c.env.DB, {
    userId: user.id,
    provider: 'monetag',
    country,
    format: value.format as any,
    purpose: tokenRow?.purpose === 'cheer' ? 'cheer' : 'ec_recharge',
    microUsd: value.effectiveMicroUsd,
    source: p1 ? 'network' : 'country_ecpm_mult',
    ecBp: creditBp,
    slot,
  });
  // V1.1: real revenue (P1 estimated_price or the slot's eCPM) backs the EC it credits, after the haircut
  const pbGross = p1 ? value.effectiveMicroUsd : backingGross(country, value as { format: string; effectiveMicroUsd: number });
  const ec = creditBp > 0 ? await creditEcProgress(c.env, user.id, creditBp, `postback:monetag:${txId}`, { microUsd: safeValue(c.env, pbGross), source: 'ad_charge', country }) : null;
  return c.json({ ok: true, note, valueSource: p1 ? 'network' : 'country_ecpm_mult', effectiveMicroUsd: value.effectiveMicroUsd, ecProgressPct: Math.round(creditBp / 100), energyTickets: ec?.energyTickets ?? null }, 200);
});
