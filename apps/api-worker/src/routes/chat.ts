import { Hono } from 'hono';
import { DirectMessageSendSchema } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { trackQuestAction } from './quests';

export const chatRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

chatRouter.use('*', authMiddleware);

// 1. Get Chat History with Another User
chatRouter.get('/messages/:otherUserId', async (c) => {
  const user = c.get('user');
  const otherUserId = c.req.param('otherUserId');

  const rows = await c.env.CHAT_DB
    .prepare(
      `SELECT id, sender_id, receiver_id, message_text, media_r2_url, is_read, created_at
       FROM direct_messages
       WHERE (sender_id = ?1 AND receiver_id = ?2)
          OR (sender_id = ?2 AND receiver_id = ?1)
       ORDER BY created_at ASC
       LIMIT 100`
    )
    .bind(user.userId, otherUserId)
    .all<any>();

  return c.json({
    conversationWith: otherUserId,
    messages: rows.results || [],
  });
});

// 2. Send Direct Message
chatRouter.post('/messages', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null);

  const parseResult = DirectMessageSendSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { receiver_id, message_text, media_r2_url } = parseResult.data;
  const now = Math.floor(Date.now() / 1000);

  const res = await c.env.CHAT_DB
    .prepare(
      'INSERT INTO direct_messages (sender_id, receiver_id, message_text, media_r2_url, is_read, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5)'
    )
    .bind(user.userId, receiver_id, message_text || null, media_r2_url || null, now)
    .run();

  // Track daily quest for sender
  await trackQuestAction(c.env.DB, user.userId, 'send_chat_or_network', 1);

  return c.json({
    success: true,
    messageId: res.meta?.last_row_id,
    senderId: user.userId,
    receiverId: receiver_id,
    messageText: message_text,
    mediaR2Url: media_r2_url,
    createdAt: now,
  }, 201);
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
