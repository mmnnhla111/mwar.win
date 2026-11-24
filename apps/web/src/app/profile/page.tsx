'use client';

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PROFILE_COVER_COLORS, PROFILE_COVER_IDS, SOCIAL_BIO_MAX_CHARS, SOCIAL_DISPLAY_NAME_MAX_CHARS } from '@mwar/shared';
import type { ProfileCoverColor, SocialPost, SocialProfile } from '@mwar/shared';
import { Avatar } from '../../components/ui/Avatar';
import { Card, Modal, Spinner, btn, inputCls } from '../../components/ui/Card';
import { Icon, type IconName } from '../../components/ui/Icon';
import { FeedList } from '../../components/social/FeedList';
import { getFeed, getProfile, setFollow, updateSocialProfile, uploadMedia } from '../../lib/api';
import { compressImageToWebp } from '../../lib/image';
import { useSession } from '../../lib/session';
import { displayName, formatCount, formatUsd } from '../../lib/format';
import { memoDrop, memoGet, memoSet } from '../../lib/memo';

type ProfileState = { profile: SocialProfile; posts: SocialPost[]; next: string | null };

const coverStyle = (c: ProfileCoverColor) => {
  const [a, b] = PROFILE_COVER_COLORS[c] || PROFILE_COVER_COLORS.lemon;
  return { background: `linear-gradient(135deg, ${a} 0%, ${b} 100%)` };
};

function Stat({ icon, label, value, tint }: { icon: IconName; label: string; value: string; tint: string }) {
  return (
    <div className="rounded-2xl bg-stone-50 border border-stone-100 p-3 flex items-center gap-3">
      <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${tint}`}>
        <Icon name={icon} size={18} />
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold text-stone-500">{label}</span>
        <span className="block text-sm font-extrabold text-stone-900 truncate">{value}</span>
      </span>
    </div>
  );
}

function ProfileView() {
  const params = useSearchParams();
  const { boot, patch } = useSession();
  const username = params.get('u') || boot?.user.username || '';
  const key = `profile:${username}`;
  const [state, setState] = useState<ProfileState | null>(() => memoGet<ProfileState>(key));
  const [loading, setLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState('');
  const [followBusy, setFollowBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(
    async (force = false) => {
      if (!username) return;
      const cached = memoGet<ProfileState>(key);
      if (cached && !force) {
        setState(cached);
        return;
      }
      setLoading(true);
      setError('');
      try {
        const r = await getProfile(username);
        const s = { profile: r.profile, posts: r.posts.items, next: r.posts.nextCursor };
        memoSet(key, s);
        setState(s);
      } catch (err: any) {
        setError(err?.message || 'Could not load this profile');
        setState(null);
      } finally {
        setLoading(false);
      }
    },
    [key, username]
  );

  useEffect(() => {
    load();
  }, [load]);

  const update = (s: ProfileState) => {
    memoSet(key, s);
    setState(s);
  };

  const setPosts: React.Dispatch<React.SetStateAction<SocialPost[]>> = (fn) => {
    setState((prev) => {
      if (!prev) return prev;
      const posts = typeof fn === 'function' ? (fn as (p: SocialPost[]) => SocialPost[])(prev.posts) : fn;
      const s = { ...prev, posts };
      memoSet(key, s);
      return s;
    });
  };

  const loadMore = async () => {
    if (!state?.next) return;
    setMoreLoading(true);
    try {
      const pg = await getFeed({ author: state.profile.username, cursor: state.next });
      update({ ...state, posts: [...state.posts, ...pg.items], next: pg.nextCursor });
    } finally {
      setMoreLoading(false);
    }
  };

  const toggleFollow = async () => {
    if (!state || followBusy) return;
    const follow = !state.profile.isFollowing;
    setFollowBusy(true);
    try {
      const r = await setFollow(state.profile.id, follow);
      update({ ...state, profile: { ...state.profile, isFollowing: r.following, followersCount: r.followersCount } });
      memoDrop(`profile:${boot?.user.username}`);
    } finally {
      setFollowBusy(false);
    }
  };

  const copyRef = async () => {
    if (!boot) return;
    await navigator.clipboard.writeText(`${window.location.origin}/register?ref=${boot.user.username}`).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  if (!state) {
    return (
      <Card className="p-10 flex flex-col items-center justify-center text-center max-w-[640px] mx-auto">
        {loading || !error ? (
          <Spinner size={24} />
        ) : (
          <>
            <div className="text-4xl">🔍</div>
            <div className="mt-2 font-extrabold text-stone-900">{error}</div>
            <Link href="/" className={`${btn.soft} mt-4`}>
              Back to feed
            </Link>
          </>
        )}
      </Card>
    );
  }

  const p = state.profile;
  return (
    <div className="space-y-3 max-w-[640px] mx-auto">
      <Card className="overflow-hidden">
        <div className="h-36 sm:h-44 relative" style={coverStyle(p.coverColor)}>
          <div className="absolute inset-0 opacity-40" style={{ backgroundImage: 'radial-gradient(circle at 20% 30%, #fff 0 2px, transparent 3px), radial-gradient(circle at 70% 60%, #fff 0 2px, transparent 3px)', backgroundSize: '48px 48px' }} />
        </div>
        <div className="px-4 sm:px-6 pb-5">
          <div className="flex items-end justify-between gap-3 -mt-12">
            <Avatar src={p.avatarUrl} name={displayName(p)} size={88} ring className="ring-4 relative z-10 shrink-0" />
            <div className="flex flex-wrap justify-end gap-1.5 sm:gap-2 pb-1">
              {p.isMe ? (
                <>
                  <button onClick={() => setEditOpen(true)} className={btn.soft}>
                    <Icon name="edit" size={16} /> Edit profile
                  </button>
                  <button onClick={copyRef} className={btn.primary}>
                    <Icon name="link" size={16} /> {copied ? 'Copied!' : 'Copy referral link'}
                  </button>
                </>
              ) : (
                <>
                  <button onClick={toggleFollow} disabled={followBusy} className={p.isFollowing ? btn.soft : btn.primary}>
                    <Icon name={p.isFollowing ? 'check' : 'plus'} size={16} /> {p.isFollowing ? 'Following' : 'Follow'}
                  </button>
                  <Link href={`/chat?userId=${p.id}&name=${encodeURIComponent(p.username)}`} className={btn.soft}>
                    <Icon name="chat" size={16} /> Message
                  </Link>
                </>
              )}
            </div>
          </div>
          <h1 className="mt-3 text-2xl font-extrabold text-stone-900 tracking-tight">{displayName(p)}</h1>
          <div className="text-sm text-stone-400">@{p.username}</div>
          {p.bio && <p className="mt-2 text-[15px] text-stone-700 whitespace-pre-wrap">{p.bio}</p>}
          <div className="mt-3 flex gap-4 text-sm">
            <Link href={`/friends?u=${p.username}&tab=followers`} className="hover:underline">
              <b className="text-stone-900">{formatCount(p.followersCount)}</b> <span className="text-stone-500">Followers</span>
            </Link>
            <Link href={`/friends?u=${p.username}&tab=following`} className="hover:underline">
              <b className="text-stone-900">{formatCount(p.followingCount)}</b> <span className="text-stone-500">Following</span>
            </Link>
            <span>
              <b className="text-stone-900">{formatCount(p.postsCount)}</b> <span className="text-stone-500">Posts</span>
            </span>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-extrabold text-stone-900">Player stats</div>
          <span className="text-[11px] font-bold rounded-full bg-stone-900 text-[#FFE135] px-2.5 py-1">MWAR Tactical FPS</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Stat icon="games" label="Matches" value={formatCount(p.totalMatches)} tint="bg-[#E0F2FE] text-sky-700" />
          <Stat icon="target" label="Kills" value={formatCount(p.totalKills)} tint="bg-[#FFE4E6] text-rose-600" />
          <Stat icon="trophy" label="Head bounty" value={formatUsd(p.headBountyMicroUsd)} tint="bg-[#FFF6C2] text-[#8A6A00]" />
          <Stat
            icon="calendar"
            label="Member since"
            value={new Date(p.memberSince * 1000).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
            tint="bg-[#D1FAE5] text-emerald-700"
          />
        </div>
      </Card>

      <div className="flex items-center justify-between px-1 pt-1">
        <div className="font-extrabold text-stone-900">Posts</div>
        <button onClick={() => load(true)} className="text-stone-400 hover:text-stone-800" aria-label="Refresh profile">
          <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <FeedList
        posts={state.posts}
        setPosts={setPosts}
        nextCursor={state.next}
        loading={moreLoading}
        onLoadMore={loadMore}
        empty={<Card className="p-8 text-center text-sm text-stone-500">No posts yet.</Card>}
      />

      {p.isMe && (
        <EditProfileModal
          open={editOpen}
          profile={p}
          onClose={() => setEditOpen(false)}
          onSaved={(changes) => {
            const np = { ...p, ...changes };
            update({ ...state, profile: np });
            memoDrop('feed:');
            patch((b) => ({
              ...b,
              user: { ...b.user, displayName: np.displayName, avatarUrl: np.avatarUrl, coverColor: np.coverColor },
            }));
          }}
        />
      )}
    </div>
  );
}

function EditProfileModal({
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
      setError(err?.message || 'Could not use this photo');
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
      setError(err?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit profile">
      <div className="p-5 space-y-4">
        <div className="rounded-3xl overflow-hidden border border-stone-100">
          <div className="h-20" style={coverStyle(cover)} />
          <div className="px-4 pb-4 -mt-8 flex items-end gap-3">
            <Avatar src={avatar?.url || profile.avatarUrl} name={name || profile.username} size={68} ring className="ring-4 relative z-10" />
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pick} />
            <button onClick={() => fileRef.current?.click()} className={`${btn.soft} mb-1`}>
              <Icon name="image" size={16} /> Change photo
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs font-bold text-stone-600 mb-1.5 ml-1">Cover colour</label>
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
            Display name
          </label>
          <input id="ep-name" className={inputCls} value={name} maxLength={SOCIAL_DISPLAY_NAME_MAX_CHARS} onChange={(e) => setName(e.target.value)} placeholder={profile.username} />
        </div>
        <div>
          <label htmlFor="ep-bio" className="block text-xs font-bold text-stone-600 mb-1.5 ml-1">
            Bio
          </label>
          <textarea id="ep-bio" rows={3} className={`${inputCls} resize-none`} value={bio} maxLength={SOCIAL_BIO_MAX_CHARS} onChange={(e) => setBio(e.target.value)} placeholder="Say something cute about yourself" />
          <div className="text-right text-[11px] text-stone-400 mt-1">
            {bio.length}/{SOCIAL_BIO_MAX_CHARS}
          </div>
        </div>
        {error && <p className="rounded-2xl bg-[#FFE4E6] text-rose-600 text-sm font-semibold px-4 py-2.5">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className={btn.soft}>
            Cancel
          </button>
          <button onClick={save} disabled={busy} className={btn.primary}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function ProfilePage() {
  return (
    <Suspense fallback={null}>
      <ProfileView />
    </Suspense>
  );
}
