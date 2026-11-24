import type { Context } from 'hono';
import type { Env } from '../types';
import { edgeCachePurge } from './edge-cache';

/**
 * Social media + content-policy helpers shared by the social routes, the moderation queue API,
 * the admin takedown queue and the nightly cron.
 */

export const MEDIA_KEY_RE = /^social\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(webp|mp4|webm)$/;
/** Legacy (0008) photo URLs: <origin>/api/media/<uid>/<file>.webp in ASSETS_BUCKET under media/. */
const LEGACY_MEDIA_RE = /\/api\/media\/([a-z0-9-]{8,64})\/([a-z0-9-]{8,64}\.webp)$/i;

export function newMediaKey(ext: 'webp' | 'mp4' | 'webm', now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `social/${y}/${m}/${crypto.randomUUID()}.${ext}`;
}

export function mediaUrlFor(origin: string, key: string): string {
  return `${origin}/api/media/${key}`;
}

export type SniffedMedia = { type: 'image'; ext: 'webp'; contentType: 'image/webp' } | { type: 'video'; ext: 'mp4' | 'webm'; contentType: 'video/mp4' | 'video/webm' };

/** Identify an upload from its magic bytes (never trust the client Content-Type). */
export function sniffMedia(b: Uint8Array): SniffedMedia | null {
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { type: 'image', ext: 'webp', contentType: 'image/webp' };
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
 * MP4 duration in seconds from the moov/mvhd box (no decoding). Returns null when the box is not
 * found; the moderation worker re-checks every video with ffprobe anyway.
 */
export function mp4DurationSeconds(b: Uint8Array): number | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const type = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const walk = (start: number, end: number, depth: number): number | null => {
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      const t = type(o + 4);
      let header = 8;
      if (size === 1 && o + 16 <= end) {
        size = Number(dv.getBigUint64(o + 8));
        header = 16;
      } else if (size === 0) size = end - o;
      if (size < header || o + size > end) return null;
      if (t === 'moov' && depth === 0) return walk(o + header, o + size, 1);
      if (t === 'mvhd' && depth === 1) {
        const v = b[o + header];
        if (v === 1) {
          const timescale = dv.getUint32(o + header + 20);
          const duration = Number(dv.getBigUint64(o + header + 24));
          return timescale ? duration / timescale : null;
        }
        const timescale = dv.getUint32(o + header + 12);
        const duration = dv.getUint32(o + header + 16);
        return timescale ? duration / timescale : null;
      }
      o += size;
    }
    return null;
  };
  try {
    return walk(0, b.byteLength, 0);
  } catch {
    return null;
  }
}

/** Delete a post's media object(s) from R2 so removed files use 0 bytes. */
export async function deletePostMedia(env: Env, mediaKey: string | null | undefined, legacyImageUrl?: string | null) {
  const tasks: Promise<unknown>[] = [];
  if (mediaKey && MEDIA_KEY_RE.test(mediaKey)) tasks.push(env.MEDIA_BUCKET.delete(mediaKey));
  const m = legacyImageUrl ? LEGACY_MEDIA_RE.exec(legacyImageUrl) : null;
  if (m) tasks.push(env.ASSETS_BUCKET.delete(`media/${m[1]}/${m[2]}`));
  await Promise.all(tasks.map((t) => t.catch((e) => console.warn('[media] R2 delete failed', e))));
}

/** Feed cache keys: one variant per viewer 18+ preference (v0 = safe only, v1 = includes 18+). */
export const feedKey = (tag: string, authorId: string, cursor: string, nsfw: boolean) => `social-feed:v${nsfw ? 1 : 0}:${tag}:${authorId}:${cursor}`;

export async function purgeFeedHeads(c: Context<any>, authorId: string, tag?: string) {
  const keys: string[] = [];
  for (const v of [false, true]) {
    keys.push(feedKey('', '', '', v), feedKey('', authorId, '', v));
    if (tag) keys.push(feedKey(tag, '', '', v));
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

/**
 * Permanently delete a post with its likes, comments, notifications, moderation jobs and R2 media.
 * Open reports on the post are closed with `reportStatus`. One D1 batch + one R2 delete.
 */
export async function hardDeletePost(c: Context<{ Bindings: Env; Variables: any }>, postId: string, opts: { reportStatus?: 'deleted'; resolvedBy?: string } = {}) {
  const env = c.env;
  const post = await env.DB
    .prepare('SELECT id, author_id, tag, media_key, image_url FROM social_posts WHERE id = ?1')
    .bind(postId)
    .first<{ id: string; author_id: string; tag: string; media_key: string | null; image_url: string | null }>();
  if (!post) return null;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM social_post_likes WHERE post_id = ?1').bind(postId),
    env.DB.prepare('DELETE FROM social_post_comments WHERE post_id = ?1').bind(postId),
    env.DB.prepare('DELETE FROM social_notifications WHERE post_id = ?1').bind(postId),
    env.DB.prepare('DELETE FROM moderation_jobs WHERE post_id = ?1').bind(postId),
    env.DB.prepare('DELETE FROM social_posts WHERE id = ?1').bind(postId),
    env.DB.prepare('UPDATE users SET posts_count = MAX(0, posts_count - 1) WHERE id = ?1').bind(post.author_id),
    env.DB.prepare("UPDATE content_reports SET status = ?1, resolved_by = ?2, resolved_at = ?3 WHERE post_id = ?4 AND status = 'pending'").bind(
      opts.reportStatus || 'deleted',
      opts.resolvedBy || null,
      now,
      postId
    ),
  ]);
  await deletePostMedia(env, post.media_key, post.image_url);
  const origin = new URL(c.req.url).origin;
  await Promise.all([purgeFeedHeads(c, post.author_id, post.tag), purgeMediaCache(c, origin, post.media_key), edgeCachePurge(c, `social-comments:${postId}:`)]);
  return post;
}
