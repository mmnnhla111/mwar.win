import type { Context } from 'hono';
import {
  AD_SLOT_NETWORK,
  DEFAULT_AD_MULTIPLIERS,
  clampAdMultiplier,
  getAdEcProgressBp,
  getEffectiveAdMicroUsd,
  parseAdsterraBanner,
  parseMonetagInpage,
  sanitizeDirectUrl,
  getStatisticalAdMicroUsd,
  AD_SLOT_FORMAT,
  type AdNetworkConfig,
  type AdSlot,
  type PublicAdConfig,
} from '@mwar/shared';
import type { Env } from '../types';
import { edgeCachedValue, edgeCachePurge } from './edge-cache';
import { normalizeCountry } from './ad-value';

export const AD_CONFIG_CACHE_KEY = 'ad-network-config-v1';
const AD_CONFIG_TTL = 60;

const EMPTY: AdNetworkConfig = {
  adMode: 'test',
  adsterraEnabled: true,
  adsterraBanner300x250: '',
  adsterraBanner320x50: '',
  adsterraSmartlinkUrl: '',
  monetagEnabled: true,
  monetagInpageZoneId: '',
  monetagInpageScript: '',
  monetagDirectLinkUrl: '',
  multipliers: { ...DEFAULT_AD_MULTIPLIERS },
  updatedAt: 0,
  updatedBy: null,
};

function rowToConfig(r: any): AdNetworkConfig {
  if (!r) return { ...EMPTY, multipliers: { ...DEFAULT_AD_MULTIPLIERS } };
  return {
    adMode: r.ad_mode === 'live' ? 'live' : 'test',
    adsterraEnabled: !!r.adsterra_enabled,
    adsterraBanner300x250: r.adsterra_banner_300x250 || '',
    adsterraBanner320x50: r.adsterra_banner_320x50 || '',
    adsterraSmartlinkUrl: r.adsterra_smartlink_url || '',
    monetagEnabled: !!r.monetag_enabled,
    monetagInpageZoneId: r.monetag_inpage_zone_id || '',
    monetagInpageScript: r.monetag_inpage_script || '',
    monetagDirectLinkUrl: r.monetag_direct_link_url || '',
    multipliers: {
      adsterra_300x250: clampAdMultiplier(r.mult_adsterra_300x250_pct, DEFAULT_AD_MULTIPLIERS.adsterra_300x250),
      adsterra_320x50: clampAdMultiplier(r.mult_adsterra_320x50_pct, DEFAULT_AD_MULTIPLIERS.adsterra_320x50),
      monetag_inpage: clampAdMultiplier(r.mult_monetag_inpage_pct, DEFAULT_AD_MULTIPLIERS.monetag_inpage),
      monetag_direct: clampAdMultiplier(r.mult_monetag_direct_pct, DEFAULT_AD_MULTIPLIERS.monetag_direct),
      adsterra_smartlink: clampAdMultiplier(r.mult_adsterra_smartlink_pct, DEFAULT_AD_MULTIPLIERS.adsterra_smartlink),
    },
    updatedAt: Number(r.updated_at || 0),
    updatedBy: r.updated_by || null,
  };
}

/** Straight from D1 (admin screens, writes). */
export async function readAdConfig(env: Env): Promise<AdNetworkConfig> {
  try {
    const r = await env.DB.prepare("SELECT * FROM ad_network_configs WHERE id = 'default'").first<any>();
    return rowToConfig(r);
  } catch {
    return rowToConfig(null); // table missing before migration 0015: everything stays in test mode
  }
}

/** Edge-cached 60 s (hot paths: config, start, claim, impression, postback). */
export async function getAdConfig(c: Context<any>): Promise<AdNetworkConfig> {
  return edgeCachedValue(c, AD_CONFIG_CACHE_KEY, AD_CONFIG_TTL, () => readAdConfig(c.env));
}

export async function purgeAdConfig(c: Context<any>) {
  await edgeCachePurge(c, AD_CONFIG_CACHE_KEY);
  await edgeCachePurge(c, `${AD_CONFIG_CACHE_KEY}:public`);
}

export function toPublicAdConfig(cfg: AdNetworkConfig): PublicAdConfig {
  const live = cfg.adMode === 'live';
  const ast = live && cfg.adsterraEnabled;
  const mon = live && cfg.monetagEnabled;
  return {
    adMode: cfg.adMode,
    adsterraEnabled: cfg.adsterraEnabled,
    monetagEnabled: cfg.monetagEnabled,
    banner300x250: ast ? parseAdsterraBanner(cfg.adsterraBanner300x250, 300, 250) : null,
    banner320x50: ast ? parseAdsterraBanner(cfg.adsterraBanner320x50, 320, 50) : null,
    inpage: mon ? parseMonetagInpage(cfg.monetagInpageScript, cfg.monetagInpageZoneId) : null,
    directLink: !!pickDirectLink(cfg),
    multipliers: cfg.multipliers,
  };
}

/** Monetag Direct Link first, Adsterra Smartlink as fallback. Null in test mode / nothing configured. */
export function pickDirectLink(cfg: AdNetworkConfig): { slot: AdSlot; network: 'monetag' | 'adsterra'; url: string } | null {
  if (cfg.adMode !== 'live') return null;
  const monetag = cfg.monetagEnabled ? sanitizeDirectUrl(cfg.monetagDirectLinkUrl) : null;
  if (monetag) return { slot: 'monetag_direct', network: 'monetag', url: monetag };
  const smart = cfg.adsterraEnabled ? sanitizeDirectUrl(cfg.adsterraSmartlinkUrl) : null;
  if (smart) return { slot: 'adsterra_smartlink', network: 'adsterra', url: smart };
  return null;
}

export function cfCountryOf(c: Context<any>): string {
  // Country comes ONLY from Cloudflare; never from the client
  return normalizeCountry((c.req.raw as Request & { cf?: { country?: string } }).cf?.country || 'GLOBAL');
}

/** P2/P3 valuation of one view of a slot: statistical country eCPM × the slot's safety multiplier. */
export function valueSlot(cfg: AdNetworkConfig, country: string, slot: AdSlot, seconds?: number) {
  const pct = cfg.multipliers[slot];
  const effectiveMicroUsd = getEffectiveAdMicroUsd(country, slot, pct, { seconds });
  const ecBp = getAdEcProgressBp(country, effectiveMicroUsd);
  const format = seconds === 30 && (slot === 'monetag_direct' || slot === 'adsterra_smartlink') ? 'video_30s' : AD_SLOT_FORMAT[slot];
  return { network: AD_SLOT_NETWORK[slot], format, pct, effectiveMicroUsd, ecBp, ecProgressPct: Math.min(100, Math.round(ecBp / 100)) };
}

/** P1 valuation: the network's real `estimated_price` (USD per impression) → micro-USD. */
export function valueFromNetworkPrice(country: string, priceUsd: number) {
  const effectiveMicroUsd = Math.max(1, Math.round(priceUsd * 1_000_000));
  const ref = Math.max(1, getStatisticalAdMicroUsd(country, 'video_30s'));
  const ecBp = Math.max(0, Math.min(10_000, Math.round((effectiveMicroUsd / ref) * 10_000)));
  return { effectiveMicroUsd, ecBp, ecProgressPct: Math.min(100, Math.round(ecBp / 100)) };
}
