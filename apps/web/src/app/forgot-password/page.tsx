'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { requestPasswordReset, resetPassword } from '../../lib/api';
import { AuthCard, FieldLabel, FormError, FormSuccess } from '../../components/auth/AuthCard';
import { btn, inputCls } from '../../components/ui/Card';

/**
 * Step 1: ask for a reset link by email. Step 2 (opened from the email, ?token=…): choose a new password.
 * The link expires after 15 minutes and works once.
 */
export default function ForgotPasswordPage() {
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [devLink, setDevLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token');
    if (t) setToken(t);
  }, []);

  const request = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setOk('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      const res = await requestPasswordReset(email.trim());
      setOk(res.message);
      if (res.devResetLink) setDevLink(res.devResetLink);
    } catch (err: any) {
      setError(err?.message || 'Could not send the reset link');
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (pw.length < 8) return setError('Password must be at least 8 characters.');
    if (pw !== pw2) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      const res = await resetPassword(token, pw);
      setOk(res.message);
      setDone(true);
    } catch (err: any) {
      setError(err?.message || 'Reset failed');
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <Link href="/login" className="font-extrabold text-stone-900 underline decoration-[#FACC15] decoration-[3px] underline-offset-4">
      ← Back to sign in
    </Link>
  );

  if (token) {
    return (
      <AuthCard title="ตั้งรหัสผ่านใหม่ 🔑" subtitle="Choose a new password for your account." footer={footer}>
        {done ? (
          <div className="space-y-4">
            <FormSuccess msg={ok} />
            <Link href="/login" className={`${btn.primary} w-full py-3`}>
              Sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={reset} className="space-y-4" noValidate>
            <div>
              <FieldLabel htmlFor="new-pw">New password</FieldLabel>
              <input id="new-pw" type="password" autoComplete="new-password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" />
            </div>
            <div>
              <FieldLabel htmlFor="new-pw2">Repeat new password</FieldLabel>
              <input id="new-pw2" type="password" autoComplete="new-password" className={inputCls} value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </div>
            <FormError msg={error} />
            <button type="submit" disabled={busy} className={`${btn.primary} w-full py-3`}>
              {busy ? 'Saving…' : 'Save new password'}
            </button>
          </form>
        )}
      </AuthCard>
    );
  }

  return (
    <AuthCard title="ลืมรหัสผ่าน? 🍋" subtitle="Enter your account email and we'll send you a reset link (valid 15 minutes)." footer={footer}>
      <form onSubmit={request} className="space-y-4" noValidate>
        <div>
          <FieldLabel htmlFor="fp-email">Email</FieldLabel>
          <input id="fp-email" type="email" autoComplete="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </div>
        <FormError msg={error} />
        <FormSuccess msg={ok} />
        {devLink && (
          <p className="rounded-2xl bg-[#E0F2FE] text-sky-800 text-xs px-4 py-2.5 break-all">
            Dev mode (no mail service yet): <a className="underline font-semibold" href={devLink.replace(/^https?:\/\/[^/]+/, '')}>open reset link</a>
          </p>
        )}
        <button type="submit" disabled={busy} className={`${btn.primary} w-full py-3`}>
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
    </AuthCard>
  );
}
