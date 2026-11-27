'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ActiveGameSession } from '@mwar/shared';
import { getActiveSession, getAuthToken, rejoinHref } from '../../lib/api';
import { useTranslation } from '../../i18n/I18nProvider';
import { Icon } from '../ui/Icon';
import { isAuthPath, isGamePath } from './nav';

/** ✕ hides the card for this browser tab only (sessionStorage) — it never touches the character in the match. */
const DISMISS_KEY = 'mwar_rejoin_dismissed_v1';
/** Light polling while the tab is visible (plus a check on every navigation and when the tab comes back). */
const POLL_MS = 30_000;

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * V1.1 R3 — floating "your character is still in the arena" card on every non-game page. Shown while
 * GET /api/game/active-session reports an alive body of this account (a disconnected body keeps standing —
 * or hiding as a prop — in the match and can still be found and defeated). "Rejoin" opens
 * /game?rejoin=<roomId>, which re-attaches to that same body with no new EC.
 */
export function ActiveMatchPopup() {
  const { t } = useTranslation();
  const pathname = usePathname() || '/';
  const [session, setSession] = useState<ActiveGameSession | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const busy = useRef(false);
  const hidden = isGamePath(pathname) || isAuthPath(pathname);

  const check = useCallback(async () => {
    if (busy.current || !getAuthToken()) return;
    busy.current = true;
    try {
      const r = await getActiveSession();
      setSession(r.session);
    } catch {
      // offline / signed out: keep the last answer
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => setDismissed(readDismissed()), []);

  useEffect(() => {
    if (hidden) return;
    void check();
  }, [pathname, hidden, check]);

  useEffect(() => {
    if (hidden) return;
    const tick = () => document.visibilityState === 'visible' && void check();
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [hidden, check]);

  if (hidden || !session || dismissed === session.entryId) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, session.entryId);
    } catch {
      /* storage blocked: hide until the next navigation */
    }
    setDismissed(session.entryId);
  };
  const modeKey = session.mode === 'standard_100' || session.mode === 'fast_mini' ? session.mode : 'mini_30';
  const hp = Math.max(0, Math.min(100, Math.round(session.hp)));

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="active-match-popup"
      className="fixed z-[60] left-3 right-3 bottom-[calc(76px+env(safe-area-inset-bottom))] md:left-auto md:right-6 md:bottom-6 md:w-[340px] animate-[fadeIn_.25s_ease-out]"
    >
      <div className="relative rounded-2xl bg-white border border-stone-200 shadow-[0_10px_30px_-8px_rgba(28,25,23,0.35)] overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-[#FFE135] via-amber-400 to-rose-400" />
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('rejoin.dismiss')}
          title={t('rejoin.dismiss')}
          data-testid="active-match-dismiss"
          className="absolute top-2.5 right-2.5 w-7 h-7 rounded-full flex items-center justify-center text-stone-400 hover:text-stone-700 hover:bg-stone-100"
        >
          <Icon name="close" size={16} />
        </button>
        <div className="p-3.5 pr-10 flex gap-3">
          <div className="relative shrink-0 w-11 h-11 rounded-xl bg-stone-900 flex items-center justify-center text-[#FFE135]">
            <Icon name="target" size={22} />
            <span className="absolute -top-1 -right-1 flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500 border-2 border-white" />
            </span>
          </div>
          <div className="min-w-0">
            <div className="text-[13.5px] font-extrabold text-stone-900 leading-snug">
              {t('rejoin.title')} <span className="text-stone-500 font-bold">({t(`rejoin.mode.${modeKey}`)})</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {session.isPropHidden && (
                <span className="inline-flex items-center gap-1 text-[10.5px] font-black px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                  <Icon name="eye" size={12} /> {t('rejoin.propBadge')}
                </span>
              )}
              <span className="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-stone-100 text-stone-700">
                {t('rejoin.hp', { hp })}
              </span>
              {session.roomCode && <span className="text-[10.5px] font-bold text-stone-400">{session.roomCode}</span>}
            </div>
            <div className="mt-1 text-[11.5px] text-stone-500 leading-snug">{session.isDisconnected ? t('rejoin.away') : t('rejoin.elsewhere')}</div>
          </div>
        </div>
        <div className="px-3.5 pb-3.5">
          <Link
            href={rejoinHref(session)}
            data-testid="active-match-rejoin"
            className="flex items-center justify-center gap-2 w-full rounded-xl bg-[#FFE135] hover:bg-[#ffd900] text-stone-900 text-sm font-black py-2.5 shadow-sm active:scale-[0.98] transition"
          >
            <Icon name="games" size={18} /> {t('rejoin.button')}
          </Link>
        </div>
      </div>
    </div>
  );
}
