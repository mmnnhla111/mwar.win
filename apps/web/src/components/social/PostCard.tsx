'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { POST_VISIBILITY, SOCIAL_COMMENT_MAX_CHARS, SOCIAL_POST_MAX_CHARS, staffCanAny } from '@mwar/shared';
import type { PostVisibility, SocialComment, SocialPost } from '@mwar/shared';
import { Avatar } from '../ui/Avatar';
import { Card, Spinner } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { TAG_STYLE, VISIBILITY_ICON } from './PostComposer';
import { MediaCarousel } from './MediaCarousel';
import { ReportModal } from './ReportModal';
import { CheerButton } from '../cheer/CheerModal';
import { addComment, deleteComment, deletePost, getComments, setPostLike, updateComment, updatePost } from '../../lib/api';
import { useSession } from '../../lib/session';
import { displayName, formatCount, timeAgo } from '../../lib/format';
import { useTranslation } from '../../i18n/I18nProvider';

/** Post text with #hashtags as links to the hashtag feed. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(#[\p{L}\p{M}\p{N}_]{1,40})/u);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Link key={i} href={`/?hashtag=${encodeURIComponent(part.slice(1).toLowerCase())}`} className="font-semibold text-sky-600 hover:underline">
            {part}
          </Link>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
}

/** Lemon8-style post card. Comments are fetched only when the drawer is opened (saves D1 reads). */
export function PostCard({ post, onChange, onDelete }: { post: SocialPost; onChange: (p: SocialPost) => void; onDelete?: (id: string) => void }) {
  const { boot } = useSession();
  const { t, lang } = useTranslation();
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
  const [reporting, setReporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState('');
  const [editVis, setEditVis] = useState<PostVisibility>('public');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cmEdit, setCmEdit] = useState<{ id: string; body: string } | null>(null);

  const startEdit = () => {
    setMenu(false);
    setEditBody(post.body);
    setEditVis(post.visibility || 'public');
    setEditing(true);
  };
  const saveEdit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const r = await updatePost(post.id, { body: editBody.trim(), visibility: editVis });
      onChange({ ...r.post, localPreviewUrls: post.localPreviewUrls });
      setEditing(false);
    } catch {
      /* keep the editor open */
    } finally {
      setSaving(false);
    }
  };
  const saveComment = async () => {
    if (!cmEdit?.body.trim()) return;
    try {
      const r = await updateComment(cmEdit.id, cmEdit.body.trim());
      setComments((prev) => (prev || []).map((c) => (c.id === cmEdit.id ? { ...c, body: r.body, editedAt: r.editedAt } : c)));
      setCmEdit(null);
    } catch {
      /* ignore */
    }
  };
  const removeComment = async (id: string) => {
    try {
      const r = await deleteComment(id);
      setComments((prev) => (prev || []).filter((c) => c.id !== id));
      onChange({ ...post, commentCount: r.commentCount });
    } catch {
      /* ignore */
    }
  };

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
    setConfirmDelete(false);
    try {
      await deletePost(post.id);
      onDelete?.(post.id);
    } catch {
      /* ignore */
    }
  };

  const isMine = !!me && me.id === post.author.id;
  const canDelete = !!me && (isMine || staffCanAny(me.staffRoles, 'takedown'));
  const pending = post.moderationStatus === 'pending';
  const rejected = post.moderationStatus === 'rejected';
  const is18 = post.contentRating === 'nsfw_18';
  // Silent moderation: the author sees their post normally while it is checked (no badge); other
  // players only ever receive approved / 18+ posts from the API.
  const media = (post.media || [])
    .map((m, i) => ({ ...m, url: m.url || post.localPreviewUrls?.[i] || '' }))
    .filter((m) => !!m.url);
  const legacySrc = !media.length ? post.mediaUrl || post.imageUrl || post.localPreviewUrl || null : null;
  const visibility = post.visibility || 'public';

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
            <time dateTime={new Date(post.createdAt * 1000).toISOString()}>{timeAgo(post.createdAt, t, lang)}</time>
            <span className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${TAG_STYLE[post.tag]}`}>#{t(`tag.${post.tag}`)}</span>
            {is18 && <span className="rounded-full px-2 py-0.5 text-[10px] font-black bg-rose-100 text-rose-600" title={t('post.nsfwTitle')}>18+</span>}
            {visibility !== 'public' && (
              <span className="text-[11px]" title={t(`visibility.${visibility}`)} data-visibility={visibility}>
                {VISIBILITY_ICON[visibility]}
              </span>
            )}
            {post.editedAt ? <span className="text-[10px] text-stone-400">· {t('post.edited')}</span> : null}
          </div>
        </div>
        {me && (
          <div className="relative">
            <button onClick={() => setMenu((v) => !v)} className="w-8 h-8 rounded-full hover:bg-stone-100 text-stone-400 flex items-center justify-center" aria-label={t('post.options')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
            {menu && (
              <div className="absolute right-0 mt-1 w-52 bg-white rounded-2xl border border-stone-200 shadow-lg p-1 z-10">
                {!isMine && (
                  <button
                    onClick={() => {
                      setMenu(false);
                      setReporting(true);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-stone-50 text-sm font-semibold text-stone-700"
                  >
                    <Icon name="shield" size={16} /> {t('report.menu')}
                  </button>
                )}
                {isMine && (
                  <button onClick={startEdit} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-stone-50 text-sm font-semibold text-stone-700">
                    <Icon name="edit" size={16} /> {t('post.edit')}
                  </button>
                )}
                {canDelete && (
                  <button onClick={() => { setMenu(false); setConfirmDelete(true); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-rose-50 text-sm font-semibold text-rose-500">
                    <Icon name="trash" size={16} /> {t('post.delete')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {confirmDelete && (
        <div className="mx-4 mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700 flex items-center gap-2 flex-wrap" role="alertdialog">
          <span className="flex-1 min-w-[10rem] font-semibold">{t('post.deleteConfirm')}</span>
          <button onClick={() => setConfirmDelete(false)} className="rounded-full px-3 py-1 text-xs font-bold bg-white border border-stone-200 text-stone-600">
            {t('common.cancel')}
          </button>
          <button onClick={remove} className="rounded-full px-3 py-1 text-xs font-bold bg-rose-500 text-white" data-confirm-delete>
            {t('post.delete')}
          </button>
        </div>
      )}
      {editing ? (
        <div className="px-4 pb-3 space-y-2" data-post-editor>
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value.slice(0, SOCIAL_POST_MAX_CHARS))}
            rows={3}
            className="w-full resize-none rounded-2xl bg-stone-50 border border-stone-200 focus:ring-2 focus:ring-yellow-300 outline-none px-3 py-2 text-[15px]"
          />
          <div className="flex items-center gap-2 flex-wrap">
            <select value={editVis} onChange={(e) => setEditVis(e.target.value as PostVisibility)} aria-label={t('visibility.label')} className="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs font-bold text-stone-600">
              {POST_VISIBILITY.map((v) => (
                <option key={v} value={v}>
                  {VISIBILITY_ICON[v]} {t(`visibility.${v}`)}
                </option>
              ))}
            </select>
            <span className="flex-1" />
            <button onClick={() => setEditing(false)} className="rounded-full px-3 py-1.5 text-xs font-bold bg-white border border-stone-200 text-stone-600">
              {t('common.cancel')}
            </button>
            <button onClick={saveEdit} disabled={saving || (!editBody.trim() && !media.length && !legacySrc)} className="rounded-full px-4 py-1.5 text-xs font-bold bg-[#FFE135] text-stone-900 disabled:opacity-40">
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      ) : (
        post.body && (
          <p className="px-4 pb-3 text-[15px] leading-relaxed text-stone-800 whitespace-pre-wrap break-words">
            <RichText text={post.body} />
          </p>
        )
      )}
      {rejected && (
        <div className="mx-4 mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700" data-badge="rejected">
          <b>{t('post.removedTitle')}</b> — {post.moderationReason || t('post.removedReason')}
          <div className="text-xs text-rose-500 mt-0.5">{t('post.removedNote')}</div>
        </div>
      )}
      {!rejected && media.length > 0 && <MediaCarousel items={media} />}
      {!rejected && legacySrc && (
        <div className="px-4 pb-3 relative">
          {post.mediaType === 'video' ? (
            <video src={legacySrc} controls playsInline preload="metadata" className="w-full max-h-[520px] rounded-2xl border border-stone-100 bg-stone-900" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={legacySrc} alt="" loading="lazy" decoding="async" className="w-full max-h-[520px] object-cover rounded-2xl border border-stone-100 bg-stone-50" />
          )}
        </div>
      )}
      <ReportModal postId={post.id} open={reporting} onClose={() => setReporting(false)} />

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
              {t('post.comments', { count: post.commentCount })}
            </button>
          )}
        </div>
      )}

      <div className="mx-4 border-t border-stone-100 grid grid-cols-4 py-1">
        <button
          onClick={toggleLike}
          aria-pressed={!!post.likedByMe}
          className={`flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-semibold transition hover:bg-stone-50 ${post.likedByMe ? 'text-[#FF6B6B]' : 'text-stone-500'}`}
        >
          <Icon name="heart" size={20} filled={!!post.likedByMe} className={post.likedByMe ? 'scale-110 transition' : 'transition'} /> {t('post.like')}
        </button>
        <button onClick={toggleComments} className={`flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-semibold hover:bg-stone-50 ${showComments ? 'text-stone-900' : 'text-stone-500'}`}>
          <Icon name="comment" size={20} /> <span className="hidden sm:inline">{t('post.comment')}</span>
        </button>
        {!isMine && !pending && !rejected ? (
          <CheerButton
            targetType="post"
            targetId={post.id}
            targetName={displayName(post.author)}
            count={post.cheerCount || 0}
            compactLabel
            onCheered={(n) => n !== null && onChange({ ...post, cheerCount: n })}
            className="flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-semibold text-[#B08600] hover:bg-[#FFFBEA]"
          />
        ) : (
          <span className="flex items-center justify-center gap-1.5 py-2 text-sm font-semibold text-stone-400" title={t('cheer.received')} data-cheer-count>
            <Icon name="cheer" size={18} /> {formatCount(post.cheerCount || 0)}
          </span>
        )}
        <button onClick={share} className="flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-semibold text-stone-500 hover:bg-stone-50">
          <Icon name="share" size={20} /> <span className="hidden sm:inline">{copied ? t('common.copied') : t('post.share')}</span>
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
                  {cmEdit?.id === cm.id ? (
                    <div className="flex items-center gap-1.5 mt-1">
                      <input
                        value={cmEdit.body}
                        onChange={(e) => setCmEdit({ id: cm.id, body: e.target.value.slice(0, SOCIAL_COMMENT_MAX_CHARS) })}
                        onKeyDown={(e) => e.key === 'Enter' && saveComment()}
                        className="min-w-0 flex-1 rounded-full border border-stone-200 px-3 py-1 text-sm outline-none focus:ring-2 focus:ring-yellow-300"
                        autoFocus
                      />
                      <button onClick={saveComment} className="text-xs font-bold text-stone-800">
                        {t('common.save')}
                      </button>
                    </div>
                  ) : (
                    <p className="text-sm text-stone-700 whitespace-pre-wrap break-words">
                      <RichText text={cm.body} />
                    </p>
                  )}
                </div>
                <div className="text-[11px] text-stone-400 mt-0.5 ml-2 flex items-center gap-2">
                  <span>{timeAgo(cm.createdAt, t, lang)}</span>
                  {cm.editedAt ? <span>· {t('post.edited')}</span> : null}
                  {me?.id === cm.author.id && cmEdit?.id !== cm.id && (
                    <button onClick={() => setCmEdit({ id: cm.id, body: cm.body })} className="font-bold hover:text-stone-700">
                      {t('post.edit')}
                    </button>
                  )}
                  {(me?.id === cm.author.id || isMine || staffCanAny(me?.staffRoles, 'takedown')) && (
                    <button onClick={() => removeComment(cm.id)} className="font-bold hover:text-rose-500">
                      {t('post.delete')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {nextCursor && (
            <button onClick={() => loadComments(nextCursor)} disabled={loadingComments} className="text-xs font-bold text-stone-500 hover:text-stone-800">
              {loadingComments ? t('common.loading') : t('post.moreComments')}
            </button>
          )}
          <form onSubmit={send} className="flex items-center gap-2 pt-2">
            <Avatar src={me?.avatarUrl} name={me ? displayName(me) : '?'} size={32} />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, SOCIAL_COMMENT_MAX_CHARS))}
              placeholder={t('post.writeComment')}
              className="flex-1 min-w-0 rounded-full bg-white border border-stone-200 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-yellow-300"
            />
            <button type="submit" disabled={!draft.trim() || sending} className="w-9 h-9 rounded-full bg-[#FFE135] text-stone-900 flex items-center justify-center disabled:opacity-40" aria-label={t('post.sendComment')}>
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
