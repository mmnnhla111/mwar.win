/**
 * Language registry. To turn on a phase-2 language: add `locales/<code>.json` (same keys as en.json,
 * check with `pnpm --filter @mwar/web i18n:check`) and flip `enabled` to true. Nothing else changes.
 */
export type LangCode = 'en' | 'th' | 'id' | 'vi' | 'es' | 'zh' | 'ko' | 'ja' | 'hi' | 'pt';

export interface LangInfo {
  code: LangCode;
  /** Name in its own language (shown in pickers). */
  native: string;
  /** English name. */
  english: string;
  enabled: boolean;
}

export const LANGUAGES: LangInfo[] = [
  { code: 'en', native: 'English', english: 'English', enabled: true },
  { code: 'th', native: 'ไทย', english: 'Thai', enabled: true },
  { code: 'id', native: 'Bahasa Indonesia', english: 'Indonesian', enabled: true },
  { code: 'vi', native: 'Tiếng Việt', english: 'Vietnamese', enabled: true },
  { code: 'es', native: 'Español', english: 'Spanish', enabled: true },
  // Phase 2 slots
  { code: 'zh', native: '中文', english: 'Chinese', enabled: false },
  { code: 'ko', native: '한국어', english: 'Korean', enabled: false },
  { code: 'ja', native: '日本語', english: 'Japanese', enabled: false },
  { code: 'hi', native: 'हिन्दी', english: 'Hindi', enabled: false },
  { code: 'pt', native: 'Português', english: 'Portuguese', enabled: false },
];

export const DEFAULT_LANG: LangCode = 'en';
export const LANG_STORAGE_KEY = 'mwar_lang';

export const ENABLED_LANGS = LANGUAGES.filter((l) => l.enabled);

export function isEnabledLang(code: string | null | undefined): code is LangCode {
  return !!code && ENABLED_LANGS.some((l) => l.code === code);
}

/** 'th-TH' -> 'th', 'zh-Hant-TW' -> 'zh', 'pt-BR' -> 'pt'; null when not an enabled language. */
export function normalizeLang(tag: string | null | undefined): LangCode | null {
  if (!tag) return null;
  const base = tag.toLowerCase().split(/[-_]/)[0];
  const code = base === 'in' ? 'id' : base; // old Java/Android tag for Indonesian
  return isEnabledLang(code) ? code : null;
}

/**
 * Country guess from the device time zone (no network request, no IP lookup).
 * Only languages that are enabled are ever returned.
 */
const TZ_LANG: Array<[RegExp, LangCode]> = [
  [/^Asia\/Bangkok$/, 'th'],
  [/^Asia\/(Jakarta|Pontianak|Makassar|Jayapura)$/, 'id'],
  [/^Asia\/(Ho_Chi_Minh|Saigon)$/, 'vi'],
  [
    /^(Europe\/Madrid|Africa\/Ceuta|Atlantic\/Canary|America\/(Mexico_City|Cancun|Merida|Monterrey|Matamoros|Chihuahua|Ciudad_Juarez|Ojinaga|Mazatlan|Bahia_Banderas|Hermosillo|Tijuana|Bogota|Lima|Santiago|Punta_Arenas|Buenos_Aires|Argentina\/.+|Caracas|La_Paz|Asuncion|Montevideo|Guayaquil|Guatemala|Tegucigalpa|El_Salvador|Managua|Costa_Rica|Panama|Havana|Santo_Domingo|Puerto_Rico)|Pacific\/Galapagos)$/,
    'es',
  ],
  [/^Asia\/(Shanghai|Chongqing|Harbin|Urumqi|Taipei|Hong_Kong|Macau)$/, 'zh'],
  [/^Asia\/Seoul$/, 'ko'],
  [/^Asia\/Tokyo$/, 'ja'],
  [/^Asia\/(Kolkata|Calcutta)$/, 'hi'],
  [/^(America\/(Sao_Paulo|Bahia|Fortaleza|Recife|Belem|Manaus|Cuiaba|Campo_Grande|Porto_Velho|Boa_Vista|Rio_Branco|Maceio|Araguaina|Santarem|Noronha)|Europe\/Lisbon|Atlantic\/(Azores|Madeira)|Africa\/(Luanda|Maputo))$/, 'pt'],
];

export function langFromTimeZone(tz: string | null | undefined): LangCode | null {
  if (!tz) return null;
  for (const [re, code] of TZ_LANG) if (re.test(tz)) return isEnabledLang(code) ? code : null;
  return null;
}

/**
 * Auto-detect (used when the user never picked a language):
 * 1. a supported non-English browser language (e.g. th-TH -> th),
 * 2. else the country from the device time zone (Thailand -> th, even on an English phone),
 * 3. else English.
 */
export function detectLang(): LangCode {
  if (typeof window === 'undefined') return DEFAULT_LANG;
  const tags = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]) || [];
  for (const tag of tags) {
    const l = normalizeLang(tag);
    if (l && l !== 'en') return l;
  }
  let tz: string | undefined;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    tz = undefined;
  }
  return langFromTimeZone(tz) || DEFAULT_LANG;
}
