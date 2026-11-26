'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { OAuthLoginResponse, OAuthProvider } from '@mwar/shared';
import { clearBootstrapCache, getAuthToken, oauthLine, oauthTelegram, setAuthToken, telegramBotExchange } from '../../lib/api';
import { authErrorKey, clearTelegramWait, hasTelegramWait, isIos, isIosInAppBrowser, readTelegramResult, rememberRef, safariUrl, takePending, takeRedirectAfter } from '../../lib/oauth';
import { getDeviceFp, storedReferral } from '../../lib/referral';
import { useSession } from '../../lib/session';
import { AuthCard, FormError } from './AuthCard';
import { TelegramIcon, LineIcon } from './ProviderButtons';
import { Spinner, btn } from '../ui/Card';
import { useTranslation } from '../../i18n/I18nProvider';

/**
 * Single-execution guard across re-renders, StrictMode double effects and remounts: a LINE `code`,
 * a server `state` or a Telegram exchange token is only ever sent once per page load.
 */
const handled = new Set<string>();

/** Shared body of /auth/callback/telegram and /auth/callback/line (static pages). */
export function OAuthCallback({ provider }: { provider: OAuthProvider }) {
  const router = useRouter();
  const { refresh } = useSession();
  const { t } = useTranslation();
  const ran = useRef(false);
  // i18n key (translated at render, so it follows the language once its dictionary has loaded) or a raw server message
  const [error, setError] = useState<{ key?: string; raw?: string } | null>(null);
  const [linking, setLinking] = useState(false);
  /**
   * iPhone: the bot's button opened this page in Telegram's in-app browser (or another browser) instead of
   * the Safari tab / PWA where the player pressed "Sign in with Telegram". Signing in here would leave
   * the session in the wrong browser, so offer "Open in Safari" and point back to the waiting tab.
   */
  const [escape, setEscape] = useState<{ token: string; inApp: boolean } | null>(null);
  const [busyHere, setBusyHere] = useState(false);
  const exchangeRef = useRef<((token: string) => Promise<void>) | null>(null);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const q = new URLSearchParams(window.location.search);
    const fail = (key: string) => setError({ key });

    // Which one-time credential is this page carrying? (LINE code+state, bot token, or legacy widget)
    const lineCode = provider === 'line' ? q.get('code') : null;
    const lineState = provider === 'line' ? q.get('state') : null;
    const botToken = provider === 'telegram' ? q.get('token') : null;
    const guardKey = provider === 'line' ? `line:${lineCode || ''}:${lineState || ''}` : botToken ? `tgbot:${botToken}` : `tg:${window.location.hash}`;
    if (handled.has(guardKey)) return;
    handled.add(guardKey);
    // Legacy Telegram widget only: what we were doing is in sessionStorage (may be missing: then a plain sign-in)
    const pending = provider === 'telegram' && !botToken ? takePending('telegram') : null;
    // Read the legacy widget result BEFORE the URL (and its #tgAuthResult hash) is cleaned
    const widgetData = provider === 'telegram' && !botToken ? readTelegramResult() : null;
    window.history.replaceState(null, '', window.location.pathname);

    const finish = async (res: OAuthLoginResponse) => {
      if (res.linked) {
        setLinking(true);
        const back = takeRedirectAfter();
        clearBootstrapCache();
        router.replace(back && back.startsWith('/settings') ? back : `/settings?linked=${provider}`);
        return;
      }
      takeRedirectAfter();
      if (!res.token) return fail('oauth.err.generic');
      setAuthToken(res.token, true);
      rememberRef(null);
      clearTelegramWait();
      clearBootstrapCache();
      await refresh(true);
      router.replace(res.isNewUser ? '/welcome' : '/');
    };
    exchangeRef.current = async (token: string) => {
      let res: OAuthLoginResponse;
      try {
        res = await telegramBotExchange(token);
      } catch (err: any) {
        const key = authErrorKey(err);
        return key ? fail(key) : setError(err?.message ? { raw: err.message } : { key: 'oauth.err.generic' });
      }
      await finish(res);
    };

    if (botToken && !hasTelegramWait() && (isIos() || isIosInAppBrowser())) {
      setEscape({ token: botToken, inApp: isIosInAppBrowser() });
      return;
    }

    (async () => {
      let res: OAuthLoginResponse;
      try {
        if (provider === 'line') {
          if (q.get('error')) return fail('oauth.err.cancelled');
          // The state lives on the server (D1): nothing here depends on sessionStorage
          if (!lineCode || !lineState) return fail('oauth.err.state');
          const deviceFp = await getDeviceFp().catch(() => null);
          res = await oauthLine({ code: lineCode, state: lineState, device_fp: deviceFp });
        } else if (botToken) {
          // 1-tap return from the Telegram bot's "🚀 เข้าสู่ระบบ mwar.win" button
          res = await telegramBotExchange(botToken);
        } else {
          const link = !!pending?.link;
          if (link && !getAuthToken()) return fail('oauth.err.signInAgain');
          const data = widgetData;
          if (!data) return fail('oauth.err.cancelled');
          const refCode = link ? null : pending?.ref || (await storedReferral()) || null;
          const deviceFp = link ? null : await getDeviceFp().catch(() => null);
          res = await oauthTelegram({ ...data, referral_code: refCode, device_fp: deviceFp, link_to_current_user: link || undefined });
        }
      } catch (err: any) {
        const key = authErrorKey(err);
        return key ? fail(key) : setError(err?.message ? { raw: err.message } : { key: 'oauth.err.generic' });
      }

      await finish(res);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const name = provider === 'telegram' ? 'Telegram' : 'LINE';
  if (escape && !error) {
    const here = `${window.location.origin}/auth/callback/telegram?token=${encodeURIComponent(escape.token)}`;
    return (
      <AuthCard title={t('tgbot.iosTitle')}>
        <div className="space-y-4 text-center" data-ios-escape={escape.inApp ? 'inapp' : 'browser'}>
          <span className="mx-auto w-14 h-14 rounded-3xl bg-[#24A1DE] flex items-center justify-center">
            <TelegramIcon size={32} />
          </span>
          <p className="text-sm text-stone-700 leading-relaxed font-semibold">{t('tgbot.iosSwitchBack')}</p>
          <a
            href={safariUrl(here)}
            className={`${btn.primary} w-full !py-4 !text-base justify-center !bg-[#0A84FF] !text-white`}
            data-open-safari
          >
            {t('tgbot.openSafari')}
          </a>
          <a href={here} target="_blank" rel="noopener noreferrer" className="block text-xs font-semibold text-stone-500 underline underline-offset-2" data-open-system>
            {t('tgbot.openSystemBrowser')}
          </a>
          <div className="pt-2 border-t border-stone-100">
            <button
              type="button"
              disabled={busyHere}
              onClick={async () => {
                setBusyHere(true);
                await exchangeRef.current?.(escape.token);
                setBusyHere(false);
              }}
              className={`${btn.soft} w-full justify-center`}
              data-signin-here
            >
              {busyHere ? <Spinner size={16} /> : t('tgbot.signInHere')}
            </button>
            <p className="mt-2 text-[11px] text-stone-400 leading-snug">{t('tgbot.signInHereHint')}</p>
          </div>
        </div>
      </AuthCard>
    );
  }
  if (error) {
    return (
      <AuthCard title={t('oauth.failedTitle')}>
        <div className="space-y-4" data-oauth-error>
          <FormError msg={error.key ? t(error.key) : error.raw} />
          <Link href={linking ? '/settings' : '/login'} className={`${btn.primary} w-full py-3 justify-center`}>
            {linking ? t('oauth.backToSettings') : t('oauth.backToLogin')}
          </Link>
        </div>
      </AuthCard>
    );
  }
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center gap-4 px-6 text-center" data-oauth-pending>
      <span className={`w-16 h-16 rounded-3xl flex items-center justify-center ${provider === 'telegram' ? 'bg-[#24A1DE]' : 'bg-[#06C755]'}`}>
        {provider === 'telegram' ? <TelegramIcon size={36} /> : <LineIcon size={36} />}
      </span>
      <div className="font-extrabold text-stone-900">{t('oauth.verifying', { name })}</div>
      <Spinner size={22} />
    </div>
  );
}
