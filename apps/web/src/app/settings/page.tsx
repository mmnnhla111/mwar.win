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
      setError(err?.message || 'Could not save');
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
      setError(err?.message || 'Could not load your profile');
    } finally {
      setLoadingProfile(false);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-2xl font-black text-stone-900 flex items-center gap-2">
        <Icon name="edit" size={22} /> ตั้งค่า <span className="text-stone-400 text-base font-bold">Settings</span>
      </h1>

      <Card className="p-5">
        <h2 className="text-sm font-black text-stone-500 uppercase tracking-wider">การตั้งค่าเนื้อหา (Content Preferences)</h2>
        <div className="mt-4 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="font-bold text-stone-900">แสดงภาพและวิดีโอ 18+ (Show 18+ / NSFW Content)</div>
            <p className="text-sm text-stone-500 mt-0.5">
              ปิดไว้เป็นค่าเริ่มต้น เมื่อปิด โพสต์ที่ติดป้าย 18+ จะไม่ถูกส่งมาที่เครื่องคุณเลย. Off by default: 18+ posts are never sent to you while this is off.
            </p>
          </div>
          <Toggle label="Show 18+ content" on={showNsfw} disabled={busy || !user} onChange={() => (showNsfw ? save(false) : setConfirmOpen(true))} />
        </div>
        <div className="mt-4 rounded-2xl bg-[#FFFBEA] border border-yellow-200 px-4 py-3 text-xs text-stone-600 leading-relaxed">
          <b>นโยบายเนื้อหา:</b> ห้ามอาวุธจริง เลือด/บาดแผล และความรุนแรง (ลบอัตโนมัติ) • ภาพโป๊/18+ อนุญาตแต่จะถูกจัดหมวด 18+ และซ่อนไว้ •
          <span className="block mt-1">
            Weapons, blood and violence are removed automatically. Nudity is allowed but labelled 18+ and hidden unless you turn this on.
          </span>
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
            {loadingProfile ? <Spinner size={16} /> : <Icon name="edit" size={16} />} แก้ไขโปรไฟล์ / Edit profile
          </button>
        </div>
        <p className="px-5 pb-5 text-xs text-stone-400">Display name, bio, avatar and pastel cover.</p>
      </Card>

      <Card className="p-5 flex items-center gap-3">
        <Icon name="shield" size={20} />
        <div className="min-w-0 flex-1 text-sm text-stone-600">
          เห็นเนื้อหาที่ไม่เหมาะสม? กด <b>…</b> บนโพสต์ แล้วเลือก <b>แจ้งขอให้ลบ / Report</b>
        </div>
        <Link href="/" className={btn.ghost}>
          Feed
        </Link>
      </Card>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="ยืนยันอายุ 18+ (Age confirmation)">
        <div className="p-1 space-y-3" data-age-confirm>
          <div className="mx-auto w-14 h-14 rounded-full bg-rose-100 text-rose-600 font-black flex items-center justify-center">18+</div>
          <p className="text-sm text-stone-700 text-center">
            ฉันยืนยันว่ามีอายุ 18 ปีขึ้นไป และต้องการเห็นภาพ/วิดีโอสำหรับผู้ใหญ่
            <br />
            <span className="text-stone-500">I confirm I am 18 or older and want to see adult content.</span>
          </p>
          <div className="flex justify-center gap-2 pt-1">
            <button onClick={() => setConfirmOpen(false)} className={btn.soft}>
              ยกเลิก / Cancel
            </button>
            <button onClick={() => save(true)} disabled={busy} className={btn.primary} data-age-yes>
              ฉันอายุ 18+ / I am 18+
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
