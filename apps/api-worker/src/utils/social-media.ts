import type { Context } from 'hono';
import type { Env } from '../types';
import { edgeCachePurge } from './edge-cache';

/**
 * Social media + content-policy helpers shared by the social routes, the moderation queue API,
 * the admin takedown queue and the nightly cron.
 */

export const MEDIA_KEY_RE = /^social\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(webp|jpg|mp4|webm)$/;
export const CHAT_MEDIA_KEY_RE = /^chat-media\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.(webp|jpg|mp4)$/;
export const COVER_KEY_RE = /^covers\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.webp$/;
/** Legacy (0008) photo URLs: <origin>/api/media/<uid>/<file>.webp in ASSETS_BUCKET under media/. */
const LEGACY_MEDIA_RE = /\/api\/media\/([a-z0-9-]{8,64})\/([a-z0-9-]{8,64}\.webp)$/i;

type Ext = 'webp' | 'jpg' | 'mp4' | 'webm';

const ymd = (now = new Date()) => ({
  y: now.getUTCFullYear(),
  m: String(now.getUTCMonth() + 1).padStart(2, '0'),
  d: String(now.getUTCDate()).padStart(2, '0'),
});

export function newMediaKey(ext: Ext, now = new Date()): string {
  const { y, m } = ymd(now);
  return `social/${y}/${m}/${crypto.randomUUID()}.${ext}`;
}

export function newChatMediaKey(ext: 'webp' | 'jpg' | 'mp4', now = new Date()): string {
  const { y, m, d } = ymd(now);
  return `chat-media/${y}/${m}/${d}/${crypto.randomUUID()}.${ext}`;
}

export function newCoverKey(now = new Date()): string {
  const { y, m } = ymd(now);
  return `covers/${y}/${m}/${crypto.randomUUID()}.webp`;
}

export function mediaUrlFor(origin: string, key: string): string {
  return `${origin}/api/media/${key}`;
}

export function contentTypeFor(key: string): string {
  if (key.endsWith('.webp')) return 'image/webp';
  if (key.endsWith('.jpg')) return 'image/jpeg';
  if (key.endsWith('.webm')) return 'video/webm';
  return 'video/mp4';
}

export type SniffedMedia =
  | { type: 'image'; ext: 'webp'; contentType: 'image/webp' }
  | { type: 'image'; ext: 'jpg'; contentType: 'image/jpeg' }
  | { type: 'video'; ext: 'mp4' | 'webm'; contentType: 'video/mp4' | 'video/webm' };

/** Identify an upload from its magic bytes (never trust the client Content-Type). */
export function sniffMedia(b: Uint8Array): SniffedMedia | null {
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { type: 'image', ext: 'webp', contentType: 'image/webp' };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { type: 'image', ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    return { type: 'video', ext: 'mp4', contentType: 'video/mp4' };
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return { type: 'video', ext: 'webm', contentType: 'video/webm' };
  }
  return null;
}

/**
 * Walk ISO-BMFF boxes (MP4 / MOV) without decoding. Returns the movie duration (mvhd) and the
 * largest video track size (tkhd width/height of tracks whose handler is 'vide').
 */
export function mp4Info(b: Uint8Array): { durationSec: number | null; width: number | null; height: number | null } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const type = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  let durationSec: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  const boxes = (start: number, end: number, fn: (t: string, body: number, end: number) => void) => {
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      const t = type(o + 4);
      let header = 8;
      if (size === 1 && o + 16 <= end) {
        size = Number(dv.getBigUint64(o + 8));
        header = 16;
      } else if (size === 0) size = end - o;
      if (size < header || o + size > end) return;
      fn(t, o + header, o + size);
      o += size;
    }
  };
  // Fragmented MP4 (browser MediaRecorder output): mvhd duration is 0, so the video track's
  // sample durations are summed from every moof/traf/trun instead.
  let videoTrackId = 0;
  let videoTimescale = 0;
  const trexDefault = new Map<number, number>();
  try {
    boxes(0, b.byteLength, (t, body, end) => {
      if (t !== 'moov') return;
      boxes(body, end, (t2, b2, e2) => {
        if (t2 === 'mvhd') {
          const v = b[b2];
          const timescale = v === 1 ? dv.getUint32(b2 + 20) : dv.getUint32(b2 + 12);
          const duration = v === 1 ? Number(dv.getBigUint64(b2 + 24)) : dv.getUint32(b2 + 16);
          durationSec = timescale ? duration / timescale : null;
        }
        if (t2 === 'mvex') {
          boxes(b2, e2, (t3, b3) => {
            if (t3 === 'trex') trexDefault.set(dv.getUint32(b3 + 4), dv.getUint32(b3 + 12));
          });
        }
        if (t2 !== 'trak') return;
        let tw = 0;
        let th = 0;
        let isVideo = false;
        let trackId = 0;
        let timescale = 0;
        boxes(b2, e2, (t3, b3, e3) => {
          if (t3 === 'tkhd') {
            const v = b[b3];
            trackId = dv.getUint32(b3 + (v === 1 ? 20 : 12));
            const off = b3 + (v === 1 ? 88 : 76); // width / height (16.16 fixed) at the end of tkhd
            if (off + 8 <= e3) {
              tw = Math.round(dv.getUint32(off) / 65536);
              th = Math.round(dv.getUint32(off + 4) / 65536);
            }
          }
          if (t3 === 'mdia') {
            boxes(b3, e3, (t4, b4) => {
              if (t4 === 'hdlr' && type(b4 + 8) === 'vide') isVideo = true;
              if (t4 === 'mdhd') timescale = dv.getUint32(b4 + (b[b4] === 1 ? 20 : 12));
            });
          }
        });
        if (isVideo && tw * th > (width || 0) * (height || 0)) {
          width = tw;
          height = th;
          videoTrackId = trackId;
          videoTimescale = timescale;
        }
      });
    });
    if (!durationSec && videoTrackId && videoTimescale) {
      let units = 0;
      let sawFragment = false;
      boxes(0, b.byteLength, (t, body, end) => {
        if (t !== 'moof') return;
        boxes(body, end, (t2, b2, e2) => {
          if (t2 !== 'traf') return;
          let trackId = 0;
          let defDur = 0;
          boxes(b2, e2, (t3, b3) => {
            if (t3 === 'tfhd') {
              const flags = dv.getUint32(b3) & 0xffffff;
              trackId = dv.getUint32(b3 + 4);
              let o = b3 + 8;
              if (flags & 0x01) o += 8;
              if (flags & 0x02) o += 4;
              defDur = flags & 0x08 ? dv.getUint32(o) : trexDefault.get(trackId) || 0;
            }
            if (t3 === 'trun' && trackId === videoTrackId) {
              sawFragment = true;
              const flags = dv.getUint32(b3) & 0xffffff;
              const count = dv.getUint32(b3 + 4);
              let o = b3 + 8;
              if (flags & 0x01) o += 4;
              if (flags & 0x04) o += 4;
              const per = ((flags & 0x100 ? 1 : 0) + (flags & 0x200 ? 1 : 0) + (flags & 0x400 ? 1 : 0) + (flags & 0x800 ? 1 : 0)) * 4;
              if (!(flags & 0x100)) units += count * defDur;
              else for (let i = 0; i < count && o + 4 <= b.byteLength; i++, o += per) units += dv.getUint32(o);
            }
          });
        });
      });
      if (sawFragment) durationSec = units / videoTimescale;
    }
  } catch {
    /* malformed: callers treat nulls as a rejection */
  }
  return { durationSec, width, height };
}

/** MP4 duration in seconds from moov/mvhd (kept for callers of the old helper). */
export function mp4DurationSeconds(b: Uint8Array): number | null {
  return mp4Info(b).durationSec;
}

/** Delete media objects from R2 so removed files use 0 bytes. */
export async function deleteMediaKeys(env: Env, keys: Array<string | null | undefined>) {
  const valid = keys.filter((k): k is string => !!k && (MEDIA_KEY_RE.test(k) || CHAT_MEDIA_KEY_RE.test(k) || COVER_KEY_RE.test(k)));
  if (!valid.length) return;
  await env.MEDIA_BUCKET.delete(valid).catch((e) => console.warn('[media] R2 delete failed', e));
}

/** Delete a post's legacy single media object(s) from R2. */
export async function deletePostMedia(env: Env, mediaKey: string | null | undefined, legacyImageUrl?: string | null) {
  const tasks: Promise<unknown>[] = [];
  if (mediaKey && MEDIA_KEY_RE.test(mediaKey)) tasks.push(env.MEDIA_BUCKET.delete(mediaKey));
  const m = legacyImageUrl ? LEGACY_MEDIA_RE.exec(legacyImageUrl) : null;
  if (m) tasks.push(env.ASSETS_BUCKET.delete(`media/${m[1]}/${m[2]}`));
  await Promise.all(tasks.map((t) => t.catch((e) => console.warn('[media] R2 delete failed', e))));
}

/** Feed cache keys: one variant per viewer 18+ preference (v0 = safe only, v1 = includes 18+). Public posts only. */
export const feedKey = (tag: string, authorId: string, cursor: string, nsfw: boolean) => `social-feed:v${nsfw ? 1 : 0}:${tag}:${authorId}:${cursor}`;

export async function purgeFeedHeads(c: Context<any>, authorId: string, tag?: string, hashtags: string[] = []) {
  const keys: string[] = [];
  for (const v of [false, true]) {
    keys.push(feedKey('', '', '', v), feedKey('', authorId, '', v));
    if (tag) keys.push(feedKey(tag, '', '', v));
    for (const h of hashtags) keys.push(feedKey(`#${h}`, '', '', v));
  }
  await Promise.all(keys.map((k) => edgeCachePurge(c, k)));
}

/** Purge the edge-cached copy of a media file and its visibility check in this colo. */
export async function purgeMediaCache(c: Context<any>, origin: string, mediaKey: string | null | undefined) {
  if (!mediaKey) return;
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  await edgeCachePurge(c, `media-status:${mediaKey}`);
  if (!cache) return;
  try {
    c.executionCtx.waitUntil(cache.delete(new Request(mediaUrlFor(origin, mediaKey))));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Owner-signed media URLs: the author sees their own photos / videos while they are still
// being checked (silent moderation); everyone else gets 404 until the item is approved.
// ---------------------------------------------------------------------------
let signKey: Promise<CryptoKey> | null = null;
let signSecret = '';
function hmacKey(secret: string) {
  if (!signKey || signSecret !== secret) {
    signSecret = secret;
    signKey = crypto.subtle.importKey('raw', new TextEncoder().encode(`media-owner:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  return signKey;
}
export async function mediaSig(env: Env, key: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.JWT_SECRET || 'dev'), new TextEncoder().encode(key));
  return [...new Uint8Array(sig)]
    .slice(0, 16)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export async function signedMediaUrl(env: Env, origin: string, key: string): Promise<string> {
  return `${mediaUrlFor(origin, key)}?o=${await mediaSig(env, key)}`;
}

/**
 * Permanently delete a post with its media items, likes, comments, hashtags, notifications,
 * moderation jobs and R2 files. Open reports on the post are closed with `reportStatus`.
 */
export async function hardDeletePost(c: Context<{ Bindings: Env; Variables: any }>, postId: string, opts: { reportStatus?: 'deleted'; resolvedBy?: string } = {}) {
  const env = c.env;
  const [postRes, mediaRes, tagRes] = await env.DB.batch([
    env.DB.prepare('SELECT id, author_id, tag, media_key, image_url FROM social_posts WHERE id = ?1').bind(postId),
    env.DB.prepare('SELECT media_key FROM social_post_media WHERE post_id = ?1').bind(postId),
    env.DB.prepare('SELECT tag FROM social_post_hashtags WHERE post_id = ?1').bind(postId),
  ]);
  const post = postRes.results?.[0] as { id: string; author_id: string; tag: string; media_key: string | null; image_url: string | null } | undefined;
  if (!post) return null;
  const keys = ((mediaRes.results || []) as { media_key: string }[]).map((r) => r.media_key);
  const hashtags = ((tagRes.results || []) as { tag: string }[]).map((r) => r.tag);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM social_post_likes WHERE post_id = ?1').bind(postId),
    env.DB.prepare('DELETE FROM social_post_comments WHERE post_id = ?1').bind(postId),
    env.DB.prepare('DELETE FROM notifications WHERE target_id = ?1').bind(postId),
    env.DB.prepare('DELETE FROM moderation_jobs WHERE post_id = ?1').bind(postId),
    env.DB.prepare('DELETE FROM social_post_media WHERE post_id = ?1').bind(postId),
    env.DB.prepare('DELETE FROM social_post_hashtags WHERE post_id = ?1').bind(postId),
    env.DB.prepare('DELETE FROM social_posts WHERE id = ?1').bind(postId),
    env.DB.prepare('UPDATE users SET posts_count = MAX(0, posts_count - 1) WHERE id = ?1').bind(post.author_id),
    env.DB.prepare("UPDATE content_reports SET status = ?1, resolved_by = ?2, resolved_at = ?3 WHERE post_id = ?4 AND status = 'pending'").bind(
      opts.reportStatus || 'deleted',
      opts.resolvedBy || null,
      now,
      postId
    ),
  ]);
  await Promise.all([deleteMediaKeys(env, [...keys, post.media_key]), deletePostMedia(env, null, post.image_url)]);
  const origin = new URL(c.req.url).origin;
  await Promise.all([
    purgeFeedHeads(c, post.author_id, post.tag, hashtags),
    ...[...new Set([...keys, post.media_key])].map((k) => purgeMediaCache(c, origin, k)),
    edgeCachePurge(c, `social-comments:${postId}:`),
  ]);
  return post;
}
