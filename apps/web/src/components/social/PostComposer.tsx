'use client';

import React, { useEffect, useRef, useState } from 'react';
import { POST_MEDIA_MAX_ITEMS, POST_VISIBILITY, SOCIAL_POST_MAX_CHARS, SOCIAL_POST_TAGS } from '@mwar/shared';
import type { PostVisibility, SocialPost, SocialPostTag } from '@mwar/shared';
import { Avatar } from '../ui/Avatar';
import { Card, btn } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { useSession } from '../../lib/session';
import { preloadMediaCompress } from '../../lib/mediaCompress';
import { displayName } from '../../lib/format';
import { useTranslation } from '../../i18n/I18nProvider';
import { usePostUpload } from './PostUploadProvider';

export const TAG_STYLE: Record<SocialPostTag, string> = {
  General: 'bg-stone-100 text-stone-700',
  Highlight: 'bg-[#FFF6C2] text-[#8A6A00]',
  LookingForSquad: 'bg-[#D1FAE5] text-emerald-700',
  Market: 'bg-[#E0F2FE] text-sky-700',
};

export const VISIBILITY_ICON: Record<PostVisibility, string> = { public: '🌐', followers: '👥', private: '🔒' };

type Item = { key: string; file: File; url: string; kind: 'image' | 'video'; size: number };

const newAttemptId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * "คุณคิดอะไรอยู่..." composer: text + 1–10 photos / videos (mixed, reorder + remove before posting),
 * a tag pill, audience (public / followers / only me) and an optional 18+ self-tag.
 * Media selection only validates count and renders instant local previews; compression/preparation
 * and upload are deferred to the global PostUploadProvider when the user clicks "Post".
 */
export function PostComposer({ onPosted }: { onPosted?: (p: SocialPost) => void }) {
  const { boot } = useSession();
  const { t: tr } = useTranslation();
  const { enqueuePost } = usePostUpload();
  const user = boot?.user;
  const [body, setBody] = useState('');
  const [tag, setTag] = useState<SocialPostTag>('General');
  const [items, setItems] = useState<Item[]>([]);
  const [nsfw, setNsfw] = useState(false);
  const [visibility, setVisibility] = useState<PostVisibility>('public');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => preloadMediaCompress(), []);

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setError('');
    setExpanded(true);
    const room = POST_MEDIA_MAX_ITEMS - items.length;
    if (files.length > room) setError(tr('composer.maxItems', { max: POST_MEDIA_MAX_ITEMS }));
    const nextItems: Item[] = files.slice(0, Math.max(0, room)).map((f) => ({
      key: newAttemptId(),
      file: f,
      url: URL.createObjectURL(f),
      kind: f.type.startsWith('video/') ? 'video' : 'image',
      size: f.size,
    }));
    if (nextItems.length) {
      setItems((prev) => [...prev, ...nextItems].slice(0, POST_MEDIA_MAX_ITEMS));
    }
  };

  const removeAt = (i: number) =>
    setItems((prev) => {
      URL.revokeObjectURL(prev[i].url);
      return prev.filter((_, j) => j !== i);
    });
  const move = (i: number, d: -1 | 1) =>
    setItems((prev) => {
      const j = i + d;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const reset = () => {
    items.forEach((it) => URL.revokeObjectURL(it.url));
    setBody('');
    setTag('General');
    setNsfw(false);
    setItems([]);
    setExpanded(false);
    setError('');
  };

  const submit = () => {
    if (!body.trim() && !items.length) return;
    enqueuePost({
      body: body.trim(),
      tag,
      nsfw,
      visibility,
      rawFiles: items.map((it) => it.file),
    });
    reset();
  };

  const canPost = !!body.trim() || items.length > 0;

  return (
    <Card className="p-4">
      <div className="flex gap-3">
        <Avatar src={user?.avatarUrl} name={user ? displayName(user) : '?'} size={42} />
        <div className="flex-1 min-w-0">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, SOCIAL_POST_MAX_CHARS))}
            onFocus={() => setExpanded(true)}
            rows={expanded ? 3 : 1}
            placeholder={tr('composer.placeholder')}
            className="w-full resize-none rounded-2xl bg-stone-100 hover:bg-stone-200/60 focus:bg-white focus:ring-2 focus:ring-yellow-300 outline-none px-4 py-2.5 text-[15px] text-stone-800 placeholder:text-stone-500 transition"
          />
          {items.length > 0 && (
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1" data-no-swipe>
              {items.map((it, i) => (
                <div key={it.key} className="relative shrink-0 w-28 h-28 rounded-2xl overflow-hidden border border-stone-200 bg-stone-100">
                  {it.kind === 'video' ? (
                    <video src={it.url} className="w-full h-full object-cover" muted playsInline preload="metadata" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={it.url} alt={tr('composer.selected')} className="w-full h-full object-cover" />
                  )}
                  <span className="absolute top-1 left-1 text-[10px] font-black bg-white/90 rounded-full px-1.5 text-stone-700">{i + 1}</span>
                  <button
                    onClick={() => removeAt(i)}
                    className="absolute top-1 right-1 w-7 h-7 rounded-full bg-white/90 text-stone-700 flex items-center justify-center shadow"
                    aria-label={tr('composer.remove')}
                  >
                    <Icon name="close" size={14} />
                  </button>
                  <div className="absolute bottom-1 inset-x-1 flex items-center justify-between">
                    <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={tr('composer.moveLeft')} className="w-7 h-7 rounded-full bg-white/90 text-stone-700 font-black text-sm disabled:opacity-30">
                      ‹
                    </button>
                    <span className="text-[9px] font-bold bg-white/90 rounded-full px-1.5 text-stone-600">
                      {it.kind === 'video' ? `${(it.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(it.size / 1024)} KB`}
                    </span>
                    <button onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label={tr('composer.moveRight')} className="w-7 h-7 rounded-full bg-white/90 text-stone-700 font-black text-sm disabled:opacity-30">
                      ›
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {items.length > 0 && <p className="mt-1 text-[11px] text-stone-400">{tr('composer.itemCount', { n: items.length, max: POST_MEDIA_MAX_ITEMS })}</p>}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 flex flex-wrap gap-1.5 pl-[54px]">
          {SOCIAL_POST_TAGS.map((t) => (
            <button
              key={t}
              onClick={() => setTag(t)}
              className={`rounded-full px-3 py-1 text-xs font-bold transition ${tag === t ? `${TAG_STYLE[t]} ring-2 ring-offset-1 ring-[#FACC15]` : 'bg-white border border-stone-200 text-stone-500 hover:bg-stone-50'}`}
            >
              #{tr(`tag.${t}`)}
            </button>
          ))}
          <button
            onClick={() => setNsfw((v) => !v)}
            aria-pressed={nsfw}
            title={tr('composer.nsfwTitle')}
            className={`rounded-full px-3 py-1 text-xs font-bold transition ${nsfw ? 'bg-rose-100 text-rose-600 ring-2 ring-offset-1 ring-rose-300' : 'bg-white border border-stone-200 text-stone-500 hover:bg-stone-50'}`}
          >
            18+
          </button>
          <label className="inline-flex items-center gap-1 rounded-full bg-white border border-stone-200 pl-2 pr-1 py-0.5 text-xs font-bold text-stone-600">
            <span aria-hidden>{VISIBILITY_ICON[visibility]}</span>
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as PostVisibility)}
              aria-label={tr('visibility.label')}
              className="bg-transparent outline-none py-0.5 pr-1 cursor-pointer"
            >
              {POST_VISIBILITY.map((v) => (
                <option key={v} value={v}>
                  {tr(`visibility.${v}`)}
                </option>
              ))}
            </select>
          </label>
          {items.length > 0 && <span className="w-full text-[11px] text-stone-400">{tr('composer.policyNote')}</span>}
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm font-semibold text-rose-500 pl-[54px]" role="alert">
          {error}
        </p>
      )}

      <div className="mt-3 pt-3 border-t border-stone-100 flex items-center gap-2">
        <input ref={fileRef} type="file" accept="image/*,video/mp4,video/quicktime,video/webm" multiple className="hidden" onChange={pick} />
        <button onClick={() => fileRef.current?.click()} disabled={items.length >= POST_MEDIA_MAX_ITEMS} className={`${btn.ghost} text-emerald-600`}>
          <Icon name="image" size={20} /> {tr('composer.media')}
        </button>
        <button onClick={() => setExpanded(true)} className={`${btn.ghost} text-[#B08600] hidden sm:inline-flex`}>
          <Icon name="sparkle" size={20} /> {tr('composer.tag')}
        </button>
        <span className="ml-auto text-[11px] text-stone-400 tabular-nums">{body.length ? `${body.length}/${SOCIAL_POST_MAX_CHARS}` : ''}</span>
        <button onClick={submit} disabled={!canPost} className={btn.primary} data-post-submit>
          {tr('composer.post')}
        </button>
      </div>
    </Card>
  );
}
