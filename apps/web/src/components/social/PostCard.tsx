'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { SOCIAL_COMMENT_MAX_CHARS } from '@mwar/shared';
import type { SocialComment, SocialPost } from '@mwar/shared';
import { Avatar } from '../ui/Avatar';
import { Card, Spinner } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { TAG_STYLE } from './PostComposer';
import { addComment, deletePost, getComments, setPostLike } from '../../lib/api';
import { useSession } from '../../lib/session';
import { displayName, formatCount, timeAgo } from '../../lib/format';

/** Lemon8-style post card. Comments are fetched only when the drawer is opened (saves D1 reads). */
export function PostCard({ post, onChange, onDelete }: { post: SocialPost; onChange: (p: SocialPost) => void; onDelete?: (id: string) => void }) {
  const { boot } = useSession();
  const me = boot?.user;
  const [likeBusy, setLikeBusy] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<SocialComment[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);

  const toggleLike = async () => {
    if (likeBusy) return;
    const like = !post.likedByMe;
    // Optimistic update, reconciled with the server count
    onChange({ ...post, likedByMe: like, likeCount: Math.max(0, post.likeCount + (like ? 1 : -1)) });
    setLikeBusy(true);
    try {
      const r = await setPostLike(post.id, like);
      onChange({ ...post, likedByMe: r.liked, likeCount: r.likeCount });
    } catch {
      onChange(post);
    } finally {
      setLikeBusy(false);
    }
  };

  const loadComments = async (cursor?: string | null) => {
    setLoadingComments(true);
    try {
      const pg = await getComments(post.id, cursor);
      setComments((prev) => (cursor && prev ? [...prev, ...pg.items] : pg.items));
      setNextCursor(pg.nextCursor);
    } finally {
      setLoadingComments(false);
    }
  };

  const toggleComments = () => {
    const next = !showComments;
    setShowComments(next);
    if (next && comments === null && post.commentCount > 0) loadComments();
    if (next && comments === null && post.commentCount === 0) setComments([]);
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const r = await addComment(post.id, body);
      setComments((prev) => [...(prev || []), r.comment]);
      onChange({ ...post, commentCount: r.commentCount });
      setDraft('');
    } finally {
      setSending(false);
    }
  };

  const share = async () => {
    const url = `${window.location.origin}/profile?u=${post.author.username}`;
    try {
      if (navigator.share) await navigator.share({ title: 'mwar.win', text: post.body.slice(0, 80), url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      /* cancelled */
    }
  };

  const remove = async () => {
    setMenu(false);
    try {
      await deletePost(post.id);
      onDelete?.(post.id);
    } catch {
      /* ignore */
    }
  };

  const canDelete = me && (me.id === post.author.id || me.role === 'admin');

  return (
    <Card as="article" className="overflow-hidden">
      <div className="p-4 pb-3 flex items-start gap-3">
        <Link href={`/profile?u=${post.author.username}`} className="shrink-0">
          <Avatar src={post.author.avatarUrl} name={displayName(post.author)} size={42} />
        </Link>
        <div className="min-w-0 flex-1">
          <Link href={`/profile?u=${post.author.username}`} className="font-bold text-[15px] text-stone-900 hover:underline">
            {displayName(post.author)}
          </Link>
          <div className="text-xs text-stone-400 flex items-center gap-1.5 flex-wrap">
            <span>@{post.author.username}</span>
            <span>·</span>
            <time dateTime={new Date(post.createdAt * 1000).toISOString()}>{timeAgo(post.createdAt)}</time>
            <span className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${TAG_STYLE[post.tag]}`}>#{post.tag}</span>
          </div>
        </div>
        {canDelete && (
          <div className="relative">
            <button onClick={() => setMenu((v) => !v)} className="w-8 h-8 rounded-full hover:bg-stone-100 text-stone-400 flex items-center justify-center" aria-label="Post options">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
            {menu && (
              <div className="absolute right-0 mt-1 w-40 bg-white rounded-2xl border border-stone-200 shadow-lg p-1 z-10">
                <button onClick={remove} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-rose-50 text-sm font-semibold text-rose-500">
                  <Icon name="trash" size={16} /> Delete post
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {post.body && <p className="px-4 pb-3 text-[15px] leading-relaxed text-stone-800 whitespace-pre-wrap break-words">{post.body}</p>}
      {post.imageUrl && (
        <div className="px-4 pb-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={post.imageUrl} alt="" loading="lazy" decoding="async" className="w-full max-h-[520px] object-cover rounded-2xl border border-stone-100 bg-stone-50" />
        </div>
      )}

      {(post.likeCount > 0 || post.commentCount > 0) && (
        <div className="px-4 pb-2 flex items-center justify-between text-xs text-stone-400">
          <span className="flex items-center gap-1">
            {post.likeCount > 0 && (
              <>
                <span className="w-[18px] h-[18px] rounded-full bg-[#FF6B6B] text-white flex items-center justify-center">
                  <Icon name="heart" size={11} filled strokeWidth={0} />
                </span>
                {formatCount(post.likeCount)}
              </>
            )}
          </span>
          {post.commentCount > 0 && (
            <button onClick={toggleComments} className="hover:underline">
              {formatCount(post.commentCount)} comment{post.commentCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      <div className="mx-4 border-t border-stone-100 grid grid-cols-3 py-1">
        <button
          onClick={toggleLike}
          aria-pressed={!!post.likedByMe}
          className={`flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-semibold transition hover:bg-stone-50 ${post.likedByMe ? 'text-[#FF6B6B]' : 'text-stone-500'}`}
        >
          <Icon name="heart" size={20} filled={!!post.likedByMe} className={post.likedByMe ? 'scale-110 transition' : 'transition'} /> Like
        </button>
        <button onClick={toggleComments} className={`flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-semibold hover:bg-stone-50 ${showComments ? 'text-stone-900' : 'text-stone-500'}`}>
          <Icon name="comment" size={20} /> Comment
        </button>
        <button onClick={share} className="flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-semibold text-stone-500 hover:bg-stone-50">
          <Icon name="share" size={20} /> {copied ? 'Copied!' : 'Share'}
        </button>
      </div>

      {showComments && (
        <div className="px-4 pb-4 pt-1 space-y-2.5 bg-[#FCFBF8] border-t border-stone-100">
          {loadingComments && comments === null && (
            <div className="py-3 flex justify-center">
              <Spinner />
            </div>
          )}
          {(comments || []).map((cm) => (
            <div key={cm.id} className="flex gap-2.5 pt-2">
              <Link href={`/profile?u=${cm.author.username}`}>
                <Avatar src={cm.author.avatarUrl} name={displayName(cm.author)} size={32} />
              </Link>
              <div className="min-w-0">
                <div className="bg-white border border-stone-200/70 rounded-2xl px-3 py-2">
                  <Link href={`/profile?u=${cm.author.username}`} className="text-xs font-bold text-stone-900 hover:underline">
                    {displayName(cm.author)}
                  </Link>
                  <p className="text-sm text-stone-700 whitespace-pre-wrap break-words">{cm.body}</p>
                </div>
                <div className="text-[11px] text-stone-400 mt-0.5 ml-2">{timeAgo(cm.createdAt)}</div>
              </div>
            </div>
          ))}
          {nextCursor && (
            <button onClick={() => loadComments(nextCursor)} disabled={loadingComments} className="text-xs font-bold text-stone-500 hover:text-stone-800">
              {loadingComments ? 'Loading…' : 'View more comments'}
            </button>
          )}
          <form onSubmit={send} className="flex items-center gap-2 pt-2">
            <Avatar src={me?.avatarUrl} name={me ? displayName(me) : '?'} size={32} />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, SOCIAL_COMMENT_MAX_CHARS))}
              placeholder="Write a comment…"
              className="flex-1 min-w-0 rounded-full bg-white border border-stone-200 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-yellow-300"
            />
            <button type="submit" disabled={!draft.trim() || sending} className="w-9 h-9 rounded-full bg-[#FFE135] text-stone-900 flex items-center justify-center disabled:opacity-40" aria-label="Send comment">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 20.5 21 12 3 3.5l2.5 7L15 12l-9.5 1.5z" />
              </svg>
            </button>
          </form>
        </div>
      )}
    </Card>
  );
}
