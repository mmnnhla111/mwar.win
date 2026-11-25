'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import en from './locales/en.json';
import { DEFAULT_LANG, LANG_STORAGE_KEY, detectLang, isEnabledLang, type LangCode } from './config';
import { useSession } from '../lib/session';
import { updateSocialSettings } from '../lib/api';

export type Dict = Record<string, string>;
export type TParams = Record<string, string | number>;
export type TFunction = (key: string, params?: TParams) => string;

const EN = en as Dict;
/** Dictionaries loaded this session (in memory; each language chunk is fetched at most once). */
const cache: Partial<Record<LangCode, Dict>> = { en: EN };

/** English is bundled; every other language is its own lazily loaded chunk. */
export async function loadDict(lang: LangCode): Promise<Dict> {
  const hit = cache[lang];
  if (hit) return hit;
  const mod = await import(`./locales/${lang}.json`);
  const dict = (mod.default || mod) as Dict;
  cache[lang] = dict;
  return dict;
}

export function interpolate(s: string, params?: TParams): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
}

/** Pure translator: current language -> English -> the key itself. `{count}` picks `<key>_one` when count is 1. */
export function translate(dict: Dict, key: string, params?: TParams): string {
  let k = key;
  if (params && params.count === 1 && (dict[`${key}_one`] !== undefined || EN[`${key}_one`] !== undefined)) k = `${key}_one`;
  const raw = dict[k] ?? EN[k] ?? dict[key] ?? EN[key] ?? key;
  return interpolate(raw, params);
}

interface I18nValue {
  lang: LangCode;
  t: TFunction;
  /** Translate `key` when a dictionary has it, else return `fallback` (server-provided English text). */
  tx: (key: string, fallback: string, params?: TParams) => string;
  /** Translate admin-editable server text only while it is still the stock English text; edited text shows as typed. */
  ts: (key: string, serverText: string) => string;
  /** Switch language; saved to localStorage and, when signed in, to the account. */
  setLang: (lang: LangCode) => Promise<void>;
}

const I18nCtx = createContext<I18nValue>({
  lang: DEFAULT_LANG,
  t: (k, p) => translate(EN, k, p),
  tx: (k, fb, p) => (EN[k] !== undefined ? translate(EN, k, p) : fb),
  ts: (_k, v) => v,
  setLang: async () => {},
});

function readStored(): LangCode | null {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY);
    return isEnabledLang(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Zero-dependency i18n. Order: localStorage `mwar_lang` (explicit pick) -> account `preferred_lang`
 * from the already-loaded /api/bootstrap (no extra request) -> browser language -> country from the
 * device time zone -> English. Must sit inside <SessionProvider>.
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const { boot, patch } = useSession();
  const [lang, setLangState] = useState<LangCode>(DEFAULT_LANG);
  const [dict, setDict] = useState<Dict>(EN);
  const want = useRef<LangCode>(DEFAULT_LANG);

  const apply = useCallback(async (next: LangCode) => {
    want.current = next;
    const d = await loadDict(next).catch(() => EN);
    if (want.current !== next) return; // a newer choice won
    setDict(d);
    setLangState(next);
    document.documentElement.lang = next;
  }, []);

  // First paint on the client: explicit pick, else auto-detect
  useEffect(() => {
    apply(readStored() || detectLang());
  }, [apply]);

  // Account preference from bootstrap (only when this device has no explicit pick).
  // 'en' is also the column default, so it never overrides a detected language.
  const accountLang = boot?.user?.preferredLang;
  useEffect(() => {
    if (!readStored() && isEnabledLang(accountLang) && accountLang !== 'en') apply(accountLang);
  }, [accountLang, apply]);

  const setLang = useCallback(
    async (next: LangCode) => {
      try {
        localStorage.setItem(LANG_STORAGE_KEY, next);
      } catch {
        /* private mode */
      }
      await apply(next);
      if (boot?.user && boot.user.preferredLang !== next) {
        patch((b) => ({ ...b, user: { ...b.user, preferredLang: next } }));
        updateSocialSettings({ preferredLang: next }).catch(() => {});
      }
    },
    [apply, boot?.user, patch]
  );

  const t = useCallback<TFunction>((key, params) => translate(dict, key, params), [dict]);
  const tx = useCallback(
    (key: string, fallback: string, params?: TParams) => (dict[key] !== undefined || EN[key] !== undefined ? translate(dict, key, params) : fallback),
    [dict]
  );
  const ts = useCallback((key: string, serverText: string) => (EN[key] === serverText ? translate(dict, key) : serverText), [dict]);
  const value = useMemo(() => ({ lang, t, tx, ts, setLang }), [lang, t, tx, ts, setLang]);
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useTranslation() {
  return useContext(I18nCtx);
}
