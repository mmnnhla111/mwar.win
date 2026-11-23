import { Hono } from 'hono';
import {
  DAILY_QUESTS_REQUIRED_TO_UNLOCK,
  SELF_REPORTED_QUESTS,
  SPECTATE_HEARTBEAT_SECONDS,
  QuestProgressSchema,
  QuestClaimSchema,
  formatMicroUsd,
  microUsdToCoins,
  MICRO_USD_PER_COIN,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logFinancialTransaction, walletBalance } from '../utils/audit-logger';
import { isLocalDev, safeEqual } from '../utils/guards';

export const questsRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

// Helper: Get Current UTC Date Key (YYYY-MM-DD)
export function getUtcDateKey(date = new Date()): string {
  return date.toISOString().split('T')[0];
}

// Helper: Check if user has unlocked daily MLM for a given date
export async function isUserMlmUnlocked(db: D1Database, userId: string, dateKey: string): Promise<boolean> {
  const result = await db
    .prepare('SELECT COUNT(*) as completed_count FROM user_daily_quests WHERE user_id = ?1 AND date_key = ?2 AND is_completed = 1')
    .bind(userId, dateKey)
    .first<{ completed_count: number }>();
  return (result?.completed_count || 0) >= DAILY_QUESTS_REQUIRED_TO_UNLOCK;
}

// Helper: Record Downline MLM Commission into Daily Pending Ledger
export async function recordPendingMlmCommission(
  db: D1Database,
  sponsorUserId: string,
  downlineUserId: string,
  depthLevel: number,
  amountMicroUsd: number,
  sourceType: 'AD_WATCH' | 'GAME_KILL' | 'CHEST_OPEN',
  dateKey = getUtcDateKey()
): Promise<{ id: string; status: string }> {
  const unlocked = await isUserMlmUnlocked(db, sponsorUserId, dateKey);
  const status = unlocked ? 'unlocked_green' : 'pending_grey';
  const id = `mlm_pend_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  await db
    .prepare(
      `INSERT INTO daily_mlm_pending_ledger
       (id, user_id, date_key, downline_user_id, depth_level, amount_micro_usd, status, source_type, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch())`
    )
    .bind(id, sponsorUserId, dateKey, downlineUserId, depthLevel, amountMicroUsd, status, sourceType)
    .run();

  return { id, status };
}

// Helper: Increment Quest Progress for an Action Type
export async function trackQuestAction(
  db: D1Database,
  userId: string,
  actionType: string,
  increment = 1,
  dateKey = getUtcDateKey()
): Promise<void> {
  const questDef = await db
    .prepare('SELECT quest_id, target_count FROM daily_quest_definitions WHERE action_type = ?1')
    .bind(actionType)
    .first<{ quest_id: string; target_count: number }>();

  if (!questDef) return;

  await updateQuestProgress(db, userId, questDef.quest_id, increment, dateKey);
}

// Helper: Update a specific quest progress and auto-unlock MLM if threshold reached
export async function updateQuestProgress(
  db: D1Database,
  userId: string,
  questId: string,
  increment: number,
  dateKey = getUtcDateKey()
): Promise<{ current: number; isCompleted: boolean; justUnlockedMlm: boolean }> {
  // 1. Get definition
  const def = await db
    .prepare('SELECT target_count FROM daily_quest_definitions WHERE quest_id = ?1')
    .bind(questId)
    .first<{ target_count: number }>();

  if (!def) {
    throw new Error(`Quest ${questId} definition not found`);
  }

  // 2. Fetch or create user quest row
  let row = await db
    .prepare('SELECT id, current_count, is_completed FROM user_daily_quests WHERE user_id = ?1 AND date_key = ?2 AND quest_id = ?3')
    .bind(userId, dateKey, questId)
    .first<{ id: string; current_count: number; is_completed: number }>();

  if (!row) {
    const newId = `uq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await db
      .prepare('INSERT INTO user_daily_quests (id, user_id, date_key, quest_id, current_count, is_completed, is_claimed) VALUES (?1, ?2, ?3, ?4, 0, 0, 0)')
      .bind(newId, userId, dateKey, questId)
      .run();
    row = { id: newId, current_count: 0, is_completed: 0 };
  }

  const newCount = Math.min(def.target_count, row.current_count + increment);
  const nowCompleted = newCount >= def.target_count;
  const isCompletedInt = nowCompleted ? 1 : 0;
  const completedAt = nowCompleted && !row.is_completed ? Math.floor(Date.now() / 1000) : null;

  await db
    .prepare(
      'UPDATE user_daily_quests SET current_count = ?1, is_completed = ?2, completed_at = COALESCE(completed_at, ?3), last_progress_at = ?4 WHERE id = ?5'
    )
    .bind(newCount, isCompletedInt, completedAt, Math.floor(Date.now() / 1000), row.id)
    .run();

  // 3. Check if user now qualifies for MLM Unlock (>= 4 quests)
  const completedCountRes = await db
    .prepare('SELECT COUNT(*) as count FROM user_daily_quests WHERE user_id = ?1 AND date_key = ?2 AND is_completed = 1')
    .bind(userId, dateKey)
    .first<{ count: number }>();

  const totalCompleted = completedCountRes?.count || 0;
  let justUnlockedMlm = false;

  if (totalCompleted >= DAILY_QUESTS_REQUIRED_TO_UNLOCK) {
    // Unlock all pending_grey ledger entries for today -> unlocked_green
    const updateResult = await db
      .prepare(
        "UPDATE daily_mlm_pending_ledger SET status = 'unlocked_green' WHERE user_id = ?1 AND date_key = ?2 AND status = 'pending_grey'"
      )
      .bind(userId, dateKey)
      .run();

    if ((updateResult.meta?.changes || 0) > 0) {
      justUnlockedMlm = true;
    }
  }

  return {
    current: newCount,
    isCompleted: nowCompleted,
    justUnlockedMlm,
  };
}

// ----------------------------------------------------------------------------
// API Endpoints
// ----------------------------------------------------------------------------

// 1. GET /api/quests/today
questsRouter.get('/today', authMiddleware, async (c) => {
  const authUser = c.get('user');
  const dateKey = c.req.query('dateKey') || getUtcDateKey();

  // Fetch all quest definitions
  const defs = await c.env.DB
    .prepare('SELECT quest_id, title, description, target_count, action_type, reward_coins FROM daily_quest_definitions ORDER BY quest_id ASC')
    .all<{
      quest_id: string;
      title: string;
      description: string;
      target_count: number;
      action_type: string;
      reward_coins: number;
    }>();

  const questList = defs.results || [];

  // Ensure user rows exist for this date
  const userRows = await c.env.DB
    .prepare('SELECT quest_id, current_count, is_completed, is_claimed FROM user_daily_quests WHERE user_id = ?1 AND date_key = ?2')
    .bind(authUser.userId, dateKey)
    .all<{ quest_id: string; current_count: number; is_completed: number; is_claimed: number }>();

  const userProgressMap = new Map<string, { current_count: number; is_completed: number; is_claimed: number }>();
  for (const r of userRows.results || []) {
    userProgressMap.set(r.quest_id, r);
  }

  // Populate any missing rows
  for (const q of questList) {
    if (!userProgressMap.has(q.quest_id)) {
      const newId = `uq_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      await c.env.DB
        .prepare('INSERT OR IGNORE INTO user_daily_quests (id, user_id, date_key, quest_id, current_count, is_completed, is_claimed) VALUES (?1, ?2, ?3, ?4, 0, 0, 0)')
        .bind(newId, authUser.userId, dateKey, q.quest_id)
        .run();
      userProgressMap.set(q.quest_id, { current_count: 0, is_completed: 0, is_claimed: 0 });
    }
  }

  let completedQuests = 0;
  const quests = questList.map((q) => {
    const prog = userProgressMap.get(q.quest_id) || { current_count: 0, is_completed: 0, is_claimed: 0 };
    const isCompleted = prog.is_completed === 1;
    if (isCompleted) completedQuests++;

    return {
      questId: q.quest_id,
      title: q.title,
      description: q.description,
      target: q.target_count,
      current: prog.current_count,
      rewardCoins: q.reward_coins,
      actionType: q.action_type,
      isCompleted,
      isClaimed: prog.is_claimed === 1,
    };
  });

  const isMlmUnlocked = completedQuests >= DAILY_QUESTS_REQUIRED_TO_UNLOCK;

  return c.json({
    dateKey,
    totalQuests: quests.length,
    completedQuests,
    requiredToUnlock: DAILY_QUESTS_REQUIRED_TO_UNLOCK,
    isMlmUnlocked,
    quests,
  });
});

// 2. POST /api/quests/progress
questsRouter.post('/progress', authMiddleware, async (c) => {
  const authUser = c.get('user');
  const body = await c.req.json().catch(() => null);
  const parseResult = QuestProgressSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Invalid quest progress payload', details: parseResult.error.format() }, 400);
  }

  const { questId, increment } = parseResult.data;
  // Progress always counts toward the server's current UTC day (no back-/forward-dating)
  const dateKey = getUtcDateKey();

  // Only timer/check-in quests are client-reported; ads, matches, coins and community are server-tracked
  if (!(SELF_REPORTED_QUESTS as readonly string[]).includes(questId)) {
    return c.json({ error: `${questId} progress is tracked by the server` }, 403);
  }
  if (questId === 'Q_DAILY_CHECKIN' && increment !== 1) {
    return c.json({ error: 'Invalid check-in increment' }, 400);
  }
  if (questId === 'Q_SPECTATE') {
    // Spectate heartbeats: at most 15 s per report, and never faster than wall-clock time allows
    const row = await c.env.DB
      .prepare('SELECT last_progress_at FROM user_daily_quests WHERE user_id = ?1 AND date_key = ?2 AND quest_id = ?3')
      .bind(authUser.userId, dateKey, questId)
      .first<{ last_progress_at: number }>();
    const nowSec = Math.floor(Date.now() / 1000);
    const elapsed = nowSec - (row?.last_progress_at || 0);
    if (row?.last_progress_at && elapsed < Math.min(increment, SPECTATE_HEARTBEAT_SECONDS) - 2) {
      return c.json({ error: 'Spectate heartbeat too fast' }, 429);
    }
  }

  try {
    const result = await updateQuestProgress(c.env.DB, authUser.userId, questId, increment, dateKey);
    const unlocked = await isUserMlmUnlocked(c.env.DB, authUser.userId, dateKey);

    return c.json({
      success: true,
      questId,
      current: result.current,
      isCompleted: result.isCompleted,
      isMlmUnlocked: unlocked,
      justUnlockedMlm: result.justUnlockedMlm,
    });
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to update quest progress' }, 500);
  }
});

// 3. POST /api/quests/claim
questsRouter.post('/claim', authMiddleware, async (c) => {
  const authUser = c.get('user');
  const body = await c.req.json().catch(() => null);
  const parseResult = QuestClaimSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Invalid quest claim payload', details: parseResult.error.format() }, 400);
  }

  const { questId } = parseResult.data;
  const dateKey = getUtcDateKey();

  // If daily check-in is claimed, auto-increment progress to target
  if (questId === 'Q_DAILY_CHECKIN') {
    await updateQuestProgress(c.env.DB, authUser.userId, 'Q_DAILY_CHECKIN', 1, dateKey);
  }

  const userQuest = await c.env.DB
    .prepare('SELECT id, is_completed, is_claimed FROM user_daily_quests WHERE user_id = ?1 AND date_key = ?2 AND quest_id = ?3')
    .bind(authUser.userId, dateKey, questId)
    .first<{ id: string; is_completed: number; is_claimed: number }>();

  if (!userQuest || userQuest.is_completed !== 1) {
    return c.json({ error: 'Quest is not completed yet' }, 400);
  }

  if (userQuest.is_claimed === 1) {
    return c.json({ error: 'Quest reward already claimed' }, 400);
  }

  const def = await c.env.DB
    .prepare('SELECT reward_coins FROM daily_quest_definitions WHERE quest_id = ?1')
    .bind(questId)
    .first<{ reward_coins: number }>();

  const rewardCoins = def?.reward_coins || 50;
  const rewardMicroUsd = rewardCoins * Number(MICRO_USD_PER_COIN); // 1 Coin = 100 Micro-USD

  // Credit reward to wallet balance & mark claimed — the credit only applies if this request flipped
  // is_claimed 0 → 1 (changes() guard), so parallel double-claims pay once.
  const now = Math.floor(Date.now() / 1000);
  const res = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE user_daily_quests SET is_claimed = 1 WHERE id = ?1 AND is_claimed = 0').bind(userQuest.id),
    c.env.DB.prepare(
      'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3 AND changes() = 1'
    ).bind(rewardMicroUsd, now, authUser.userId),
  ]);
  if ((res[1].meta?.changes ?? 0) !== 1) {
    return c.json({ error: 'Quest reward already claimed' }, 400);
  }
  await logFinancialTransaction(c.env, {
    transaction_id: `tx_quest_${questId}_${dateKey}_${authUser.userId.slice(0, 8)}`,
    user_id: authUser.userId,
    action_type: 'QUEST_REWARD',
    amount_micro_usd: BigInt(rewardMicroUsd),
    balance_after_micro_usd: await walletBalance(c.env.DB, authUser.userId),
  });

  return c.json({
    success: true,
    questId,
    rewardCoins,
    rewardMicroUsd,
    formattedReward: formatMicroUsd(rewardMicroUsd),
  });
});

// Helper: Get Daily MLM Summary for a user
export async function getDailyMlmSummary(db: D1Database, userId: string, dateKey = getUtcDateKey()) {
  const ledgerRes = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending_grey' THEN amount_micro_usd ELSE 0 END), 0) AS pending_grey,
         COALESCE(SUM(CASE WHEN status = 'unlocked_green' THEN amount_micro_usd ELSE 0 END), 0) AS unlocked_green,
         COALESCE(SUM(CASE WHEN status = 'forfeited_burned' THEN amount_micro_usd ELSE 0 END), 0) AS forfeited,
         COALESCE(SUM(CASE WHEN status = 'settled_paid' THEN amount_micro_usd ELSE 0 END), 0) AS settled_paid
       FROM daily_mlm_pending_ledger
       WHERE user_id = ?1 AND date_key = ?2`
    )
    .bind(userId, dateKey)
    .first<{ pending_grey: number; unlocked_green: number; forfeited: number; settled_paid: number }>();

  const completedCountRes = await db
    .prepare('SELECT COUNT(*) as count FROM user_daily_quests WHERE user_id = ?1 AND date_key = ?2 AND is_completed = 1')
    .bind(userId, dateKey)
    .first<{ count: number }>();

  const completedQuestsCount = completedCountRes?.count || 0;
  const isUnlocked = completedQuestsCount >= DAILY_QUESTS_REQUIRED_TO_UNLOCK;
  const pendingGreyMicroUsd = ledgerRes?.pending_grey || 0;
  const unlockedGreenMicroUsd = ledgerRes?.unlocked_green || 0;
  const forfeitedMicroUsd = ledgerRes?.forfeited || 0;
  const settledPaidMicroUsd = ledgerRes?.settled_paid || 0;

  let message = '';
  if (isUnlocked) {
    message = `All daily quests completed! Today's downline earnings (${formatMicroUsd(unlockedGreenMicroUsd)}) are UNLOCKED for midnight settlement.`;
  } else if (pendingGreyMicroUsd > 0) {
    const remaining = DAILY_QUESTS_REQUIRED_TO_UNLOCK - completedQuestsCount;
    message = `Complete ${remaining} more quest(s) to unlock ${formatMicroUsd(pendingGreyMicroUsd)} downline earnings tonight!`;
  } else {
    message = 'Complete 4 daily quests to activate your 5-level downline commission earnings for today.';
  }

  return {
    dateKey,
    isUnlocked,
    pendingGreyMicroUsd,
    unlockedGreenMicroUsd,
    forfeitedMicroUsd,
    settledPaidMicroUsd,
    completedQuestsCount,
    requiredQuestsCount: DAILY_QUESTS_REQUIRED_TO_UNLOCK,
    formattedPendingGrey: formatMicroUsd(pendingGreyMicroUsd),
    formattedUnlockedGreen: formatMicroUsd(unlockedGreenMicroUsd),
    message,
  };
}

// 4. GET /api/wallet/daily-mlm-summary & /api/quests/summary
questsRouter.get('/summary', authMiddleware, async (c) => {
  const authUser = c.get('user');
  const dateKey = c.req.query('dateKey') || getUtcDateKey();
  const summary = await getDailyMlmSummary(c.env.DB, authUser.userId, dateKey);
  return c.json(summary);
});

questsRouter.get('/daily-mlm-summary', authMiddleware, async (c) => {
  const authUser = c.get('user');
  const dateKey = c.req.query('dateKey') || getUtcDateKey();
  const summary = await getDailyMlmSummary(c.env.DB, authUser.userId, dateKey);
  return c.json(summary);
});

// Helper: Execute Daily Midnight MLM Settlement
export async function settleDailyMlm(
  env: Env,
  dateKey = getUtcDateKey(),
  targetUserId?: string
) {
  let query = `
    SELECT DISTINCT user_id
    FROM daily_mlm_pending_ledger
    WHERE date_key = ?1 AND status IN ('pending_grey', 'unlocked_green')
  `;
  const params: any[] = [dateKey];

  if (targetUserId) {
    query += ' AND user_id = ?2';
    params.push(targetUserId);
  }

  const usersRes = await env.DB.prepare(query).bind(...params).all<{ user_id: string }>();
  const users = usersRes.results || [];

  let settledUsersCount = 0;
  let forfeitedUsersCount = 0;
  let totalSettledMicroUsd = 0;
  let totalForfeitedMicroUsd = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const u of users) {
    const isUnlocked = await isUserMlmUnlocked(env.DB, u.user_id, dateKey);

    if (isUnlocked) {
      // Calculate total amount to credit
      const sumRes = await env.DB
        .prepare(
          "SELECT SUM(amount_micro_usd) as total FROM daily_mlm_pending_ledger WHERE user_id = ?1 AND date_key = ?2 AND status IN ('pending_grey', 'unlocked_green')"
        )
        .bind(u.user_id, dateKey)
        .first<{ total: number }>();

      const totalToSettle = sumRes?.total || 0;

      if (totalToSettle > 0) {
        await env.DB.batch([
          env.DB.prepare(
            'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3'
          ).bind(totalToSettle, now, u.user_id),
          env.DB.prepare(
            "UPDATE daily_mlm_pending_ledger SET status = 'settled_paid' WHERE user_id = ?1 AND date_key = ?2 AND status IN ('pending_grey', 'unlocked_green')"
          ).bind(u.user_id, dateKey),
        ]);

        await logFinancialTransaction(env, {
          transaction_id: `tx_mlm_settle_${dateKey}_${u.user_id.substring(0, 6)}_${Date.now()}`,
          user_id: u.user_id,
          action_type: 'MLM_COMMISSION',
          amount_micro_usd: BigInt(totalToSettle),
          balance_after_micro_usd: await walletBalance(env.DB, u.user_id),
        });

        settledUsersCount++;
        totalSettledMicroUsd += totalToSettle;
      }
    } else {
      // Forfeited & Burned due to inactivity
      const sumRes = await env.DB
        .prepare(
          "SELECT SUM(amount_micro_usd) as total FROM daily_mlm_pending_ledger WHERE user_id = ?1 AND date_key = ?2 AND status = 'pending_grey'"
        )
        .bind(u.user_id, dateKey)
        .first<{ total: number }>();

      const totalToBurn = sumRes?.total || 0;

      if (totalToBurn > 0) {
        await env.DB
          .prepare(
            "UPDATE daily_mlm_pending_ledger SET status = 'forfeited_burned' WHERE user_id = ?1 AND date_key = ?2 AND status = 'pending_grey'"
          )
          .bind(u.user_id, dateKey)
          .run();

        await logFinancialTransaction(env, {
          transaction_id: `tx_mlm_forfeit_${dateKey}_${u.user_id.substring(0, 6)}_${Date.now()}`,
          user_id: u.user_id,
          action_type: 'MLM_FORFEIT',
          amount_micro_usd: BigInt(totalToBurn),
          balance_after_micro_usd: await walletBalance(env.DB, u.user_id),
          related_user_id: 'SYSTEM_RESERVE_BURN',
        });

        forfeitedUsersCount++;
        totalForfeitedMicroUsd += totalToBurn;
      }
    }
  }

  return {
    success: true,
    dateKey,
    settledUsersCount,
    forfeitedUsersCount,
    totalSettledMicroUsd,
    formattedSettled: formatMicroUsd(totalSettledMicroUsd),
    totalForfeitedMicroUsd,
    formattedForfeited: formatMicroUsd(totalForfeitedMicroUsd),
  };
}

// 5. POST /api/cron/settle-daily-mlm (Midnight Settlement)
questsRouter.post('/settle-daily-mlm', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const check = authorizeSettlement(c.env, isLocalDev(c), c.req.header('X-Internal-Secret'), body);
  if (!check.ok) return c.json({ error: check.error }, check.status);
  const result = await settleDailyMlm(c.env, check.dateKey, body.targetUserId);
  return c.json(result);
});

/** Previous UTC day (the day the midnight cron settles). */
export function yesterdayUtcDateKey(now = new Date()): string {
  return getUtcDateKey(new Date(now.getTime() - 86_400_000));
}

/**
 * Settlement is irreversible (grey → forfeited), so it needs the internal secret and may only run on
 * a day that has already ended — running it for "today" would burn commissions mid-day.
 * Local `wrangler dev` keeps the old open behaviour for the Dev Mock Panel.
 */
export function authorizeSettlement(
  env: Env,
  localDev: boolean,
  secretHeader: string | undefined,
  body: { dateKey?: string; secret?: string }
): { ok: true; dateKey: string } | { ok: false; error: string; status: 400 | 401 } {
  const dev = localDev;
  const secret = secretHeader || body.secret;
  if (!dev && !safeEqual(secret, env.INTERNAL_API_SECRET)) {
    return { ok: false, error: 'Unauthorized settlement trigger', status: 401 };
  }
  const dateKey = body.dateKey || yesterdayUtcDateKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return { ok: false, error: 'Invalid dateKey', status: 400 };
  if (!dev && dateKey >= getUtcDateKey()) return { ok: false, error: 'Only completed UTC days can be settled', status: 400 };
  return { ok: true, dateKey };
}
