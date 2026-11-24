'use client';

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { SocialPost, SocialProfile } from '@mwar/shared';
import { Avatar } from '../../components/ui/Avatar';
import { Card, Spinner, btn } from '../../components/ui/Card';
import { Icon, type IconName } from '../../components/ui/Icon';
import { FeedList } from '../../components/social/FeedList';
import { getFeed, getProfile, setFollow } from '../../lib/api';
import { EditProfileModal, coverStyle } from '../../components/social/EditProfileModal';
import { useSession } from '../../lib/session';
import { displayName, formatCount, formatUsd } from '../../lib/format';
import { memoDrop, memoGet, memoSet } from '../../lib/memo';
import { useTranslation } from '../../i18n/I18nProvider';

type ProfileState = { profile: SocialProfile; posts: SocialPost[]; next: string | null };


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
  const { t, lang } = useTranslation();
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
        const mine = (r.posts.mine || []).filter((m) => !r.posts.items.some((x) => x.id === m.id));
        const s = { profile: r.profile, posts: [...mine, ...r.posts.items], next: r.posts.nextCursor };
        memoSet(key, s);
        setState(s);
      } catch (err: any) {
        setError(err?.message || t('profile.loadFailed'));
        setState(null);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
              {t('report.backToFeed')}
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
                    <Icon name="edit" size={16} /> {t('profile.edit')}
                  </button>
                  <Link href="/settings" className={btn.soft} data-settings-link>
                    {t('nav.settings')}
                  </Link>
                  <button onClick={copyRef} className={btn.primary}>
                    <Icon name="link" size={16} /> {copied ? t('common.copied') : t('profile.copyRef')}
                  </button>
                </>
              ) : (
                <>
                  <button onClick={toggleFollow} disabled={followBusy} className={p.isFollowing ? btn.soft : btn.primary}>
                    <Icon name={p.isFollowing ? 'check' : 'plus'} size={16} /> {p.isFollowing ? t('profile.followingBtn') : t('profile.follow')}
                  </button>
                  <Link href={`/chat?userId=${p.id}&name=${encodeURIComponent(p.username)}`} className={btn.soft}>
                    <Icon name="chat" size={16} /> {t('profile.message')}
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
              <b className="text-stone-900">{formatCount(p.followersCount)}</b> <span className="text-stone-500">{t('profile.followers')}</span>
            </Link>
            <Link href={`/friends?u=${p.username}&tab=following`} className="hover:underline">
              <b className="text-stone-900">{formatCount(p.followingCount)}</b> <span className="text-stone-500">{t('profile.following')}</span>
            </Link>
            <span>
              <b className="text-stone-900">{formatCount(p.postsCount)}</b> <span className="text-stone-500">{t('profile.posts')}</span>
            </span>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-extrabold text-stone-900">{t('profile.stats')}</div>
          <span className="text-[11px] font-bold rounded-full bg-stone-900 text-[#FFE135] px-2.5 py-1">MWAR Tactical FPS</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Stat icon="games" label={t('profile.matches')} value={formatCount(p.totalMatches)} tint="bg-[#E0F2FE] text-sky-700" />
          <Stat icon="target" label={t('profile.kills')} value={formatCount(p.totalKills)} tint="bg-[#FFE4E6] text-rose-600" />
          <Stat icon="trophy" label={t('side.headBounty')} value={formatUsd(p.headBountyMicroUsd)} tint="bg-[#FFF6C2] text-[#8A6A00]" />
          <Stat
            icon="calendar"
            label={t('profile.memberSince')}
            value={new Date(p.memberSince * 1000).toLocaleDateString(lang, { month: 'short', year: 'numeric' })}
            tint="bg-[#D1FAE5] text-emerald-700"
          />
        </div>
      </Card>

      <div className="flex items-center justify-between px-1 pt-1">
        <div className="font-extrabold text-stone-900">{t('profile.posts')}</div>
        <button onClick={() => load(true)} className="text-stone-400 hover:text-stone-800" aria-label={t('profile.refresh')}>
          <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <FeedList
        posts={state.posts}
        setPosts={setPosts}
        nextCursor={state.next}
        loading={moreLoading}
        onLoadMore={loadMore}
        empty={<Card className="p-8 text-center text-sm text-stone-500">{t('profile.noPosts')}</Card>}
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

export default function ProfilePage() {
  return (
    <Suspense fallback={null}>
      <ProfileView />
    </Suspense>
  );
}
