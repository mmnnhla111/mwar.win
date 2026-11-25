'use client';

import React, { useEffect, useState } from 'react';
import { LemonLogo, Icon } from '../ui/Icon';
import { useTranslation } from '../../i18n/I18nProvider';

const DISMISS_KEY = 'mwar_pwa_prompt_dismissed_at';
const SNOOZE_MS = 48 * 3600 * 1000;

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}
function snoozed() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return at > 0 && Date.now() - at < SNOOZE_MS;
  } catch {
    return false;
  }
}

/** Register /sw.js once (static export: the file is served from public/). */
export function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  const go = () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}

/**
 * "Add mwar.win to your home screen" card. Android / Chrome: the native install prompt
 * (beforeinstallprompt). iPhone / iPad Safari: a Share → Add to Home Screen guide.
 * Never shown in the installed app; X hides it for 48 hours (localStorage mwar_pwa_prompt_dismissed_at).
 */
export function PwaInstall() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'android' | 'ios' | null>(null);
  const [evt, setEvt] = useState<BIPEvent | null>(null);

  useEffect(() => {
    registerServiceWorker();
    if (isStandalone() || snoozed()) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e as BIPEvent);
      setMode('android');
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    const onInstalled = () => setMode(null);
    window.addEventListener('appinstalled', onInstalled);
    const ua = navigator.userAgent;
    const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const safari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (ios && safari) timer = setTimeout(() => setMode('ios'), 2500);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* private mode */
    }
    setMode(null);
  };

  const install = async () => {
    if (!evt) return;
    await evt.prompt().catch(() => {});
    const choice = await evt.userChoice.catch(() => null);
    setEvt(null);
    if (choice?.outcome !== 'accepted') dismiss();
    else setMode(null);
  };

  if (!mode) return null;
  return (
    <div
      className="fixed z-50 left-3 right-3 bottom-[calc(76px+env(safe-area-inset-bottom))] md:left-auto md:right-6 md:bottom-6 md:w-[360px] rounded-3xl bg-white border border-stone-200 shadow-[0_12px_40px_rgba(0,0,0,0.15)] p-4 animate-[popIn_200ms_ease-out]"
      role="dialog"
      aria-label={t('pwa.title')}
      data-pwa-prompt={mode}
    >
      <button onClick={dismiss} className="absolute top-2.5 right-2.5 w-8 h-8 rounded-full bg-stone-100 text-stone-600 flex items-center justify-center" aria-label={t('common.close')} data-pwa-dismiss>
        <Icon name="close" size={15} />
      </button>
      <div className="flex items-start gap-3 pr-8">
        <LemonLogo size={44} />
        <div className="min-w-0">
          <div className="font-extrabold text-stone-900">{t('pwa.title')}</div>
          <p className="text-xs text-stone-500 mt-0.5">{t('pwa.subtitle')}</p>
        </div>
      </div>
      {mode === 'android' ? (
        <button onClick={install} className="mt-3 w-full rounded-2xl bg-[#FFE135] py-2.5 text-sm font-extrabold text-stone-900" data-pwa-install>
          {t('pwa.install')}
        </button>
      ) : (
        <ol className="mt-3 space-y-1.5 text-sm text-stone-700">
          <li className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-stone-100 text-xs font-black flex items-center justify-center">1</span>
            {t('pwa.iosStep1')}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0A84FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
            </svg>
          </li>
          <li className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-stone-100 text-xs font-black flex items-center justify-center">2</span>
            {t('pwa.iosStep2')}
          </li>
          <li className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-stone-100 text-xs font-black flex items-center justify-center">3</span>
            {t('pwa.iosStep3')}
          </li>
        </ol>
      )}
    </div>
  );
}
