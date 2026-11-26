'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { OAuthLoginResponse, TelegramBotInitResponse } from '@mwar/shared';
import { getAuthToken, telegramBotPoll } from '../../lib/api';
import { authErrorKey } from '../../lib/oauth';
import { useTranslation } from '../../i18n/I18nProvider';
import { TelegramIcon } from './ProviderButtons';
import { Spinner, btn } from '../ui/Card';

/** Fast enough that switching back from Telegram feels instant on iPhone (Safari tab or PWA). */
const POLL_MS = 1500;
const MAX_WAIT_MS = 3 * 60 * 1000;

/**
 * Waiting card after "เข้าสู่ระบบด้วย Telegram": the Telegram app opened @bot with /start auth_<state>.
 * While this tab is visible it asks the server every 1.5 s (max 3 min), and at once on focus / pageshow, whether the bot approved,
 * so a player who switches back by hand is signed in automatically. Tapping the bot's button
 * instead signs in through /auth/callback/telegram?token=… in whatever browser Telegram opens.
 */
export function TelegramBotWait({
  init,
  onSuccess,
  onCancel,
  onWidget,
  linking = false,
}: {
  init: TelegramBotInitResponse;
  onSuccess: (res: OAuthLoginResponse) => void;
  onCancel: () => void;
  /** Desktop fallback: the legacy web widget (phone number). */
  onWidget?: () => void;
  linking?: boolean;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'waiting' | 'timeout' | 'expired' | 'elsewhere' | 'error'>('waiting');
  const [errKey, setErrKey] = useState<string | null>(null);
  const done = useRef(false);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  useEffect(() => {
    if (phase !== 'waiting') return;
    const startedAt = Date.now();
    let timer: number | null = null;
    let inFlight = false;
    let stopped = false;

    const poll = async () => {
      if (stopped || done.current || inFlight || document.visibilityState !== 'visible') return;
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        stopped = true;
        setPhase('timeout');
        return;
      }
      inFlight = true;
      try {
        const r = await telegramBotPoll(init.state);
        if (stopped || done.current) return;
        if (r.status === 'approved') {
          done.current = true;
          stopped = true;
          onSuccessRef.current(r);
        } else if (r.status === 'expired') {
          stopped = true;
          setPhase('expired');
        } else if (r.status === 'consumed') {
          // Signed in through the bot button (maybe in another browser)
          stopped = true;
          setPhase('elsewhere');
        }
      } catch (e: any) {
        const key = authErrorKey(e);
        if (key || (e?.status && e.status < 500 && e.status !== 429)) {
          stopped = true;
          setErrKey(key || 'oauth.err.generic');
          setPhase('error');
        }
      } finally {
        inFlight = false;
      }
    };

    timer = window.setInterval(poll, POLL_MS);
    // iOS freezes timers in a background tab: check immediately when the player comes back
    const onVis = () => {
      if (document.visibilityState === 'visible') poll();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    window.addEventListener('pageshow', onVis);
    poll();
    return () => {
      stopped = true;
      if (timer) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
      window.removeEventListener('pageshow', onVis);
    };
  }, [init.state, phase]);

  const signedInHere = typeof window !== 'undefined' && !!getAuthToken();

  // Signed in from another tab of this same browser (e.g. "Open in Safari"): continue without a tap
  useEffect(() => {
    if (phase === 'elsewhere' && signedInHere && !linking) {
      const id = window.setTimeout(() => window.location.replace('/'), 900);
      return () => window.clearTimeout(id);
    }
  }, [phase, signedInHere, linking]);

  return (
    <div className="space-y-3 rounded-3xl border border-sky-100 bg-[#F0F9FF] p-4 text-center" data-telegram-wait={phase}>
      <span className="mx-auto w-12 h-12 rounded-2xl bg-[#24A1DE] flex items-center justify-center">
        <TelegramIcon size={30} />
      </span>
      {phase === 'waiting' && (
        <>
          <div className="font-extrabold text-stone-900 flex items-center justify-center gap-2">
            <Spinner size={16} /> {t('tgbot.waitingTitle')}
          </div>
          <p className="text-sm text-stone-600 leading-relaxed">{t(linking ? 'tgbot.waitingLink' : 'tgbot.waitingHint')}</p>
        </>
      )}
      {phase === 'timeout' && <p className="text-sm font-semibold text-stone-700">{t('tgbot.timeout')}</p>}
      {phase === 'expired' && <p className="text-sm font-semibold text-rose-600">{t('oauth.err.state')}</p>}
      {phase === 'error' && <p className="text-sm font-semibold text-rose-600">{t(errKey || 'oauth.err.generic')}</p>}
      {phase === 'elsewhere' && (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-emerald-700">{t('tgbot.elsewhere')}</p>
          {signedInHere && !linking && (
            <button className={`${btn.primary} w-full justify-center`} onClick={() => window.location.replace('/')}>
              {t('tgbot.continue')}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {phase === 'waiting' && (
          <a href={init.deepLinkUrl} target="_blank" rel="noopener noreferrer" className={`${btn.primary} w-full justify-center !bg-[#24A1DE] !text-white`} data-telegram-reopen>
            {t('tgbot.reopen')}
          </a>
        )}
        {phase === 'timeout' && (
          <button className={`${btn.soft} w-full justify-center`} onClick={() => setPhase('waiting')} data-telegram-keepwaiting>
            {t('tgbot.keepWaiting')}
          </button>
        )}
        <button className={`${btn.ghost} w-full justify-center text-xs`} onClick={onCancel} data-telegram-cancel>
          {phase === 'waiting' || phase === 'timeout' ? t('common.cancel') : t('tgbot.tryAgain')}
        </button>
        {onWidget && (
          <button type="button" onClick={onWidget} className="text-[11px] font-semibold text-stone-400 underline underline-offset-2 hover:text-stone-600" data-telegram-widget>
            {t('tgbot.widgetFallback')}
          </button>
        )}
      </div>
    </div>
  );
}
