'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, setAuthToken, clearBootstrapCache } from '../../lib/api';
import { useSession } from '../../lib/session';
import { AuthCard, FieldLabel, FormError } from '../../components/auth/AuthCard';
import { btn, inputCls } from '../../components/ui/Card';
import { useTranslation } from '../../i18n/I18nProvider';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function RegisterPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [refCode, setRefCode] = useState('');
  const [refLocked, setRefLocked] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get('ref');
    if (ref) {
      setRefCode(ref.slice(0, 64));
      setRefLocked(true);
    }
  }, []);

  const errors = {
    username: !USERNAME_RE.test(username) ? t('register.usernameRule') : '',
    email: !EMAIL_RE.test(email) ? t('register.emailRule') : '',
    password: password.length < 8 ? t('register.passwordRule') : '',
  };
  const valid = !errors.username && !errors.email && !errors.password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ username: true, email: true, password: true });
    setError('');
    if (!valid) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ token: string }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, email: email.trim(), password, referrer_id: refCode.trim() || undefined }),
      });
      setAuthToken(res.token, true);
      clearBootstrapCache();
      await refresh(true);
      router.replace('/');
    } catch (err: any) {
      setError(err?.message || t('register.failed'));
      setBusy(false);
    }
  };

  const hint = (k: keyof typeof errors) =>
    touched[k] && errors[k] ? <p className="text-xs font-semibold text-rose-500 mt-1 ml-1">{errors[k]}</p> : null;

  return (
    <AuthCard
      title={t('register.title')}
      subtitle={t('register.subtitle')}
      footer={
        <span>
          {t('register.haveAccount')}{' '}
          <Link href="/login" className="font-extrabold text-stone-900 underline decoration-[#FACC15] decoration-[3px] underline-offset-4">
            {t('register.signIn')}
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <FieldLabel htmlFor="reg-user">{t('register.username')}</FieldLabel>
          <input
            id="reg-user"
            className={inputCls}
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, username: true }))}
            placeholder="lemon_warrior"
          />
          {hint('username')}
        </div>
        <div>
          <FieldLabel htmlFor="reg-email">{t('register.email')}</FieldLabel>
          <input
            id="reg-email"
            className={inputCls}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, email: true }))}
            placeholder="you@example.com"
          />
          {hint('email')}
        </div>
        <div>
          <FieldLabel htmlFor="reg-pw">{t('auth.password')}</FieldLabel>
          <input
            id="reg-pw"
            className={inputCls}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, password: true }))}
            placeholder={t('register.passwordRule')}
          />
          {hint('password')}
        </div>
        <div>
          <FieldLabel htmlFor="reg-ref">{t('register.ref')}</FieldLabel>
          <input
            id="reg-ref"
            className={`${inputCls} ${refLocked ? 'bg-[#FFFBEA] border-[#FDE68A]' : ''}`}
            value={refCode}
            onChange={(e) => {
              setRefCode(e.target.value);
              setRefLocked(false);
            }}
            placeholder={t('register.refPlaceholder')}
          />
          {refLocked && <p className="text-xs font-semibold text-[#B08600] mt-1 ml-1">{t('register.refFilled')}</p>}
        </div>
        <FormError msg={error} />
        <button type="submit" disabled={busy} className={`${btn.primary} w-full py-3 text-[15px]`}>
          {busy ? t('register.creating') : t('register.create')}
        </button>
      </form>
    </AuthCard>
  );
}
