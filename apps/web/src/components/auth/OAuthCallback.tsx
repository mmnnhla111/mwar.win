'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { OAuthLoginResponse, OAuthProvider } from '@mwar/shared';
import { clearBootstrapCache, getAuthToken, oauthLine, oauthTelegram, setAuthToken } from '../../lib/api';
import { authErrorKey, callbackUrl, readTelegramResult, rememberRef, takePending } from '../../lib/oauth';
import { useSession } from '../../lib/session';
import { AuthCard, FormError } from './AuthCard';
import { TelegramIcon, LineIcon } from './ProviderButtons';
import { Spinner, btn } from '../ui/Card';
import { useTranslation } from '../../i18n/I18nProvider';

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
    const pending = takePending(provider);
    const link = !!pending?.link;
    setLinking(link);
    const fail = (key: string) => setError({ key });

    (async () => {
      let res: OAuthLoginResponse;
      try {
        if (link && !getAuthToken()) return fail('oauth.err.signInAgain');
        if (provider === 'line') {
          const q = new URLSearchParams(window.location.search);
          window.history.replaceState(null, '', window.location.pathname);
          if (q.get('error')) return fail('oauth.err.cancelled');
          const code = q.get('code');
          // CSRF: the state must be the one we generated before leaving for LINE
          if (!code || !pending || q.get('state') !== pending.state) return fail('oauth.err.state');
          res = await oauthLine({ code, redirect_uri: callbackUrl('line'), referral_code: link ? null : pending.ref, link_to_current_user: link || undefined });
        } else {
          const data = readTelegramResult();
          window.history.replaceState(null, '', window.location.pathname);
          if (!data) return fail('oauth.err.cancelled');
          res = await oauthTelegram({ ...data, referral_code: link ? null : pending?.ref || null, link_to_current_user: link || undefined });
        }
      } catch (err: any) {
        const key = authErrorKey(err);
        return key ? fail(key) : setError(err?.message ? { raw: err.message } : { key: 'oauth.err.generic' });
      }

      if (link) {
        clearBootstrapCache();
        router.replace(`/settings?linked=${provider}`);
        return;
      }
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
