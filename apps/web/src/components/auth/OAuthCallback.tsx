'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { OAuthLoginResponse, OAuthProvider } from '@mwar/shared';
import { clearBootstrapCache, getAuthToken, oauthLine, oauthTelegram, setAuthToken, telegramBotExchange } from '../../lib/api';
import { authErrorKey, readTelegramResult, rememberRef, takePending, takeRedirectAfter } from '../../lib/oauth';
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
    window.history.replaceState(null, '', window.location.pathname);

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
          const data = readTelegramResult();
          if (!data) return fail('oauth.err.cancelled');
          const refCode = link ? null : pending?.ref || (await storedReferral()) || null;
          const deviceFp = link ? null : await getDeviceFp().catch(() => null);
          res = await oauthTelegram({ ...data, referral_code: refCode, device_fp: deviceFp, link_to_current_user: link || undefined });
        }
      } catch (err: any) {
        const key = authErrorKey(err);
        return key ? fail(key) : setError(err?.message ? { raw: err.message } : { key: 'oauth.err.generic' });
      }

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
      clearBootstrapCache();
      await refresh(true);
      router.replace(res.isNewUser ? '/welcome' : '/');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const name = provider === 'telegram' ? 'Telegram' : 'LINE';
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
