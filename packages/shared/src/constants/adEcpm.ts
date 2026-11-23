/**
 * Programmatic & Rewarded Mobile/Web Ad eCPM & Micro-USD Rates by Country
 * Specification: docs/AD_ECPM_BY_COUNTRY.md
 * Standard: 1 USD = 1,000,000 micro_usd = 10,000 MWAR coins (1 coin = 100 micro_usd)
 */

export type AdFormat = 'banner' | 'video_5s' | 'video_15s' | 'video_30s';

export interface AdEcpmEntry {
  country: string;
  code: string;
  tier: 1 | 2 | 3 | 0; // 1 = Tier 1, 2 = Tier 2, 3 = Tier 3, 0 = Global fallback
  bannerEcpmUsd: number;
  video5sEcpmUsd: number;
  video15sEcpmUsd: number;
  video30sEcpmUsd: number;
  bannerMicroUsd: number;
  video5sMicroUsd: number;
  video15sMicroUsd: number;
  video30sMicroUsd: number;
}

/**
 * Standardized statistical eCPM ($ per 1,000 impressions) and micro_usd (per single view)
 * lookup matrix across Tier 1, Tier 2, Tier 3, and Global fallback.
 */
export const COUNTRY_AD_ECPM_USD: Record<string, AdEcpmEntry> = {
  // --- Tier 1 High-Value Markets ---
  US: {
    country: 'United States',
    code: 'US',
    tier: 1,
    bannerEcpmUsd: 1.5,
    video5sEcpmUsd: 6.5,
    video15sEcpmUsd: 18.0,
    video30sEcpmUsd: 32.0,
    bannerMicroUsd: 1_500,
    video5sMicroUsd: 6_500,
    video15sMicroUsd: 18_000,
    video30sMicroUsd: 32_000,
  },
  AU: {
    country: 'Australia',
    code: 'AU',
    tier: 1,
    bannerEcpmUsd: 1.3,
    video5sEcpmUsd: 5.5,
    video15sEcpmUsd: 15.0,
    video30sEcpmUsd: 27.0,
    bannerMicroUsd: 1_300,
    video5sMicroUsd: 5_500,
    video15sMicroUsd: 15_000,
    video30sMicroUsd: 27_000,
  },
  GB: {
    country: 'United Kingdom',
    code: 'GB',
    tier: 1,
    bannerEcpmUsd: 1.2,
    video5sEcpmUsd: 5.2,
    video15sEcpmUsd: 14.5,
    video30sEcpmUsd: 26.0,
    bannerMicroUsd: 1_200,
    video5sMicroUsd: 5_200,
    video15sMicroUsd: 14_500,
    video30sMicroUsd: 26_000,
  },
  CA: {
    country: 'Canada',
    code: 'CA',
    tier: 1,
    bannerEcpmUsd: 1.15,
    video5sEcpmUsd: 5.0,
    video15sEcpmUsd: 14.0,
    video30sEcpmUsd: 25.0,
    bannerMicroUsd: 1_150,
    video5sMicroUsd: 5_000,
    video15sMicroUsd: 14_000,
    video30sMicroUsd: 25_000,
  },
  JP: {
    country: 'Japan',
    code: 'JP',
    tier: 1,
    bannerEcpmUsd: 1.1,
    video5sEcpmUsd: 4.8,
    video15sEcpmUsd: 13.5,
    video30sEcpmUsd: 24.0,
    bannerMicroUsd: 1_100,
    video5sMicroUsd: 4_800,
    video15sMicroUsd: 13_500,
    video30sMicroUsd: 24_000,
  },
  DE: {
    country: 'Germany',
    code: 'DE',
    tier: 1,
    bannerEcpmUsd: 1.0,
    video5sEcpmUsd: 4.5,
    video15sEcpmUsd: 13.0,
    video30sEcpmUsd: 23.0,
    bannerMicroUsd: 1_000,
    video5sMicroUsd: 4_500,
    video15sMicroUsd: 13_000,
    video30sMicroUsd: 23_000,
  },
  SG: {
    country: 'Singapore',
    code: 'SG',
    tier: 1,
    bannerEcpmUsd: 1.05,
    video5sEcpmUsd: 4.6,
    video15sEcpmUsd: 13.0,
    video30sEcpmUsd: 22.5,
    bannerMicroUsd: 1_050,
    video5sMicroUsd: 4_600,
    video15sMicroUsd: 13_000,
    video30sMicroUsd: 22_500,
  },
  KR: {
    country: 'South Korea',
    code: 'KR',
    tier: 1,
    bannerEcpmUsd: 0.95,
    video5sEcpmUsd: 4.2,
    video15sEcpmUsd: 12.0,
    video30sEcpmUsd: 21.0,
    bannerMicroUsd: 950,
    video5sMicroUsd: 4_200,
    video15sMicroUsd: 12_000,
    video30sMicroUsd: 21_000,
  },

  // --- Tier 2 Emerging & Mid-Value Markets ---
  AE: {
    country: 'United Arab Emirates',
    code: 'AE',
    tier: 2,
    bannerEcpmUsd: 0.7,
    video5sEcpmUsd: 3.0,
    video15sEcpmUsd: 8.5,
    video30sEcpmUsd: 15.0,
    bannerMicroUsd: 700,
    video5sMicroUsd: 3_000,
    video15sMicroUsd: 8_500,
    video30sMicroUsd: 15_000,
  },
  TW: {
    country: 'Taiwan',
    code: 'TW',
    tier: 2,
    bannerEcpmUsd: 0.65,
    video5sEcpmUsd: 2.8,
    video15sEcpmUsd: 8.0,
    video30sEcpmUsd: 14.0,
    bannerMicroUsd: 650,
    video5sMicroUsd: 2_800,
    video15sMicroUsd: 8_000,
    video30sMicroUsd: 14_000,
  },
  SA: {
    country: 'Saudi Arabia',
    code: 'SA',
    tier: 2,
    bannerEcpmUsd: 0.6,
    video5sEcpmUsd: 2.6,
    video15sEcpmUsd: 7.5,
    video30sEcpmUsd: 13.5,
    bannerMicroUsd: 600,
    video5sMicroUsd: 2_600,
    video15sMicroUsd: 7_500,
    video30sMicroUsd: 13_500,
  },
  MY: {
    country: 'Malaysia',
    code: 'MY',
    tier: 2,
    bannerEcpmUsd: 0.4,
    video5sEcpmUsd: 1.8,
    video15sEcpmUsd: 5.0,
    video30sEcpmUsd: 9.5,
    bannerMicroUsd: 400,
    video5sMicroUsd: 1_800,
    video15sMicroUsd: 5_000,
    video30sMicroUsd: 9_500,
  },
  TH: {
    country: 'Thailand',
    code: 'TH',
    tier: 2,
    bannerEcpmUsd: 0.35,
    video5sEcpmUsd: 1.6,
    video15sEcpmUsd: 4.5,
    video30sEcpmUsd: 8.5,
    bannerMicroUsd: 350,
    video5sMicroUsd: 1_600,
    video15sMicroUsd: 4_500,
    video30sMicroUsd: 8_500,
  },
  MX: {
    country: 'Mexico',
    code: 'MX',
    tier: 2,
    bannerEcpmUsd: 0.32,
    video5sEcpmUsd: 1.4,
    video15sEcpmUsd: 4.0,
    video30sEcpmUsd: 7.5,
    bannerMicroUsd: 320,
    video5sMicroUsd: 1_400,
    video15sMicroUsd: 4_000,
    video30sMicroUsd: 7_500,
  },
  BR: {
    country: 'Brazil',
    code: 'BR',
    tier: 2,
    bannerEcpmUsd: 0.3,
    video5sEcpmUsd: 1.3,
    video15sEcpmUsd: 3.8,
    video30sEcpmUsd: 7.0,
    bannerMicroUsd: 300,
    video5sMicroUsd: 1_300,
    video15sMicroUsd: 3_800,
    video30sMicroUsd: 7_000,
  },
  RU: {
    country: 'Russia',
    code: 'RU',
    tier: 2,
    bannerEcpmUsd: 0.25,
    video5sEcpmUsd: 1.1,
    video15sEcpmUsd: 3.2,
    video30sEcpmUsd: 6.0,
    bannerMicroUsd: 250,
    video5sMicroUsd: 1_100,
    video15sMicroUsd: 3_200,
    video30sMicroUsd: 6_000,
  },
  TR: {
    country: 'Turkey',
    code: 'TR',
    tier: 2,
    bannerEcpmUsd: 0.22,
    video5sEcpmUsd: 1.0,
    video15sEcpmUsd: 2.9,
    video30sEcpmUsd: 5.5,
    bannerMicroUsd: 220,
    video5sMicroUsd: 1_000,
    video15sMicroUsd: 2_900,
    video30sMicroUsd: 5_500,
  },

  // --- Tier 3 Southeast & South Asia / Developing Markets ---
  VN: {
    country: 'Vietnam',
    code: 'VN',
    tier: 3,
    bannerEcpmUsd: 0.18,
    video5sEcpmUsd: 0.8,
    video15sEcpmUsd: 2.2,
    video30sEcpmUsd: 4.2,
    bannerMicroUsd: 180,
    video5sMicroUsd: 800,
    video15sMicroUsd: 2_200,
    video30sMicroUsd: 4_200,
  },
  PH: {
    country: 'Philippines',
    code: 'PH',
    tier: 3,
    bannerEcpmUsd: 0.18,
    video5sEcpmUsd: 0.75,
    video15sEcpmUsd: 2.1,
    video30sEcpmUsd: 4.0,
    bannerMicroUsd: 180,
    video5sMicroUsd: 750,
    video15sMicroUsd: 2_100,
    video30sMicroUsd: 4_000,
  },
  ID: {
    country: 'Indonesia',
    code: 'ID',
    tier: 3,
    bannerEcpmUsd: 0.16,
    video5sEcpmUsd: 0.7,
    video15sEcpmUsd: 2.0,
    video30sEcpmUsd: 3.8,
    bannerMicroUsd: 160,
    video5sMicroUsd: 700,
    video15sMicroUsd: 2_000,
    video30sMicroUsd: 3_800,
  },
  KH: {
    country: 'Cambodia',
    code: 'KH',
    tier: 3,
    bannerEcpmUsd: 0.12,
    video5sEcpmUsd: 0.55,
    video15sEcpmUsd: 1.5,
    video30sEcpmUsd: 2.8,
    bannerMicroUsd: 120,
    video5sMicroUsd: 550,
    video15sMicroUsd: 1_500,
    video30sMicroUsd: 2_800,
  },
  IN: {
    country: 'India',
    code: 'IN',
    tier: 3,
    bannerEcpmUsd: 0.12,
    video5sEcpmUsd: 0.5,
    video15sEcpmUsd: 1.4,
    video30sEcpmUsd: 2.8,
    bannerMicroUsd: 120,
    video5sMicroUsd: 500,
    video15sMicroUsd: 1_400,
    video30sMicroUsd: 2_800,
  },
  MM: {
    country: 'Myanmar',
    code: 'MM',
    tier: 3,
    bannerEcpmUsd: 0.1,
    video5sEcpmUsd: 0.45,
    video15sEcpmUsd: 1.3,
    video30sEcpmUsd: 2.5,
    bannerMicroUsd: 100,
    video5sMicroUsd: 450,
    video15sMicroUsd: 1_300,
    video30sMicroUsd: 2_500,
  },
  LA: {
    country: 'Laos',
    code: 'LA',
    tier: 3,
    bannerEcpmUsd: 0.1,
    video5sEcpmUsd: 0.45,
    video15sEcpmUsd: 1.3,
    video30sEcpmUsd: 2.5,
    bannerMicroUsd: 100,
    video5sMicroUsd: 450,
    video15sMicroUsd: 1_300,
    video30sMicroUsd: 2_500,
  },
  BD: {
    country: 'Bangladesh',
    code: 'BD',
    tier: 3,
    bannerEcpmUsd: 0.08,
    video5sEcpmUsd: 0.35,
    video15sEcpmUsd: 1.0,
    video30sEcpmUsd: 2.0,
    bannerMicroUsd: 80,
    video5sMicroUsd: 350,
    video15sMicroUsd: 1_000,
    video30sMicroUsd: 2_000,
  },
  PK: {
    country: 'Pakistan',
    code: 'PK',
    tier: 3,
    bannerEcpmUsd: 0.08,
    video5sEcpmUsd: 0.35,
    video15sEcpmUsd: 1.0,
    video30sEcpmUsd: 2.0,
    bannerMicroUsd: 80,
    video5sMicroUsd: 350,
    video15sMicroUsd: 1_000,
    video30sMicroUsd: 2_000,
  },

  // --- Conservative Global Fallback ---
  GLOBAL: {
    country: 'Global Fallback',
    code: 'GLOBAL',
    tier: 0,
    bannerEcpmUsd: 0.25,
    video5sEcpmUsd: 1.1,
    video15sEcpmUsd: 3.2,
    video30sEcpmUsd: 6.0,
    bannerMicroUsd: 250,
    video5sMicroUsd: 1_100,
    video15sMicroUsd: 3_200,
    video30sMicroUsd: 6_000,
  },
};

/**
 * Returns the exact statistical gross ad reward in integer micro_usd for a given country code and ad format.
 * Falls back to GLOBAL if the country code is missing or not explicitly defined.
 *
 * @param countryCode ISO 3166-1 alpha-2 code (case-insensitive, e.g. 'US', 'TH', 'MM')
 * @param format Ad format ('banner' | 'video_5s' | 'video_15s' | 'video_30s'). Defaults to 'video_30s'.
 * @returns Integer micro_usd value (1 USD = 1,000,000 micro_usd)
 */
export function getStatisticalAdMicroUsd(
  countryCode?: string | null,
  format: AdFormat = 'video_30s'
): number {
  const code = (countryCode || '').trim().toUpperCase();
  const entry = COUNTRY_AD_ECPM_USD[code] || COUNTRY_AD_ECPM_USD.GLOBAL;

  switch (format) {
    case 'banner':
      return entry.bannerMicroUsd;
    case 'video_5s':
      return entry.video5sMicroUsd;
    case 'video_15s':
      return entry.video15sMicroUsd;
    case 'video_30s':
    default:
      return entry.video30sMicroUsd;
  }
}

/**
 * Returns the exact statistical gross ad reward in MWAR coins (1 coin = 100 micro_usd).
 */
export function getStatisticalAdCoins(
  countryCode?: string | null,
  format: AdFormat = 'video_30s'
): number {
  return Math.floor(getStatisticalAdMicroUsd(countryCode, format) / 100);
}
