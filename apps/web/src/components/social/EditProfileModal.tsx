'use client';

import React, { useEffect, useRef, useState } from 'react';
import { PROFILE_COVER_COLORS, PROFILE_COVER_IDS, SOCIAL_BIO_MAX_CHARS, SOCIAL_DISPLAY_NAME_MAX_CHARS } from '@mwar/shared';
import type { ProfileCoverColor, SocialProfile } from '@mwar/shared';
import { Avatar } from '../ui/Avatar';
import { Modal, btn, inputCls } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { updateSocialProfile, uploadMedia } from '../../lib/api';
import { compressImageToWebp } from '../../lib/image';
import { useTranslation } from '../../i18n/I18nProvider';
import { EarningsVisibilityPicker } from '../settings/EarningsVisibility';

export const coverStyle = (c: ProfileCoverColor) => {
  const [a, b] = PROFILE_COVER_COLORS[c] || PROFILE_COVER_COLORS.lemon;
  return { background: `linear-gradient(135deg, ${a} 0%, ${b} 100%)` };
};

/** Edit display name, bio, avatar and pastel cover (used on /profile and /settings). */
export function EditProfileModal({
  open,
  profile,
  onClose,
  onSaved,
}: {
  open: boolean;
  profile: SocialProfile;
  onClose: () => void;
  onSaved: (changes: Partial<SocialProfile>) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(profile.displayName || '');
  const [bio, setBio] = useState(profile.bio || '');
  const [cover, setCover] = useState<ProfileCoverColor>(profile.coverColor);
  const [avatar, setAvatar] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(profile.displayName || '');
      setBio(profile.bio || '');
      setCover(profile.coverColor);
      setAvatar(null);
      setError('');
    }
  }, [open, profile]);

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      // Avatars are shown small: 320 px wide is plenty and keeps the file tiny
      const blob = await compressImageToWebp(f, 320);
      setAvatar({ blob, url: URL.createObjectURL(blob) });
    } catch (err: any) {
      setError(err?.message || t('composer.photoFailed'));
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const avatarUrl = avatar ? await uploadMedia(avatar.blob) : undefined;
      await updateSocialProfile({ displayName: name.trim(), bio: bio.trim(), coverColor: cover, ...(avatarUrl ? { avatarUrl } : {}) });
      onSaved({ displayName: name.trim() || null, bio: bio.trim() || null, coverColor: cover, ...(avatarUrl ? { avatarUrl } : {}) });
      onClose();
    } catch (err: any) {
      setError(err?.message || t('settings.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('profile.edit')}>
      <div className="p-5 space-y-4">
        <div className="rounded-3xl overflow-hidden border border-stone-100">
          <div className="h-20" style={coverStyle(cover)} />
          <div className="px-4 pb-4 -mt-8 flex items-end gap-3">
            <Avatar src={avatar?.url || profile.avatarUrl} name={name || profile.username} size={68} ring className="ring-4 relative z-10" />
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pick} />
            <button onClick={() => fileRef.current?.click()} className={`${btn.soft} mb-1`}>
              <Icon name="image" size={16} /> {t('profile.changePhoto')}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs font-bold text-stone-600 mb-1.5 ml-1">{t('profile.cover')}</label>
          <div className="flex gap-2 flex-wrap">
            {PROFILE_COVER_IDS.map((c) => (
              <button
                key={c}
                onClick={() => setCover(c)}
                aria-label={c}
                className={`w-10 h-10 rounded-full border-2 transition ${cover === c ? 'border-stone-900 scale-110' : 'border-white shadow'}`}
                style={coverStyle(c)}
              />
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="ep-name" className="block text-xs font-bold text-stone-600 mb-1.5 ml-1">
            {t('profile.displayName')}
          </label>
          <input id="ep-name" className={inputCls} value={name} maxLength={SOCIAL_DISPLAY_NAME_MAX_CHARS} onChange={(e) => setName(e.target.value)} placeholder={profile.username} />
        </div>
        <div>
          <label htmlFor="ep-bio" className="block text-xs font-bold text-stone-600 mb-1.5 ml-1">
            {t('profile.bio')}
          </label>
          <textarea id="ep-bio" rows={3} className={`${inputCls} resize-none`} value={bio} maxLength={SOCIAL_BIO_MAX_CHARS} onChange={(e) => setBio(e.target.value)} placeholder={t('profile.bioPlaceholder')} />
          <div className="text-right text-[11px] text-stone-400 mt-1">
            {bio.length}/{SOCIAL_BIO_MAX_CHARS}
          </div>
        </div>
        <div>
          <label className="block text-xs font-bold text-stone-600 mb-1.5 ml-1">{t('earnings.visibility')}</label>
          <EarningsVisibilityPicker compact onSaved={(v) => onSaved({ totalEarnings: { ...profile.totalEarnings, visibility: v } })} />
        </div>
        {error && <p className="rounded-2xl bg-[#FFE4E6] text-rose-600 text-sm font-semibold px-4 py-2.5">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className={btn.soft}>
            {t('common.cancel')}
          </button>
          <button onClick={save} disabled={busy} className={btn.primary}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
