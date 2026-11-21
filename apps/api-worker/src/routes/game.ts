import { Hono } from 'hono';
import {
  GameBatchPayoutSchema,
  calculateMlmDistribution,
  formatMicroUsd,
} from '@mwar/shared';
import type { Env } from '../types';
import { getUplines } from '../utils/mlm-tree';
import { logFinancialTransaction } from '../utils/audit-logger';
import { recordPendingMlmCommission, trackQuestAction, getUtcDateKey } from './quests';

export const gameRouter = new Hono<{ Bindings: Env }>();

// Batch Payout Sync Endpoint from Colyseus Game Engine
gameRouter.post('/batch-payout', async (c) => {
  const body = await c.req.json().catch(() => null);

  const parseResult = GameBatchPayoutSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { gameId, secret, payouts } = parseResult.data;

  // Validate internal shared secret
  if (secret !== c.env.INTERNAL_API_SECRET) {
    return c.json({ error: 'Unauthorized game server secret' }, 401);
  }

  if (payouts.length === 0) {
    return c.json({ success: true, processedCount: 0 });
  }

  const now = Math.floor(Date.now() / 1000);
  const dateKey = getUtcDateKey();
  const statements: ReturnType<typeof c.env.DB.prepare>[] = [];
  const logItems: Parameters<typeof logFinancialTransaction>[1][] = [];

  for (const item of payouts) {
    // 1. Credit player who performed the action (kill or chest)
    statements.push(
      c.env.DB.prepare(
        'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3'
      ).bind(item.amountMicroUsd, now, item.userId)
    );

    logItems.push({
      transaction_id: `tx_game_${gameId.slice(0, 8)}_${item.userId.slice(0, 6)}_${now}_${Math.random().toString(36).substring(2, 7)}`,
      user_id: item.userId,
      action_type: item.actionType,
      amount_micro_usd: BigInt(item.amountMicroUsd),
      balance_after_micro_usd: 0n,
      source_game_id: gameId,
    });

    // Track daily quests for player: match played & coins earned
    await trackQuestAction(c.env.DB, item.userId, 'finish_game_match', 1, dateKey);
    const coinsEarned = Math.floor(item.amountMicroUsd / 100);
    if (coinsEarned > 0) {
      await trackQuestAction(c.env.DB, item.userId, 'earn_coins', coinsEarned, dateKey);
    }

    // 2. Compute 5-level MLM commission from this reward
    const uplines = await getUplines(c.env.DB, item.userId);
    if (uplines.length > 0) {
      const mlm = calculateMlmDistribution(item.amountMicroUsd, uplines);
      for (const p of mlm.payouts) {
        // Record in daily_mlm_pending_ledger (pending_grey or unlocked_green)
        await recordPendingMlmCommission(
          c.env.DB,
          p.userId,
          item.userId,
          p.depth,
          Number(p.amountMicroUsd),
          item.actionType === 'CHEST_OPEN' ? 'CHEST_OPEN' : 'GAME_KILL',
          dateKey
        );

        logItems.push({
          transaction_id: `tx_mlm_${gameId.slice(0, 8)}_L${p.depth}_${now}_${Math.random().toString(36).substring(2, 7)}`,
          user_id: p.userId,
          action_type: 'MLM_COMMISSION',
          amount_micro_usd: p.amountMicroUsd,
          balance_after_micro_usd: 0n,
          source_game_id: gameId,
          related_user_id: item.userId,
          mlm_level: p.depth,
        });
      }
    }
  }

  // Atomic batch commit in Cloudflare D1
  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  // Push audit logs asynchronously
  for (const log of logItems) {
    await logFinancialTransaction(c.env, log);
  }

  return c.json({
    success: true,
    gameId,
    processedItems: payouts.length,
    statementsExecuted: statements.length,
  });
});
