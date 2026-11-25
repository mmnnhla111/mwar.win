'use client';

import React, { useEffect, useState } from 'react';
import type { AuthProvidersResponse, LinkedAccountsResponse, OAuthProvider } from '@mwar/shared';
import { USERNAME_RE, BACKUP_PASSWORD_MIN } from '@mwar/shared';
import { getAuthProviders, getLinkedAccounts, setBackupPassword, setUsernameOnce, unlinkAccount } from '../../lib/api';
import { authErrorKey, replaceAuthToken, startLine, startTelegram } from '../../lib/oauth';
import { useSession } from '../../lib/session';
import { Card, Spinner, btn, inputCls } from '../ui/Card';
import { TelegramIcon, LineIcon } from '../auth/ProviderButtons';
import { useTranslation } from '../../i18n/I18nProvider';

const msgCls = (ok: boolean) =>
  `rounded-2xl text-sm font-semibold px-4 py-2.5 ${ok ? 'bg-[#D1FAE5] text-emerald-700' : 'bg-[#FFE4E6] text-rose-600'}`;

/** /settings → Connected accounts & backup: Telegram / LINE (connect, change, disconnect), username (once), backup password. */
export function ConnectedAccounts() {
  const { t, lang } = useTranslation();
  const { patch } = useSession();
  const [data, setData] = useState<LinkedAccountsResponse | null>(null);
  const [providers, setProviders] = useState<AuthProvidersResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // "Telegram connected." after the link redirect (translated at render: the dictionary may still be loading)
  const [justLinked, setJustLinked] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');

  const errText = (err: any) => {
    const key = authErrorKey(err);
    return key ? t(key) : err?.message || t('settings.saveFailed');
  };

  const load = () =>
    getLinkedAccounts()
      .then((d) => {
        setData(d);
        setLoadError('');
      })
      .catch((err) => setLoadError(errText(err)));

  useEffect(() => {
    load();
    getAuthProviders().then(setProviders).catch(() => {});
    // Back from the Telegram / LINE link flow
    const linked = new URLSearchParams(window.location.search).get('linked');
    if (linked === 'telegram' || linked === 'line') {
      setJustLinked(linked === 'telegram' ? 'Telegram' : 'LINE');
      window.history.replaceState(null, '', window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = (p: OAuthProvider) => {
    if (!providers) return;
    setMsg(null);
    const ok = p === 'telegram' ? startTelegram(providers, { link: true }) : startLine(providers, { link: true });
    if (!ok) setMsg({ ok: false, text: t('oauth.err.notConfigured') });
  };

  const disconnect = async (p: OAuthProvider) => {
    setBusy(`unlink-${p}`);
    setMsg(null);
    try {
      await unlinkAccount(p);
      await load();
      setMsg({ ok: true, text: t('security.unlinkedOk', { name: p === 'telegram' ? 'Telegram' : 'LINE' }) });
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  const saveUsername = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    if (!USERNAME_RE.test(name)) return setMsg({ ok: false, text: t('security.usernameRule') });
    setBusy('username');
    setMsg(null);
    try {
      const r = await setUsernameOnce(name);
      replaceAuthToken(r.token);
      patch((b) => ({ ...b, user: { ...b.user, username: r.username } }));
      setUsername('');
      await load();
      setMsg({ ok: true, text: t('security.usernameSaved') });
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < BACKUP_PASSWORD_MIN) return setMsg({ ok: false, text: t('security.pwRule') });
    if (pw !== pw2) return setMsg({ ok: false, text: t('security.pwMismatch') });
    setBusy('password');
    setMsg(null);
    try {
      await setBackupPassword(pw);
      setPw('');
      setPw2('');
      await load();
      setMsg({ ok: true, text: t('security.pwSaved') });
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  const linkedCount = (data?.telegram ? 1 : 0) + (data?.line ? 1 : 0);
  const cooldownUntil = data?.passwordChangeAvailableAt ? new Date(data.passwordChangeAvailableAt * 1000) : null;

  const providerRow = (p: OAuthProvider) => {
    const acc = p === 'telegram' ? data?.telegram : data?.line;
    const enabled = p === 'telegram' ? providers?.telegramEnabled : providers?.lineEnabled;
    const name = p === 'telegram' ? 'Telegram' : 'LINE';
    const who = acc ? (p === 'telegram' && acc.username ? `@${acc.username}` : acc.displayName || acc.username || '') : '';
    return (
      <div className="flex items-center gap-3 py-3" data-linked-row={p} data-linked={acc ? 'yes' : 'no'}>
        <span className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${p === 'telegram' ? 'bg-[#24A1DE]' : 'bg-[#06C755]'}`}>
          {p === 'telegram' ? <TelegramIcon size={24} /> : <LineIcon size={24} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-bold text-stone-900">{name}</div>
          <div className={`text-xs truncate ${acc ? 'text-emerald-600 font-semibold' : 'text-stone-400'}`}>
            {acc ? t('security.connectedAs', { name: who || name }) : enabled === false ? t('oauth.notReady') : t('security.notConnected')}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5 shrink-0">
          {acc ? (
            <>
              <button type="button" onClick={() => connect(p)} disabled={!enabled} className={`${btn.soft} !px-3 !py-1.5 text-xs`} data-change={p}>
                {t('security.change')}
              </button>
              {linkedCount > 1 && (
                <button type="button" onClick={() => disconnect(p)} disabled={busy === `unlink-${p}`} className={`${btn.ghost} !px-3 !py-1.5 text-xs text-rose-600`}>
                  {t('security.disconnect')}
                </button>
              )}
            </>
          ) : (
            <button type="button" onClick={() => connect(p)} disabled={!enabled} className={`${btn.primary} !px-3 !py-1.5 text-xs`} data-connect={p}>
              {t('security.connect')}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card className="p-5" data-settings-security>
      <h2 className="text-sm font-black text-stone-500 uppercase tracking-wider">{t('security.title')}</h2>
      <p className="text-sm text-stone-500 mt-1">{t('security.hint')}</p>

      {!data && !loadError && (
        <div className="py-6 flex justify-center">
          <Spinner size={20} />
        </div>
      )}
      {loadError && <p className={`${msgCls(false)} mt-3`}>{loadError}</p>}

      {data && (
        <>
          <div className="mt-2 divide-y divide-stone-100">
            {providerRow('telegram')}
            {providerRow('line')}
          </div>
          <p className="text-[11px] text-stone-400">{t('security.changeHint')}</p>

          {/* Username: choose once */}
          <div className="mt-5 pt-4 border-t border-stone-100">
            <div className="font-bold text-stone-900">{t('security.username')}</div>
            {data.usernameLocked ? (
              <p className="text-sm text-stone-500 mt-1" data-username-locked>
                <b className="text-stone-800">@{data.username}</b> · {t('security.usernameLocked')}
              </p>
            ) : (
              <form onSubmit={saveUsername} className="mt-2 space-y-2" data-username-form>
                <p className="text-xs text-stone-500">{t('security.usernameOnce', { name: data.username })}</p>
                <div className="flex gap-2">
                  <input
                    className={`${inputCls} min-w-0 flex-1`}
                    value={username}
                    maxLength={20}
                    onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
                    placeholder={data.username}
                    aria-label={t('security.username')}
                  />
                  <button type="submit" disabled={busy === 'username' || !username.trim()} className={`${btn.primary} shrink-0`}>
                    {busy === 'username' ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Backup password */}
          <form onSubmit={savePassword} className="mt-5 pt-4 border-t border-stone-100 space-y-2" data-password-form>
            <div className="flex items-center justify-between gap-2">
              <div className="font-bold text-stone-900">{t('security.backupPassword')}</div>
              <span className={`text-[11px] font-bold rounded-full px-2.5 py-1 ${data.hasPassword ? 'bg-[#D1FAE5] text-emerald-700' : 'bg-stone-100 text-stone-500'}`}>
                {data.hasPassword ? t('security.pwSet') : t('security.pwNotSet')}
              </span>
            </div>
            <p className="text-xs text-stone-500">{t('security.pwHint')}</p>
            {cooldownUntil ? (
              <p className="text-xs font-semibold text-amber-700 bg-[#FFFBEA] rounded-2xl px-3 py-2" data-pw-cooldown>
                {t('security.pwCooldown', { time: cooldownUntil.toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }) })}
              </p>
            ) : (
              <>
                <div className="grid sm:grid-cols-2 gap-2">
                  <input type="password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t('security.newPw')} autoComplete="new-password" aria-label={t('security.newPw')} />
                  <input type="password" className={inputCls} value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder={t('security.repeatPw')} autoComplete="new-password" aria-label={t('security.repeatPw')} />
                </div>
                <button type="submit" disabled={busy === 'password' || !pw} className={btn.primary}>
                  {busy === 'password' ? t('common.saving') : data.hasPassword ? t('security.changePw') : t('security.setPw')}
                </button>
              </>
            )}
          </form>
        </>
      )}

      {(msg || justLinked) && (
        <p className={`${msgCls(msg ? msg.ok : true)} mt-4`} data-security-msg>
          {msg ? msg.text : t('security.linkedOk', { name: justLinked || '' })}
        </p>
      )}
    </Card>
  );
}
