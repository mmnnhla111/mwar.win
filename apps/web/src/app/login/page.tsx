'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthProvidersResponse, OAuthLoginResponse, OAuthProvider, TelegramBotInitResponse } from '@mwar/shared';
import { apiFetch, setAuthToken, clearBootstrapCache, getAuthProviders, checkReferralCode } from '../../lib/api';
import { startLine, startTelegramWidget, initTelegramBot, prepareTab, openDeepLink, rememberRef, recalledRef, authErrorKey } from '../../lib/oauth';
import { restoreReferral } from '../../lib/referral';
import { useSession } from '../../lib/session';
import { AuthCard, FieldLabel, FormError } from '../../components/auth/AuthCard';
import { ProviderButton } from '../../components/auth/ProviderButtons';
import { TelegramBotWait } from '../../components/auth/TelegramBotWait';
import { btn, inputCls } from '../../components/ui/Card';
import { useTranslation } from '../../i18n/I18nProvider';

/**
 * The only auth page: 1-click Telegram / LINE (opens an account automatically the first time),
 * an optional referral code, and a folded-away backup password login.
 */
export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const { t } = useTranslation();
  const [providers, setProviders] = useState<AuthProvidersResponse | null>(null);
  const [providersFailed, setProvidersFailed] = useState(false);
  const [ref, setRef] = useState('');
  const [refFromLink, setRefFromLink] = useState(false);
  const [starting, setStarting] = useState<OAuthProvider | null>(null);
  const [socialError, setSocialError] = useState('');
  const [tgWait, setTgWait] = useState<TelegramBotInitResponse | null>(null);

  const [pwOpen, setPwOpen] = useState(false);
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const fromUrl = (q.get('ref') || '').trim().slice(0, 64);
    const kept = recalledRef();
    if (fromUrl || kept) {
      setRef(fromUrl || kept);
      setRefFromLink(true);
      if (fromUrl) rememberRef(fromUrl);
    }
    // Sticky referral: URL → cookie → IndexedDB → localStorage → server (device hash)
    restoreReferral()
      .then((code) => {
        if (!code) return;
        setRef((cur) => (cur && cur.toLowerCase() !== code.toLowerCase() && !fromUrl ? cur : code));
        setRefFromLink(true);
      })
      .catch(() => {});
    if (q.get('mode') === 'password') setPwOpen(true);
    getAuthProviders()
      .then(setProviders)
      .catch(() => setProvidersFailed(true));
  }, []);

  const errText = (err: any) => {
    const key = authErrorKey(err);
    return key ? t(key) : err?.message || t('oauth.err.generic');
  };

  const go = async (provider: OAuthProvider) => {
    if (!providers) return;
    setSocialError('');
    // Telegram: open the tab for t.me synchronously inside the click (popup blockers)
    const tab = provider === 'telegram' ? prepareTab() : null;
    setStarting(provider);
    const code = ref.trim();
    const fail = (msg: string) => {
      try {
        tab?.close();
      } catch {
        /* ignore */
      }
      setSocialError(msg);
      setStarting(null);
    };
    if (code) {
      // Catch typos before leaving for Telegram / LINE: the upline cannot be changed later
      try {
        const r = await checkReferralCode(code);
        if (!r.valid) return fail(t('oauth.err.referral'));
      } catch {
        /* network hiccup: the server checks again */
      }
    }
    rememberRef(code || null);
    try {
      if (provider === 'line') {
        await startLine({ ref: code || null });
        return; // leaving for LINE
      }
      const init = await initTelegramBot({ ref: code || null });
      openDeepLink(tab, init.deepLinkUrl);
      setTgWait(init);
      setStarting(null);
    } catch (err) {
      fail(errText(err));
    }
  };

  /** Desktop fallback: the legacy Telegram web widget (asks for a phone number). */
  const goWidget = () => {
    if (!providers) return;
    setTgWait(null);
    if (!startTelegramWidget(providers, { ref: ref.trim() || null })) setSocialError(t('oauth.err.notConfigured'));
  };

  const finishBot = async (res: OAuthLoginResponse) => {
    if (!res.token) return setSocialError(t('oauth.err.generic'));
    setAuthToken(res.token, true);
    rememberRef(null);
    clearBootstrapCache();
    // Full navigation: the login page's "already signed in → feed" bounce must not win over /welcome
    window.location.replace(res.isNewUser ? '/welcome' : '/');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (id.trim().length < 3 || !password) {
      setError(t('login.missing'));
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{ token: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ usernameOrEmail: id.trim(), password }),
      });
      setAuthToken(res.token, remember);
      clearBootstrapCache();
      await refresh(true);
      router.replace('/');
    } catch (err: any) {
      setError(err?.message || t('login.failed'));
      setBusy(false);
    }
  };

  const tgOff = !!providers && !providers.telegramEnabled;
  const lineOff = !!providers && !providers.lineEnabled;

  return (
    <AuthCard title={t('login.title')} subtitle={t('oauth.subtitle')}>
      <div className="space-y-3" data-social-login>
        {tgWait ? (
          <TelegramBotWait init={tgWait} onSuccess={finishBot} onCancel={() => setTgWait(null)} onWidget={goWidget} />
        ) : (
        <ProviderButton
          provider="telegram"
          label={t('oauth.continueTelegram')}
          onClick={() => go('telegram')}
          disabled={!providers || tgOff || (!!starting && starting !== 'telegram')}
          busy={starting === 'telegram'}
          note={tgOff ? t('oauth.notReady') : null}
        />
        )}
        <ProviderButton
          provider="line"
          label={t('oauth.continueLine')}
          onClick={() => go('line')}
          disabled={!providers || lineOff || (!!starting && starting !== 'line')}
          busy={starting === 'line'}
          note={lineOff ? t('oauth.notReady') : null}
        />
        <p className="text-xs text-stone-500 text-center leading-relaxed px-1">{t('oauth.autoCreate')}</p>
        {providersFailed && <FormError msg={t('oauth.err.providers')} />}
        <FormError msg={socialError} />
      </div>

      <div className="mt-5">
        <FieldLabel htmlFor="login-ref">{t('oauth.refLabel')}</FieldLabel>
        <input
          id="login-ref"
          className={inputCls}
          value={ref}
          maxLength={64}
          onChange={(e) => {
            setRef(e.target.value);
            setRefFromLink(false);
          }}
          placeholder={t('oauth.refPlaceholder')}
          autoComplete="off"
          data-ref-input
        />
        <p className="text-[11px] text-stone-400 mt-1 ml-1">{refFromLink && ref ? t('oauth.refFilled') : t('oauth.refHint')}</p>
      </div>

      <div className="mt-5 pt-4 border-t border-stone-100">
        <button
          type="button"
          onClick={() => setPwOpen((v) => !v)}
          aria-expanded={pwOpen}
          className="w-full flex items-center justify-between gap-2 text-sm font-bold text-stone-500 hover:text-stone-900"
          data-password-toggle
        >
          <span>{t('oauth.passwordLogin')}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className={`transition ${pwOpen ? 'rotate-180' : ''}`}>
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {pwOpen && (
          <form onSubmit={submit} className="space-y-4 mt-4" noValidate data-password-form>
            <p className="text-xs text-stone-500">{t('oauth.passwordHint')}</p>
            <div>
              <FieldLabel htmlFor="login-id">{t('login.idLabel')}</FieldLabel>
              <input id="login-id" className={inputCls} autoComplete="username" value={id} onChange={(e) => setId(e.target.value)} placeholder="lemon_warrior" />
            </div>
            <div>
              <FieldLabel htmlFor="login-pw">{t('auth.password')}</FieldLabel>
              <div className="relative">
                <input
                  id="login-pw"
                  className={`${inputCls} pr-16`}
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
                <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-stone-500 hover:text-stone-800">
                  {showPw ? t('auth.hide') : t('auth.show')}
                </button>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-stone-600 font-medium cursor-pointer">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="w-4 h-4 rounded accent-[#FACC15]" />
              {t('login.remember')}
            </label>
            <FormError msg={error} />
            <button type="submit" disabled={busy} className={`${btn.primary} w-full py-3 text-[15px]`}>
              {busy ? t('login.signingIn') : t('login.signIn')}
            </button>
          </form>
        )}
      </div>
    </AuthCard>
  );
}
