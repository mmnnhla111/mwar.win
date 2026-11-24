'use client';

import React from 'react';
import type { SocialPost } from '@mwar/shared';
import { PostCard } from './PostCard';
import { Card, Spinner, btn } from '../ui/Card';

export function FeedList({
  posts,
  setPosts,
  nextCursor,
  loading,
  onLoadMore,
  empty,
}: {
  posts: SocialPost[];
  setPosts: React.Dispatch<React.SetStateAction<SocialPost[]>>;
  nextCursor: string | null;
  loading: boolean;
  onLoadMore: () => void;
  empty?: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      {posts.map((p) => (
        <PostCard
          key={p.id}
          post={p}
          onChange={(np) => setPosts((list) => list.map((x) => (x.id === np.id ? np : x)))}
          onDelete={(id) => setPosts((list) => list.filter((x) => x.id !== id))}
        />
      ))}
      {loading && posts.length === 0 && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Card key={i} className="p-4 animate-pulse">
              <div className="flex gap-3">
                <div className="w-10 h-10 rounded-full bg-stone-100" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-1/3 rounded bg-stone-100" />
                  <div className="h-3 w-1/5 rounded bg-stone-100" />
                </div>
              </div>
              <div className="mt-4 h-3 w-full rounded bg-stone-100" />
              <div className="mt-2 h-3 w-2/3 rounded bg-stone-100" />
            </Card>
          ))}
        </div>
      )}
      {!loading && posts.length === 0 && empty}
      {nextCursor && (
        <div className="flex justify-center pt-1">
          <button onClick={onLoadMore} disabled={loading} className={`${btn.soft} bg-white border border-stone-200`}>
            {loading ? <Spinner size={16} /> : null} Load more posts
          </button>
        </div>
      )}
      {!nextCursor && posts.length > 0 && <p className="text-center text-xs text-stone-400 py-3">You&apos;re all caught up 🍋</p>}
    </div>
  );
}
