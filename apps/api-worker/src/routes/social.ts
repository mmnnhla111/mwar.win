import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  SOCIAL_PAGE_SIZE,
  SOCIAL_IMAGE_MAX_BYTES,
  SOCIAL_POST_IMAGE_MAX_BYTES,
  SOCIAL_VIDEO_MAX_BYTES,
  SOCIAL_VIDEO_MAX_SECONDS,
  SOCIAL_POST_TAGS,
  PROFILE_COVER_IDS,
  SocialPostCreateSchema,
  SocialCommentCreateSchema,
  SocialProfileUpdateSchema,
  SocialSettingsSchema,
  ContentReportSchema,
  ReportActionSchema,
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
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { edgeCachedValue, edgeCachePurge } from '../utils/edge-cache';
import {
  MEDIA_KEY_RE,
  feedKey,
  purgeFeedHeads,
  hardDeletePost,
  mediaUrlFor,
  newMediaKey,
  sniffMedia,
  mp4DurationSeconds,
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

/** Legacy inline (data:) avatars are masked so list payloads stay tiny. */
const AVATAR_SQL = (alias: string) => `CASE WHEN ${alias}.avatar_url LIKE 'data:%' THEN NULL ELSE ${alias}.avatar_url END`;
const AUTHOR_COLS = `u.id AS a_id, u.username AS a_username, u.display_name AS a_display, ${AVATAR_SQL('u')} AS a_avatar`;

function rowAuthor(r: any): SocialAuthor {
  return { id: r.a_id, username: r.a_username, displayName: r.a_display || null, avatarUrl: r.a_avatar || null };
}

/** Post columns for list queries (media key + moderation fields, never media bytes). */
const POST_COLS = `p.id, p.body, p.tag, p.image_url, p.media_type, p.media_key, p.content_rating, p.moderation_status, p.like_count, p.comment_count, p.created_at`;

/** Approved / 18+ media get a public URL; pending and rejected media never do. */
export function rowPost(r: any, origin: string, withReason = false): SocialPost {
  const visible = r.moderation_status === 'approved' || r.moderation_status === 'nsfw_18';
  const mediaType = (r.media_type || (r.image_url ? 'image' : 'none')) as SocialPost['mediaType'];
  const mediaUrl = !visible ? null : r.media_key ? mediaUrlFor(origin, r.media_key) : r.image_url || null;
  return {
    id: r.id,
    author: rowAuthor(r),
    body: r.body || '',
    tag: (r.tag || 'General') as SocialPostTag,
    imageUrl: mediaType === 'image' ? mediaUrl : null,
    mediaType,
    mediaUrl,
    contentRating: r.content_rating === 'nsfw_18' ? 'nsfw_18' : 'safe',
    moderationStatus: (r.moderation_status || 'approved') as SocialPost['moderationStatus'],
    ...(withReason ? { moderationReason: r.moderation_reason || null } : {}),
    likeCount: r.like_count || 0,
    commentCount: r.comment_count || 0,
    createdAt: r.created_at,
  };
}

const originOf = (c: AppCtx) => new URL(c.req.url).origin;

/** Viewer's 18+ preference (one primary-key read). Default OFF. */
async function viewerShowsNsfw(c: AppCtx): Promise<boolean> {
  const r = await c.env.DB.prepare('SELECT show_nsfw FROM users WHERE id = ?1').bind(c.get('user').userId).first<{ show_nsfw: number }>();
  return r?.show_nsfw === 1;
}

/** Visibility rule shared by every public list: approved (+ 18+ only when the viewer opted in). */
const visibleSql = (nsfw: boolean) =>
  nsfw ? `p.moderation_status IN ('approved', 'nsfw_18')` : `p.moderation_status = 'approved' AND p.content_rating = 'safe'`;

/** The author's own posts that are still being checked or were removed (max 5, author-only). */
async function myModerationStrip(c: AppCtx): Promise<SocialPost[]> {
  const me = c.get('user').userId;
  const { results } = await c.env.DB
    .prepare(
      `SELECT ${POST_COLS}, p.moderation_reason, ${AUTHOR_COLS}
       FROM social_posts p JOIN users u ON u.id = p.author_id
       WHERE p.author_id = ?1 AND p.moderation_status IN ('pending', 'rejected')
       ORDER BY p.id DESC LIMIT 5`
    )
    .bind(me)
    .all<any>();
  return (results || []).map((r) => rowPost(r, originOf(c), true));
}

function page<T extends { id: string }>(rows: T[]): CursorPage<T> {
  const hasMore = rows.length > PAGE;
  const items = hasMore ? rows.slice(0, PAGE) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

/**
 * One feed page (public data only) — the shared, edge-cached part. There are two cached variants,
 * with and without 18+ posts, so a viewer with 18+ off never receives an nsfw_18 post.
 */
async function loadFeedPage(c: AppCtx, opts: { tag?: string; authorId?: string; cursor?: string; nsfw: boolean }): Promise<CursorPage<SocialPost>> {
  const tag = opts.tag || '';
  const authorId = opts.authorId || '';
  const cursor = opts.cursor || '';
  const origin = originOf(c);
  return edgeCachedValue(c, feedKey(tag, authorId, cursor, opts.nsfw), FEED_TTL, async () => {
    const where: string[] = [visibleSql(opts.nsfw)];
    const binds: unknown[] = [];
    if (authorId) {
      where.push(`p.author_id = ?${binds.length + 1}`);
      binds.push(authorId);
    }
    if (tag) {
      where.push(`p.tag = ?${binds.length + 1}`);
      binds.push(tag);
    }
    if (cursor) {
      where.push(`p.id < ?${binds.length + 1}`);
      binds.push(cursor);
    }
    const sql = `SELECT ${POST_COLS}, ${AUTHOR_COLS}
      FROM social_posts p JOIN users u ON u.id = p.author_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.id DESC LIMIT ${PAGE + 1}`;
    const { results } = await c.env.DB.prepare(sql).bind(...binds).all<any>();
    return page((results || []).map((r) => rowPost(r, origin)));
  });
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

// ----------------------------------------------------------------------------
// Feed + posts
// ----------------------------------------------------------------------------

/** GET /api/social/feed?cursor=&tag=&author=<username> — 10 posts per page, edge-cached 15 s. */
socialRouter.get('/feed', async (c) => {
  const cursor = cleanCursor(c.req.query('cursor'));
  const tagQ = c.req.query('tag') || '';
  const tag = (SOCIAL_POST_TAGS as readonly string[]).includes(tagQ) ? tagQ : '';
  let authorId = '';
  const author = c.req.query('author');
  if (author) {
    const prof = await loadProfile(c, author);
    if (!prof) return c.json({ items: [], nextCursor: null });
    authorId = prof.id;
  }
  const nsfw = await viewerShowsNsfw(c);
  const firstHomePage = !cursor && !tag && !authorId;
  const [pg, mine] = await Promise.all([loadFeedPage(c, { tag, authorId, cursor, nsfw }), firstHomePage ? myModerationStrip(c) : Promise.resolve([])]);
  return c.json({ items: await markLiked(c, pg.items), nextCursor: pg.nextCursor, mine });
});

/**
 * POST /api/social/posts
 *  - JSON { body, tag, nsfw } for text posts (approved at once, or nsfw_18 when self-tagged 18+)
 *  - multipart/form-data { body, tag, nsfw, media } for a photo (WebP <= 150 KB, resized client-side to
 *    720 px) or a video (MP4 / WebM <= 30 s, <= 5 MB). Media posts start `pending` (author-only) and a
 *    moderation job is queued for the Ubuntu moderation worker. Upload + post are one request, so an
 *    R2 object always belongs to a post (no orphan files).
 */
socialRouter.post('/posts', async (c) => {
  const me = c.get('user');
  const ctype = c.req.header('Content-Type') || '';
  let raw: Record<string, unknown> | null = null;
  let file: File | null = null;
  if (ctype.startsWith('multipart/form-data')) {
    const len = Number(c.req.header('Content-Length') || 0);
    if (len > SOCIAL_VIDEO_MAX_BYTES + 64 * 1024) return c.json({ error: 'Media is too large (video max 5 MB, photo max 150 KB)' }, 413);
    const form = await c.req.raw.formData().catch(() => null);
    if (!form) return c.json({ error: 'Invalid upload' }, 400);
    raw = { body: String(form.get('body') ?? ''), tag: String(form.get('tag') ?? 'General'), nsfw: form.get('nsfw') === 'true' || form.get('nsfw') === '1' };
    const f = form.get('media');
    if (f && typeof f !== 'string') file = f as unknown as File;
  } else {
    raw = await c.req.json().catch(() => null);
  }
  const parsed = SocialPostCreateSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid post' }, 400);
  const { body, tag, nsfw } = parsed.data;
  if (!body && !file) return c.json({ error: 'Write something or attach a photo / video' }, 400);

  // Cooldown: one indexed row read (newest post by me)
  const last = await c.env.DB
    .prepare('SELECT id FROM social_posts WHERE author_id = ?1 ORDER BY id DESC LIMIT 1')
    .bind(me.userId)
    .first<{ id: string }>();
  const now = Math.floor(Date.now() / 1000);
  if (last && now - idTime(last.id, 1) < POST_COOLDOWN_SECONDS) {
    return c.json({ error: `Please wait ${POST_COOLDOWN_SECONDS} seconds between posts` }, 429);
  }

  // Media: magic-byte sniffing + hard caps; bytes go to R2, D1 only keeps the short key
  let mediaKey: string | null = null;
  let mediaType: 'none' | 'image' | 'video' = 'none';
  if (file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const kind = sniffMedia(buf);
    if (!kind) return c.json({ error: 'Only WebP photos or MP4 / WebM videos are accepted' }, 415);
    if (kind.type === 'image' && buf.byteLength > SOCIAL_POST_IMAGE_MAX_BYTES) return c.json({ error: 'Photo must be 150 KB or less after compression' }, 413);
    if (kind.type === 'video' && buf.byteLength > SOCIAL_VIDEO_MAX_BYTES) return c.json({ error: 'Video must be 5 MB or less' }, 413);
    if (kind.ext === 'mp4') {
      const secs = mp4DurationSeconds(buf);
      if (secs !== null && secs > SOCIAL_VIDEO_MAX_SECONDS + 0.5) return c.json({ error: `Video must be ${SOCIAL_VIDEO_MAX_SECONDS} seconds or shorter` }, 413);
    }
    mediaKey = newMediaKey(kind.ext);
    mediaType = kind.type;
    await c.env.MEDIA_BUCKET.put(mediaKey, buf, {
      httpMetadata: { contentType: kind.contentType, cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { owner: me.userId },
    });
  }

  const contentRating = nsfw ? 'nsfw_18' : 'safe';
  const status = mediaKey ? 'pending' : nsfw ? 'nsfw_18' : 'approved';
  const id = sortableId('p');
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO social_posts (id, author_id, body, tag, media_type, media_key, content_rating, moderation_status, author_marked_nsfw, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    ).bind(id, me.userId, body, tag, mediaType, mediaKey, contentRating, status, nsfw ? 1 : 0, now),
    c.env.DB.prepare('UPDATE users SET posts_count = posts_count + 1 WHERE id = ?1').bind(me.userId),
    c.env.DB.prepare(`SELECT ${AUTHOR_COLS} FROM users u WHERE u.id = ?1`).bind(me.userId),
  ];
  if (mediaKey) {
    stmts.push(
      c.env.DB.prepare('INSERT INTO moderation_jobs (id, post_id, media_key, media_type, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, \'pending\', ?5, ?5)').bind(
        sortableId('j'),
        id,
        mediaKey,
        mediaType,
        now
      )
    );
  }
  let res;
  try {
    res = await c.env.DB.batch(stmts);
  } catch (err) {
    if (mediaKey) await c.env.MEDIA_BUCKET.delete(mediaKey).catch(() => {});
    throw err;
  }
  const authorRow = (res[2].results?.[0] || { a_id: me.userId, a_username: me.username }) as any;
  if (status !== 'pending') await purgeFeedHeads(c, me.userId, tag);
  await purgeProfile(c, me.username);
  const post: SocialPost = {
    ...rowPost(
      { id, body, tag, media_type: mediaType, media_key: mediaKey, content_rating: contentRating, moderation_status: status, like_count: 0, comment_count: 0, created_at: now, ...authorRow },
      originOf(c)
    ),
    likedByMe: false,
  };
  return c.json({ success: true, post }, 201);
});

/** DELETE /api/social/posts/:id — author or admin; removes likes, comments, reports' target and the R2 file. */
socialRouter.delete('/posts/:id', async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  const post = await c.env.DB.prepare('SELECT author_id FROM social_posts WHERE id = ?1').bind(id).first<{ author_id: string }>();
  if (!post) return c.json({ error: 'Post not found' }, 404);
  if (post.author_id !== me.userId && me.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
  await hardDeletePost(c, id, { reportStatus: 'deleted', resolvedBy: me.userId });
  return c.json({ success: true });
});

/** POST /api/social/posts/:id/like { like: boolean } — idempotent, one D1 batch. */
socialRouter.post('/posts/:id/like', async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const like = body?.like !== false;
  const now = Math.floor(Date.now() / 1000);
  const stmts = like
    ? [
        c.env.DB.prepare('INSERT OR IGNORE INTO social_post_likes (post_id, user_id, created_at) SELECT id, ?2, ?3 FROM social_posts WHERE id = ?1').bind(id, me.userId, now),
        c.env.DB.prepare('UPDATE social_posts SET like_count = like_count + 1 WHERE id = ?1 AND changes() = 1').bind(id),
        c.env.DB.prepare(
          `INSERT INTO social_notifications (id, user_id, actor_id, type, post_id, created_at)
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
        `SELECT cm.id, cm.post_id, cm.body, cm.created_at, ${AUTHOR_COLS}
         FROM social_post_comments cm JOIN users u ON u.id = cm.author_id
         WHERE cm.post_id = ?1 ${cursor ? 'AND cm.id > ?2' : ''}
         ORDER BY cm.id ASC LIMIT ${PAGE + 1}`
      )
      .bind(...(cursor ? [id, cursor] : [id]))
      .all<any>();
    return page(
      (results || []).map((r: any) => ({ id: r.id, postId: r.post_id, body: r.body, createdAt: r.created_at, author: rowAuthor(r) }))
    );
  });
  return c.json(pg);
});

/** POST /api/social/posts/:id/comments { body } */
socialRouter.post('/posts/:id/comments', async (c) => {
  const me = c.get('user');
  const postId = c.req.param('id');
  const parsed = SocialCommentCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid comment' }, 400);
  const now = Math.floor(Date.now() / 1000);
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
      `INSERT INTO social_notifications (id, user_id, actor_id, type, post_id, created_at)
       SELECT ?1, author_id, ?2, 'comment', id, ?3 FROM social_posts WHERE id = ?4 AND author_id <> ?2 AND changes() = 1`
    ).bind(sortableId('n'), me.userId, now, postId),
    c.env.DB.prepare(`SELECT ${AUTHOR_COLS} FROM users u WHERE u.id = ?1`).bind(me.userId),
    c.env.DB.prepare('SELECT comment_count FROM social_posts WHERE id = ?1').bind(postId),
  ]);
  if ((res[0].meta?.changes ?? 0) !== 1) return c.json({ error: 'Post not found' }, 404);
  await edgeCachePurge(c, `social-comments:${postId}:`);
  const comment: SocialComment = { id, postId, body: parsed.data.body, createdAt: now, author: rowAuthor(res[3].results?.[0] || {}) };
  const commentCount = (res[4].results?.[0] as { comment_count: number } | undefined)?.comment_count ?? 0;
  return c.json({ success: true, comment, commentCount }, 201);
});

// ----------------------------------------------------------------------------
// Profiles + follows
// ----------------------------------------------------------------------------
async function loadProfile(c: AppCtx, username: string): Promise<SocialProfile | null> {
  if (!/^[a-zA-Z0-9_]{1,40}$/.test(username)) return null;
  return edgeCachedValue<SocialProfile | null>(c, `social-profile:${username}`, PROFILE_TTL, async () => {
    const r = await c.env.DB
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.bio, ${AVATAR_SQL('u')} AS avatar_url, u.cover_color,
                u.total_kills, u.total_matches, u.followers_count, u.following_count, u.posts_count, u.created_at,
                COALESCE(w.bounty_micro_usd, 0) AS bounty
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
      totalKills: r.total_kills || 0,
      totalMatches: r.total_matches || 0,
      headBountyMicroUsd: Number(r.bounty || 0),
      followersCount: r.followers_count || 0,
      followingCount: r.following_count || 0,
      postsCount: r.posts_count || 0,
      memberSince: r.created_at || 0,
    };
  });
}

/**
 * GET /api/social/profile?u=<username> (omit u for yourself) — profile + first page of their posts in
 * ONE request. The public parts are edge-cached; only isFollowing / likedByMe are per-viewer lookups.
 */
socialRouter.get('/profile', async (c) => {
  const me = c.get('user');
  const username = c.req.query('u') || me.username;
  const profile = await loadProfile(c, username);
  if (!profile) return c.json({ error: 'Player not found' }, 404);
  const isMe = profile.id === me.userId;
  const nsfw = await viewerShowsNsfw(c);
  const [posts, follow, mine] = await Promise.all([
    loadFeedPage(c, { authorId: profile.id, nsfw }),
    isMe
      ? Promise.resolve(null)
      : c.env.DB.prepare('SELECT 1 AS f FROM social_follows WHERE follower_id = ?1 AND followee_id = ?2').bind(me.userId, profile.id).first(),
    isMe ? myModerationStrip(c) : Promise.resolve([]),
  ]);
  return c.json({
    profile: { ...profile, isMe, isFollowing: !!follow },
    posts: { items: await markLiked(c, posts.items), nextCursor: posts.nextCursor, mine },
  });
});

/** POST /api/social/profile { displayName?, bio?, avatarUrl?, coverColor? } */
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
  if (sets.length === 0) return c.json({ error: 'Nothing to update' }, 400);
  binds.push(me.userId);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${binds.length}`).bind(...binds).run();
  await Promise.all([purgeProfile(c, me.username), purgeFeedHeads(c, me.userId)]);
  return c.json({ success: true });
});

/** POST /api/social/follow { userId, follow: boolean } — idempotent, one D1 batch. */
socialRouter.post('/follow', async (c) => {
  const me = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const target = typeof body?.userId === 'string' ? body.userId : '';
  const follow = body?.follow !== false;
  if (!target || target === me.userId) return c.json({ error: 'Invalid player' }, 400);
  const now = Math.floor(Date.now() / 1000);
  const stmts = follow
    ? [
        c.env.DB.prepare('INSERT OR IGNORE INTO social_follows (follower_id, followee_id, created_at) SELECT ?1, id, ?3 FROM users WHERE id = ?2').bind(me.userId, target, now),
        c.env.DB.prepare('UPDATE users SET followers_count = followers_count + 1 WHERE id = ?1 AND changes() = 1').bind(target),
        c.env.DB.prepare('UPDATE users SET following_count = following_count + 1 WHERE id = ?1 AND changes() = 1').bind(me.userId),
        c.env.DB.prepare(
          "INSERT INTO social_notifications (id, user_id, actor_id, type, created_at) SELECT ?1, ?2, ?3, 'follow', ?4 WHERE changes() = 1"
        ).bind(sortableId('n'), target, me.userId, now),
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

/** GET /api/social/follows?u=<username>&type=followers|following&cursor= — 10 per page. */
socialRouter.get('/follows', async (c) => {
  const profile = await loadProfile(c, c.req.query('u') || c.get('user').username);
  if (!profile) return c.json({ items: [], nextCursor: null });
  const type = c.req.query('type') === 'followers' ? 'followers' : 'following';
  const cursorRaw = c.req.query('cursor') || '';
  const m = /^(\d{1,12})_([0-9a-f-]{8,40})$/i.exec(cursorRaw);
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

/** GET /api/social/search?q= — username prefix search on the UNIQUE(username) index, 8 results. */
socialRouter.get('/search', async (c) => {
  const q = (c.req.query('q') || '').trim().replace(/^@/, '');
  if (!/^[a-zA-Z0-9_]{1,20}$/.test(q)) return c.json({ users: [] });
  const users = await edgeCachedValue(c, `social-search:${q.toLowerCase()}`, 30, async () => {
    // Two index range scans (as typed + lower-case) instead of a full-table LIKE scan
    const variants = [...new Set([q, q.toLowerCase()])];
    const seen = new Map<string, SocialAuthor>();
    for (const v of variants) {
      const { results } = await c.env.DB
        .prepare(`SELECT ${AUTHOR_COLS} FROM users u WHERE u.username >= ?1 AND u.username < ?2 AND u.status != 'banned' ORDER BY u.username LIMIT 8`)
        .bind(v, `${v}￿`)
        .all<any>();
      for (const r of results || []) seen.set(r.a_id, rowAuthor(r));
    }
    return [...seen.values()].slice(0, 8);
  });
  return c.json({ users });
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
// Notifications (private: never cached)
// ----------------------------------------------------------------------------
socialRouter.get('/notifications', async (c) => {
  const me = c.get('user');
  const cursor = cleanCursor(c.req.query('cursor'));
  const { results } = await c.env.DB
    .prepare(
      `SELECT n.id, n.type, n.post_id, n.is_read, n.created_at, ${AUTHOR_COLS},
              CASE WHEN n.type = 'moderation' THEN (SELECT p.moderation_reason FROM social_posts p WHERE p.id = n.post_id) END AS reason
       FROM social_notifications n JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = ?1 ${cursor ? 'AND n.id < ?2' : ''}
       ORDER BY n.id DESC LIMIT ${PAGE + 1}`
    )
    .bind(...(cursor ? [me.userId, cursor] : [me.userId]))
    .all<any>();
  const pg = page(
    (results || []).map(
      (r: any): SocialNotification => ({
        id: r.id,
        type: r.type,
        postId: r.post_id || null,
        isRead: r.is_read === 1,
        createdAt: r.created_at,
        actor: rowAuthor(r),
        ...(r.type === 'moderation' ? { reason: r.reason || 'Removed under the content policy (weapons / blood / violence)' } : {}),
      })
    )
  );
  return c.json(pg);
});

socialRouter.post('/notifications/read', async (c) => {
  const me = c.get('user');
  await c.env.DB.prepare('UPDATE social_notifications SET is_read = 1 WHERE user_id = ?1 AND is_read = 0').bind(me.userId).run();
  return c.json({ success: true });
});

// ----------------------------------------------------------------------------
// Media: client-compressed WebP (<= 120 KB) stored in R2, served immutable
// ----------------------------------------------------------------------------
socialRouter.post('/media', async (c) => {
  const me = c.get('user');
  const len = Number(c.req.header('Content-Length') || 0);
  if (len > SOCIAL_IMAGE_MAX_BYTES) return c.json({ error: 'Image must be 120 KB or less' }, 413);
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > SOCIAL_IMAGE_MAX_BYTES) return c.json({ error: 'Image must be 120 KB or less' }, 413);
  const b = new Uint8Array(buf);
  const isWebp = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  if (!isWebp) return c.json({ error: 'Only WebP images are accepted' }, 415);
  const file = crypto.randomUUID();
  await c.env.ASSETS_BUCKET.put(`media/${me.userId}/${file}.webp`, buf, {
    httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' },
  });
  const origin = new URL(c.req.url).origin;
  return c.json({ success: true, url: `${origin}/api/media/${me.userId}/${file}.webp` }, 201);
});

/** GET /api/media/:uid/:file — public, immutable; edge cache keeps R2 reads to ~1 per colo. */
export async function serveMedia(c: Context<{ Bindings: Env }>) {
  const uid = c.req.param('uid') || '';
  const file = c.req.param('file') || '';
  if (!/^[a-z0-9-]{8,64}$/i.test(uid) || !/^[a-z0-9-]{8,64}\.webp$/i.test(file)) return c.json({ error: 'Not found' }, 404);
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const cacheKey = new Request(new URL(c.req.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) return hit;
  }
  const obj = await c.env.ASSETS_BUCKET.get(`media/${uid}/${file}`);
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

/**
 * GET /api/media/social/:y/:m/:file — post photos / videos from MEDIA_BUCKET.
 * Served only for approved or 18+ posts (pending / rejected media answer 404). The browser gets an
 * immutable 1-year Cache-Control; the colo edge cache keeps photos for 1 day so a takedown disappears
 * everywhere within 24 h (its own colo is purged at once). Videos support Range requests.
 */
const MEDIA_EDGE_TTL = 86_400;
export async function serveSocialMedia(c: Context<{ Bindings: Env }>) {
  const key = `social/${c.req.param('y')}/${c.req.param('m')}/${c.req.param('file')}`;
  if (!MEDIA_KEY_RE.test(key)) return c.json({ error: 'Not found' }, 404);
  const isVideo = !key.endsWith('.webp');
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const url = new URL(c.req.url);
  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  const okKey = new Request(`https://edge-cache.mwar.win/media-status:${key}`);

  if (cache && !isVideo) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res;
    }
  }
  // Visibility check: cached "ok" marker (1 day) or one indexed D1 read on the unique media_key index
  let visible = false;
  if (cache) visible = !!(await cache.match(okKey).catch(() => undefined));
  if (!visible) {
    const row = await c.env.DB.prepare('SELECT moderation_status FROM social_posts WHERE media_key = ?1').bind(key).first<{ moderation_status: string }>();
    visible = row?.moderation_status === 'approved' || row?.moderation_status === 'nsfw_18';
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
    'Content-Type': isVideo ? (key.endsWith('.webm') ? 'video/webm' : 'video/mp4') : 'image/webp',
    'Cache-Control': 'public, max-age=31536000, immutable',
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
  if (cache) {
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
  const { showNsfw, confirmAdult, preferredLang } = parsed.data;
  if (showNsfw && confirmAdult !== true) {
    return c.json({ error: 'Please confirm you are 18 or older to show 18+ content' }, 400);
  }
  // One UPDATE; a field left out keeps its value
  await c.env.DB.prepare('UPDATE users SET show_nsfw = COALESCE(?1, show_nsfw), preferred_lang = COALESCE(?2, preferred_lang) WHERE id = ?3')
    .bind(showNsfw === undefined ? null : showNsfw ? 1 : 0, preferredLang ?? null, me.userId)
    .run();
  return c.json({ success: true, showNsfw, preferredLang });
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
  const now = Math.floor(Date.now() / 1000);
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
// Admin takedown queue (admin / auditor)
// ----------------------------------------------------------------------------
function isStaff(c: AppCtx) {
  const r = c.get('user').role;
  return r === 'admin' || r === 'auditor';
}

/** GET /api/social/admin/reports?cursor= — pending reports, newest first, with a post preview. */
socialRouter.get('/admin/reports', async (c) => {
  if (!isStaff(c)) return c.json({ error: 'Forbidden: insufficient role privileges' }, 403);
  const cursor = cleanCursor(c.req.query('cursor'));
  const origin = originOf(c);
  const { results } = await c.env.DB
    .prepare(
      `SELECT r.id AS r_id, r.post_id AS r_post, r.reason_category, r.details, r.reporter_contact, r.created_at AS r_at,
              ru.username AS reporter_username,
              (SELECT COUNT(*) FROM content_reports r2 WHERE r2.post_id = r.post_id AND r2.status = 'pending') AS report_count,
              ${POST_COLS}, p.moderation_reason, ${AUTHOR_COLS}
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
  const items = rows.slice(0, PAGE).map((r: any) => {
    // Post preview (media URL only for approved / 18+ posts; pending media is not public yet)
    const post = r.id ? rowPost(r, origin, true) : null;
    return {
      id: r.r_id,
      postId: r.r_post,
      reasonCategory: r.reason_category,
      details: r.details || null,
      reporterUsername: r.reporter_username || null,
      reporterContact: r.reporter_contact || null,
      createdAt: r.r_at,
      reportCount: Number(r.report_count || 1),
      post,
    };
  });
  return c.json({ items, nextCursor: hasMore ? items[items.length - 1].id : null }, 200, { 'Cache-Control': 'private, no-store' });
});

/**
 * POST /api/social/admin/reports/:id/action { action: 'delete' | 'reclassify_18' | 'dismiss' }
 *  - delete: post + comments + likes removed from D1, media deleted from R2, reports -> 'deleted'
 *  - reclassify_18: post becomes nsfw_18 (hidden from viewers with 18+ off), reports -> 'reclassified'
 *  - dismiss: this report -> 'dismissed'
 */
socialRouter.post('/admin/reports/:id/action', async (c) => {
  if (!isStaff(c)) return c.json({ error: 'Forbidden: insufficient role privileges' }, 403);
  const me = c.get('user');
  const parsed = ReportActionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid action' }, 400);
  const report = await c.env.DB.prepare('SELECT id, post_id, status FROM content_reports WHERE id = ?1').bind(c.req.param('id')).first<{ id: string; post_id: string; status: string }>();
  if (!report) return c.json({ error: 'Report not found' }, 404);
  const now = Math.floor(Date.now() / 1000);
  const action = parsed.data.action;

  if (action === 'delete') {
    const post = await hardDeletePost(c, report.post_id, { reportStatus: 'deleted', resolvedBy: me.userId });
    if (!post) {
      await c.env.DB.prepare("UPDATE content_reports SET status = 'deleted', resolved_by = ?1, resolved_at = ?2 WHERE post_id = ?3 AND status = 'pending'").bind(me.userId, now, report.post_id).run();
    }
    return c.json({ success: true, action, postDeleted: !!post });
  }
  if (action === 'reclassify_18') {
    const post = await c.env.DB.prepare('SELECT author_id, tag FROM social_posts WHERE id = ?1').bind(report.post_id).first<{ author_id: string; tag: string }>();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE social_posts SET content_rating = 'nsfw_18',
           moderation_status = CASE WHEN moderation_status = 'approved' THEN 'nsfw_18' ELSE moderation_status END
         WHERE id = ?1`
      ).bind(report.post_id),
      c.env.DB.prepare("UPDATE content_reports SET status = 'reclassified', resolved_by = ?1, resolved_at = ?2 WHERE post_id = ?3 AND status = 'pending'").bind(
        me.userId,
        now,
        report.post_id
      ),
    ]);
    if (post) await purgeFeedHeads(c, post.author_id, post.tag);
    return c.json({ success: true, action });
  }
  await c.env.DB.prepare("UPDATE content_reports SET status = 'dismissed', resolved_by = ?1, resolved_at = ?2 WHERE id = ?3").bind(me.userId, now, report.id).run();
  return c.json({ success: true, action });
});
