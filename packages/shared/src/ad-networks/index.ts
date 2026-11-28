import { z } from 'zod';
import { getStatisticalAdMicroUsd, type AdFormat } from '../constants/adEcpm';

/**
 * Real ad networks (Adsterra + Monetag): the slot → format mapping and the anti-loss "safety
 * multipliers" an admin calibrates. A slot's value per view is the statistical country eCPM for its
 * mapped format × the slot's multiplier (10–150 %). EC progress = that value ÷ a 30 s rewarded video
 * in the same country (a 30 s video's value = 1 full EC), capped at 100 %.
 *
 * Ads credit non-withdrawable EC only. Withdrawable USD still comes only from game rooms (55/15/5/5/20).
 */
export const AD_NETWORKS = ['adsterra', 'monetag'] as const;
export type AdNetwork = (typeof AD_NETWORKS)[number];

export const AD_MODES = ['test', 'live'] as const;
export type AdMode = (typeof AD_MODES)[number];

export const AD_SLOTS = ['adsterra_300x250', 'adsterra_320x50', 'monetag_inpage', 'monetag_direct', 'adsterra_smartlink'] as const;
export type AdSlot = (typeof AD_SLOTS)[number];

/** Which statistical eCPM format each real slot is valued against. */
export const AD_SLOT_FORMAT: Record<AdSlot, AdFormat> = {
  adsterra_300x250: 'banner',
  adsterra_320x50: 'banner',
  monetag_inpage: 'video_5s',
  monetag_direct: 'video_15s',
  adsterra_smartlink: 'video_15s',
};

export const AD_SLOT_NETWORK: Record<AdSlot, AdNetwork> = {
  adsterra_300x250: 'adsterra',
  adsterra_320x50: 'adsterra',
  monetag_inpage: 'monetag',
  monetag_direct: 'monetag',
  adsterra_smartlink: 'adsterra',
};

export const AD_MULT_MIN_PCT = 10;
export const AD_MULT_MAX_PCT = 150;

export const DEFAULT_AD_MULTIPLIERS: Record<AdSlot, number> = {
  // V1.2 conservative launch values (audit H3): banners 60 %, direct links 35 % of the statistical eCPM,
  // raised later from the networks' real reports (P1 / P2)
  adsterra_300x250: 60,
  adsterra_320x50: 60,
  monetag_inpage: 50,
  monetag_direct: 35,
  adsterra_smartlink: 35,
};

/** Direct-link visits: how long the ad tab must stay open (seconds) before the claim is accepted. */
export const DIRECT_LINK_SECONDS = [15, 30] as const;
export type DirectLinkSeconds = (typeof DIRECT_LINK_SECONDS)[number];
/** Seconds between two direct-link visits of one user. */
export const DIRECT_LINK_COOLDOWN_SECONDS = 45;
/** A started visit can be claimed for this long, then it expires. */
export const DIRECT_LINK_TOKEN_TTL_SECONDS = 30 * 60;

/** Countries shown in the admin calibration preview. */
export const AD_PREVIEW_COUNTRIES = ['US', 'TH', 'VN', 'ID', 'MM', 'GLOBAL'] as const;

export function clampAdMultiplier(v: unknown, fallback = 100): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(AD_MULT_MAX_PCT, Math.max(AD_MULT_MIN_PCT, n));
}

/**
 * Value of one view of a slot (micro-USD). A direct-link visit held for 30 s is valued as a 30 s video
 * (still scaled by the slot's multiplier); otherwise the slot's mapped format is used.
 */
export function getEffectiveAdMicroUsd(country: string, slot: AdSlot, pct: number, opts: { seconds?: number } = {}): number {
  const format: AdFormat = opts.seconds === 30 && (slot === 'monetag_direct' || slot === 'adsterra_smartlink') ? 'video_30s' : AD_SLOT_FORMAT[slot];
  return Math.floor((getStatisticalAdMicroUsd(country, format) * clampAdMultiplier(pct)) / 100);
}

/** EC progress in basis points (10 000 = +1 EC) for a value, against a 30 s video in the same country. */
export function getAdEcProgressBp(country: string, effectiveMicroUsd: number): number {
  const ref = Math.max(1, getStatisticalAdMicroUsd(country, 'video_30s'));
  return Math.max(0, Math.min(10_000, Math.round((effectiveMicroUsd / ref) * 10_000)));
}

/** Rounded whole-percent EC progress (what the spec logs / the admin preview shows). */
export function getAdEcProgressPct(country: string, effectiveMicroUsd: number): number {
  const ref = Math.max(1, getStatisticalAdMicroUsd(country, 'video_30s'));
  return Math.min(100, Math.round((effectiveMicroUsd / ref) * 100));
}

/** Public, sanitized ad config (GET /api/ads/config). Never contains raw script HTML. */
export interface AdBannerSpec {
  key: string;
  src: string;
  width: number;
  height: number;
}
export interface PublicAdConfig {
  adMode: AdMode;
  adsterraEnabled: boolean;
  monetagEnabled: boolean;
  banner300x250: AdBannerSpec | null;
  banner320x50: AdBannerSpec | null;
  inpage: { zoneId: string; src: string } | null;
  /** A direct link (Monetag first, Adsterra Smartlink fallback) is configured. */
  directLink: boolean;
  multipliers: Record<AdSlot, number>;
}

/** Full config for super_admin (GET/PUT /api/admin/ads/config). */
export interface AdNetworkConfig {
  adMode: AdMode;
  adsterraEnabled: boolean;
  adsterraBanner300x250: string;
  adsterraBanner320x50: string;
  adsterraSmartlinkUrl: string;
  monetagEnabled: boolean;
  monetagInpageZoneId: string;
  monetagInpageScript: string;
  monetagDirectLinkUrl: string;
  multipliers: Record<AdSlot, number>;
  updatedAt: number;
  updatedBy: string | null;
}

const multSchema = z.coerce.number().int().min(AD_MULT_MIN_PCT).max(AD_MULT_MAX_PCT);
const text = (max: number) => z.string().trim().max(max);

export const AdNetworkConfigUpdateSchema = z
  .object({
    adMode: z.enum(AD_MODES),
    adsterraEnabled: z.boolean(),
    adsterraBanner300x250: text(2000),
    adsterraBanner320x50: text(2000),
    adsterraSmartlinkUrl: text(500),
    monetagEnabled: z.boolean(),
    monetagInpageZoneId: z.string().trim().regex(/^\d{0,12}$/, 'Zone ID must be digits'),
    monetagInpageScript: text(2000),
    monetagDirectLinkUrl: text(500),
    multipliers: z.object({
      adsterra_300x250: multSchema,
      adsterra_320x50: multSchema,
      monetag_inpage: multSchema,
      monetag_direct: multSchema,
      adsterra_smartlink: multSchema,
    }),
  })
  .partial();
export type AdNetworkConfigUpdate = z.infer<typeof AdNetworkConfigUpdateSchema>;

export const DirectLinkStartSchema = z
  .object({
    purpose: z.enum(['ec_recharge', 'cheer']),
    seconds: z.coerce.number().refine((v) => v === 15 || v === 30, 'seconds must be 15 or 30'),
    targetType: z.enum(['post', 'profile', 'energy']).optional(),
    targetId: z.string().trim().min(1).max(64).optional().nullable(),
  })
  .refine((v) => v.purpose !== 'cheer' || (v.targetType && (v.targetType === 'energy' || !!v.targetId)), { message: 'targetId is required', path: ['targetId'] });

export const DirectLinkClaimSchema = z.object({ token: z.string().regex(/^dl_[a-f0-9-]{36}$/) });

export interface DirectLinkStart {
  token: string;
  launchUrl: string;
  requiredSeconds: number;
  network: AdNetwork;
  adMode: AdMode;
}

export interface AdStatsRow {
  impressions: number;
  estMicroUsd: number;
  ecBp: number;
}
/**
 * V1.2 (audit H3): estimated ad value the system credited (P2/P3 valuations of real network slots) vs the
 * revenue the networks themselves reported (P1 postbacks with estimated_price), last 7 days.
 * `alert` is true when the estimate is above the verified revenue.
 */
export interface AdRevenueCheck {
  estimatedMicroUsd: number;
  verifiedMicroUsd: number;
  estimatedImpressions: number;
  verifiedImpressions: number;
  alert: boolean;
}
/** /admin → Ad Networks → economy card (super_admin): system pools + the boss-fee toggle. */
export interface EconomyStatus {
  redirectPlatformFeeToBoss: boolean;
  bossBountyPoolMicroUsd: number;
  /** Golden Boss draws currently reserved (status 'reserved'), not in the pool any more. */
  bossReservedMicroUsd: number;
  bossReservedCount: number;
  safetyReserveMicroUsd: number;
  platformMicroUsd: number;
  energyPoolUnspentMicroUsd: number;
  settingUpdatedAt: number | null;
  settingUpdatedBy: string | null;
}
export interface AdStats {
  today: AdStatsRow;
  last7: AdStatsRow;
  revenueCheck?: AdRevenueCheck;
  topCountries: (AdStatsRow & { country: string })[];
  byNetwork: (AdStatsRow & { network: string })[];
  bySlot: (AdStatsRow & { slot: string })[];
}

// ---- Sanitizers: turn stored snippets into the few safe fields a page may use -------------------

function safeHttpsUrl(v: string | null | undefined): string | null {
  const s = String(v || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Adsterra iframe banner: from the full snippet (atOptions + script) or "key" alone + a default src. */
export function parseAdsterraBanner(snippet: string | null | undefined, width: number, height: number): AdBannerSpec | null {
  const s = String(snippet || '');
  const key = s.match(/['"]key['"]\s*:\s*['"]([a-f0-9]{32})['"]/i)?.[1] || s.match(/\b([a-f0-9]{32})\b/i)?.[1];
  if (!key) return null;
  const srcRaw = s.match(/src\s*=\s*["'](https:\/\/[^"']+)["']/i)?.[1];
  const src = safeHttpsUrl(srcRaw);
  if (!src || !src.includes(key)) return null;
  return { key: key.toLowerCase(), src, width, height };
}

/** Monetag In-Page Push: zone id + tag script URL out of the stored snippet (zone id column wins). */
export function parseMonetagInpage(script: string | null | undefined, zoneId: string | null | undefined): { zoneId: string; src: string } | null {
  const s = String(script || '');
  const zone = String(zoneId || '').trim() || s.match(/zone\s*=\s*['"](\d+)['"]/i)?.[1] || '';
  const src = safeHttpsUrl(s.match(/src\s*=\s*['"](https:\/\/[^'"]+)['"]/i)?.[1]);
  if (!/^\d{3,12}$/.test(zone) || !src) return null;
  return { zoneId: zone, src };
}

export function sanitizeDirectUrl(v: string | null | undefined): string | null {
  return safeHttpsUrl(v);
}
