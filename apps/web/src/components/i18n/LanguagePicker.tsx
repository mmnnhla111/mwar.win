'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ENABLED_LANGS, type LangCode } from '../../i18n/config';
import { useTranslation } from '../../i18n/I18nProvider';

export function GlobeIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </svg>
  );
}

function current(lang: LangCode) {
  return ENABLED_LANGS.find((l) => l.code === lang) || ENABLED_LANGS[0];
}

function Options({ onPick }: { onPick?: () => void }) {
  const { lang, setLang } = useTranslation();
  return (
    <ul role="listbox" className="py-1">
      {ENABLED_LANGS.map((l) => (
        <li key={l.code}>
          <button
            type="button"
            role="option"
            aria-selected={l.code === lang}
            data-lang={l.code}
            lang={l.code}
            onClick={() => {
              setLang(l.code);
              onPick?.();
            }}
            className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl text-sm text-left transition ${
              l.code === lang ? 'bg-[#FFF6C2] font-bold text-stone-900' : 'hover:bg-stone-50 font-semibold text-stone-700'
            }`}
          >
            <span className="truncate">{l.native}</span>
            <span className="text-[11px] uppercase text-stone-400 shrink-0">{l.code}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open, close]);
  return ref;
}

/** Floating pill for the sign-in / sign-up pages (top-right corner). */
export function LanguagePill() {
  const { lang, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  return (
    <div ref={ref} className="absolute top-3 right-3 sm:top-5 sm:right-5 z-30">
      <button
        type="button"
        data-lang-pill
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('nav.language')}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 h-9 pl-3 pr-3.5 rounded-full bg-white/90 backdrop-blur border border-stone-200/80 shadow-sm text-sm font-bold text-stone-700 hover:bg-white"
      >
        <GlobeIcon size={16} />
        <span className="max-w-[9rem] truncate">{current(lang).native}</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 bg-white rounded-2xl border border-stone-200/80 shadow-[0_12px_40px_rgba(0,0,0,0.10)] p-1.5">
          <Options onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** Row inside the navbar user menu that expands into the language list. */
export function LanguageMenu() {
  const { lang, t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        data-lang-menu
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-stone-50 text-sm font-semibold text-stone-800"
      >
        <GlobeIcon size={18} />
        <span className="flex-1 text-left">{t('nav.language')}</span>
        <span className="text-xs text-stone-400 truncate max-w-[6.5rem]">{current(lang).native}</span>
      </button>
      {open && (
        <div className="mx-1 mb-1 rounded-xl bg-stone-50/70 px-1">
          <Options onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** Grid of language buttons for /settings. */
export function LanguageGrid() {
  const { lang, setLang } = useTranslation();
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" role="radiogroup" data-lang-grid>
      {ENABLED_LANGS.map((l) => (
        <button
          key={l.code}
          type="button"
          role="radio"
          aria-checked={l.code === lang}
          data-lang={l.code}
          lang={l.code}
          onClick={() => setLang(l.code)}
          className={`min-w-0 px-3 py-2.5 rounded-2xl border text-sm text-left transition ${
            l.code === lang ? 'border-yellow-400 bg-[#FFFBEA] font-bold text-stone-900' : 'border-stone-200 hover:bg-stone-50 font-semibold text-stone-700'
          }`}
        >
          <span className="block truncate">{l.native}</span>
          <span className="block text-[11px] text-stone-400 truncate">{l.english}</span>
        </button>
      ))}
    </div>
  );
}
