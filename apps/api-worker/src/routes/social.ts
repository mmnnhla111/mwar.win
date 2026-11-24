import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  SOCIAL_PAGE_SIZE,
  SOCIAL_IMAGE_MAX_BYTES,
  SOCIAL_POST_TAGS,
  PROFILE_COVER_IDS,
  SocialPostCreateSchema,
  SocialCommentCreateSchema,
  SocialProfileUpdateSchema,
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

function rowPost(r: any): SocialPost {
  return {
    id: r.id,
    author: rowAuthor(r),
    body: r.body || '',
    tag: (r.tag || 'General') as SocialPostTag,
    imageUrl: r.image_url || null,
    likeCount: r.like_count || 0,
    commentCount: r.comment_count || 0,
    createdAt: r.created_at,
  };
}

function page<T extends { id: string }>(rows: T[]): CursorPage<T> {
  const hasMore = rows.length > PAGE;
  const items = hasMore ? rows.slice(0, PAGE) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

const feedKey = (tag: string, authorId: string, cursor: string) => `social-feed:${tag}:${authorId}:${cursor}`;

/** One feed page (public data only) — the shared, edge-cached part. */
async function loadFeedPage(c: AppCtx, opts: { tag?: string; authorId?: string; cursor?: string }): Promise<CursorPage<SocialPost>> {
  const tag = opts.tag || '';
  const authorId = opts.authorId || '';
  const cursor = opts.cursor || '';
  return edgeCachedValue(c, feedKey(tag, authorId, cursor), FEED_TTL, async () => {
    const where: string[] = [];
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
    const sql = `SELECT p.id, p.body, p.tag, p.image_url, p.like_count, p.comment_count, p.created_at, ${AUTHOR_COLS}
      FROM social_posts p JOIN users u ON u.id = p.author_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.id DESC LIMIT ${PAGE + 1}`;
    const { results } = await c.env.DB.prepare(sql).bind(...binds).all<any>();
    return page((results || []).map(rowPost));
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

async function purgeFeedHeads(c: AppCtx, authorId: string, tag?: string) {
  await Promise.all([
    edgeCachePurge(c, feedKey('', '', '')),
    edgeCachePurge(c, feedKey('', authorId, '')),
    tag ? edgeCachePurge(c, feedKey(tag, '', '')) : Promise.resolve(),
  ]);
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
  const pg = await loadFeedPage(c, { tag, authorId, cursor });
  return c.json({ items: await markLiked(c, pg.items), nextCursor: pg.nextCursor });
});

/** POST /api/social/posts { body, tag, imageUrl? } */
socialRouter.post('/posts', async (c) => {
  const me = c.get('user');
  const parsed = SocialPostCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid post' }, 400);
  const { body, tag, imageUrl } = parsed.data;

  // Cooldown: one indexed row read (newest post by me)
  const last = await c.env.DB
    .prepare('SELECT id FROM social_posts WHERE author_id = ?1 ORDER BY id DESC LIMIT 1')
    .bind(me.userId)
    .first<{ id: string }>();
  const now = Math.floor(Date.now() / 1000);
  if (last && now - idTime(last.id, 1) < POST_COOLDOWN_SECONDS) {
    return c.json({ error: `Please wait ${POST_COOLDOWN_SECONDS} seconds between posts` }, 429);
  }

  const id = sortableId('p');
  const res = await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO social_posts (id, author_id, body, tag, image_url, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(
      id,
      me.userId,
      body,
      tag,
      imageUrl || null,
      now
    ),
    c.env.DB.prepare('UPDATE users SET posts_count = posts_count + 1 WHERE id = ?1').bind(me.userId),
    c.env.DB.prepare(`SELECT ${AUTHOR_COLS} FROM users u WHERE u.id = ?1`).bind(me.userId),
  ]);
  const authorRow = (res[2].results?.[0] || { a_id: me.userId, a_username: me.username }) as any;
  await purgeFeedHeads(c, me.userId, tag);
  await purgeProfile(c, me.username);
  const post: SocialPost = {
    id,
    author: rowAuthor(authorRow),
    body,
    tag,
    imageUrl: imageUrl || null,
    likeCount: 0,
    commentCount: 0,
    createdAt: now,
    likedByMe: false,
  };
  return c.json({ success: true, post }, 201);
});

/** DELETE /api/social/posts/:id — author or admin. */
socialRouter.delete('/posts/:id', async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  const post = await c.env.DB.prepare('SELECT author_id, tag FROM social_posts WHERE id = ?1').bind(id).first<{ author_id: string; tag: string }>();
  if (!post) return c.json({ error: 'Post not found' }, 404);
  if (post.author_id !== me.userId && me.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM social_post_likes WHERE post_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM social_post_comments WHERE post_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM social_notifications WHERE post_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM social_posts WHERE id = ?1').bind(id),
    c.env.DB.prepare('UPDATE users SET posts_count = MAX(0, posts_count - 1) WHERE id = ?1').bind(post.author_id),
  ]);
  await purgeFeedHeads(c, post.author_id, post.tag);
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
  const [posts, follow] = await Promise.all([
    loadFeedPage(c, { authorId: profile.id }),
    isMe
      ? Promise.resolve(null)
      : c.env.DB.prepare('SELECT 1 AS f FROM social_follows WHERE follower_id = ?1 AND followee_id = ?2').bind(me.userId, profile.id).first(),
  ]);
  return c.json({
    profile: { ...profile, isMe, isFollowing: !!follow },
    posts: { items: await markLiked(c, posts.items), nextCursor: posts.nextCursor },
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
      `SELECT n.id, n.type, n.post_id, n.is_read, n.created_at, ${AUTHOR_COLS}
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
