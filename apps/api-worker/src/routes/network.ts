import { Hono } from 'hono';
import { formatMicroUsd } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { trackQuestAction } from './quests';

export const networkRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

networkRouter.use('*', authMiddleware);

// 1. Get 5-Level Downline Members
networkRouter.get('/downline', async (c) => {
  // Q_COMMUNITY: inspecting your network tree counts as community interaction (server-tracked)
  await trackQuestAction(c.env.DB, c.get('user').userId, 'send_chat_or_network', 1).catch(() => {});
  const user = c.get('user');

  const rows = await c.env.DB
    .prepare(
      `SELECT n.descendant_id, n.depth, u.username, u.email, u.phone_number, u.telegram_id, u.created_at,
              w.total_earned_micro_usd, w.balance_micro_usd
       FROM network_trees n
       JOIN users u ON u.id = n.descendant_id
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE n.ancestor_id = ?1
       ORDER BY n.depth ASC, u.created_at DESC`
    )
    .bind(user.userId)
    .all<{
      descendant_id: string;
      depth: number;
      username: string;
      email: string;
      phone_number: string | null;
      telegram_id: string | null;
      created_at: number;
      total_earned_micro_usd: number | null;
      balance_micro_usd: number | null;
    }>();

  const members = (rows.results || []).map((m) => ({
    userId: m.descendant_id,
    depth: m.depth,
    username: m.username,
    email: m.email,
    phoneNumber: m.phone_number,
    telegramId: m.telegram_id,
    createdAt: m.created_at,
    totalEarnedMicroUsd: m.total_earned_micro_usd || 0,
    formattedTotalEarned: formatMicroUsd(m.total_earned_micro_usd || 0),
  }));

  return c.json({
    ancestorId: user.userId,
    count: members.length,
    members,
  });
});

// 2. Summary Statistics by Level (Levels 1 to 5)
networkRouter.get('/stats', async (c) => {
  const user = c.get('user');

  const rows = await c.env.DB
    .prepare(
      `SELECT depth, COUNT(*) as member_count
       FROM network_trees
       WHERE ancestor_id = ?1
       GROUP BY depth
       ORDER BY depth ASC`
    )
    .bind(user.userId)
    .all<{ depth: number; member_count: number }>();

  const levelStats: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let totalTeamMembers = 0;

  if (rows.results) {
    for (const r of rows.results) {
      levelStats[r.depth] = r.member_count;
      totalTeamMembers += r.member_count;
    }
  }

  return c.json({
    totalTeamMembers,
    levelStats,
  });
});

// 3. Direct Upline Info
networkRouter.get('/upline', async (c) => {
  const user = c.get('user');

  const upline = await c.env.DB
    .prepare(
      `SELECT u.id, u.username, u.email, u.phone_number, u.telegram_id, u.created_at
       FROM users me
       JOIN users u ON u.id = me.referrer_id
       WHERE me.id = ?1`
    )
    .bind(user.userId)
    .first();

  return c.json({ upline: upline || null });
});
