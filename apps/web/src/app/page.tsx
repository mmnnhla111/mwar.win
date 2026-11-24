'use client';

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { SOCIAL_POST_TAGS } from '@mwar/shared';
import type { SocialPost, SocialPostTag } from '@mwar/shared';
import { PostComposer } from '../components/social/PostComposer';
import { FeedList } from '../components/social/FeedList';
import { Card } from '../components/ui/Card';
import { Icon } from '../components/ui/Icon';
import { getFeed } from '../lib/api';
import { memoGet, memoSet, memoDrop } from '../lib/memo';

type FeedState = { posts: SocialPost[]; next: string | null };

function HomeFeed() {
  const params = useSearchParams();
  const tagParam = params.get('tag');
  const tag = (SOCIAL_POST_TAGS as readonly string[]).includes(tagParam || '') ? (tagParam as SocialPostTag) : null;
  const key = `feed:${tag || ''}`;
  const [posts, setPosts] = useState<SocialPost[]>(() => memoGet<FeedState>(key)?.posts || []);
  const [next, setNext] = useState<string | null>(() => memoGet<FeedState>(key)?.next || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (opts: { cursor?: string | null; force?: boolean } = {}) => {
      if (!opts.cursor && !opts.force) {
        const cached = memoGet<FeedState>(key);
        if (cached) {
          setPosts(cached.posts);
          setNext(cached.next);
          return;
        }
      }
      setLoading(true);
      setError('');
      try {
        const pg = await getFeed({ cursor: opts.cursor, tag });
        setPosts((prev) => {
          const merged = opts.cursor ? [...prev, ...pg.items] : pg.items;
          memoSet<FeedState>(key, { posts: merged, next: pg.nextCursor });
          return merged;
        });
        setNext(pg.nextCursor);
      } catch (err: any) {
        setError(err?.message || 'Could not load the feed');
      } finally {
        setLoading(false);
      }
    },
    [key, tag]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Keep the page cache in step with likes / comments / deletes
  useEffect(() => {
    const cached = memoGet<FeedState>(key);
    if (cached && cached.posts !== posts) memoSet<FeedState>(key, { posts, next });
  }, [posts, next, key]);

  return (
    <div className="space-y-3 max-w-[640px] mx-auto">
      {/* Quick play (handy on mobile where the sidebars are hidden) */}
      <Link
        href="/games/fps"
        className="md:hidden flex items-center gap-3 rounded-3xl bg-stone-900 text-white p-3.5 shadow-[0_2px_12px_rgba(0,0,0,0.08)]"
      >
        <span className="w-11 h-11 rounded-2xl bg-[#FFE135] text-stone-900 flex items-center justify-center">
          <Icon name="target" size={22} />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block font-extrabold text-sm">MWAR Tactical FPS</span>
          <span className="block text-xs text-stone-300">Rooms are live · tap to pick a room</span>
        </span>
        <Icon name="chevron" size={18} className="text-stone-400" />
      </Link>

      {!tag && (
        <PostComposer
          onPosted={(p) => {
            memoDrop('feed:');
            setPosts((list) => [p, ...list]);
          }}
        />
      )}

      <div className="flex items-center gap-2 pt-1">
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar flex-1">
          <Link
            href="/"
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-bold transition ${!tag ? 'bg-stone-900 text-white' : 'bg-white border border-stone-200 text-stone-600 hover:bg-stone-50'}`}
          >
            For you
          </Link>
          {SOCIAL_POST_TAGS.map((t) => (
            <Link
              key={t}
              href={`/?tag=${t}`}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-bold transition ${tag === t ? 'bg-[#FFE135] text-stone-900' : 'bg-white border border-stone-200 text-stone-600 hover:bg-stone-50'}`}
            >
              #{t}
            </Link>
          ))}
        </div>
        <button
          onClick={() => load({ force: true })}
          disabled={loading}
          className="shrink-0 w-9 h-9 rounded-full bg-white border border-stone-200 text-stone-500 hover:text-stone-900 flex items-center justify-center"
          aria-label="Refresh feed"
          title="Refresh"
        >
          <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <p className="rounded-2xl bg-[#FFE4E6] text-rose-600 text-sm font-semibold px-4 py-2.5">{error}</p>}

      <FeedList
        posts={posts}
        setPosts={setPosts}
        nextCursor={next}
        loading={loading}
        onLoadMore={() => load({ cursor: next })}
        empty={
          <Card className="p-8 text-center">
            <div className="text-4xl">🍋</div>
            <div className="mt-2 font-extrabold text-stone-900">{tag ? `No #${tag} posts yet` : 'Your feed is fresh and empty'}</div>
            <p className="text-sm text-stone-500 mt-1">Share a highlight, find a squad, or say hi!</p>
          </Card>
        }
      />
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <HomeFeed />
    </Suspense>
  );
}
