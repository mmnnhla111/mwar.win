'use client';

import React, { useRef, useState } from 'react';
import { SOCIAL_POST_MAX_CHARS, SOCIAL_POST_TAGS } from '@mwar/shared';
import type { SocialPost, SocialPostTag } from '@mwar/shared';
import { Avatar } from '../ui/Avatar';
import { Card, btn } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { useSession } from '../../lib/session';
import { createPost, uploadMedia } from '../../lib/api';
import { compressImageToWebp } from '../../lib/image';
import { displayName } from '../../lib/format';

export const TAG_STYLE: Record<SocialPostTag, string> = {
  General: 'bg-stone-100 text-stone-700',
  Highlight: 'bg-[#FFF6C2] text-[#8A6A00]',
  LookingForSquad: 'bg-[#D1FAE5] text-emerald-700',
  Market: 'bg-[#E0F2FE] text-sky-700',
};

/** "คุณคิดอะไรอยู่..." composer: text + one client-compressed WebP photo + a tag pill. */
export function PostComposer({ onPosted }: { onPosted: (p: SocialPost) => void }) {
  const { boot } = useSession();
  const user = boot?.user;
  const [body, setBody] = useState('');
  const [tag, setTag] = useState<SocialPostTag>('General');
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setError('');
    setCompressing(true);
    try {
      const blob = await compressImageToWebp(f);
      if (photo) URL.revokeObjectURL(photo.url);
      setPhoto({ blob, url: URL.createObjectURL(blob) });
      setExpanded(true);
    } catch (err: any) {
      setError(err?.message || 'Could not use this photo');
    } finally {
      setCompressing(false);
    }
  };

  const submit = async () => {
    if (busy || (!body.trim() && !photo)) return;
    setBusy(true);
    setError('');
    try {
      const imageUrl = photo ? await uploadMedia(photo.blob) : null;
      const res = await createPost({ body: body.trim(), tag, imageUrl });
      onPosted(res.post);
      setBody('');
      setTag('General');
      if (photo) URL.revokeObjectURL(photo.url);
      setPhoto(null);
      setExpanded(false);
    } catch (err: any) {
      setError(err?.message || 'Could not post');
    } finally {
      setBusy(false);
    }
  };

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
            placeholder="คุณคิดอะไรอยู่... (What's on your mind?)"
            className="w-full resize-none rounded-2xl bg-stone-100 hover:bg-stone-200/60 focus:bg-white focus:ring-2 focus:ring-yellow-300 outline-none px-4 py-2.5 text-[15px] text-stone-800 placeholder:text-stone-500 transition"
          />
          {photo && (
            <div className="relative mt-2 inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.url} alt="Selected photo" className="max-h-56 rounded-2xl border border-stone-200 object-cover" />
              <button
                onClick={() => {
                  URL.revokeObjectURL(photo.url);
                  setPhoto(null);
                }}
                className="absolute top-2 right-2 w-8 h-8 rounded-full bg-white/90 text-stone-700 flex items-center justify-center shadow"
                aria-label="Remove photo"
              >
                <Icon name="close" size={16} />
              </button>
              <span className="absolute bottom-2 left-2 text-[10px] font-bold bg-white/90 rounded-full px-2 py-0.5 text-stone-600">
                {Math.round(photo.blob.size / 1024)} KB WebP
              </span>
            </div>
          )}
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
              #{t}
            </button>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-sm font-semibold text-rose-500 pl-[54px]">{error}</p>}

      <div className="mt-3 pt-3 border-t border-stone-100 flex items-center gap-2">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickPhoto} />
        <button onClick={() => fileRef.current?.click()} disabled={compressing} className={`${btn.ghost} text-emerald-600`}>
          <Icon name="image" size={20} /> {compressing ? 'Compressing…' : 'Photo'}
        </button>
        <button onClick={() => setExpanded(true)} className={`${btn.ghost} text-[#B08600] hidden sm:inline-flex`}>
          <Icon name="sparkle" size={20} /> Tag
        </button>
        <span className="ml-auto text-[11px] text-stone-400 tabular-nums">{body.length ? `${body.length}/${SOCIAL_POST_MAX_CHARS}` : ''}</span>
        <button onClick={submit} disabled={busy || (!body.trim() && !photo)} className={btn.primary}>
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
    </Card>
  );
}
