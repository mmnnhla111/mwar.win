/**
 * V1.2 Round C — "live economy" rules shared by the Worker, the game server, the web app and the tests
 * (spec §4.3, §5.6, §7.6):
 *   · Spectator gifting (TikTok-Live style): free Ammo Box (ad, EC only) + paid C gifts split 70 % / 30 %
 *   · Cold-start tools: smart bot fill (bot bounties drawn from the Boss Bounty Pool), Happy Hour 2x (the EXTRA
 *     comes from the Boss Bounty Pool, capped by it), launch promo codes (tickets backed by the marketing pool)
 *   · Streamer Showcase Rooms (Silver I+): 30–50 % (default 40 %) of the VERIFIED spectator ad value of the room
 *   · P2P skin marketplace: mission crates → cosmetic skins, listed in C (min 50 C), seller 90 % / fee 5–10 %
 * Zero-deficit rule: every µUSD paid comes from an existing balance in the same atomic D1 batch — these helpers
 * only compute the integer split; the Worker enforces the guards.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------------------------
// 1. Spectator gifts
// ---------------------------------------------------------------------------------------------------------------
export type GiftCode = 'ammo_box_ad' | 'golden_grenade_100' | 'champion_crown_500';
export const GIFT_CODES = ['ammo_box_ad', 'golden_grenade_100', 'champion_crown_500'] as const;
export const PAID_GIFT_CODES = ['golden_grenade_100', 'champion_crown_500'] as const;
export type PaidGiftCode = (typeof PAID_GIFT_CODES)[number];

export interface SpectatorGiftDef {
  code: GiftCode;
  emoji: string;
  /** µUSD debited from the sender's wallet (0 = free: paid by watching an ad). */
  priceMicroUsd: number;
  /** Shown over the receiver (crown) / as a full-room banner. */
  overheadCrown: boolean;
  roomBanner: boolean;
}

export const SPECTATOR_GIFTS: Record<GiftCode, SpectatorGiftDef> = {
  ammo_box_ad: { code: 'ammo_box_ad', emoji: '📦', priceMicroUsd: 0, overheadCrown: false, roomBanner: false },
  golden_grenade_100: { code: 'golden_grenade_100', emoji: '💣', priceMicroUsd: 10_000, overheadCrown: false, roomBanner: false },
  champion_crown_500: { code: 'champion_crown_500', emoji: '👑', priceMicroUsd: 50_000, overheadCrown: true, roomBanner: true },
};

/** Receiver share of a paid gift (the rest — 30 % + rounding — is platform revenue). */
export const GIFT_RECEIVER_PCT = 70;
/** How long the gift token the Worker signs for the game server stays valid. */
export const GIFT_TOKEN_TTL_SECONDS = 120;
/** How long a Champion Crown floats above the receiver. */
export const GIFT_CROWN_MS = 60_000;
/** A claimed direct-link visit can pay for one Ammo Box within this window. */
export const AMMO_BOX_AD_WINDOW_SECONDS = 15 * 60;

export interface GiftSplit {
  grossMicroUsd: number;
  receiverMicroUsd: number;
  platformMicroUsd: number;
}

/** 70 / 30 split of a paid gift: receiver = floor(G × 70 %), platform = G − receiver (exactly 100 %). */
export function splitGift(grossMicroUsd: number): GiftSplit {
  const g = Math.max(0, Math.floor(Number(grossMicroUsd) || 0));
  const receiver = Math.floor((g * GIFT_RECEIVER_PCT) / 100);
  return { grossMicroUsd: g, receiverMicroUsd: receiver, platformMicroUsd: g - receiver };
}

export const GIFT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const GiftSendSchema = z.object({
  giftCode: z.enum(PAID_GIFT_CODES),
  /** Colyseus room id the spectator is watching. */
  roomId: z.string().trim().min(1).max(64),
  receiverUserId: z.string().uuid(),
  /** Idempotency key chosen by the client (one gift per key per sender). */
  clientRequestId: z.string().regex(GIFT_REQUEST_ID_RE),
});
export const AmmoBoxGiftSchema = z.object({
  roomId: z.string().trim().min(1).max(64),
  receiverUserId: z.string().uuid().optional().nullable(),
  /** The claimed direct-link visit (dl_…) that pays for the box. */
  adToken: z.string().regex(/^dl_[a-f0-9-]{36}$/),
});

export interface GiftSendResult {
  success: true;
  giftId: string;
  giftCode: GiftCode;
  /** HMAC token for the game server (spectator_gift message); the server never trusts a bare claim. */
  giftToken: string;
  grossMicroUsd: number;
  receiverMicroUsd: number;
  platformMicroUsd: number;
  balanceMicroUsd: number;
  duplicate?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Cold-start tools (platform_settings keys)
// ---------------------------------------------------------------------------------------------------------------
export const COLD_START_BOT_FILL_KEY = 'cold_start_bot_fill_enabled';
export const COLD_START_TARGET_BOTS_KEY = 'cold_start_target_bots';
export const HAPPY_HOUR_ENABLED_KEY = 'happy_hour_enabled';
/** JSON { start: "HH:MM", end: "HH:MM", tzOffsetMinutes } (local time of the schedule). */
export const HAPPY_HOUR_SCHEDULE_KEY = 'happy_hour_schedule';
export const STREAMER_SHARE_PCT_KEY = 'streamer_ad_share_pct';
export const SKIN_MARKET_FEE_PCT_KEY = 'skin_market_fee_pct';

export const COLD_START_TARGET_BOTS_MIN = 6;
export const COLD_START_TARGET_BOTS_MAX = 12;
export const COLD_START_TARGET_BOTS_DEFAULT = 8;

/**
 * Bot bounty: a bot spawned by the cold-start fill may carry a small bounty drawn from the Boss Bounty Pool
 * (10 C – 50 C, whole C), only while the pool holds at least 1,000 C (so the Golden Boss stays funded) and never
 * more than the pool holds. 0 = the bot carries no bounty (pool too low) — it never pays anything then.
 */
export const BOT_BOUNTY_MIN_POOL_MICRO_USD = 100_000;
export const BOT_BOUNTY_MIN_MICRO_USD = 1_000;
export const BOT_BOUNTY_MAX_MICRO_USD = 5_000;
/** Reservations a single game room may hold at once (≥ the max bot count). */
export const BOT_BOUNTY_MAX_LIVE_PER_GAME = 12;
/** Bot bounty reservations a single game room may draw per rolling hour (farming cap). */
export const BOT_BOUNTY_MAX_PER_GAME_HOUR = 40;
export const BOT_BOUNTY_RESERVATION_TTL_SECONDS = 30 * 60;

export function drawBotBountyMicroUsd(poolMicroUsd: number, rand: () => number = Math.random): number {
  const pool = Math.max(0, Math.floor(Number(poolMicroUsd) || 0));
  if (pool < BOT_BOUNTY_MIN_POOL_MICRO_USD) return 0;
  const r = Math.min(0.999999, Math.max(0, Number(rand()) || 0));
  const steps = (BOT_BOUNTY_MAX_MICRO_USD - BOT_BOUNTY_MIN_MICRO_USD) / 100 + 1;
  return Math.min(pool, BOT_BOUNTY_MIN_MICRO_USD + Math.floor(r * steps) * 100);
}

export interface HappyHourSchedule {
  /** Minutes after local midnight (0–1439). */
  startMinute: number;
  endMinute: number;
  /** Offset of the schedule's local time from UTC in minutes (Asia/Bangkok = +420, no DST). */
  tzOffsetMinutes: number;
}
export const HAPPY_HOUR_DEFAULT_SCHEDULE: HappyHourSchedule = { startMinute: 20 * 60, endMinute: 21 * 60, tzOffsetMinutes: 420 };
export const HAPPY_HOUR_MULTIPLIER = 2;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const hhmmToMinute = (s: string): number | null => {
  const m = HHMM_RE.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const minuteToHhmm = (n: number): string => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

export function parseHappyHourSchedule(raw: unknown): HappyHourSchedule {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const s = hhmmToMinute((j as any)?.start);
    const e = hhmmToMinute((j as any)?.end);
    const tz = Number((j as any)?.tzOffsetMinutes);
    if (s === null || e === null || s === e) return { ...HAPPY_HOUR_DEFAULT_SCHEDULE };
    return { startMinute: s, endMinute: e, tzOffsetMinutes: Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? Math.trunc(tz) : 420 };
  } catch {
    return { ...HAPPY_HOUR_DEFAULT_SCHEDULE };
  }
}
export const serializeHappyHourSchedule = (s: HappyHourSchedule) =>
  JSON.stringify({ start: minuteToHhmm(s.startMinute), end: minuteToHhmm(s.endMinute), tzOffsetMinutes: s.tzOffsetMinutes });

/** Is `nowMs` inside the daily window (an end before the start wraps past midnight)? Also returns the window's end. */
export function happyHourWindow(nowMs: number, s: HappyHourSchedule): { active: boolean; endsAtMs: number | null; nextStartMs: number } {
  const local = nowMs + s.tzOffsetMinutes * 60_000;
  const dayStart = Math.floor(local / 86_400_000) * 86_400_000;
  const minute = Math.floor((local - dayStart) / 60_000);
  const toUtc = (localMs: number) => localMs - s.tzOffsetMinutes * 60_000;
  const wraps = s.endMinute < s.startMinute;
  const inside = wraps ? minute >= s.startMinute || minute < s.endMinute : minute >= s.startMinute && minute < s.endMinute;
  let endsAt: number | null = null;
  if (inside) {
    const endDay = wraps && minute >= s.startMinute ? dayStart + 86_400_000 : dayStart;
    endsAt = toUtc(endDay + s.endMinute * 60_000);
  }
  let nextStart = dayStart + s.startMinute * 60_000;
  if (nextStart <= local) nextStart += 86_400_000;
  return { active: inside, endsAtMs: endsAt, nextStartMs: toUtc(nextStart) };
}

/**
 * Happy Hour 2x: the EXTRA (= the earner's credited 55 % share once more) is paid from the Boss Bounty Pool —
 * all of it or nothing (falls back to 1x when the pool cannot cover it). The base payout never changes.
 */
export function happyHourExtraMicroUsd(earnerMicroUsd: number, bossPoolMicroUsd: number, active: boolean): number {
  if (!active) return 0;
  const want = Math.max(0, Math.floor(Number(earnerMicroUsd) || 0)) * (HAPPY_HOUR_MULTIPLIER - 1);
  return want > 0 && want <= Math.max(0, Math.floor(Number(bossPoolMicroUsd) || 0)) ? want : 0;
}

/** GET /api/game/live-config — what the game server and the lobby show (public). */
export interface LiveConfigResponse {
  botFill: { enabled: boolean; targetBots: number };
  happyHour: { enabled: boolean; active: boolean; start: string; end: string; tzOffsetMinutes: number; endsAt: number | null; nextStartAt: number; multiplier: number };
  streamerSharePct: number;
  skinMarketFeePct: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Launch promo codes
// ---------------------------------------------------------------------------------------------------------------
export const PROMO_MAX_REDEMPTIONS = 500;
/** Default backing of the 1 EC ticket a redemption mints: 100 C (10,000 µUSD). */
export const PROMO_DEFAULT_BACKED_MICRO_USD = 10_000;
export const PROMO_MAX_BACKED_MICRO_USD = 100_000;
export const PROMO_CODE_RE = /^[A-Z0-9]{4,20}$/;

export const PromoCodeCreateSchema = z.object({
  code: z.string().trim().toUpperCase().regex(PROMO_CODE_RE, 'Code: 4–20 of A-Z / 0-9'),
  backedMicroUsdPerTicket: z.number().int().min(0).max(PROMO_MAX_BACKED_MICRO_USD).default(PROMO_DEFAULT_BACKED_MICRO_USD),
  maxRedemptions: z.number().int().min(1).max(PROMO_MAX_REDEMPTIONS).default(PROMO_MAX_REDEMPTIONS),
  expiresAt: z.number().int().positive().optional().nullable(),
  /** Optional marketing-pool deposit made in the same atomic batch (µUSD of real company money). */
  depositMicroUsd: z.number().int().min(0).max(1_000_000_000).default(0),
});
export const PromoRedeemSchema = z.object({
  code: z.string().trim().toUpperCase().regex(PROMO_CODE_RE),
  deviceFp: z.string().trim().regex(/^[a-f0-9]{32,64}$/),
});
export const MarketingDepositSchema = z.object({
  amountMicroUsd: z.number().int().min(1).max(1_000_000_000),
  note: z.string().trim().max(120).optional().nullable(),
});

export type PromoRefusal = 'inactive' | 'expired' | 'cap' | 'user' | 'device' | 'pool_empty' | 'ec_full';

/** Pure decision used by the tests (the Worker enforces the same rules atomically in D1). */
export function promoRedemptionDecision(s: {
  isActive: boolean;
  expiresAt: number | null;
  nowSec: number;
  redeemedCount: number;
  maxRedemptions: number;
  userAlreadyRedeemed: boolean;
  deviceAlreadyRedeemed: boolean;
  marketingPoolMicroUsd: number;
  backedMicroUsd: number;
  ticketsFull?: boolean;
}): { ok: true } | { ok: false; reason: PromoRefusal } {
  if (!s.isActive) return { ok: false, reason: 'inactive' };
  if (s.expiresAt !== null && s.expiresAt <= s.nowSec) return { ok: false, reason: 'expired' };
  if (s.redeemedCount >= Math.min(s.maxRedemptions, PROMO_MAX_REDEMPTIONS)) return { ok: false, reason: 'cap' };
  if (s.userAlreadyRedeemed) return { ok: false, reason: 'user' };
  if (s.deviceAlreadyRedeemed) return { ok: false, reason: 'device' };
  if (s.ticketsFull) return { ok: false, reason: 'ec_full' };
  if (s.marketingPoolMicroUsd < s.backedMicroUsd) return { ok: false, reason: 'pool_empty' };
  return { ok: true };
}

export interface PromoCodeRow {
  code: string;
  backedMicroUsdPerTicket: number;
  maxRedemptions: number;
  redeemedCount: number;
  expiresAt: number | null;
  isActive: boolean;
  createdBy: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Streamer Showcase Rooms
// ---------------------------------------------------------------------------------------------------------------
/** Lowest rank that may open a Streamer Room (packages/shared ranks: Silver I = 25 downlines). */
export const STREAMER_MIN_RANK_ID = 'silver_1';
export const STREAMER_SHARE_PCT_DEFAULT = 40;
export const STREAMER_SHARE_PCT_MIN = 30;
export const STREAMER_SHARE_PCT_MAX = 50;
/** "Unlimited" spectators = the registry's hard cap. */
export const STREAMER_ROOM_MAX_SPECTATORS = 500;
export const STREAMER_ROOM_MAX_PLAYERS = 30;
/** A streamer room closes itself after this long (the streamer can reopen it). */
export const STREAMER_ROOM_TTL_SECONDS = 12 * 3600;
export const STREAMER_ROOM_CODE_RE = /^LIVE-[A-Z0-9]{6}$/;

/** Streamer share of a VERIFIED net ad value V attributed to the room: floor(V × pct); the rest stays with the viewer's split. */
export function splitStreamerShare(netMicroUsd: number, pct: number): { streamerMicroUsd: number; restMicroUsd: number } {
  const v = Math.max(0, Math.floor(Number(netMicroUsd) || 0));
  const p = Math.min(STREAMER_SHARE_PCT_MAX, Math.max(STREAMER_SHARE_PCT_MIN, Math.floor(Number(pct) || STREAMER_SHARE_PCT_DEFAULT)));
  const s = Math.floor((v * p) / 100);
  return { streamerMicroUsd: s, restMicroUsd: v - s };
}

export const StreamerRoomOpenSchema = z.object({
  title: z.string().trim().min(2).max(60),
  mode: z.enum(['skirmish', 'fast_mini']).default('skirmish'),
});

export interface StreamerStatus {
  eligible: boolean;
  rankId: string;
  minRankId: string;
  room: { roomCode: string; title: string; mode: string; createdAt: number; expiresAt: number } | null;
  sharePct: number;
}

// ---------------------------------------------------------------------------------------------------------------
// 5. Skins (cosmetic) + P2P marketplace
// ---------------------------------------------------------------------------------------------------------------
export type SkinRarity = 'common' | 'rare' | 'epic' | 'legendary';
export const SKIN_RARITIES = ['common', 'rare', 'epic', 'legendary'] as const;
export type SkinKind = 'weapon_finish' | 'outfit';

export interface SkinDef {
  slug: string;
  kind: SkinKind;
  rarity: SkinRarity;
  /** Hex tint applied in the arena (cosmetic data only). */
  tint: string;
  /** 0..1 metalness / emissive strength hint for the finish. */
  sheen: number;
}

export const SKIN_CATALOG: readonly SkinDef[] = [
  { slug: 'finish_desert_sand', kind: 'weapon_finish', rarity: 'common', tint: '#c8a96a', sheen: 0.1 },
  { slug: 'finish_urban_grey', kind: 'weapon_finish', rarity: 'common', tint: '#8a8f98', sheen: 0.1 },
  { slug: 'finish_jungle_green', kind: 'weapon_finish', rarity: 'common', tint: '#4f7a3a', sheen: 0.1 },
  { slug: 'finish_arctic_white', kind: 'weapon_finish', rarity: 'rare', tint: '#e8f1f8', sheen: 0.25 },
  { slug: 'finish_cobalt_blue', kind: 'weapon_finish', rarity: 'rare', tint: '#2f6fe0', sheen: 0.3 },
  { slug: 'finish_crimson_tiger', kind: 'weapon_finish', rarity: 'epic', tint: '#d02a36', sheen: 0.45 },
  { slug: 'finish_neon_viper', kind: 'weapon_finish', rarity: 'epic', tint: '#39ff88', sheen: 0.6 },
  { slug: 'finish_royal_gold', kind: 'weapon_finish', rarity: 'legendary', tint: '#ffcc33', sheen: 0.9 },
  { slug: 'outfit_field_khaki', kind: 'outfit', rarity: 'common', tint: '#a58d5f', sheen: 0 },
  { slug: 'outfit_night_ops', kind: 'outfit', rarity: 'common', tint: '#30343c', sheen: 0 },
  { slug: 'outfit_ocean_camo', kind: 'outfit', rarity: 'rare', tint: '#3b8fb5', sheen: 0.1 },
  { slug: 'outfit_sakura', kind: 'outfit', rarity: 'rare', tint: '#f3a6c8', sheen: 0.1 },
  { slug: 'outfit_lava_core', kind: 'outfit', rarity: 'epic', tint: '#ff5a1f', sheen: 0.35 },
  { slug: 'outfit_phantom_violet', kind: 'outfit', rarity: 'epic', tint: '#8b5cf6', sheen: 0.35 },
  { slug: 'outfit_golden_emperor', kind: 'outfit', rarity: 'legendary', tint: '#f5c542', sheen: 0.7 },
];
export const SKIN_BY_SLUG: Record<string, SkinDef> = Object.fromEntries(SKIN_CATALOG.map((s) => [s.slug, s]));

/** Mission drop: each claimed daily quest gives 1 Skin Blueprint Fragment; 3 fragments open 1 Loot Crate. */
export const SKIN_FRAGMENTS_PER_QUEST = 1;
export const SKIN_FRAGMENTS_PER_CRATE = 3;
/** Crate odds in % (sum 100). */
export const SKIN_RARITY_WEIGHTS: Record<SkinRarity, number> = { common: 62, rare: 27, epic: 9, legendary: 2 };

export function rollSkinRarity(r: number): SkinRarity {
  let x = Math.min(0.999999, Math.max(0, Number(r) || 0)) * 100;
  for (const k of SKIN_RARITIES) {
    x -= SKIN_RARITY_WEIGHTS[k];
    if (x < 0) return k;
  }
  return 'common';
}
export function rollSkin(rRarity: number, rPick: number): SkinDef {
  const rarity = rollSkinRarity(rRarity);
  const list = SKIN_CATALOG.filter((s) => s.rarity === rarity);
  return list[Math.min(list.length - 1, Math.floor(Math.min(0.999999, Math.max(0, rPick)) * list.length))];
}

/** Listing floor: 50 C. */
export const SKIN_MIN_PRICE_MICRO_USD = 5_000;
export const SKIN_MAX_PRICE_MICRO_USD = 100_000_000;
export const SKIN_MARKET_FEE_PCT_DEFAULT = 10;
export const SKIN_MARKET_FEE_PCT_MIN = 5;
export const SKIN_MARKET_FEE_PCT_MAX = 10;

export function clampSkinFeePct(pct: unknown): number {
  const n = Math.floor(Number(pct));
  if (!Number.isFinite(n)) return SKIN_MARKET_FEE_PCT_DEFAULT;
  return Math.min(SKIN_MARKET_FEE_PCT_MAX, Math.max(SKIN_MARKET_FEE_PCT_MIN, n));
}

/** Sale split: platform fee = floor(P × fee %), seller = P − fee (exactly 100 %; 90 / 10 by default). */
export function splitSkinSale(priceMicroUsd: number, feePct: number = SKIN_MARKET_FEE_PCT_DEFAULT): { priceMicroUsd: number; sellerMicroUsd: number; feeMicroUsd: number } {
  const p = Math.max(0, Math.floor(Number(priceMicroUsd) || 0));
  const fee = Math.floor((p * clampSkinFeePct(feePct)) / 100);
  return { priceMicroUsd: p, sellerMicroUsd: p - fee, feeMicroUsd: fee };
}

export const SkinListSchema = z.object({
  skinId: z.string().regex(/^skn_[a-f0-9-]{36}$/),
  priceMicroUsd: z.number().int().min(SKIN_MIN_PRICE_MICRO_USD).max(SKIN_MAX_PRICE_MICRO_USD),
});
export const SkinEquipSchema = z.object({
  skinId: z.string().regex(/^skn_[a-f0-9-]{36}$/).nullable(),
  kind: z.enum(['weapon_finish', 'outfit']),
});

export interface UserSkinItem {
  id: string;
  slug: string;
  kind: SkinKind;
  rarity: SkinRarity;
  tint: string;
  isTradeable: boolean;
  isListed: boolean;
  listingId: string | null;
  equipped: boolean;
  acquiredFrom: string;
  createdAt: number;
}
export interface SkinInventoryResponse {
  items: UserSkinItem[];
  fragments: number;
  fragmentsPerCrate: number;
  equipped: { weapon_finish: string | null; outfit: string | null };
  feePct: number;
}
export interface SkinListingItem {
  id: string;
  skinId: string;
  slug: string;
  kind: SkinKind;
  rarity: SkinRarity;
  tint: string;
  sellerId: string;
  sellerUsername: string;
  priceMicroUsd: number;
  createdAt: number;
}

/** Admin "Game & Rooms → Cold start" settings payload. */
export const ColdStartSettingsSchema = z.object({
  botFillEnabled: z.boolean().optional(),
  targetBots: z.number().int().min(COLD_START_TARGET_BOTS_MIN).max(COLD_START_TARGET_BOTS_MAX).optional(),
  happyHourEnabled: z.boolean().optional(),
  happyHourStart: z.string().regex(HHMM_RE).optional(),
  happyHourEnd: z.string().regex(HHMM_RE).optional(),
  happyHourTzOffsetMinutes: z.number().int().min(-720).max(840).optional(),
  streamerSharePct: z.number().int().min(STREAMER_SHARE_PCT_MIN).max(STREAMER_SHARE_PCT_MAX).optional(),
  skinMarketFeePct: z.number().int().min(SKIN_MARKET_FEE_PCT_MIN).max(SKIN_MARKET_FEE_PCT_MAX).optional(),
});
export type ColdStartSettingsUpdate = z.infer<typeof ColdStartSettingsSchema>;

export interface ColdStartAdminStatus {
  settings: LiveConfigResponse;
  pools: { bossBountyPoolMicroUsd: number; marketingPoolMicroUsd: number; botReservedMicroUsd: number; botReservedCount: number };
  promoCodes: PromoCodeRow[];
}
