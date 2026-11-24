'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import type { SocialProfile } from '@mwar/shared';
import { Card, Modal, Spinner, btn } from '../../components/ui/Card';
import { Avatar } from '../../components/ui/Avatar';
import { Icon } from '../../components/ui/Icon';
import { EditProfileModal, coverStyle } from '../../components/social/EditProfileModal';
import { getProfile, updateSocialSettings } from '../../lib/api';
import { useSession } from '../../lib/session';
import { memoDrop } from '../../lib/memo';
import { displayName } from '../../lib/format';
import { LanguageGrid } from '../../components/i18n/LanguagePicker';
import { useTranslation } from '../../i18n/I18nProvider';

function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-nsfw-toggle={on ? 'on' : 'off'}
      disabled={disabled}
      onClick={onChange}
      className={`relative w-12 h-7 rounded-full transition shrink-0 ${on ? 'bg-[#FF6B6B]' : 'bg-stone-300'} disabled:opacity-50`}
    >
      <span className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

/** /settings — content preferences (18+ age gate) and profile settings, Lemon8 minimalist style. */
export default function SettingsPage() {
  const { boot, patch } = useSession();
  const { t } = useTranslation();
  const user = boot?.user;
  const showNsfw = !!user?.showNsfw;
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState('');
  const [editProfile, setEditProfile] = useState<SocialProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);

  const save = async (next: boolean) => {
    setBusy(true);
    setError('');
    try {
      await updateSocialSettings({ showNsfw: next, confirmAdult: next ? true : undefined });
      // Update the cached /api/bootstrap state at once (no extra request) and drop cached feeds
      patch((b) => ({ ...b, user: { ...b.user, showNsfw: next } }));
      memoDrop('feed:');
      memoDrop('profile:');
    } catch (err: any) {
      setError(err?.message || t('settings.saveFailed'));
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const openEdit = async () => {
    setLoadingProfile(true);
    try {
      const r = await getProfile();
      setEditProfile(r.profile);
    } catch (err: any) {
      setError(err?.message || t('settings.profileFailed'));
    } finally {
      setLoadingProfile(false);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-2xl font-black text-stone-900 flex items-center gap-2">
        <Icon name="edit" size={22} /> {t('nav.settings')}
      </h1>

      <Card className="p-5" data-settings-language>
        <h2 className="text-sm font-black text-stone-500 uppercase tracking-wider">{t('settings.language')}</h2>
        <p className="text-sm text-stone-500 mt-1 mb-3">{t('settings.languageHint')}</p>
        <LanguageGrid />
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-black text-stone-500 uppercase tracking-wider">{t('settings.content')}</h2>
        <div className="mt-4 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="font-bold text-stone-900">{t('settings.nsfwLabel')}</div>
            <p className="text-sm text-stone-500 mt-0.5">
              {t('settings.nsfwHint')}
            </p>
          </div>
          <Toggle label={t('settings.nsfwLabel')} on={showNsfw} disabled={busy || !user} onChange={() => (showNsfw ? save(false) : setConfirmOpen(true))} />
        </div>
        <div className="mt-4 rounded-2xl bg-[#FFFBEA] border border-yellow-200 px-4 py-3 text-xs text-stone-600 leading-relaxed">
          <b>{t('settings.policyTitle')}</b> {t('settings.policy')}
        </div>
        {error && <p className="mt-3 text-sm font-semibold text-rose-500">{error}</p>}
      </Card>

      <Card className="overflow-hidden">
        <div className="h-20" style={coverStyle(user?.coverColor || 'lemon')} />
        <div className="px-5 pb-5 -mt-8 flex items-end gap-3 flex-wrap">
          <Avatar src={user?.avatarUrl} name={user ? displayName(user) : '?'} size={68} ring className="ring-4 relative z-10" />
          <div className="min-w-[8rem] flex-1 pb-1">
            <div className="font-bold text-stone-900 truncate">{user ? displayName(user) : '…'}</div>
            <div className="text-xs text-stone-400 truncate">@{user?.username}</div>
          </div>
          <button onClick={openEdit} disabled={loadingProfile || !user} className={`${btn.soft} w-full sm:w-auto justify-center`}>
            {loadingProfile ? <Spinner size={16} /> : <Icon name="edit" size={16} />} {t('profile.edit')}
          </button>
        </div>
        <p className="px-5 pb-5 text-xs text-stone-400">{t('settings.profileHint')}</p>
      </Card>

      <Card className="p-5 flex items-center gap-3">
        <Icon name="shield" size={20} />
        <div className="min-w-0 flex-1 text-sm text-stone-600">
          {t('settings.reportHint')}
        </div>
        <Link href="/" className={btn.ghost}>
          {t('nav.home')}
        </Link>
      </Card>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title={t('settings.ageTitle')}>
        <div className="p-1 space-y-3" data-age-confirm>
          <div className="mx-auto w-14 h-14 rounded-full bg-rose-100 text-rose-600 font-black flex items-center justify-center">18+</div>
          <p className="text-sm text-stone-700 text-center">
            {t('settings.ageText')}
          </p>
          <div className="flex justify-center gap-2 pt-1">
            <button onClick={() => setConfirmOpen(false)} className={btn.soft}>
              {t('common.cancel')}
            </button>
            <button onClick={() => save(true)} disabled={busy} className={btn.primary} data-age-yes>
              {t('settings.ageYes')}
            </button>
          </div>
        </div>
      </Modal>

      {editProfile && (
        <EditProfileModal
          open={!!editProfile}
          profile={editProfile}
          onClose={() => setEditProfile(null)}
          onSaved={(changes) => {
            patch((b) => ({
              ...b,
              user: {
                ...b.user,
                ...(changes.displayName !== undefined ? { displayName: changes.displayName } : {}),
                ...(changes.avatarUrl ? { avatarUrl: changes.avatarUrl } : {}),
                ...(changes.coverColor ? { coverColor: changes.coverColor } : {}),
              },
            }));
            memoDrop('profile:');
          }}
        />
      )}
    </div>
  );
}
