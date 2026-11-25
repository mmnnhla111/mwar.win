'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { USERNAME_RE, BACKUP_PASSWORD_MIN } from '@mwar/shared';
import { getAuthToken, setBackupPassword, setUsernameOnce } from '../../lib/api';
import { authErrorKey, replaceAuthToken } from '../../lib/oauth';
import { useSession } from '../../lib/session';
import { AuthCard, FieldLabel, FormError } from '../../components/auth/AuthCard';
import { btn, inputCls } from '../../components/ui/Card';
import { useTranslation } from '../../i18n/I18nProvider';

/**
 * Shown once, right after Telegram / LINE opened a new account: optionally pick your own username
 * (once, never changeable afterwards) and a backup password. "Skip" sits at the top.
 */
export default function WelcomePage() {
  const router = useRouter();
  const { boot, patch } = useSession();
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!getAuthToken()) router.replace('/login');
  }, [router]);

  const skip = () => router.replace('/');

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const name = username.trim();
    if (!name && !password) return skip();
    if (name && !USERNAME_RE.test(name)) return setError(t('security.usernameRule'));
    if (password && password.length < BACKUP_PASSWORD_MIN) return setError(t('security.pwRule'));
    setBusy(true);
    try {
      const res = password ? await setBackupPassword(password, name || undefined) : await setUsernameOnce(name);
      if (res.token) replaceAuthToken(res.token);
      if (name) patch((b) => ({ ...b, user: { ...b.user, username: res.username } }));
      router.replace('/');
    } catch (err: any) {
      const key = authErrorKey(err);
      setError(key ? t(key) : err?.message || t('settings.saveFailed'));
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={t('welcome.title')}
      subtitle={t('welcome.subtitle')}
      headerAction={
        <button type="button" onClick={skip} className="rounded-full bg-stone-100 hover:bg-stone-200 px-3.5 py-1.5 text-sm font-extrabold text-stone-700" data-welcome-skip>
          {t('welcome.skip')} →
        </button>
      }
    >
      <form onSubmit={save} className="space-y-4" noValidate data-welcome-form>
        <div>
          <FieldLabel htmlFor="w-username">{t('security.username')}</FieldLabel>
          <input
            id="w-username"
            className={inputCls}
            value={username}
            maxLength={20}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
            placeholder={boot?.user.username || 'lemon_warrior'}
          />
          <p className="text-[11px] text-stone-400 mt-1 ml-1">{t('welcome.usernameHint')}</p>
        </div>
        <div>
          <FieldLabel htmlFor="w-pw">{t('security.backupPassword')}</FieldLabel>
          <div className="relative">
            <input
              id="w-pw"
              className={`${inputCls} pr-16`}
              type={showPw ? 'text' : 'password'}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
            <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-stone-500 hover:text-stone-800">
              {showPw ? t('auth.hide') : t('auth.show')}
            </button>
          </div>
          <p className="text-[11px] text-stone-400 mt-1 ml-1">{t('welcome.passwordHint')}</p>
        </div>
        <FormError msg={error} />
        <button type="submit" disabled={busy} className={`${btn.primary} w-full py-3 text-[15px]`}>
          {busy ? t('common.saving') : t('welcome.save')}
        </button>
        <p className="text-xs text-stone-400 text-center">{t('welcome.later')}</p>
      </form>
    </AuthCard>
  );
}
