'use client';

import React, { useEffect, useRef, useState } from 'react';
import { COVER_MAX_BYTES, COVER_MAX_HEIGHT, COVER_MAX_WIDTH, PROFILE_COVER_COLORS, PROFILE_COVER_IDS, SOCIAL_BIO_MAX_CHARS, SOCIAL_DISPLAY_NAME_MAX_CHARS } from '@mwar/shared';
import type { ProfileCoverColor, SocialProfile } from '@mwar/shared';
import { Avatar } from '../ui/Avatar';
import { Modal, btn, inputCls } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { updateSocialProfile, uploadCover, uploadMedia } from '../../lib/api';
import { loadMediaCompress, preloadMediaCompress } from '../../lib/mediaCompress';
import { compressImageToWebp } from '../../lib/image';
import { useTranslation } from '../../i18n/I18nProvider';
import { EarningsVisibilityPicker } from '../settings/EarningsVisibility';

/** Cover photo when there is one, on top of the pastel gradient (also the fallback while it loads / fails). */
export const coverStyle = (c: ProfileCoverColor, url?: string | null): React.CSSProperties => {
  const [a, b] = PROFILE_COVER_COLORS[c] || PROFILE_COVER_COLORS.lemon;
  const grad = `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
  return url
    ? { backgroundImage: `url("${url.replace(/"/g, '%22')}"), ${grad}`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: grad };
};

/** Pick + compress a cover photo on the device: WebP, 1200x400 (centre crop), <= 250 KB. */
export async function compressCover(f: File): Promise<Blob> {
  const lib = await loadMediaCompress();
  const out = await lib.compressImage(f, { maxWidth: COVER_MAX_WIDTH, maxHeight: COVER_MAX_HEIGHT, crop: 'cover', maxBytes: COVER_MAX_BYTES - 2048, forceWebp: true });
  return out.blob;
}

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
  // null = unchanged, 'remove' = back to the gradient
  const [coverPhoto, setCoverPhoto] = useState<{ blob: Blob; url: string } | 'remove' | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const coverRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(profile.displayName || '');
      setBio(profile.bio || '');
      setCover(profile.coverColor);
      setAvatar(null);
      setCoverPhoto(null);
      setError('');
      preloadMediaCompress();
    }
  }, [open, profile]);

  const pickCover = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setCoverBusy(true);
    setError('');
    try {
      const blob = await compressCover(f);
      setCoverPhoto({ blob, url: URL.createObjectURL(blob) });
    } catch (err: any) {
      setError(err?.message || t('composer.photoFailed'));
    } finally {
      setCoverBusy(false);
    }
  };
  const coverPreview = coverPhoto === 'remove' ? null : coverPhoto?.url || profile.coverUrl;

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
      const coverUrl = coverPhoto === 'remove' ? null : coverPhoto ? await uploadCover(coverPhoto.blob) : undefined;
      await updateSocialProfile({ displayName: name.trim(), bio: bio.trim(), coverColor: cover, ...(avatarUrl ? { avatarUrl } : {}), ...(coverUrl !== undefined ? { coverUrl } : {}) });
      onSaved({ displayName: name.trim() || null, bio: bio.trim() || null, coverColor: cover, ...(avatarUrl ? { avatarUrl } : {}), ...(coverUrl !== undefined ? { coverUrl } : {}) });
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
          <div className="h-24 relative" style={coverStyle(cover, coverPreview)} data-cover-preview={coverPreview ? 'photo' : 'gradient'}>
            <input ref={coverRef} type="file" accept="image/*" className="hidden" onChange={pickCover} />
            <div className="absolute top-2 right-2 flex gap-1.5">
              <button onClick={() => coverRef.current?.click()} disabled={coverBusy} className="rounded-full bg-white/90 px-3 py-1 text-xs font-bold text-stone-700 shadow" data-cover-pick>
                {coverBusy ? t('composer.compressing') : t('profile.coverPhoto')}
              </button>
              {coverPreview && (
                <button onClick={() => setCoverPhoto('remove')} className="rounded-full bg-white/90 px-2.5 py-1 text-xs font-bold text-rose-500 shadow" aria-label={t('profile.coverRemove')}>
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
          </div>
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
          <p className="text-[11px] text-stone-400 mb-1.5 ml-1">{t('profile.coverHint')}</p>
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
