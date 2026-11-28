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
  splitAdGross,
  type AdSlot,
  type CheerTargetType,
  type DirectLinkStart,
  type PublicAdConfig,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { edgeCachedValue } from '../utils/edge-cache';
import { creditEcProgress, logAdImpression, normalizeCountry, utcDateKey } from '../utils/ad-value';
import { creditFastMiniBanner } from '../utils/fast-mini';
import { AD_CONFIG_CACHE_KEY, cfCountryOf, getAdConfig, pickDirectLink, toPublicAdConfig, valueFromNetworkPrice, valueSlot } from '../utils/ad-networks';
import { isLocalDev, safeEqual } from '../utils/guards';
import { bannerGateBody, bannerIdleMs, claimBannerGate, idlePausedBody } from '../utils/ad-activity';
import { loadStatus, recordCheer, resolveTarget, settleCheerRevenue } from './cheer';
import { safeValue } from '../utils/energy-tickets';
import { getStatisticalAdMicroUsd, splitStreamerShare, STREAMER_ROOM_CODE_RE, type AdFormat } from '@mwar/shared';
import { liveConfig } from '../utils/platform-settings';
import { ledgerAfterUpdate } from '../utils/ledger';
import { logFinancialTransaction, walletBalance } from '../utils/audit-logger';

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
 *   POST /impression             live Adsterra banner impression ping (30–45 s, visible tab, ≤ 60 / day) → EC % only
 *   POST /direct-link/start      Path A: open a Monetag Direct Link (Adsterra Smartlink fallback) with a token
 *   POST /direct-link/claim      Path A: claim after required_seconds (server clock) → EC % / Cheer count
 *   ALL  /postback/monetag       Path B: Monetag S2S postback (secret) → P1 value from estimated_price
 * V1.2 (audit H2 — verified-ad-only cash): banner pings and timer-only claims are UNVERIFIED (the client says
 * they happened) and credit EC progress with 0 µUSD backing, never cheer cash. Only an S2S postback carrying the
 * network's own estimated_price (P1) creates value: G → 3 % safety reserve + 5 % Boss Bounty Pool + V 92 %,
 * where V backs the viewer's EC (ec_recharge) or is split 55/15/5/5/20 for a cheer — exactly once per visit.
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
  const refused = await claimBannerGate(c.env.DB, me.userId, count);
  if (refused) return c.json(bannerGateBody(refused), 429);

  const country = cfCountryOf(c);
  const v = valueSlot(cfg, country, slot);
  await logAdImpression(
    c.env.DB,
    { userId: me.userId, provider: v.network, country, format: v.format, purpose: 'ec_recharge', microUsd: v.effectiveMicroUsd, source: 'country_ecpm_mult', ecBp: v.ecBp, slot },
    count
  );
  // V1.2 (audit H2): a banner ping is client-reported, the network never confirms it → EC progress only, 0 µUSD
  // cash backing. Its estimated value is still what the slot is worth for EC % and the Fast & Mini pot share.
  let creditBp = v.ecBp * count;
  // V1.1 R2 Fast & Mini: 50 % of the banner's value funds the player's own pot (what a killer can win, 90/10)
  // and the EC % is scaled to the other 50 %. V1.2: the pot share is drawn from the Energy Pool's UNSPENT
  // balance (capped by what it holds, exactly like a simulated banner) — never created from an unverified ping.
  const fmPot = body.fastMiniEntryId
    ? await creditFastMiniBanner(c.env, { userId: me.userId, potId: body.fastMiniEntryId, safeMicroUsd: safeValue(c.env, backingGross(country, v)) * count, ecBp: creditBp, fromPool: true, ref: `${slot}x${count}` })
    : null;
  if (fmPot && fmPot.potMicroUsd > 0) creditBp = fmPot.ecBp;
  const ec = creditBp > 0 ? await creditEcProgress(c.env, me.userId, creditBp, `${slot}x${count}`, { microUsd: 0, source: 'ad_charge', country }) : null;
  return c.json({
    success: true,
    format: 'banner',
    backedMicroUsd: ec?.backedAddedMicroUsd ?? 0,
    verified: false,
    pendingEcMicroUsd: ec?.pendingEcMicroUsd,
    slot,
    country,
    impressions: count,
    adValueMicroUsd: v.effectiveMicroUsd,
    ecProgressAddedPct: creditBp / (EC_PROGRESS_BP_PER_TICKET / 100),
    fastMiniPotAddedMicroUsd: fmPot?.potMicroUsd ?? 0,
    fastMiniPotMicroUsd: fmPot?.potOpenMicroUsd ?? 0,
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
  // V1.2 C Streamer Room attribution: only an EC-recharge visit of a viewer watching someone else's live streamer
  // room is attributed (the streamer is credited later, and only from the VERIFIED postback value)
  const streamer = purpose === 'ec_recharge' ? await streamerOfRoom(c.env, parsed.data.roomCode) : null;
  const attributed = streamer && streamer.userId !== me.userId ? streamer : null;
  await c.env.DB
    .prepare(
      `INSERT INTO ad_click_tokens (token, user_id, network, purpose, target_type, target_id, target_user_id, country_code, required_seconds, started_at, status, room_code, streamer_user_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12)`
    )
    .bind(token, me.userId, link.network, purpose, target.targetType, target.targetId, target.targetUserId, country, seconds, now, attributed ? attributed.roomCode : null, attributed ? attributed.userId : null)
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
  // V1.2 (audit H2): the 15/30 s timer only proves the tab stayed open — no network confirmed the visit. It
  // credits EC progress with 0 µUSD backing and the cheer COUNT only (creator cash 0). The revenue is applied
  // when (if) the network's S2S postback with estimated_price arrives for this token — or right here when the
  // postback already arrived before the claim (applyVerifiedVisit, exactly once per token).
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
  const ec = v.ecBp > 0 ? await creditEcProgress(c.env, me.userId, v.ecBp, `direct:${slot}:${row.token}`, { microUsd: 0, source: row.purpose === 'cheer' ? 'cheer_pool' : 'ad_charge', country }) : null;
  const verified = await applyVerifiedVisit(c.env, row.token);
  if (verified.applied) cheerSplit = { valueMicroUsd: verified.netMicroUsd, creatorMicroUsd: verified.creatorMicroUsd, viewerBackingMicroUsd: verified.viewerBackingMicroUsd };
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
    verified: verified.applied,
    valueMicroUsd: verified.applied ? verified.netMicroUsd : 0,
    estimatedMicroUsd: safeValue(c.env, backingGross(country, v)),
    creatorMicroUsd: cheerSplit?.creatorMicroUsd ?? 0,
    ecBackingMicroUsd: (ec?.backedAddedMicroUsd ?? 0) + (verified.applied ? verified.viewerBackingMicroUsd : 0),
  });
});

/**
 * V1.2: apply the S2S-verified revenue (ad_click_tokens.verified_gross_micro_usd, the network's estimated_price)
 * of a CLAIMED direct-link visit, exactly once per token (guarded by verified_at IS NULL: a replayed postback,
 * a racing timer claim or a second call all find it already applied):
 *   G -> 3 % Platform Safety Reserve + 5 % Boss Bounty Pool + V (92 %)
 *   ec_recharge / EC-panel cheer -> V backs the viewer's EC (pending_ec_micro_usd)
 *   creator cheer -> V split 55 / 15 / 5 / 5 / 20 (settleCheerRevenue), the 20 % slice backs the viewer's EC
 */
export async function applyVerifiedVisit(env: Env, token: string): Promise<{ applied: boolean; netMicroUsd: number; creatorMicroUsd: number; viewerBackingMicroUsd: number; streamerMicroUsd?: number }> {
  const none = { applied: false, netMicroUsd: 0, creatorMicroUsd: 0, viewerBackingMicroUsd: 0 };
  const now = nowSec();
  const upd = await env.DB
    .prepare("UPDATE ad_click_tokens SET verified_at = ?1 WHERE token = ?2 AND status = 'claimed' AND verified_at IS NULL AND verified_gross_micro_usd > 0")
    .bind(now, token)
    .run();
  if ((upd.meta?.changes ?? 0) !== 1) return none;
  const row = await env.DB.prepare('SELECT * FROM ad_click_tokens WHERE token = ?1').bind(token).first<any>();
  if (!row) return none;
  const h = splitAdGross(Number(row.verified_gross_micro_usd) || 0);
  if (h.grossMicroUsd <= 0) return none;
  const country = normalizeCountry(row.country_code);
  if (row.purpose === 'cheer' && row.target_user_id && row.target_user_id !== row.user_id) {
    const split = await settleCheerRevenue(env, { creatorId: row.target_user_id, viewerId: row.user_id, valueMicroUsd: h.netMicroUsd, sourceId: `cheer:${token}`, adHaircut: h });
    if (split.viewerBackingMicroUsd > 0) {
      await creditEcProgress(env, row.user_id, 0, `verified:cheer:${token}`, { microUsd: split.viewerBackingMicroUsd, source: 'cheer_pool', country });
    }
    return { applied: true, netMicroUsd: h.netMicroUsd, creatorMicroUsd: split.creatorMicroUsd, viewerBackingMicroUsd: split.viewerBackingMicroUsd };
  }
  // V1.2 C Streamer Room: the streamer gets 30–50 % (default 40 %) of the VERIFIED net value V of a spectator's ad
  // watched in their room; the viewer's EC backing is the rest (G = 3 % + 5 % + streamer + viewer, exactly once)
  const { backing, streamerMicroUsd } = await applyStreamerShare(env, row, h.netMicroUsd);
  const ec = await creditEcProgress(env, row.user_id, 0, `verified:${token}`, { microUsd: backing, source: row.purpose === 'cheer' ? 'cheer_pool' : 'ad_charge', country, haircut: h });
  return { applied: true, netMicroUsd: h.netMicroUsd, creatorMicroUsd: 0, viewerBackingMicroUsd: ec?.backedAddedMicroUsd ?? 0, streamerMicroUsd };
}

/**
 * V1.2 C: credit the room's streamer floor(V × 30–50 %) of a VERIFIED net value V of an ec_recharge visit (once per
 * token: streamer_micro_usd IS NULL guard; wallet + ledger in the same batch). Returns what is left to back the
 * viewer's EC. Call only AFTER the visit's verified revenue was marked applied (verified_at).
 */
export async function applyStreamerShare(env: Env, row: any, netMicroUsd: number): Promise<{ backing: number; streamerMicroUsd: number }> {
  if (row?.purpose !== 'ec_recharge' || !row.streamer_user_id || row.streamer_user_id === row.user_id || netMicroUsd <= 0) return { backing: netMicroUsd, streamerMicroUsd: 0 };
  const pct = (await liveConfig(env)).streamerSharePct;
  const share = splitStreamerShare(netMicroUsd, pct).streamerMicroUsd;
  if (share <= 0) return { backing: netMicroUsd, streamerMicroUsd: 0 };
  const token = String(row.token);
  const t = nowSec();
  const r = await env.DB.batch([
    env.DB.prepare('UPDATE ad_click_tokens SET streamer_micro_usd = ?1 WHERE token = ?2 AND streamer_micro_usd IS NULL').bind(share, token),
    env.DB.prepare('UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3 AND changes() = 1').bind(share, t, row.streamer_user_id),
    ledgerAfterUpdate(env.DB, row.streamer_user_id, share, 'STREAMER_AD_SHARE', `stream:${row.room_code ?? ''}:${token}`, t),
  ]);
  if ((r[1].meta?.changes ?? 0) !== 1) {
    // streamer wallet missing: nothing credited → the whole V stays with the viewer
    if ((r[0].meta?.changes ?? 0) === 1) await env.DB.prepare('UPDATE ad_click_tokens SET streamer_micro_usd = 0 WHERE token = ?1').bind(token).run();
    return { backing: netMicroUsd, streamerMicroUsd: 0 };
  }
  await logFinancialTransaction(env, {
    transaction_id: `tx_stream_${token.slice(3, 21)}`,
    user_id: row.streamer_user_id,
    action_type: 'STREAMER_AD_SHARE',
    amount_micro_usd: BigInt(share),
    balance_after_micro_usd: await walletBalance(env.DB, row.streamer_user_id),
    source_game_id: `stream:${row.room_code ?? ''}`.slice(0, 64),
    related_user_id: row.user_id,
  });
  return { backing: netMicroUsd - share, streamerMicroUsd: share };
}

/** V1.2 C: the live streamer room behind a registry room code (null for a normal room / closed / unknown). */
export async function streamerOfRoom(env: Env, roomCode: unknown): Promise<{ userId: string; roomCode: string } | null> {
  if (typeof roomCode !== 'string' || !STREAMER_ROOM_CODE_RE.test(roomCode)) return null;
  try {
    const r = await env.DB
      .prepare("SELECT streamer_user_id AS u, room_code AS rc FROM game_server_rooms WHERE room_code = ?1 AND is_streamer_room = 1 AND is_active = 1 AND game_id = 'fps'")
      .bind(roomCode)
      .first<{ u: string | null; rc: string }>();
    return r?.u ? { userId: r.u, roomCode: r.rc } : null;
  } catch {
    return null;
  }
}

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

  // Decide whether this postback credits EC (never twice for one visit, never above the daily cap) and whether
  // it carries VERIFIED revenue (V1.2: only P1 — the network's own estimated_price — creates value)
  let creditBp = value.ecBp;
  let note = 'credited';
  let verifiedGross = p1 ? value.effectiveMicroUsd : 0;
  const now = nowSec();
  if (eventType === 'not_valued' || eventType === 'non_valued' || eventType === 'invalid') {
    creditBp = 0;
    verifiedGross = 0;
    note = 'not_valued';
  } else if (tokenRow) {
    // Remember the verified price on the visit (first priced postback only: replays never add a second value)
    if (verifiedGross > 0) {
      const rec = await c.env.DB
        .prepare('UPDATE ad_click_tokens SET verified_gross_micro_usd = ?1, postback_at = ?2 WHERE token = ?3 AND verified_gross_micro_usd IS NULL')
        .bind(verifiedGross, now, tokenRow.token)
        .run();
      if ((rec.meta?.changes ?? 0) !== 1) verifiedGross = 0;
    }
    if (tokenRow.purpose === 'cheer') {
      creditBp = 0; // the in-app timer claim counts the cheer (+ EC %); the postback brings the real revenue
      note = verifiedGross > 0 ? 'cheer_verified' : 'cheer_unverified';
    } else {
      const upd = await c.env.DB
        .prepare("UPDATE ad_click_tokens SET status = 'claimed', claimed_at = ?1, claimed_via = 'postback' WHERE token = ?2 AND status = 'pending'")
        .bind(now, tokenRow.token)
        .run();
      if ((upd.meta?.changes ?? 0) !== 1) {
        creditBp = 0;
        note = verifiedGross > 0 ? 'verified_after_claim' : 'already_claimed';
      }
    }
    // The visit is (now) claimed: apply its verified revenue exactly once (EC backing / cheer split)
    if (verifiedGross > 0) {
      if (creditBp > 0) {
        await logAdImpression(c.env.DB, { userId: user.id, provider: 'monetag', country, format: value.format as any, purpose: 'ec_recharge', microUsd: value.effectiveMicroUsd, source: 'network', ecBp: creditBp, slot });
        // claimed by this postback: EC % and its backing in ONE credit (guarded so a racing claim cannot apply it again)
        const mark = await c.env.DB
          .prepare("UPDATE ad_click_tokens SET verified_at = ?1 WHERE token = ?2 AND verified_at IS NULL AND status = 'claimed'")
          .bind(now, tokenRow.token)
          .run();
        const h = splitAdGross(verifiedGross);
        const ok = (mark.meta?.changes ?? 0) === 1;
        // V1.2 C: a viewer's ad in a Streamer Room → the streamer's share of the verified V first
        const share = ok ? await applyStreamerShare(c.env, tokenRow, h.netMicroUsd) : { backing: 0, streamerMicroUsd: 0 };
        const ec = await creditEcProgress(c.env, user.id, creditBp, `postback:monetag:${txId}`, ok ? { microUsd: share.backing, source: 'ad_charge', country, haircut: h } : { microUsd: 0, source: 'ad_charge', country });
        return c.json({ ok: true, note, valueSource: 'network', verified: ok, effectiveMicroUsd: value.effectiveMicroUsd, netMicroUsd: ok ? h.netMicroUsd : 0, ecProgressPct: Math.round(creditBp / 100), energyTickets: ec?.energyTickets ?? null }, 200);
      }
      await logAdImpression(c.env.DB, { userId: user.id, provider: 'monetag', country, format: value.format as any, purpose: tokenRow.purpose === 'cheer' ? 'cheer' : 'ec_recharge', microUsd: value.effectiveMicroUsd, source: 'network', ecBp: 0, slot });
      const visit = await applyVerifiedVisit(c.env, tokenRow.token);
      return c.json({ ok: true, note, valueSource: 'network', verified: visit.applied, effectiveMicroUsd: value.effectiveMicroUsd, applied: visit.applied, netMicroUsd: visit.netMicroUsd, creatorMicroUsd: visit.creatorMicroUsd, ecBackingMicroUsd: visit.viewerBackingMicroUsd }, 200);
    }
  } else {
    const n = await c.env.DB
      .prepare("SELECT COUNT(*) AS n FROM ad_impressions WHERE user_id = ?1 AND provider = 'monetag' AND date_key = ?2 AND ec_progress_bp > 0")
      .bind(user.id, utcDateKey())
      .first<{ n: number }>();
    if (Number(n?.n || 0) >= AD_VIDEO_EC_DAILY_CAP) {
      creditBp = 0;
      verifiedGross = 0;
      note = 'daily_cap';
    }
  }

  // An unpriced postback that credits nothing is not logged as an estimated impression (it would inflate the
  // admin "estimated vs verified" check without anything having been credited)
  if (creditBp > 0 || verifiedGross > 0) {
    await logAdImpression(c.env.DB, {
      userId: user.id,
      provider: 'monetag',
      country,
      format: value.format as any,
      purpose: tokenRow?.purpose === 'cheer' ? 'cheer' : 'ec_recharge',
      microUsd: value.effectiveMicroUsd,
      source: verifiedGross > 0 ? 'network' : 'country_ecpm_mult',
      ecBp: creditBp,
      slot,
    });
  }
  // V1.2: only P1 revenue backs the EC it credits (G -> 3 % safety + 5 % boss pool + V 92 % in one batch);
  // a postback without the network's price credits EC % only (0 µUSD)
  const verified = verifiedGross > 0 && creditBp > 0;
  const h = splitAdGross(verified ? verifiedGross : 0);
  const ec =
    creditBp > 0
      ? await creditEcProgress(c.env, user.id, creditBp, `postback:monetag:${txId}`, verified ? { microUsd: h.netMicroUsd, source: 'ad_charge', country, haircut: h } : { microUsd: 0, source: 'ad_charge', country })
      : null;
  return c.json(
    {
      ok: true,
      note,
      valueSource: p1 ? 'network' : 'country_ecpm_mult',
      verified,
      effectiveMicroUsd: value.effectiveMicroUsd,
      netMicroUsd: verified ? h.netMicroUsd : 0,
      ecProgressPct: Math.round(creditBp / 100),
      energyTickets: ec?.energyTickets ?? null,
    },
    200
  );
});
