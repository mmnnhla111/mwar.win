'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, setAuthToken, clearBootstrapCache } from '../../lib/api';
import { useSession } from '../../lib/session';
import { AuthCard, FieldLabel, FormError } from '../../components/auth/AuthCard';
import { btn, inputCls } from '../../components/ui/Card';
import { useTranslation } from '../../i18n/I18nProvider';

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const { t } = useTranslation();
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  return (
    <AuthCard
      title={t('login.title')}
      subtitle={t('login.subtitle')}
      footer={
        <span>
          {t('login.newHere')}{' '}
          <Link href="/register" className="font-extrabold text-stone-900 underline decoration-[#FACC15] decoration-[3px] underline-offset-4">
            {t('login.createAccount')}
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
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
        <div className="flex items-center justify-between text-sm">
          <label className="flex items-center gap-2 text-stone-600 font-medium cursor-pointer">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="w-4 h-4 rounded accent-[#FACC15]" />
            {t('login.remember')}
          </label>
          <Link href="/forgot-password" className="font-semibold text-stone-500 hover:text-stone-900">
            {t('login.forgot')}
          </Link>
        </div>
        <FormError msg={error} />
        <button type="submit" disabled={busy} className={`${btn.primary} w-full py-3 text-[15px]`}>
          {busy ? t('login.signingIn') : t('login.signIn')}
        </button>
      </form>
    </AuthCard>
  );
}
