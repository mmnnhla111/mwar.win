'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, setAuthToken, clearBootstrapCache } from '../../lib/api';
import { useSession } from '../../lib/session';
import { AuthCard, FieldLabel, FormError } from '../../components/auth/AuthCard';
import { btn, inputCls } from '../../components/ui/Card';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function RegisterPage() {
  const router = useRouter();
  const { refresh } = useSession();
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
    username: !USERNAME_RE.test(username) ? '3–20 letters, numbers or _' : '',
    email: !EMAIL_RE.test(email) ? 'Enter a valid email' : '',
    password: password.length < 8 ? 'At least 8 characters' : '',
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
      setError(err?.message || 'Sign up failed');
      setBusy(false);
    }
  };

  const hint = (k: keyof typeof errors) =>
    touched[k] && errors[k] ? <p className="text-xs font-semibold text-rose-500 mt-1 ml-1">{errors[k]}</p> : null;

  return (
    <AuthCard
      title="สมัครสมาชิก ✨"
      subtitle="Create your account and join the squad."
      footer={
        <span>
          Already have an account?{' '}
          <Link href="/login" className="font-extrabold text-stone-900 underline decoration-[#FACC15] decoration-[3px] underline-offset-4">
            Sign in
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <FieldLabel htmlFor="reg-user">Username</FieldLabel>
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
          <FieldLabel htmlFor="reg-email">Email</FieldLabel>
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
          <FieldLabel htmlFor="reg-pw">Password</FieldLabel>
          <input
            id="reg-pw"
            className={inputCls}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, password: true }))}
            placeholder="At least 8 characters"
          />
          {hint('password')}
        </div>
        <div>
          <FieldLabel htmlFor="reg-ref">Referral / upline code (optional)</FieldLabel>
          <input
            id="reg-ref"
            className={`${inputCls} ${refLocked ? 'bg-[#FFFBEA] border-[#FDE68A]' : ''}`}
            value={refCode}
            onChange={(e) => {
              setRefCode(e.target.value);
              setRefLocked(false);
            }}
            placeholder="Friend's username or code"
          />
          {refLocked && <p className="text-xs font-semibold text-[#B08600] mt-1 ml-1">Filled in from your invite link 🍋</p>}
        </div>
        <FormError msg={error} />
        <button type="submit" disabled={busy} className={`${btn.primary} w-full py-3 text-[15px]`}>
          {busy ? 'Creating account…' : 'สร้างบัญชี (Create Account)'}
        </button>
      </form>
    </AuthCard>
  );
}
