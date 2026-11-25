'use client';

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { SocialPost, SocialProfile } from '@mwar/shared';
import { Avatar } from '../../components/ui/Avatar';
import { Card, Spinner, btn } from '../../components/ui/Card';
import { Icon, type IconName } from '../../components/ui/Icon';
import { FeedList } from '../../components/social/FeedList';
import { getFeed, getProfile, setBlock, setFollow } from '../../lib/api';
import { FollowListModal } from '../../components/social/FollowListModal';
import { EditProfileModal, coverStyle } from '../../components/social/EditProfileModal';
import { useSession } from '../../lib/session';
import { displayName, formatCount, formatEc, formatUsd } from '../../lib/format';
import { CheerButton } from '../../components/cheer/CheerModal';
import { MAX_ENERGY_TICKETS } from '@mwar/shared';
import { memoDrop, memoGet, memoSet } from '../../lib/memo';
import { useTranslation } from '../../i18n/I18nProvider';
import { useEarningsText } from '../../components/settings/EarningsVisibility';

type ProfileState = { profile: SocialProfile; posts: SocialPost[]; next: string | null };


function Stat({ icon, label, value, tint, ...rest }: { icon: IconName; label: string; value: string; tint: string; 'data-profile-earnings'?: string; 'data-profile-ec'?: boolean }) {
  return (
    <div className="rounded-2xl bg-stone-50 border border-stone-100 p-3 flex items-center gap-3" {...rest}>
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
  const earningsText = useEarningsText();
  const username = params.get('u') || boot?.user.username || '';
  const key = `profile:${username}`;
  const [state, setState] = useState<ProfileState | null>(() => memoGet<ProfileState>(key));
  const [loading, setLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState('');
  const [followBusy, setFollowBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [followList, setFollowList] = useState<'followers' | 'following' | null>(null);
  const [blockAsk, setBlockAsk] = useState(false);

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
      update({ ...state, posts: [...state.posts, ...pg.items.filter((x) => !state.posts.some((y) => y.id === x.id))], next: pg.nextCursor });
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

  const toggleBlock = async () => {
    if (!state) return;
    const block = !state.profile.isBlocked;
    setBlockAsk(false);
    try {
      const r = await setBlock(state.profile.id, block);
      update({
        ...state,
        profile: { ...state.profile, isBlocked: r.blocked, isFollowing: r.blocked ? false : state.profile.isFollowing },
        posts: r.blocked ? [] : state.posts,
      });
      memoDrop('feed:');
      if (!r.blocked) load(true);
    } catch {
      /* ignore */
    }
  };

  const copyRef = async () => {
    if (!boot) return;
    await navigator.clipboard.writeText(`${window.location.origin}/login?ref=${boot.user.username}`).catch(() => {});
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
        <div className="h-36 sm:h-44 relative" style={coverStyle(p.coverColor, p.coverUrl)} data-profile-cover={p.coverUrl ? 'photo' : 'gradient'}>
          <div className={`absolute inset-0 opacity-40 ${p.coverUrl ? 'hidden' : ''}`} style={{ backgroundImage: 'radial-gradient(circle at 20% 30%, #fff 0 2px, transparent 3px), radial-gradient(circle at 70% 60%, #fff 0 2px, transparent 3px)', backgroundSize: '48px 48px' }} />
        </div>
        <div className="px-4 sm:px-6 pb-5">
          <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between gap-3 -mt-12">
            <Avatar src={p.avatarUrl} name={displayName(p)} size={88} ring className="ring-4 relative z-10 shrink-0" />
            <div className="relative z-10 flex flex-wrap justify-start sm:justify-end gap-1.5 sm:gap-2 pb-1" data-profile-actions>
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
                  <CheerButton targetType="energy" label={t('cheer.rechargeBtn')} className={btn.soft} />
                </>
              ) : (
                p.isBlocked ? (
                  <button onClick={toggleBlock} className={btn.soft} data-unblock>
                    {t('profile.unblock')}
                  </button>
                ) : (
                <>
                  <button onClick={toggleFollow} disabled={followBusy} className={p.isFollowing ? btn.soft : btn.primary}>
                    <Icon name={p.isFollowing ? 'check' : 'plus'} size={16} /> {p.isFollowing ? t('profile.followingBtn') : t('profile.follow')}
                  </button>
                  <Link href={`/chat?userId=${p.id}&name=${encodeURIComponent(p.username)}`} className={btn.soft}>
                    <Icon name="chat" size={16} /> {t('profile.message')}
                  </Link>
                  <CheerButton
                    targetType="profile"
                    targetId={p.id}
                    targetName={displayName(p)}
                    className={`${btn.soft} !bg-[#FFF6C2] !text-[#8A6A00]`}
                    onCheered={(n) => n !== null && update({ ...state, profile: { ...p, cheerCount: n } })}
                  />
                  <button onClick={() => setBlockAsk(true)} className={`${btn.soft} !text-rose-500`} data-block>
                    {t('profile.block')}
                  </button>
                </>
                )
              )}
            </div>
          </div>
          {blockAsk && (
            <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700 flex items-center gap-2 flex-wrap" role="alertdialog">
              <span className="flex-1 min-w-[12rem] font-semibold">{t('profile.blockConfirm', { name: displayName(p) })}</span>
              <button onClick={() => setBlockAsk(false)} className="rounded-full px-3 py-1 text-xs font-bold bg-white border border-stone-200 text-stone-600">
                {t('common.cancel')}
              </button>
              <button onClick={toggleBlock} className="rounded-full px-3 py-1 text-xs font-bold bg-rose-500 text-white" data-confirm-block>
                {t('profile.block')}
              </button>
            </div>
          )}
          <h1 className="mt-3 text-2xl font-extrabold text-stone-900 tracking-tight">{displayName(p)}</h1>
          <div className="text-sm text-stone-400">@{p.username}</div>
          {p.bio && <p className="mt-2 text-[15px] text-stone-700 whitespace-pre-wrap">{p.bio}</p>}
          <div className="mt-3 flex gap-x-4 gap-y-1 flex-wrap text-sm">
            <button onClick={() => setFollowList('followers')} className="hover:underline" data-open-followers>
              <b className="text-stone-900">{formatCount(p.followersCount)}</b> <span className="text-stone-500">{t('profile.followers')}</span>
            </button>
            <button onClick={() => setFollowList('following')} className="hover:underline">
              <b className="text-stone-900">{formatCount(p.followingCount)}</b> <span className="text-stone-500">{t('profile.following')}</span>
            </button>
            <span>
              <b className="text-stone-900">{formatCount(p.postsCount)}</b> <span className="text-stone-500">{t('profile.posts')}</span>
            </span>
            <span data-profile-cheers>
              <b className="text-stone-900">{formatCount(p.cheerCount || 0)}</b> <span className="text-stone-500">{t('cheer.received')}</span>
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
          <Stat icon="wallet" label={t('earnings.total')} value={earningsText(p.totalEarnings)} tint="bg-[#FFF6C2] text-[#8A6A00]" data-profile-earnings={p.totalEarnings?.visibility || 'public'} />
          <Stat
            icon="calendar"
            label={t('profile.memberSince')}
            value={new Date(p.memberSince * 1000).toLocaleDateString(lang, { month: 'short', year: 'numeric' })}
            tint="bg-[#D1FAE5] text-emerald-700"
          />
          {p.isMe && boot && (
            <Stat icon="bolt" label={t('side.energy')} value={formatEc(boot.user.energyTickets, boot.user.maxEnergyTickets || MAX_ENERGY_TICKETS)} tint="bg-[#FFFBEA] text-[#8A6A00]" data-profile-ec />
          )}
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

      {p.isBlocked && <Card className="p-6 text-center text-sm text-stone-500">{t('profile.blockedNote')}</Card>}
      <FollowListModal username={p.username} type={followList} onClose={() => setFollowList(null)} />
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
              user: { ...b.user, displayName: np.displayName, avatarUrl: np.avatarUrl, coverColor: np.coverColor, coverUrl: np.coverUrl ?? null },
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
