import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  SOCIAL_PAGE_SIZE,
  SOCIAL_IMAGE_MAX_BYTES,
  SOCIAL_POST_TAGS,
  PROFILE_COVER_IDS,
  SocialPostCreateSchema,
  SocialPostUpdateSchema,
  SocialCommentCreateSchema,
  SocialProfileUpdateSchema,
  SocialSettingsSchema,
  ContentReportSchema,
  ReportActionSchema,
  earningsDisplay,
  extractHashtags,
  POST_MEDIA_MAX_ITEMS,
  MEDIA_IMAGE_HARD_BYTES,
  MEDIA_VIDEO_HARD_BYTES,
  MEDIA_VIDEO_MAX_SECONDS,
  MEDIA_VIDEO_MAX_LONG_EDGE,
  MEDIA_VIDEO_MAX_SHORT_EDGE,
  MEDIA_GATE_ERROR_CODE,
  MEDIA_GATE_ERROR_EN,
  COVER_MAX_BYTES,
} from '@mwar/shared';
import type {
  SocialAuthor,
  SocialPost,
  SocialComment,
  SocialProfile,
  SocialNotification,
  CursorPage,
  ProfileCoverColor,
  SocialPostTag,
  PostMediaItem,
  PostVisibility,
  StagedUpload,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { staffHas } from '../middleware/staff';
import { edgeCachedValue, edgeCachePurge } from '../utils/edge-cache';
import {
  MEDIA_KEY_RE,
  COVER_KEY_RE,
  feedKey,
  purgeFeedHeads,
  hardDeletePost,
  mediaUrlFor,
  newMediaKey,
  newCoverKey,
  sniffMedia,
  mp4Info,
  deleteMediaKeys,
  signedMediaUrl,
  mediaSig,
  contentTypeFor,
} from '../utils/social-media';
import { getLiveRoomsSnapshot } from './games';

type AppCtx = Context<{ Bindings: Env; Variables: { user: AuthUserPayload } }>;

export const socialRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();
socialRouter.use('*', authMiddleware);

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
const PAGE = SOCIAL_PAGE_SIZE;
const FEED_TTL = 15;
const PROFILE_TTL = 30;
const COMMENTS_TTL = 15;
const POST_COOLDOWN_SECONDS = 15;
/** Staged uploads a player may hold at once (10 per post, a little slack for retries). */
const MAX_STAGED_UPLOADS = 30;

/** Fixed-width, lexicographically time-sortable id: prefix + 9 base36 ms chars + 6 random chars. */
export function sortableId(prefix: string, nowMs = Date.now()): string {
  const rand = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => (b % 36).toString(36)).join('');
  return `${prefix}${nowMs.toString(36).padStart(9, '0')}${rand}`;
}
/** Seconds since epoch encoded in a sortableId. */
function idTime(id: string, prefixLen: number): number {
  return Math.floor(parseInt(id.slice(prefixLen, prefixLen + 9), 36) / 1000) || 0;
}

const CURSOR_RE = /^[a-z0-9]{8,40}$/i;
const cleanCursor = (v: string | undefined) => (v && CURSOR_RE.test(v) ? v : '');
const nowSec = () => Math.floor(Date.now() / 1000);

/** Legacy inline (data:) avatars are masked so list payloads stay tiny. */
const AVATAR_SQL = (alias: string) => `CASE WHEN ${alias}.avatar_url LIKE 'data:%' THEN NULL ELSE ${alias}.avatar_url END`;
const AUTHOR_COLS = `u.id AS a_id, u.username AS a_username, u.display_name AS a_display, ${AVATAR_SQL('u')} AS a_avatar`;

function rowAuthor(r: any): SocialAuthor {
  return { id: r.a_id, username: r.a_username, displayName: r.a_display || null, avatarUrl: r.a_avatar || null };
}

/** Post columns for list queries (never media bytes). */
const POST_COLS = `p.id, p.author_id, p.body, p.tag, p.image_url, p.media_type, p.media_key, p.media_count, p.visibility, p.edited_at,
  p.content_rating, p.moderation_status, p.like_count, p.comment_count, p.cheer_count, p.created_at`;

const isVisibleStatus = (s: string) => s === 'approved' || s === 'nsfw_18';

/** Build the API shape. `media` must already be resolved (see attachMedia). */
export function rowPost(r: any, origin: string, media: PostMediaItem[] = [], withReason = false): SocialPost {
  const visible = isVisibleStatus(r.moderation_status);
  // Legacy single-media posts (before 0013) without an item row
  const legacy: PostMediaItem[] =
    !media.length && visible && (r.media_key || r.image_url)
      ? [{ id: `m${r.id}`, type: r.media_type === 'video' ? 'video' : 'image', url: r.media_key ? mediaUrlFor(origin, r.media_key) : r.image_url, width: null, height: null, durationSec: null }]
      : [];
  const items = media.length ? media : legacy;
  const first = items[0];
  return {
    id: r.id,
    author: rowAuthor(r),
    body: r.body || '',
    tag: (r.tag || 'General') as SocialPostTag,
    imageUrl: first?.type === 'image' ? first.url : null,
    media: items,
    visibility: (r.visibility || 'public') as PostVisibility,
    editedAt: r.edited_at || null,
    mediaType: first ? first.type : 'none',
    mediaUrl: first?.url ?? null,
    contentRating: r.content_rating === 'nsfw_18' ? 'nsfw_18' : 'safe',
    moderationStatus: (r.moderation_status || 'approved') as SocialPost['moderationStatus'],
    ...(withReason ? { moderationReason: r.moderation_reason || null } : {}),
    likeCount: r.like_count || 0,
    commentCount: r.comment_count || 0,
    cheerCount: r.cheer_count || 0,
    createdAt: r.created_at,
  };
}

const originOf = (c: AppCtx) => new URL(c.req.url).origin;

/**
 * Media items for a list of post rows (one IN query). Approved / 18+ items get their public URL; the
 * viewer's own pending items get an owner-signed URL (silent moderation); everything else gets null.
 */
async function attachMedia(c: AppCtx, rows: any[], viewerId: string | null): Promise<SocialPost[]> {
  const origin = originOf(c);
  const ids = rows.filter((r) => Number(r.media_count || 0) > 0).map((r) => r.id);
  const byPost = new Map<string, any[]>();
  if (ids.length) {
    const ph = ids.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await c.env.DB
      .prepare(
        `SELECT id, post_id, sort_order, media_type, media_key, width, height, duration_sec, moderation_status
         FROM social_post_media WHERE post_id IN (${ph}) ORDER BY post_id, sort_order`
      )
      .bind(...ids)
      .all<any>();
    for (const m of results || []) {
      if (!byPost.has(m.post_id)) byPost.set(m.post_id, []);
      byPost.get(m.post_id)!.push(m);
    }
  }
  return Promise.all(
    rows.map(async (r) => {
      const own = !!viewerId && r.author_id === viewerId;
      const items: PostMediaItem[] = [];
      for (const m of byPost.get(r.id) || []) {
        if (m.moderation_status === 'rejected') continue;
        let url: string | null = null;
        if (isVisibleStatus(m.moderation_status)) url = mediaUrlFor(origin, m.media_key);
        else if (own) url = await signedMediaUrl(c.env, origin, m.media_key);
        if (!url && !own) continue;
        items.push({ id: m.id, type: m.media_type, url, width: m.width ?? null, height: m.height ?? null, durationSec: m.duration_sec ?? null });
      }
      return rowPost(r, origin, items);
    })
  );
}

/** Viewer's 18+ preference (one primary-key read). Default OFF. */
async function viewerShowsNsfw(c: AppCtx): Promise<boolean> {
  const r = await c.env.DB.prepare('SELECT show_nsfw FROM users WHERE id = ?1').bind(c.get('user').userId).first<{ show_nsfw: number }>();
  return r?.show_nsfw === 1;
}

/** Visibility rule shared by every list others can see: approved (+ 18+ only when the viewer opted in). */
const visibleSql = (nsfw: boolean) =>
  nsfw ? `p.moderation_status IN ('approved', 'nsfw_18')` : `p.moderation_status = 'approved' AND p.content_rating = 'safe'`;

/** Players the viewer blocked or who blocked the viewer (both directions hide each other). */
async function blockedSet(c: AppCtx): Promise<Set<string>> {
  const me = c.get('user').userId;
  const { results } = await c.env.DB
    .prepare('SELECT blocked_id AS id FROM social_blocks WHERE blocker_id = ?1 UNION SELECT blocker_id AS id FROM social_blocks WHERE blocked_id = ?1')
    .bind(me)
    .all<{ id: string }>();
  return new Set((results || []).map((r) => r.id));
}

async function isBlockedBetween(c: AppCtx, a: string, b: string): Promise<boolean> {
  const r = await c.env.DB
    .prepare('SELECT 1 AS x FROM social_blocks WHERE (blocker_id = ?1 AND blocked_id = ?2) OR (blocker_id = ?2 AND blocked_id = ?1) LIMIT 1')
    .bind(a, b)
    .first();
  return !!r;
}

function page<T extends { id: string }>(rows: T[]): CursorPage<T> {
  const hasMore = rows.length > PAGE;
  const items = hasMore ? rows.slice(0, PAGE) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

/**
 * One page of PUBLIC posts — the shared, edge-cached part. Followers-only / private posts and the
 * author's own pending posts are never in this cache; they are merged per viewer (personalRows).
 */
async function loadFeedPage(c: AppCtx, opts: { tag?: string; hashtag?: string; authorId?: string; cursor?: string; nsfw: boolean }): Promise<CursorPage<SocialPost>> {
  const tag = opts.tag || '';
  const hashtag = opts.hashtag || '';
  const authorId = opts.authorId || '';
  const cursor = opts.cursor || '';
  return edgeCachedValue(c, feedKey(hashtag ? `#${hashtag}` : tag, authorId, cursor, opts.nsfw), FEED_TTL, async () => {
    const where: string[] = [visibleSql(opts.nsfw), "p.visibility = 'public'"];
    const binds: unknown[] = [];
    const bind = (v: unknown) => {
      binds.push(v);
      return `?${binds.length}`;
    };
    if (authorId) where.push(`p.author_id = ${bind(authorId)}`);
    if (tag) where.push(`p.tag = ${bind(tag)}`);
    if (cursor) where.push(`p.id < ${bind(cursor)}`);
    const from = hashtag
      ? `social_post_hashtags h JOIN social_posts p ON p.id = h.post_id JOIN users u ON u.id = p.author_id`
      : `social_posts p JOIN users u ON u.id = p.author_id`;
    if (hashtag) where.unshift(`h.tag = ${bind(hashtag)}`);
    const sql = `SELECT ${POST_COLS}, ${AUTHOR_COLS} FROM ${from} WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT ${PAGE + 1}`;
    const { results } = await c.env.DB.prepare(sql).bind(...binds).all<any>();
    const rows = results || [];
    const posts = await attachMedia(c, rows.slice(0, PAGE + 1), null);
    return page(posts);
  });
}

/**
 * Per-viewer rows that the public cache cannot hold (never cached):
 *  - my own posts in any audience, including media still being checked (shown normally to me only)
 *  - followers-only posts of people I follow (home feed), or of this author when I follow them
 */
async function personalRows(c: AppCtx, opts: { authorId?: string; cursor?: string; nsfw: boolean; follows?: boolean }): Promise<any[]> {
  const me = c.get('user').userId;
  const cursor = opts.cursor || '';
  const stmts: ReturnType<Env['DB']['prepare']>[] = [];
  const cur = cursor ? 'AND p.id < ?2' : '';
  const withCursor = (...b: unknown[]) => (cursor ? [b[0], cursor, ...b.slice(1)] : b);
  if (!opts.authorId || opts.authorId === me) {
    stmts.push(
      c.env.DB.prepare(
        `SELECT ${POST_COLS}, ${AUTHOR_COLS} FROM social_posts p JOIN users u ON u.id = p.author_id
         WHERE p.author_id = ?1 AND p.moderation_status != 'rejected' ${cur}
         ORDER BY p.id DESC LIMIT ${PAGE + 1}`
      ).bind(...withCursor(me))
    );
  }
  if (!opts.authorId) {
    stmts.push(
      c.env.DB.prepare(
        `SELECT ${POST_COLS}, ${AUTHOR_COLS} FROM social_follows f
           JOIN social_posts p ON p.author_id = f.followee_id
           JOIN users u ON u.id = p.author_id
         WHERE f.follower_id = ?1 AND p.visibility = 'followers' AND ${visibleSql(opts.nsfw)} ${cur}
         ORDER BY p.id DESC LIMIT ${PAGE + 1}`
      ).bind(...withCursor(me))
    );
  } else if (opts.authorId !== me && opts.follows) {
    stmts.push(
      c.env.DB.prepare(
        `SELECT ${POST_COLS}, ${AUTHOR_COLS} FROM social_posts p JOIN users u ON u.id = p.author_id
         WHERE p.author_id = ?1 AND p.visibility = 'followers' AND ${visibleSql(opts.nsfw)} ${cur}
         ORDER BY p.id DESC LIMIT ${PAGE + 1}`
      ).bind(...withCursor(opts.authorId))
    );
  }
  if (!stmts.length) return [];
  const res = await c.env.DB.batch(stmts);
  return res.flatMap((r) => (r.results || []) as any[]);
}

/**
 * Merge the cached public page with the viewer's personal rows: newest first, de-duplicated,
 * 10 per page; the cursor is the last id shown (both sources page with `id < cursor`).
 */
async function mergedPage(c: AppCtx, pub: CursorPage<SocialPost>, extraRows: any[]): Promise<CursorPage<SocialPost>> {
  const me = c.get('user').userId;
  const extra = extraRows.length ? await attachMedia(c, extraRows, me) : [];
  const byId = new Map<string, SocialPost>();
  for (const p of pub.items) byId.set(p.id, p);
  for (const p of extra) byId.set(p.id, p); // own copy wins (has signed URLs for pending items)
  const blocked = await blockedSet(c);
  const all = [...byId.values()].filter((p) => !blocked.has(p.author.id)).sort((a, b) => (a.id < b.id ? 1 : -1));
  const more = !!pub.nextCursor || all.length > PAGE || extraRows.length > PAGE;
  // Stop at the public page's last id so nothing between pages is skipped
  const limitId = pub.nextCursor;
  const items = all.filter((p) => !limitId || p.id >= limitId).slice(0, PAGE);
  return { items: await markLiked(c, items), nextCursor: more && items.length ? items[items.length - 1].id : null };
}

/** Per-viewer "liked by me" flags: at most 10 primary-key lookups. */
async function markLiked(c: AppCtx, posts: SocialPost[]): Promise<SocialPost[]> {
  if (posts.length === 0) return posts;
  const me = c.get('user').userId;
  const ids = posts.map((p) => p.id);
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(',');
  const { results } = await c.env.DB
    .prepare(`SELECT post_id FROM social_post_likes WHERE user_id = ?1 AND post_id IN (${placeholders})`)
    .bind(me, ...ids)
    .all<{ post_id: string }>();
  const liked = new Set((results || []).map((r) => r.post_id));
  return posts.map((p) => ({ ...p, likedByMe: liked.has(p.id) }));
}

async function purgeProfile(c: AppCtx, username: string) {
  await edgeCachePurge(c, `social-profile:${username}`);
}

/** Can the viewer see this post at all (audience + moderation + blocks)? */
async function canView(c: AppCtx, post: { author_id: string; visibility: string; moderation_status: string; content_rating?: string }): Promise<boolean> {
  const me = c.get('user').userId;
  if (post.author_id === me) return post.moderation_status !== 'rejected';
  if (!isVisibleStatus(post.moderation_status)) return false;
  if (await isBlockedBetween(c, me, post.author_id)) return false;
  if (post.visibility === 'private') return false;
  if (post.visibility === 'followers') {
    const f = await c.env.DB.prepare('SELECT 1 AS f FROM social_follows WHERE follower_id = ?1 AND followee_id = ?2').bind(me, post.author_id).first();
    return !!f;
  }
  return true;
}

function gateError(c: AppCtx, why: string) {
  console.warn(`[media-gate] ${c.get('user').username}: ${why}`);
  return c.json({ error: MEDIA_GATE_ERROR_EN, code: MEDIA_GATE_ERROR_CODE, detail: why }, 422);
}

/** Remove every staged upload of a posting attempt (Layer-2 rejection or a failed post). */
async function purgeAttempt(c: AppCtx, attemptId: string) {
  const me = c.get('user').userId;
  const { results } = await c.env.DB
    .prepare('SELECT id, media_key FROM social_media_uploads WHERE user_id = ?1 AND attempt_id = ?2')
    .bind(me, attemptId)
    .all<{ id: string; media_key: string }>();
  if (!results?.length) return;
  await deleteMediaKeys(c.env, results.map((r) => r.media_key));
  await c.env.DB.prepare('DELETE FROM social_media_uploads WHERE user_id = ?1 AND attempt_id = ?2').bind(me, attemptId).run();
}

// ----------------------------------------------------------------------------
// Feed + posts
// ----------------------------------------------------------------------------

/** GET /api/social/feed?cursor=&tag=&hashtag=&author=<username> — 10 posts per page. */
socialRouter.get('/feed', async (c) => {
  const cursor = cleanCursor(c.req.query('cursor'));
  const tagQ = c.req.query('tag') || '';
  const tag = (SOCIAL_POST_TAGS as readonly string[]).includes(tagQ) ? tagQ : '';
  const hashtag = (c.req.query('hashtag') || '').replace(/^#/, '').toLowerCase().slice(0, 40);
  let authorId = '';
  const author = c.req.query('author');
  if (author) {
    const prof = await loadProfile(c, author);
    if (!prof) return c.json({ items: [], nextCursor: null });
    authorId = prof.id;
  }
  const nsfw = await viewerShowsNsfw(c);
  if (hashtag) {
    const pg = await loadFeedPage(c, { hashtag, cursor, nsfw });
    return c.json(await mergedPage(c, pg, []));
  }
  const me = c.get('user').userId;
  const follows =
    authorId && authorId !== me
      ? !!(await c.env.DB.prepare('SELECT 1 AS f FROM social_follows WHERE follower_id = ?1 AND followee_id = ?2').bind(me, authorId).first())
      : false;
  const [pg, extra] = await Promise.all([
    loadFeedPage(c, { tag, authorId, cursor, nsfw }),
    tag ? Promise.resolve([]) : personalRows(c, { authorId: authorId || undefined, cursor, nsfw, follows }),
  ]);
  return c.json({ ...(await mergedPage(c, pg, extra)), mine: [] });
});

/** GET /api/social/posts/:id — one post (notification click-through), audience rules applied. */
socialRouter.get('/posts/:id', async (c) => {
  const id = c.req.param('id');
  if (!CURSOR_RE.test(id)) return c.json({ error: 'Post not found' }, 404);
  const r = await c.env.DB.prepare(`SELECT ${POST_COLS}, ${AUTHOR_COLS} FROM social_posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?1`).bind(id).first<any>();
  if (!r || !(await canView(c, r))) return c.json({ error: 'Post not found' }, 404);
  const [post] = await attachMedia(c, [r], c.get('user').userId);
  const [liked] = await markLiked(c, [post]);
  return c.json({ post: liked });
});

/**
 * POST /api/social/uploads (multipart: file, attemptId, width?, height?) — Layer-2 gate for ONE photo
 * or video, then a staged R2 object. Photos: WebP / JPEG <= 300 KB. Videos: MP4, <= 3 min, <= 1280x720.
 * Any rejection deletes every upload of the attempt and answers 422 MEDIA_GATE.
 */
socialRouter.post('/uploads', async (c) => {
  const me = c.get('user');
  const len = Number(c.req.header('Content-Length') || 0);
  const form = len > MEDIA_VIDEO_HARD_BYTES + 64 * 1024 ? null : await c.req.raw.formData().catch(() => null);
  const attemptId = String(form?.get('attemptId') || c.req.query('attemptId') || '');
  if (!/^[a-z0-9]{8,40}$/i.test(attemptId)) return c.json({ error: 'Invalid upload' }, 400);
  if (!form) {
    await purgeAttempt(c, attemptId);
    return gateError(c, `request too large (${len} bytes)`);
  }
  const f = form.get('file');
  if (!f || typeof f === 'string') return c.json({ error: 'Invalid upload' }, 400);
  const buf = new Uint8Array(await (f as unknown as File).arrayBuffer());
  const kind = sniffMedia(buf);
  if (!kind || kind.ext === 'webm') {
    await purgeAttempt(c, attemptId);
    return gateError(c, 'unsupported format');
  }
  let width = Math.max(0, Math.min(10000, Math.floor(Number(form.get('width')) || 0))) || null;
  let height = Math.max(0, Math.min(10000, Math.floor(Number(form.get('height')) || 0))) || null;
  let durationSec: number | null = null;
  if (kind.type === 'image') {
    if (buf.byteLength > MEDIA_IMAGE_HARD_BYTES) {
      await purgeAttempt(c, attemptId);
      return gateError(c, `image ${buf.byteLength} bytes > ${MEDIA_IMAGE_HARD_BYTES}`);
    }
  } else {
    const info = mp4Info(buf);
    const long = Math.max(info.width || 0, info.height || 0);
    const short = Math.min(info.width || 0, info.height || 0);
    if (buf.byteLength > MEDIA_VIDEO_HARD_BYTES || info.durationSec === null || info.durationSec > MEDIA_VIDEO_MAX_SECONDS + 0.5 || !long || long > MEDIA_VIDEO_MAX_LONG_EDGE || short > MEDIA_VIDEO_MAX_SHORT_EDGE) {
      await purgeAttempt(c, attemptId);
      return gateError(c, `video ${buf.byteLength} B, ${info.durationSec ?? '?'} s, ${info.width ?? '?'}x${info.height ?? '?'}`);
    }
    width = info.width;
    height = info.height;
    durationSec = Math.round(info.durationSec * 10) / 10;
  }
  const staged = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM social_media_uploads WHERE user_id = ?1').bind(me.userId).first<{ n: number }>();
  if (Number(staged?.n || 0) >= MAX_STAGED_UPLOADS) return c.json({ error: 'Too many uploads waiting. Please post or refresh first.' }, 429);

  const key = newMediaKey(kind.ext);
  const id = sortableId('u');
  await c.env.MEDIA_BUCKET.put(key, buf, {
    httpMetadata: { contentType: kind.contentType, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { owner: me.userId },
  });
  try {
    await c.env.DB
      .prepare(
        `INSERT INTO social_media_uploads (id, user_id, attempt_id, media_key, media_type, width, height, duration_sec, bytes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
      .bind(id, me.userId, attemptId, key, kind.type, width, height, durationSec, buf.byteLength, nowSec())
      .run();
  } catch (err) {
    await deleteMediaKeys(c.env, [key]);
    throw err;
  }
  const body: StagedUpload = { uploadId: id, mediaType: kind.type, width, height, durationSec, bytes: buf.byteLength };
  return c.json(body, 201);
});

/** DELETE /api/social/uploads/:attemptId — the composer was cancelled: drop its staged files. */
socialRouter.delete('/uploads/:attemptId', async (c) => {
  const attemptId = c.req.param('attemptId');
  if (!/^[a-z0-9]{8,40}$/i.test(attemptId)) return c.json({ error: 'Invalid attempt' }, 400);
  await purgeAttempt(c, attemptId);
  return c.json({ success: true });
});

/**
 * POST /api/social/posts { body, tag, nsfw, visibility, uploads[], attemptId }
 * Text-only posts are live at once. Posts with media show normally to the author right away, while
 * other players see them only after the moderation worker approved every item (silent moderation).
 */
socialRouter.post('/posts', async (c) => {
  const me = c.get('user');
  const parsed = SocialPostCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid post' }, 400);
  const { body, tag, nsfw, visibility, uploads, attemptId } = parsed.data;
  if (!body && !uploads.length) return c.json({ error: 'Write something or attach a photo / video' }, 400);
  if (uploads.length > POST_MEDIA_MAX_ITEMS) return c.json({ error: `Up to ${POST_MEDIA_MAX_ITEMS} photos / videos per post` }, 400);

  const now = nowSec();
  const last = await c.env.DB.prepare('SELECT id FROM social_posts WHERE author_id = ?1 ORDER BY id DESC LIMIT 1').bind(me.userId).first<{ id: string }>();
  if (last && now - idTime(last.id, 1) < POST_COOLDOWN_SECONDS) {
    return c.json({ error: `Please wait ${POST_COOLDOWN_SECONDS} seconds between posts` }, 429);
  }

  let staged: any[] = [];
  if (uploads.length) {
    const ph = uploads.map((_, i) => `?${i + 2}`).join(',');
    const { results } = await c.env.DB
      .prepare(`SELECT id, media_key, media_type, width, height, duration_sec FROM social_media_uploads WHERE user_id = ?1 AND id IN (${ph})`)
      .bind(me.userId, ...uploads)
      .all<any>();
    const byId = new Map((results || []).map((r: any) => [r.id, r]));
    staged = uploads.map((u) => byId.get(u)).filter(Boolean);
    if (staged.length !== uploads.length) {
      if (attemptId) await purgeAttempt(c, attemptId);
      return c.json({ error: MEDIA_GATE_ERROR_EN, code: MEDIA_GATE_ERROR_CODE, detail: 'upload expired or missing' }, 422);
    }
  }

  const id = sortableId('p');
  const contentRating = nsfw ? 'nsfw_18' : 'safe';
  const status = staged.length ? 'pending' : nsfw ? 'nsfw_18' : 'approved';
  const hashtags = extractHashtags(body);
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO social_posts (id, author_id, body, tag, media_type, media_key, media_count, visibility, content_rating, moderation_status, author_marked_nsfw, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, ?11)`
    ).bind(id, me.userId, body, tag, staged[0]?.media_type || 'none', staged.length, visibility, contentRating, status, nsfw ? 1 : 0, now),
    c.env.DB.prepare('UPDATE users SET posts_count = posts_count + 1 WHERE id = ?1').bind(me.userId),
  ];
  staged.forEach((s, i) => {
    const mid = `m${id}${String(i).padStart(2, '0')}`;
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO social_post_media (id, post_id, sort_order, media_type, media_key, width, height, duration_sec, video_tier, moderation_status, content_rating, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?11)`
      ).bind(mid, id, i, s.media_type, s.media_key, s.width, s.height, s.duration_sec, s.media_type === 'video' ? 'hd_sub720' : null, contentRating, now),
      c.env.DB.prepare(
        `INSERT INTO moderation_jobs (id, post_id, media_id, media_key, media_type, job_type, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'scan', 'pending', ?6, ?6)`
      ).bind(sortableId('j'), id, mid, s.media_key, s.media_type, now)
    );
  });
  if (staged.length) {
    stmts.push(c.env.DB.prepare(`DELETE FROM social_media_uploads WHERE user_id = ?1 AND id IN (${staged.map((_, i) => `?${i + 2}`).join(',')})`).bind(me.userId, ...staged.map((s) => s.id)));
  }
  for (const h of hashtags) stmts.push(c.env.DB.prepare('INSERT OR IGNORE INTO social_post_hashtags (tag, post_id) VALUES (?1, ?2)').bind(h, id));
  await c.env.DB.batch(stmts);
  if (status !== 'pending' && visibility === 'public') await purgeFeedHeads(c, me.userId, tag, hashtags);
  await purgeProfile(c, me.username);

  const r = await c.env.DB.prepare(`SELECT ${POST_COLS}, ${AUTHOR_COLS} FROM social_posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?1`).bind(id).first<any>();
  const [post] = await attachMedia(c, [r], me.userId);
  return c.json({ success: true, post: { ...post, likedByMe: false } }, 201);
});

/** PATCH /api/social/posts/:id { body?, visibility? } — the author edits text and / or audience. */
socialRouter.patch('/posts/:id', async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  const parsed = SocialPostUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid update' }, 400);
  const post = await c.env.DB
    .prepare('SELECT id, author_id, body, tag, visibility, media_count FROM social_posts WHERE id = ?1')
    .bind(id)
    .first<{ id: string; author_id: string; body: string; tag: string; visibility: string; media_count: number }>();
  if (!post) return c.json({ error: 'Post not found' }, 404);
  if (post.author_id !== me.userId) return c.json({ error: 'Forbidden' }, 403);
  const { body, visibility } = parsed.data;
  if (body !== undefined && !body && !post.media_count) return c.json({ error: 'A post without photos needs some text' }, 400);
  const now = nowSec();
  const oldTags = extractHashtags(post.body);
  const stmts = [
    c.env.DB.prepare(
      'UPDATE social_posts SET body = COALESCE(?1, body), visibility = COALESCE(?2, visibility), edited_at = CASE WHEN ?1 IS NOT NULL THEN ?3 ELSE edited_at END WHERE id = ?4'
    ).bind(body ?? null, visibility ?? null, now, id),
  ];
  let newTags = oldTags;
  if (body !== undefined) {
    newTags = extractHashtags(body);
    stmts.push(c.env.DB.prepare('DELETE FROM social_post_hashtags WHERE post_id = ?1').bind(id));
    for (const h of newTags) stmts.push(c.env.DB.prepare('INSERT OR IGNORE INTO social_post_hashtags (tag, post_id) VALUES (?1, ?2)').bind(h, id));
  }
  await c.env.DB.batch(stmts);
  await Promise.all([purgeFeedHeads(c, me.userId, post.tag, [...new Set([...oldTags, ...newTags])]), purgeProfile(c, me.username)]);
  const r = await c.env.DB.prepare(`SELECT ${POST_COLS}, ${AUTHOR_COLS} FROM social_posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?1`).bind(id).first<any>();
  const [updated] = await attachMedia(c, [r], me.userId);
  const [liked] = await markLiked(c, [updated]);
  return c.json({ success: true, post: liked });
});

/** DELETE /api/social/posts/:id — author or takedown staff; removes everything incl. R2 files. */
socialRouter.delete('/posts/:id', async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  const post = await c.env.DB.prepare('SELECT author_id FROM social_posts WHERE id = ?1').bind(id).first<{ author_id: string }>();
  if (!post) return c.json({ error: 'Post not found' }, 404);
  if (post.author_id !== me.userId && !(await staffHas(c, 'takedown'))) return c.json({ error: 'Forbidden' }, 403);
  await hardDeletePost(c, id, { reportStatus: 'deleted', resolvedBy: me.userId });
  await purgeProfile(c, me.username);
  return c.json({ success: true });
});

/** POST /api/social/posts/:id/like { like: boolean } — idempotent, one D1 batch. */
socialRouter.post('/posts/:id/like', async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const like = body?.like !== false;
  const now = nowSec();
  if (like) {
    const p = await c.env.DB.prepare('SELECT author_id, visibility, moderation_status FROM social_posts WHERE id = ?1').bind(id).first<any>();
    if (!p || !(await canView(c, p))) return c.json({ error: 'Post not found' }, 404);
  }
  const stmts = like
    ? [
        c.env.DB.prepare('INSERT OR IGNORE INTO social_post_likes (post_id, user_id, created_at) SELECT id, ?2, ?3 FROM social_posts WHERE id = ?1').bind(id, me.userId, now),
        c.env.DB.prepare('UPDATE social_posts SET like_count = like_count + 1 WHERE id = ?1 AND changes() = 1').bind(id),
        c.env.DB.prepare(
          `INSERT INTO notifications (id, user_id, actor_id, type, target_id, created_at)
           SELECT ?1, author_id, ?2, 'like', id, ?3 FROM social_posts WHERE id = ?4 AND author_id <> ?2 AND changes() = 1`
        ).bind(sortableId('n'), me.userId, now, id),
      ]
    : [
        c.env.DB.prepare('DELETE FROM social_post_likes WHERE post_id = ?1 AND user_id = ?2').bind(id, me.userId),
        c.env.DB.prepare('UPDATE social_posts SET like_count = MAX(0, like_count - 1) WHERE id = ?1 AND changes() = 1').bind(id),
      ];
  stmts.push(c.env.DB.prepare('SELECT like_count FROM social_posts WHERE id = ?1').bind(id));
  const res = await c.env.DB.batch(stmts);
  const row = res[res.length - 1].results?.[0] as { like_count: number } | undefined;
  if (!row) return c.json({ error: 'Post not found' }, 404);
  return c.json({ success: true, liked: like, likeCount: row.like_count });
});

// ----------------------------------------------------------------------------
// Comments (lazy-loaded only when the drawer opens)
// ----------------------------------------------------------------------------

/** GET /api/social/posts/:id/comments?cursor= — oldest first, 10 per page, edge-cached 15 s. */
socialRouter.get('/posts/:id/comments', async (c) => {
  const id = c.req.param('id');
  if (!CURSOR_RE.test(id)) return c.json({ items: [], nextCursor: null });
  const cursor = cleanCursor(c.req.query('cursor'));
  const pg = await edgeCachedValue<CursorPage<SocialComment>>(c, `social-comments:${id}:${cursor}`, COMMENTS_TTL, async () => {
    const { results } = await c.env.DB
      .prepare(
        `SELECT cm.id, cm.post_id, cm.body, cm.created_at, cm.edited_at, ${AUTHOR_COLS}
         FROM social_post_comments cm JOIN users u ON u.id = cm.author_id
         WHERE cm.post_id = ?1 ${cursor ? 'AND cm.id > ?2' : ''}
         ORDER BY cm.id ASC LIMIT ${PAGE + 1}`
      )
      .bind(...(cursor ? [id, cursor] : [id]))
      .all<any>();
    return page(
      (results || []).map((r: any) => ({ id: r.id, postId: r.post_id, body: r.body, createdAt: r.created_at, editedAt: r.edited_at || null, author: rowAuthor(r) }))
    );
  });
  const blocked = await blockedSet(c);
  return c.json(blocked.size ? { ...pg, items: pg.items.filter((cm) => !blocked.has(cm.author.id)) } : pg);
});

/** POST /api/social/posts/:id/comments { body } */
socialRouter.post('/posts/:id/comments', async (c) => {
  const me = c.get('user');
  const postId = c.req.param('id');
  const parsed = SocialCommentCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid comment' }, 400);
  const p = await c.env.DB.prepare('SELECT author_id, visibility, moderation_status FROM social_posts WHERE id = ?1').bind(postId).first<any>();
  if (!p || !(await canView(c, p))) return c.json({ error: 'Post not found' }, 404);
  const now = nowSec();
  const id = sortableId('c');
  const res = await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO social_post_comments (id, post_id, author_id, body, created_at) SELECT ?1, id, ?2, ?3, ?4 FROM social_posts WHERE id = ?5').bind(
      id,
      me.userId,
      parsed.data.body,
      now,
      postId
    ),
    c.env.DB.prepare('UPDATE social_posts SET comment_count = comment_count + 1 WHERE id = ?1 AND changes() = 1').bind(postId),
    c.env.DB.prepare(
      `INSERT INTO notifications (id, user_id, actor_id, type, target_id, created_at)
       SELECT ?1, author_id, ?2, 'comment', id, ?3 FROM social_posts WHERE id = ?4 AND author_id <> ?2 AND changes() = 1`
    ).bind(sortableId('n'), me.userId, now, postId),
    c.env.DB.prepare(`SELECT ${AUTHOR_COLS} FROM users u WHERE u.id = ?1`).bind(me.userId),
    c.env.DB.prepare('SELECT comment_count FROM social_posts WHERE id = ?1').bind(postId),
  ]);
  if ((res[0].meta?.changes ?? 0) !== 1) return c.json({ error: 'Post not found' }, 404);
  await edgeCachePurge(c, `social-comments:${postId}:`);
  const comment: SocialComment = { id, postId, body: parsed.data.body, createdAt: now, editedAt: null, author: rowAuthor(res[3].results?.[0] || {}) };
  const commentCount = (res[4].results?.[0] as { comment_count: number } | undefined)?.comment_count ?? 0;
  return c.json({ success: true, comment, commentCount }, 201);
});

/** PATCH /api/social/comments/:id { body } — the comment author only. */
socialRouter.patch('/comments/:id', async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  const parsed = SocialCommentCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid comment' }, 400);
  const cm = await c.env.DB.prepare('SELECT post_id, author_id FROM social_post_comments WHERE id = ?1').bind(id).first<{ post_id: string; author_id: string }>();
  if (!cm) return c.json({ error: 'Comment not found' }, 404);
  if (cm.author_id !== me.userId) return c.json({ error: 'Forbidden' }, 403);
  const now = nowSec();
  await c.env.DB.prepare('UPDATE social_post_comments SET body = ?1, edited_at = ?2 WHERE id = ?3').bind(parsed.data.body, now, id).run();
  await edgeCachePurge(c, `social-comments:${cm.post_id}:`);
  return c.json({ success: true, body: parsed.data.body, editedAt: now });
});

/** DELETE /api/social/comments/:id — comment author, post author, or takedown staff. */
socialRouter.delete('/comments/:id', async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  const cm = await c.env.DB
    .prepare('SELECT cm.post_id, cm.author_id, p.author_id AS post_author FROM social_post_comments cm LEFT JOIN social_posts p ON p.id = cm.post_id WHERE cm.id = ?1')
    .bind(id)
    .first<{ post_id: string; author_id: string; post_author: string | null }>();
  if (!cm) return c.json({ error: 'Comment not found' }, 404);
  if (cm.author_id !== me.userId && cm.post_author !== me.userId && !(await staffHas(c, 'takedown'))) return c.json({ error: 'Forbidden' }, 403);
  const res = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM social_post_comments WHERE id = ?1').bind(id),
    c.env.DB.prepare('UPDATE social_posts SET comment_count = MAX(0, comment_count - 1) WHERE id = ?1 AND changes() = 1').bind(cm.post_id),
    c.env.DB.prepare('SELECT comment_count FROM social_posts WHERE id = ?1').bind(cm.post_id),
  ]);
  await edgeCachePurge(c, `social-comments:${cm.post_id}:`);
  return c.json({ success: true, commentCount: (res[2].results?.[0] as any)?.comment_count ?? 0 });
});

// ----------------------------------------------------------------------------
// Profiles + follows + blocks
// ----------------------------------------------------------------------------
async function loadProfile(c: AppCtx, username: string): Promise<SocialProfile | null> {
  if (!/^[a-zA-Z0-9_]{1,40}$/.test(username)) return null;
  return edgeCachedValue<SocialProfile | null>(c, `social-profile:${username}`, PROFILE_TTL, async () => {
    const r = await c.env.DB
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.bio, ${AVATAR_SQL('u')} AS avatar_url, u.cover_color, u.cover_url,
                u.total_kills, u.total_matches, u.followers_count, u.following_count, u.posts_count, u.cheer_count, u.created_at,
                u.earnings_visibility, COALESCE(w.total_earned_micro_usd, 0) AS earned
         FROM users u LEFT JOIN wallets w ON w.user_id = u.id
         WHERE u.username = ?1 AND u.status != 'banned'`
      )
      .bind(username)
      .first<any>();
    if (!r) return null;
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name || null,
      bio: r.bio || null,
      avatarUrl: r.avatar_url || null,
      coverColor: ((PROFILE_COVER_IDS as string[]).includes(r.cover_color) ? r.cover_color : 'lemon') as ProfileCoverColor,
      coverUrl: r.cover_url || null,
      totalKills: r.total_kills || 0,
      totalMatches: r.total_matches || 0,
      // Privacy applied here, before caching: masked / hidden amounts never reach any viewer
      totalEarnings: earningsDisplay(Number(r.earned || 0), r.earnings_visibility),
      followersCount: r.followers_count || 0,
      followingCount: r.following_count || 0,
      postsCount: r.posts_count || 0,
      cheerCount: r.cheer_count || 0,
      memberSince: r.created_at || 0,
    };
  });
}

/**
 * GET /api/social/profile?u=<username> (omit u for yourself) — profile + first page of their posts in
 * ONE request. The public parts are edge-cached; follow / block / own-post rows are per viewer.
 */
socialRouter.get('/profile', async (c) => {
  const me = c.get('user');
  const username = c.req.query('u') || me.username;
  const profile = await loadProfile(c, username);
  if (!profile) return c.json({ error: 'Player not found' }, 404);
  const isMe = profile.id === me.userId;
  const nsfw = await viewerShowsNsfw(c);
  const [rel, pub] = await Promise.all([
    isMe
      ? Promise.resolve(null)
      : c.env.DB.batch([
          c.env.DB.prepare('SELECT 1 AS f FROM social_follows WHERE follower_id = ?1 AND followee_id = ?2').bind(me.userId, profile.id),
          c.env.DB.prepare('SELECT 1 AS b FROM social_blocks WHERE blocker_id = ?1 AND blocked_id = ?2').bind(me.userId, profile.id),
          c.env.DB.prepare('SELECT 1 AS b FROM social_blocks WHERE blocker_id = ?1 AND blocked_id = ?2').bind(profile.id, me.userId),
        ]),
    loadFeedPage(c, { authorId: profile.id, nsfw }),
  ]);
  const isFollowing = !!rel?.[0].results?.length;
  const isBlocked = !!rel?.[1].results?.length;
  const blockedMe = !!rel?.[2].results?.length;
  if (blockedMe) return c.json({ error: 'Player not found' }, 404);
  const extra = isBlocked ? [] : await personalRows(c, { authorId: profile.id, nsfw, follows: isFollowing });
  const posts = isBlocked ? { items: [], nextCursor: null } : await mergedPage(c, pub, extra);
  return c.json({ profile: { ...profile, isMe, isFollowing, isBlocked }, posts: { ...posts, mine: [] } });
});

/** POST /api/social/profile { displayName?, bio?, avatarUrl?, coverColor?, coverUrl? } */
socialRouter.post('/profile', async (c) => {
  const me = c.get('user');
  const parsed = SocialProfileUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid profile' }, 400);
  const d = parsed.data;
  const sets: string[] = [];
  const binds: unknown[] = [];
  const add = (col: string, v: unknown) => {
    binds.push(v);
    sets.push(`${col} = ?${binds.length}`);
  };
  if (d.displayName !== undefined) add('display_name', d.displayName || null);
  if (d.bio !== undefined) add('bio', d.bio || null);
  if (d.avatarUrl !== undefined) add('avatar_url', d.avatarUrl);
  if (d.coverColor !== undefined) add('cover_color', d.coverColor);
  let oldCover: string | null = null;
  if (d.coverUrl !== undefined) {
    // Only the caller's own uploaded cover may be set; the previous file is deleted
    const cur = await c.env.DB.prepare('SELECT cover_url FROM users WHERE id = ?1').bind(me.userId).first<{ cover_url: string | null }>();
    oldCover = cur?.cover_url || null;
    if (d.coverUrl) {
      const key = d.coverUrl.replace(/^.*\/api\/media\//, '');
      const obj = await c.env.ASSETS_BUCKET.head(key);
      if (!obj || obj.customMetadata?.owner !== me.userId) return c.json({ error: 'Upload the cover photo first' }, 400);
    }
    add('cover_url', d.coverUrl || null);
  }
  if (sets.length === 0) return c.json({ error: 'Nothing to update' }, 400);
  binds.push(me.userId);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${binds.length}`).bind(...binds).run();
  if (oldCover && oldCover !== d.coverUrl) {
    const oldKey = oldCover.replace(/^.*\/api\/media\//, '');
    if (COVER_KEY_RE.test(oldKey)) await c.env.ASSETS_BUCKET.delete(oldKey).catch(() => {});
  }
  await Promise.all([purgeProfile(c, me.username), purgeFeedHeads(c, me.userId)]);
  return c.json({ success: true });
});

/**
 * POST /api/social/cover (raw body: WebP <= 250 KB, max 1200x400 — compressed in the browser) →
 * R2 ASSETS_BUCKET covers/YYYY/MM/<uuid>.webp. Returns the URL; save it with POST /profile { coverUrl }.
 */
socialRouter.post('/cover', async (c) => {
  const me = c.get('user');
  const len = Number(c.req.header('Content-Length') || 0);
  if (len > COVER_MAX_BYTES) return c.json({ error: 'Cover photo must be 250 KB or less' }, 413);
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (!buf.byteLength || buf.byteLength > COVER_MAX_BYTES) return c.json({ error: 'Cover photo must be 250 KB or less' }, 413);
  const kind = sniffMedia(buf);
  if (kind?.ext !== 'webp') return c.json({ error: 'Only WebP images are accepted' }, 415);
  const key = newCoverKey();
  await c.env.ASSETS_BUCKET.put(key, buf, {
    httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { owner: me.userId },
  });
  return c.json({ success: true, url: `${originOf(c)}/api/media/${key}` }, 201);
});

/** POST /api/social/follow { userId, follow: boolean } — idempotent, one D1 batch. */
socialRouter.post('/follow', async (c) => {
  const me = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const target = typeof body?.userId === 'string' ? body.userId : '';
  const follow = body?.follow !== false;
  if (!target || target === me.userId) return c.json({ error: 'Invalid player' }, 400);
  if (follow && (await isBlockedBetween(c, me.userId, target))) return c.json({ error: 'You cannot follow this player' }, 403);
  const now = nowSec();
  const stmts = follow
    ? [
        c.env.DB.prepare('INSERT OR IGNORE INTO social_follows (follower_id, followee_id, created_at) SELECT ?1, id, ?3 FROM users WHERE id = ?2').bind(me.userId, target, now),
        c.env.DB.prepare('UPDATE users SET followers_count = followers_count + 1 WHERE id = ?1 AND changes() = 1').bind(target),
        c.env.DB.prepare('UPDATE users SET following_count = following_count + 1 WHERE id = ?1 AND changes() = 1').bind(me.userId),
        c.env.DB.prepare("INSERT INTO notifications (id, user_id, actor_id, type, target_id, created_at) SELECT ?1, ?2, ?3, 'follow', ?3, ?4 WHERE changes() = 1").bind(
          sortableId('n'),
          target,
          me.userId,
          now
        ),
      ]
    : [
        c.env.DB.prepare('DELETE FROM social_follows WHERE follower_id = ?1 AND followee_id = ?2').bind(me.userId, target),
        c.env.DB.prepare('UPDATE users SET followers_count = MAX(0, followers_count - 1) WHERE id = ?1 AND changes() = 1').bind(target),
        c.env.DB.prepare('UPDATE users SET following_count = MAX(0, following_count - 1) WHERE id = ?1 AND changes() = 1').bind(me.userId),
      ];
  stmts.push(c.env.DB.prepare('SELECT username, followers_count FROM users WHERE id = ?1').bind(target));
  const res = await c.env.DB.batch(stmts);
  const row = res[res.length - 1].results?.[0] as { username: string; followers_count: number } | undefined;
  if (!row) return c.json({ error: 'Player not found' }, 404);
  await Promise.all([purgeProfile(c, row.username), purgeProfile(c, me.username)]);
  return c.json({ success: true, following: follow, followersCount: row.followers_count });
});

/**
 * POST /api/social/block { userId, block: boolean } — blocking also removes the follow links both
 * ways; blocked players don't see each other's posts, comments, profile or chat.
 */
socialRouter.post('/block', async (c) => {
  const me = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const target = typeof body?.userId === 'string' ? body.userId : '';
  const block = body?.block !== false;
  if (!target || target === me.userId) return c.json({ error: 'Invalid player' }, 400);
  const u = await c.env.DB.prepare('SELECT username FROM users WHERE id = ?1').bind(target).first<{ username: string }>();
  if (!u) return c.json({ error: 'Player not found' }, 404);
  if (block) {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT OR IGNORE INTO social_blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, ?3)').bind(me.userId, target, nowSec()),
      // Drop follows both ways and keep the counters right
      c.env.DB.prepare('DELETE FROM social_follows WHERE follower_id = ?1 AND followee_id = ?2').bind(me.userId, target),
      c.env.DB.prepare('UPDATE users SET followers_count = MAX(0, followers_count - 1) WHERE id = ?1 AND changes() = 1').bind(target),
      c.env.DB.prepare('UPDATE users SET following_count = MAX(0, following_count - 1) WHERE id = ?1 AND changes() > 0').bind(me.userId),
      c.env.DB.prepare('DELETE FROM social_follows WHERE follower_id = ?1 AND followee_id = ?2').bind(target, me.userId),
      c.env.DB.prepare('UPDATE users SET followers_count = MAX(0, followers_count - 1) WHERE id = ?1 AND changes() = 1').bind(me.userId),
      c.env.DB.prepare('UPDATE users SET following_count = MAX(0, following_count - 1) WHERE id = ?1 AND changes() > 0').bind(target),
    ]);
  } else {
    await c.env.DB.prepare('DELETE FROM social_blocks WHERE blocker_id = ?1 AND blocked_id = ?2').bind(me.userId, target).run();
  }
  await Promise.all([purgeProfile(c, u.username), purgeProfile(c, me.username)]);
  return c.json({ success: true, blocked: block });
});

/** GET /api/social/follows?u=<username>&type=followers|following&cursor= — 10 per page. */
socialRouter.get('/follows', async (c) => {
  const profile = await loadProfile(c, c.req.query('u') || c.get('user').username);
  if (!profile) return c.json({ items: [], nextCursor: null });
  const type = c.req.query('type') === 'followers' ? 'followers' : 'following';
  const cursorRaw = c.req.query('cursor') || '';
  const m = /^(\d{1,12})_([0-9a-z-]{8,40})$/i.exec(cursorRaw);
  const [selfCol, otherCol] = type === 'followers' ? ['followee_id', 'follower_id'] : ['follower_id', 'followee_id'];
  const { results } = await c.env.DB
    .prepare(
      `SELECT f.created_at AS f_at, ${AUTHOR_COLS}
       FROM social_follows f JOIN users u ON u.id = f.${otherCol}
       WHERE f.${selfCol} = ?1 ${m ? `AND (f.created_at < ?2 OR (f.created_at = ?2 AND f.${otherCol} < ?3))` : ''}
       ORDER BY f.created_at DESC, f.${otherCol} DESC LIMIT ${PAGE + 1}`
    )
    .bind(...(m ? [profile.id, Number(m[1]), m[2]] : [profile.id]))
    .all<any>();
  const rows = results || [];
  const hasMore = rows.length > PAGE;
  const items = rows.slice(0, PAGE);
  const last = items[items.length - 1];
  return c.json({
    items: items.map(rowAuthor),
    nextCursor: hasMore && last ? `${last.f_at}_${last.a_id}` : null,
  });
});

// ----------------------------------------------------------------------------
// Discovery: search + sidebar suggestions
// ----------------------------------------------------------------------------

/**
 * GET /api/social/search?q= — players (username prefix on the UNIQUE index) + public posts whose
 * text contains q (newest 6). A "#tag" query searches the hashtag index instead. Edge-cached 30 s.
 */
socialRouter.get('/search', async (c) => {
  const raw = (c.req.query('q') || '').trim().slice(0, 40);
  if (!raw) return c.json({ users: [], posts: [], hashtags: [] });
  const nsfw = await viewerShowsNsfw(c);
  const isTag = raw.startsWith('#');
  const tag = raw.replace(/^#/, '').toLowerCase();
  const userQ = raw.replace(/^@/, '');
  const res = await edgeCachedValue(c, `social-search:v2:${nsfw ? 1 : 0}:${raw.toLowerCase()}`, 30, async () => {
    const users = new Map<string, SocialAuthor>();
    if (!isTag && /^[a-zA-Z0-9_]{1,20}$/.test(userQ)) {
      for (const v of [...new Set([userQ, userQ.toLowerCase()])]) {
        const { results } = await c.env.DB
          .prepare(`SELECT ${AUTHOR_COLS} FROM users u WHERE u.username >= ?1 AND u.username < ?2 AND u.status != 'banned' ORDER BY u.username LIMIT 8`)
          .bind(v, `${v}￿`)
          .all<any>();
        for (const r of results || []) users.set(r.a_id, rowAuthor(r));
      }
    }
    let postRows: any[] = [];
    let hashtags: { tag: string; count: number }[] = [];
    if (tag && /^[\p{L}\p{M}\p{N}_]{1,40}$/u.test(tag)) {
      const { results } = await c.env.DB
        .prepare('SELECT tag, COUNT(*) AS n FROM social_post_hashtags WHERE tag >= ?1 AND tag < ?2 GROUP BY tag ORDER BY n DESC LIMIT 6')
        .bind(tag, `${tag}￿`)
        .all<any>();
      hashtags = (results || []).map((r: any) => ({ tag: r.tag, count: Number(r.n) }));
    }
    if (isTag) {
      if (tag) {
        const { results } = await c.env.DB
          .prepare(
            `SELECT ${POST_COLS}, ${AUTHOR_COLS} FROM social_post_hashtags h JOIN social_posts p ON p.id = h.post_id JOIN users u ON u.id = p.author_id
             WHERE h.tag = ?1 AND p.visibility = 'public' AND ${visibleSql(nsfw)} ORDER BY p.id DESC LIMIT 6`
          )
          .bind(tag)
          .all<any>();
        postRows = results || [];
      }
    } else if (raw.length >= 2) {
      // Bounded scan: newest 500 public posts only, so a search never walks the whole table
      const { results } = await c.env.DB
        .prepare(
          `SELECT ${POST_COLS}, ${AUTHOR_COLS} FROM (SELECT * FROM social_posts WHERE visibility = 'public' ORDER BY id DESC LIMIT 500) p
           JOIN users u ON u.id = p.author_id
           WHERE ${visibleSql(nsfw)} AND instr(lower(p.body), lower(?1)) > 0 ORDER BY p.id DESC LIMIT 6`
        )
        .bind(raw)
        .all<any>();
      postRows = results || [];
    }
    return { users: [...users.values()].slice(0, 8), posts: await attachMedia(c, postRows, null), hashtags };
  });
  const blocked = await blockedSet(c);
  return c.json({
    users: res.users.filter((u) => !blocked.has(u.id)),
    posts: res.posts.filter((p) => !blocked.has(p.author.id)),
    hashtags: res.hashtags,
  });
});

/** GET /api/social/suggestions — players online now (from the live room snapshot) + newest players. */
socialRouter.get('/suggestions', async (c) => {
  const data = await edgeCachedValue(c, 'social-suggestions', 45, async () => {
    const { results } = await c.env.DB
      .prepare(`SELECT ${AUTHOR_COLS} FROM users u WHERE u.status != 'banned' ORDER BY u.created_at DESC LIMIT 8`)
      .all<any>();
    return { newest: (results || []).map(rowAuthor) };
  });
  const snapshot = await getLiveRoomsSnapshot(c);
  const online: { username: string; userId: string | null; roomId: string }[] = [];
  for (const room of snapshot.rooms) {
    for (const p of room.roster) {
      if (p.userId && online.length < 8) online.push({ username: p.username, userId: p.userId, roomId: room.id });
    }
  }
  return c.json({ online, newest: data.newest });
});

// ----------------------------------------------------------------------------
// Notifications (private: never cached). Read on demand only (bell / page), no polling.
// ----------------------------------------------------------------------------
socialRouter.get('/notifications', async (c) => {
  const me = c.get('user');
  const cursor = cleanCursor(c.req.query('cursor'));
  const { results } = await c.env.DB
    .prepare(
      `SELECT n.id, n.type, n.target_id, n.message_key, n.payload_json, n.is_read, n.created_at,
              u.id AS a_id, u.username AS a_username, u.display_name AS a_display, ${AVATAR_SQL('u')} AS a_avatar
       FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = ?1 ${cursor ? 'AND n.id < ?2' : ''}
       ORDER BY n.id DESC LIMIT ${PAGE + 1}`
    )
    .bind(...(cursor ? [me.userId, cursor] : [me.userId]))
    .all<any>();
  const pg = page(
    (results || []).map((r: any): SocialNotification => {
      let payload: Record<string, string | number> | null = null;
      try {
        payload = r.payload_json ? JSON.parse(r.payload_json) : null;
      } catch {
        payload = null;
      }
      const postTypes = new Set(['like', 'comment', 'post_rejected']);
      return {
        id: r.id,
        type: r.type,
        actor: r.a_id ? rowAuthor(r) : null,
        targetId: r.target_id || null,
        postId: postTypes.has(r.type) ? r.target_id || null : null,
        messageKey: r.message_key || null,
        payload,
        isRead: r.is_read === 1,
        createdAt: r.created_at,
        ...(r.type === 'post_rejected' ? { reason: (payload?.reason as string) || 'Removed under the content policy (weapons / blood / violence)' } : {}),
      };
    })
  );
  return c.json(pg);
});

/** POST /api/social/notifications/read { id? } — one notification, or all when id is omitted. */
socialRouter.post('/notifications/read', async (c) => {
  const me = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const id = typeof body?.id === 'string' && CURSOR_RE.test(body.id) ? body.id : '';
  if (id) await c.env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?1 AND user_id = ?2').bind(id, me.userId).run();
  else await c.env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?1 AND is_read = 0').bind(me.userId).run();
  const left = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND is_read = 0').bind(me.userId).first<{ n: number }>();
  return c.json({ success: true, unread: Number(left?.n || 0) });
});

// ----------------------------------------------------------------------------
// Media: avatars (WebP <= 120 KB) in ASSETS_BUCKET, served immutable
// ----------------------------------------------------------------------------
socialRouter.post('/media', async (c) => {
  const me = c.get('user');
  const len = Number(c.req.header('Content-Length') || 0);
  if (len > SOCIAL_IMAGE_MAX_BYTES) return c.json({ error: 'Image must be 120 KB or less' }, 413);
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > SOCIAL_IMAGE_MAX_BYTES) return c.json({ error: 'Image must be 120 KB or less' }, 413);
  const b = new Uint8Array(buf);
  if (sniffMedia(b)?.ext !== 'webp') return c.json({ error: 'Only WebP images are accepted' }, 415);
  const file = crypto.randomUUID();
  await c.env.ASSETS_BUCKET.put(`media/${me.userId}/${file}.webp`, buf, {
    httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' },
  });
  return c.json({ success: true, url: `${originOf(c)}/api/media/${me.userId}/${file}.webp` }, 201);
});

async function serveR2Immutable(c: Context<{ Bindings: Env }>, key: string) {
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const cacheKey = new Request(new URL(c.req.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) return hit;
  }
  const obj = await c.env.ASSETS_BUCKET.get(key);
  if (!obj) return c.json({ error: 'Not found' }, 404);
  const res = new Response(obj.body as unknown as ReadableStream, {
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      ETag: obj.httpEtag,
    },
  });
  if (cache) {
    try {
      c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
    } catch {
      /* no ctx */
    }
  }
  return res;
}

/** GET /api/media/:uid/:file — avatars; public, immutable; edge cache keeps R2 reads to ~1 per colo. */
export async function serveMedia(c: Context<{ Bindings: Env }>) {
  const uid = c.req.param('uid') || '';
  const file = c.req.param('file') || '';
  if (!/^[a-z0-9-]{8,64}$/i.test(uid) || !/^[a-z0-9-]{8,64}\.webp$/i.test(file)) return c.json({ error: 'Not found' }, 404);
  return serveR2Immutable(c, `media/${uid}/${file}`);
}

/** GET /api/media/covers/:y/:m/:file — profile cover photos. */
export async function serveCover(c: Context<{ Bindings: Env }>) {
  const key = `covers/${c.req.param('y')}/${c.req.param('m')}/${c.req.param('file')}`;
  if (!COVER_KEY_RE.test(key)) return c.json({ error: 'Not found' }, 404);
  return serveR2Immutable(c, key);
}

/**
 * GET /api/media/social/:y/:m/:file[?o=<sig>] — post photos / videos from MEDIA_BUCKET.
 * Public only once the item is approved / 18+. The author's own pending items open with an
 * owner signature (?o=, silent moderation) and are never stored in the shared edge cache.
 * Approved photos stay in the colo cache for 1 day so a takedown disappears within 24 h.
 * Videos support Range requests.
 */
const MEDIA_EDGE_TTL = 86_400;
export async function serveSocialMedia(c: Context<{ Bindings: Env }>) {
  const key = `social/${c.req.param('y')}/${c.req.param('m')}/${c.req.param('file')}`;
  if (!MEDIA_KEY_RE.test(key)) return c.json({ error: 'Not found' }, 404);
  const isVideo = key.endsWith('.mp4') || key.endsWith('.webm');
  const sig = c.req.query('o') || '';
  const ownerView = !!sig && sig === (await mediaSig(c.env, key));
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const url = new URL(c.req.url);
  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  const okKey = new Request(`https://edge-cache.mwar.win/media-status:${key}`);

  if (cache && !isVideo && !ownerView) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res;
    }
  }
  let visible = ownerView;
  if (!visible && cache) visible = !!(await cache.match(okKey).catch(() => undefined));
  if (!visible) {
    const row = await c.env.DB.prepare('SELECT moderation_status FROM social_post_media WHERE media_key = ?1').bind(key).first<{ moderation_status: string }>();
    visible = isVisibleStatus(row?.moderation_status || '');
    if (visible && cache) {
      try {
        c.executionCtx.waitUntil(cache.put(okKey, new Response('1', { headers: { 'Cache-Control': `public, max-age=${MEDIA_EDGE_TTL}` } })));
      } catch {
        /* no ctx */
      }
    }
  }
  if (!visible) return c.json({ error: 'Not found' }, 404);

  const headers: Record<string, string> = {
    'Content-Type': contentTypeFor(key),
    'Cache-Control': ownerView ? 'private, max-age=3600' : 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
  };
  if (isVideo) {
    const range = c.req.header('Range');
    const obj = await c.env.MEDIA_BUCKET.get(key, range ? { range: c.req.raw.headers as any } : undefined);
    if (!obj) return c.json({ error: 'Not found' }, 404);
    headers.ETag = obj.httpEtag;
    const r = (obj as any).range as { offset?: number; length?: number } | undefined;
    if (range && r && typeof r.offset === 'number') {
      const length = r.length ?? obj.size - r.offset;
      headers['Content-Range'] = `bytes ${r.offset}-${r.offset + length - 1}/${obj.size}`;
      headers['Content-Length'] = String(length);
      return new Response((obj as any).body as ReadableStream, { status: 206, headers });
    }
    headers['Content-Length'] = String(obj.size);
    return new Response((obj as any).body as ReadableStream, { headers });
  }
  const obj = await c.env.MEDIA_BUCKET.get(key);
  if (!obj) return c.json({ error: 'Not found' }, 404);
  headers.ETag = obj.httpEtag;
  const res = new Response((obj as any).body as ReadableStream, { headers });
  if (cache && !ownerView) {
    try {
      const stored = new Response(res.clone().body, { headers: { ...headers, 'Cache-Control': `public, max-age=${MEDIA_EDGE_TTL}` } });
      c.executionCtx.waitUntil(cache.put(cacheKey, stored));
    } catch {
      /* no ctx */
    }
  }
  return res;
}

// ----------------------------------------------------------------------------
// Content settings (18+ preference)
// ----------------------------------------------------------------------------
/** PATCH /api/social/settings { showNsfw, confirmAdult } — turning 18+ on needs the age confirmation. */
socialRouter.patch('/settings', async (c) => {
  const me = c.get('user');
  const parsed = SocialSettingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid settings' }, 400);
  const { showNsfw, confirmAdult, preferredLang, earningsVisibility } = parsed.data;
  if (showNsfw && confirmAdult !== true) {
    return c.json({ error: 'Please confirm you are 18 or older to show 18+ content' }, 400);
  }
  await c.env.DB.prepare(
    'UPDATE users SET show_nsfw = COALESCE(?1, show_nsfw), preferred_lang = COALESCE(?2, preferred_lang), earnings_visibility = COALESCE(?3, earnings_visibility) WHERE id = ?4'
  )
    .bind(showNsfw === undefined ? null : showNsfw ? 1 : 0, preferredLang ?? null, earningsVisibility ?? null, me.userId)
    .run();
  if (earningsVisibility) await purgeProfile(c, me.username);
  return c.json({ success: true, showNsfw, preferredLang, earningsVisibility });
});

// ----------------------------------------------------------------------------
// Report / takedown requests
// ----------------------------------------------------------------------------
const REPORTS_PER_HOUR = 5;

/** POST /api/social/reports { postId, reasonCategory, details?, contact? } — max 5 per hour per user. */
socialRouter.post('/reports', async (c) => {
  const me = c.get('user');
  const parsed = ContentReportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid report' }, 400);
  const { postId, reasonCategory, details, contact } = parsed.data;
  const now = nowSec();
  const [post, recent, dup] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id FROM social_posts WHERE id = ?1').bind(postId),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM content_reports WHERE reporter_user_id = ?1 AND created_at > ?2').bind(me.userId, now - 3600),
    c.env.DB.prepare("SELECT 1 AS d FROM content_reports WHERE post_id = ?1 AND reporter_user_id = ?2 AND status = 'pending' LIMIT 1").bind(postId, me.userId),
  ]);
  if (!post.results?.length) return c.json({ error: 'Post not found (it may already be removed)' }, 404);
  if (Number((recent.results?.[0] as any)?.n ?? 0) >= REPORTS_PER_HOUR) {
    return c.json({ error: 'Too many reports in the last hour. Please try again later.' }, 429);
  }
  if (dup.results?.length) {
    return c.json({ success: true, duplicate: true, message: 'ได้รับคำขอแจ้งลบแล้ว ทีมงานจะดำเนินการตรวจสอบและลบให้โดยเร็วที่สุด' });
  }
  await c.env.DB
    .prepare(
      `INSERT INTO content_reports (id, post_id, reporter_user_id, reporter_contact, reason_category, details, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)`
    )
    .bind(sortableId('r'), postId, me.userId, contact || null, reasonCategory, details || null, now)
    .run();
  return c.json({ success: true, message: 'ได้รับคำขอแจ้งลบแล้ว ทีมงานจะดำเนินการตรวจสอบและลบให้โดยเร็วที่สุด' }, 201);
});

// ----------------------------------------------------------------------------
// Admin takedown queue (staff with the "takedown" permission)
// ----------------------------------------------------------------------------

/** GET /api/social/admin/reports?cursor= — pending reports, newest first, with a post preview. */
socialRouter.get('/admin/reports', async (c) => {
  if (!(await staffHas(c, 'takedown'))) return c.json({ error: 'Forbidden: your staff role does not allow this', code: 'STAFF_ROLE' }, 403);
  const cursor = cleanCursor(c.req.query('cursor'));
  const { results } = await c.env.DB
    .prepare(
      `SELECT r.id AS r_id, r.post_id AS r_post, r.reason_category, r.details, r.reporter_contact, r.created_at AS r_at,
              ru.username AS reporter_username,
              (SELECT COUNT(*) FROM content_reports r2 WHERE r2.post_id = r.post_id AND r2.status = 'pending') AS report_count,
              ${POST_COLS}, p.author_id, p.moderation_reason, ${AUTHOR_COLS}
       FROM content_reports r
       LEFT JOIN users ru ON ru.id = r.reporter_user_id
       LEFT JOIN social_posts p ON p.id = r.post_id
       LEFT JOIN users u ON u.id = p.author_id
       WHERE r.status = 'pending' ${cursor ? 'AND r.id < ?1' : ''}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ${PAGE + 1}`
    )
    .bind(...(cursor ? [cursor] : []))
    .all<any>();
  const rows = results || [];
  const hasMore = rows.length > PAGE;
  const slice = rows.slice(0, PAGE);
  const posts = await attachMedia(c, slice.filter((r: any) => r.id), null);
  const byId = new Map(posts.map((p) => [p.id, p]));
  const items = slice.map((r: any) => ({
    id: r.r_id,
    postId: r.r_post,
    reasonCategory: r.reason_category,
    details: r.details || null,
    reporterUsername: r.reporter_username || null,
    reporterContact: r.reporter_contact || null,
    createdAt: r.r_at,
    reportCount: Number(r.report_count || 1),
    post: r.id ? { ...byId.get(r.id)!, moderationReason: r.moderation_reason || null } : null,
  }));
  return c.json({ items, nextCursor: hasMore ? items[items.length - 1].id : null }, 200, { 'Cache-Control': 'private, no-store' });
});

/**
 * POST /api/social/admin/reports/:id/action { action: 'delete' | 'reclassify_18' | 'dismiss' }
 *  - delete: post + comments + likes + media rows removed from D1, files deleted from R2, reports -> 'deleted'
 *  - reclassify_18: post becomes nsfw_18 (hidden from viewers with 18+ off), reports -> 'reclassified'
 *  - dismiss: this report -> 'dismissed'
 */
socialRouter.post('/admin/reports/:id/action', async (c) => {
  if (!(await staffHas(c, 'takedown'))) return c.json({ error: 'Forbidden: your staff role does not allow this', code: 'STAFF_ROLE' }, 403);
  const me = c.get('user');
  const parsed = ReportActionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid action' }, 400);
  const report = await c.env.DB.prepare('SELECT id, post_id, status FROM content_reports WHERE id = ?1').bind(c.req.param('id')).first<{ id: string; post_id: string; status: string }>();
  if (!report) return c.json({ error: 'Report not found' }, 404);
  const now = nowSec();
  const action = parsed.data.action;

  if (action === 'delete') {
    const post = await hardDeletePost(c, report.post_id, { reportStatus: 'deleted', resolvedBy: me.userId });
    if (!post) {
      await c.env.DB.prepare("UPDATE content_reports SET status = 'deleted', resolved_by = ?1, resolved_at = ?2 WHERE post_id = ?3 AND status = 'pending'").bind(me.userId, now, report.post_id).run();
    }
    return c.json({ success: true, action, postDeleted: !!post });
  }
  if (action === 'reclassify_18') {
    const post = await c.env.DB.prepare('SELECT author_id, tag, body FROM social_posts WHERE id = ?1').bind(report.post_id).first<{ author_id: string; tag: string; body: string }>();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE social_posts SET content_rating = 'nsfw_18',
           moderation_status = CASE WHEN moderation_status = 'approved' THEN 'nsfw_18' ELSE moderation_status END
         WHERE id = ?1`
      ).bind(report.post_id),
      c.env.DB.prepare(
        `UPDATE social_post_media SET content_rating = 'nsfw_18',
           moderation_status = CASE WHEN moderation_status = 'approved' THEN 'nsfw_18' ELSE moderation_status END
         WHERE post_id = ?1`
      ).bind(report.post_id),
      c.env.DB.prepare("UPDATE content_reports SET status = 'reclassified', resolved_by = ?1, resolved_at = ?2 WHERE post_id = ?3 AND status = 'pending'").bind(
        me.userId,
        now,
        report.post_id
      ),
    ]);
    if (post) await purgeFeedHeads(c, post.author_id, post.tag, extractHashtags(post.body || ''));
    return c.json({ success: true, action });
  }
  await c.env.DB.prepare("UPDATE content_reports SET status = 'dismissed', resolved_by = ?1, resolved_at = ?2 WHERE id = ?3").bind(me.userId, now, report.id).run();
  return c.json({ success: true, action });
});
