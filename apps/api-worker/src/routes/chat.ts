import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  DirectMessageSendSchema,
  CHAT_MEDIA_TTL_SECONDS,
  MEDIA_IMAGE_HARD_BYTES,
  MEDIA_VIDEO_HARD_BYTES,
  MEDIA_VIDEO_MAX_SECONDS,
  MEDIA_VIDEO_MAX_LONG_EDGE,
  MEDIA_VIDEO_MAX_SHORT_EDGE,
  MEDIA_GATE_ERROR_CODE,
  MEDIA_GATE_ERROR_EN,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { trackQuestAction } from './quests';
import { CHAT_MEDIA_KEY_RE, newChatMediaKey, sniffMedia, mp4Info, mediaSig, contentTypeFor, deleteMediaKeys } from '../utils/social-media';

export const chatRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

chatRouter.use('*', authMiddleware);

/** Signed, unguessable URL for one chat photo / video (img / video tags cannot send a Bearer token). */
async function chatMediaUrl(env: Env, origin: string, key: string) {
  return `${origin}/api/media/${key}?o=${await mediaSig(env, key)}`;
}

async function blockedBetween(c: Context<any>, a: string, b: string): Promise<boolean> {
  const r = await c.env.DB
    .prepare('SELECT 1 AS x FROM social_blocks WHERE (blocker_id = ?1 AND blocked_id = ?2) OR (blocker_id = ?2 AND blocked_id = ?1) LIMIT 1')
    .bind(a, b)
    .first()
    .catch(() => null);
  return !!r;
}

// 1. Get Chat History with Another User
chatRouter.get('/messages/:otherUserId', async (c) => {
  const user = c.get('user');
  const otherUserId = c.req.param('otherUserId');
  const origin = new URL(c.req.url).origin;

  const rows = await c.env.CHAT_DB
    .prepare(
      `SELECT id, sender_id, receiver_id, message_text, media_key, media_type, media_expires_at, is_read, created_at
       FROM direct_messages
       WHERE (sender_id = ?1 AND receiver_id = ?2)
          OR (sender_id = ?2 AND receiver_id = ?1)
       ORDER BY created_at ASC
       LIMIT 100`
    )
    .bind(user.userId, otherUserId)
    .all<any>();

  const messages = await Promise.all(
    (rows.results || []).map(async (m: any) => ({
      id: m.id,
      sender_id: m.sender_id,
      receiver_id: m.receiver_id,
      message_text: m.message_text,
      is_read: m.is_read,
      created_at: m.created_at,
      media_type: m.media_key ? m.media_type : null,
      media_url: m.media_key ? await chatMediaUrl(c.env, origin, m.media_key) : null,
      media_expires_at: m.media_key ? m.media_expires_at : null,
      // The file was removed after 7 days (the text stays)
      media_expired: !m.media_key && !!m.media_expires_at,
    }))
  );
  return c.json({ conversationWith: otherUserId, messages, mediaTtlSeconds: CHAT_MEDIA_TTL_SECONDS });
});

/**
 * POST /api/chat/media (raw body = one compressed photo or video) → R2 chat-media/YYYY/MM/DD/<uuid>.
 * Same Layer-2 gate as posts: photos <= 300 KB, videos MP4 <= 3 min and <= 1280x720. Deleted after 7 days.
 */
chatRouter.post('/media', async (c) => {
  const me = c.get('user');
  const len = Number(c.req.header('Content-Length') || 0);
  if (len > MEDIA_VIDEO_HARD_BYTES) return c.json({ error: MEDIA_GATE_ERROR_EN, code: MEDIA_GATE_ERROR_CODE }, 422);
  const buf = new Uint8Array(await c.req.arrayBuffer());
  const kind = sniffMedia(buf);
  if (!kind || kind.ext === 'webm') return c.json({ error: MEDIA_GATE_ERROR_EN, code: MEDIA_GATE_ERROR_CODE, detail: 'format' }, 422);
  let width: number | null = null;
  let height: number | null = null;
  let durationSec: number | null = null;
  if (kind.type === 'image') {
    if (buf.byteLength > MEDIA_IMAGE_HARD_BYTES) return c.json({ error: MEDIA_GATE_ERROR_EN, code: MEDIA_GATE_ERROR_CODE, detail: 'image size' }, 422);
  } else {
    const info = mp4Info(buf);
    const long = Math.max(info.width || 0, info.height || 0);
    const short = Math.min(info.width || 0, info.height || 0);
    if (buf.byteLength > MEDIA_VIDEO_HARD_BYTES || info.durationSec === null || info.durationSec > MEDIA_VIDEO_MAX_SECONDS + 0.5 || !long || long > MEDIA_VIDEO_MAX_LONG_EDGE || short > MEDIA_VIDEO_MAX_SHORT_EDGE) {
      return c.json({ error: MEDIA_GATE_ERROR_EN, code: MEDIA_GATE_ERROR_CODE, detail: 'video limits' }, 422);
    }
    width = info.width;
    height = info.height;
    durationSec = info.durationSec;
  }
  const key = newChatMediaKey(kind.ext as 'webp' | 'jpg' | 'mp4');
  await c.env.MEDIA_BUCKET.put(key, buf, {
    httpMetadata: { contentType: kind.contentType, cacheControl: 'private, max-age=604800' },
    customMetadata: { owner: me.userId },
  });
  const origin = new URL(c.req.url).origin;
  return c.json({ success: true, mediaKey: key, mediaType: kind.type, url: await chatMediaUrl(c.env, origin, key), width, height, durationSec }, 201);
});

// 2. Send Direct Message (text and / or one uploaded media_key)
chatRouter.post('/messages', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null);

  const parseResult = DirectMessageSendSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }
  const { receiver_id, message_text, media_key } = parseResult.data;
  if (!message_text && !media_key) return c.json({ error: 'Write a message or attach a photo / video' }, 400);
  if (receiver_id === user.userId) return c.json({ error: 'Invalid receiver' }, 400);
  if (await blockedBetween(c, user.userId, receiver_id)) return c.json({ error: 'You cannot message this player', code: 'BLOCKED' }, 403);

  let mediaType: 'image' | 'video' | null = null;
  if (media_key) {
    const head = await c.env.MEDIA_BUCKET.head(media_key);
    if (!head || head.customMetadata?.owner !== user.userId) return c.json({ error: 'Upload the photo / video first' }, 400);
    mediaType = media_key.endsWith('.mp4') ? 'video' : 'image';
  }
  const now = Math.floor(Date.now() / 1000);
  const expires = media_key ? now + CHAT_MEDIA_TTL_SECONDS : null;

  const res = await c.env.CHAT_DB
    .prepare(
      `INSERT INTO direct_messages (sender_id, receiver_id, message_text, media_key, media_type, media_expires_at, is_read, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)`
    )
    .bind(user.userId, receiver_id, message_text || null, media_key || null, mediaType, expires, now)
    .run();

  await trackQuestAction(c.env.DB, user.userId, 'send_chat_or_network', 1);
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      success: true,
      messageId: res.meta?.last_row_id,
      senderId: user.userId,
      receiverId: receiver_id,
      messageText: message_text,
      mediaType,
      mediaUrl: media_key ? await chatMediaUrl(c.env, origin, media_key) : null,
      mediaExpiresAt: expires,
      createdAt: now,
    },
    201
  );
});

// 3. Mark Conversation as Read
chatRouter.post('/read/:otherUserId', async (c) => {
  const user = c.get('user');
  const otherUserId = c.req.param('otherUserId');

  await c.env.CHAT_DB
    .prepare('UPDATE direct_messages SET is_read = 1 WHERE sender_id = ?1 AND receiver_id = ?2 AND is_read = 0')
    .bind(otherUserId, user.userId)
    .run();

  return c.json({ success: true });
});

/** GET /api/media/chat-media/:y/:m/:d/:file?o=<sig> — chat photo / video (signed link, private cache). */
export async function serveChatMedia(c: Context<{ Bindings: Env }>) {
  const key = `chat-media/${c.req.param('y')}/${c.req.param('m')}/${c.req.param('d')}/${c.req.param('file')}`;
  if (!CHAT_MEDIA_KEY_RE.test(key)) return c.json({ error: 'Not found' }, 404);
  if ((c.req.query('o') || '') !== (await mediaSig(c.env, key))) return c.json({ error: 'Not found' }, 404);
  const range = c.req.header('Range');
  const obj = await c.env.MEDIA_BUCKET.get(key, range ? { range: c.req.raw.headers as any } : undefined);
  if (!obj) return c.json({ error: 'This photo / video has expired' }, 404);
  const headers: Record<string, string> = {
    'Content-Type': contentTypeFor(key),
    'Cache-Control': 'private, max-age=86400',
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    ETag: obj.httpEtag,
  };
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

/**
 * Chat media expiry (midnight cron + POST /api/internal/chat-media/prune): files older than 7 days
 * are deleted from R2 and media_key is cleared; the message text stays. Up to 1 000 per call.
 */
export async function pruneChatMedia(env: Env): Promise<{ pruned: number }> {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.CHAT_DB
    .prepare('SELECT id, media_key FROM direct_messages WHERE media_key IS NOT NULL AND media_expires_at <= ?1 LIMIT 1000')
    .bind(now)
    .all<{ id: number; media_key: string }>();
  const rows = results || [];
  if (!rows.length) return { pruned: 0 };
  await deleteMediaKeys(env, rows.map((r) => r.media_key));
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    await env.CHAT_DB.prepare(`UPDATE direct_messages SET media_key = NULL WHERE id IN (${part.map((_, j) => `?${j + 1}`).join(',')})`)
      .bind(...part)
      .run();
  }
  return { pruned: rows.length };
}
