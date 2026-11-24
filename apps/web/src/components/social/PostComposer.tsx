'use client';

import React, { useRef, useState } from 'react';
import {
  SOCIAL_IMAGE_MAX_WIDTH,
  SOCIAL_POST_IMAGE_MAX_BYTES,
  SOCIAL_POST_MAX_CHARS,
  SOCIAL_POST_TAGS,
  SOCIAL_VIDEO_MAX_BYTES,
  SOCIAL_VIDEO_MAX_SECONDS,
} from '@mwar/shared';
import type { SocialPost, SocialPostTag } from '@mwar/shared';
import { Avatar } from '../ui/Avatar';
import { Card, btn } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { useSession } from '../../lib/session';
import { createPost } from '../../lib/api';
import { compressImageToWebp } from '../../lib/image';
import { displayName } from '../../lib/format';

export const TAG_STYLE: Record<SocialPostTag, string> = {
  General: 'bg-stone-100 text-stone-700',
  Highlight: 'bg-[#FFF6C2] text-[#8A6A00]',
  LookingForSquad: 'bg-[#D1FAE5] text-emerald-700',
  Market: 'bg-[#E0F2FE] text-sky-700',
};

/** Read a video's duration from its metadata (no upload needed). */
function videoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(v.duration);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read this video'));
    };
    v.src = url;
  });
}

type Media = { blob: Blob; url: string; kind: 'image' | 'video'; name: string };

/**
 * "คุณคิดอะไรอยู่..." composer: text + one photo (client-resized to 720 px WebP <= 150 KB) or one
 * video (MP4 / WebM <= 30 s, <= 5 MB) + a tag pill + an optional 18+ self-tag.
 * Photos / videos are checked by the moderation worker before anyone else can see them.
 */
export function PostComposer({ onPosted }: { onPosted: (p: SocialPost) => void }) {
  const { boot } = useSession();
  const user = boot?.user;
  const [body, setBody] = useState('');
  const [tag, setTag] = useState<SocialPostTag>('General');
  const [photo, setPhoto] = useState<Media | null>(null);
  const [nsfw, setNsfw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);

  const pickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setError('');
    setCompressing(true);
    try {
      const blob = await compressImageToWebp(f, SOCIAL_IMAGE_MAX_WIDTH, SOCIAL_POST_IMAGE_MAX_BYTES);
      if (photo) URL.revokeObjectURL(photo.url);
      setPhoto({ blob, url: URL.createObjectURL(blob), kind: 'image', name: 'photo.webp' });
      setExpanded(true);
    } catch (err: any) {
      setError(err?.message || 'Could not use this photo');
    } finally {
      setCompressing(false);
    }
  };

  const pickVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setError('');
    try {
      if (!/^video\/(mp4|webm)$/.test(f.type)) throw new Error('Only MP4 or WebM videos');
      if (f.size > SOCIAL_VIDEO_MAX_BYTES) throw new Error(`Video must be ${SOCIAL_VIDEO_MAX_BYTES / 1024 / 1024} MB or smaller (this one is ${(f.size / 1024 / 1024).toFixed(1)} MB)`);
      const secs = await videoDuration(f);
      if (secs > SOCIAL_VIDEO_MAX_SECONDS + 0.5) throw new Error(`Video must be ${SOCIAL_VIDEO_MAX_SECONDS} seconds or shorter`);
      if (photo) URL.revokeObjectURL(photo.url);
      setPhoto({ blob: f, url: URL.createObjectURL(f), kind: 'video', name: f.type === 'video/webm' ? 'clip.webm' : 'clip.mp4' });
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
      const res = await createPost({ body: body.trim(), tag, nsfw, media: photo?.blob || null, mediaName: photo?.name });
      // Keep the local file URL so the author sees their media while it is being checked
      onPosted(photo ? { ...res.post, localPreviewUrl: photo.url } : res.post);
      setBody('');
      setTag('General');
      setNsfw(false);
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
              {photo.kind === 'video' ? (
                <video src={photo.url} className="max-h-56 rounded-2xl border border-stone-200" muted playsInline controls />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo.url} alt="Selected photo" className="max-h-56 rounded-2xl border border-stone-200 object-cover" />
              )}
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
                {photo.kind === 'video' ? `${(photo.blob.size / 1024 / 1024).toFixed(1)} MB video` : `${Math.round(photo.blob.size / 1024)} KB WebP`}
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
          <button
            onClick={() => setNsfw((v) => !v)}
            aria-pressed={nsfw}
            title="Mark as 18+ (hidden from people who have 18+ turned off)"
            className={`rounded-full px-3 py-1 text-xs font-bold transition ${nsfw ? 'bg-rose-100 text-rose-600 ring-2 ring-offset-1 ring-rose-300' : 'bg-white border border-stone-200 text-stone-500 hover:bg-stone-50'}`}
          >
            18+
          </button>
          {photo && <span className="w-full text-[11px] text-stone-400">Photos and videos are checked before they appear in the feed. Weapons, blood and violence are not allowed.</span>}
        </div>
      )}

      {error && <p className="mt-2 text-sm font-semibold text-rose-500 pl-[54px]">{error}</p>}

      <div className="mt-3 pt-3 border-t border-stone-100 flex items-center gap-2">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickPhoto} />
        <input ref={videoRef} type="file" accept="video/mp4,video/webm" className="hidden" onChange={pickVideo} />
        <button onClick={() => fileRef.current?.click()} disabled={compressing} className={`${btn.ghost} text-emerald-600`}>
          <Icon name="image" size={20} /> {compressing ? 'Compressing…' : 'Photo'}
        </button>
        <button onClick={() => videoRef.current?.click()} className={`${btn.ghost} text-sky-600`}>
          <Icon name="eye" size={20} /> Video
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
