import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logFinancialTransaction } from '../utils/audit-logger';
import {
  MAX_ENERGY_TICKETS,
  PRACTICE_ROUND_KILLS,
  PRACTICE_MIN_ROUND_SECONDS,
  PRACTICE_EC_PROGRESS_PER_ROUND,
} from '@mwar/shared';

export const practiceRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

const ClaimEcSchema = z.object({
  roundKills: z.number().int().min(PRACTICE_ROUND_KILLS).max(200),
  roundDurationSeconds: z.number().min(15), // Anti-cheat: 10 kills cannot physically happen in <15s
});

practiceRouter.post('/claim-ec', authMiddleware, async (c) => {
  const authUser = c.get('user');
  const body = await c.req.json().catch(() => null);

  const parseResult = ClaimEcSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json(
      {
        error: 'Anti-cheat validation failed: Minimum 10 kills and 15 seconds round duration required.',
        details: parseResult.error.format(),
      },
      400
    );
  }

  const { roundKills, roundDurationSeconds } = parseResult.data;
  const now = Math.floor(Date.now() / 1000);

  const user = await c.env.DB
    .prepare(
      `SELECT id, username, energy_tickets, max_energy_tickets, energy_progress_pct, last_practice_claim
       FROM users WHERE id = ?1`
    )
    .bind(authUser.userId)
    .first<any>();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  // Anti-cheat rate limit: a 10-kill round can be claimed at most once per 60 s of real time
  // (client-reported duration is not trusted on its own)
  const lastClaim = user.last_practice_claim || 0;
  if (now - lastClaim < PRACTICE_MIN_ROUND_SECONDS) {
    return c.json(
      {
        error: `Rate limit exceeded: practice rounds can be claimed once every ${PRACTICE_MIN_ROUND_SECONDS} seconds.`,
      },
      429
    );
  }

  // Credit +25% progress (4 rounds = 1 full ticket), capped at MAX_ENERGY_TICKETS (6)
  const currentProgress = user.energy_progress_pct || 0;
  const newRawProgress = currentProgress + PRACTICE_EC_PROGRESS_PER_ROUND;
  const maxTickets = Math.min(user.max_energy_tickets ?? MAX_ENERGY_TICKETS, MAX_ENERGY_TICKETS);
  let tickets = user.energy_tickets ?? MAX_ENERGY_TICKETS;
  let finalProgress = newRawProgress;
  let ticketAwarded = false;

  if (newRawProgress >= 100) {
    finalProgress = newRawProgress % 100;
    if (tickets < maxTickets) {
      tickets += 1;
      ticketAwarded = true;
    }
  }

  await c.env.DB
    .prepare(
      `UPDATE users
       SET energy_tickets = ?1, energy_progress_pct = ?2, last_practice_claim = ?3
       WHERE id = ?4 AND last_practice_claim = ?5`
    )
    .bind(tickets, finalProgress, now, authUser.userId, lastClaim)
    .run()
    .then((r) => {
      if ((r.meta?.changes ?? 0) !== 1) throw new Error('concurrent');
    })
    .catch(() => {
      throw new Error('Concurrent practice claim rejected');
    });

  // Audit log entry to logs.mwar.win (PostgreSQL) and Cloudflare Queue
  await logFinancialTransaction(c.env, {
    id: 0,
    transaction_id: `ec_claim_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    user_id: authUser.userId,
    action_type: 'PRACTICE_EC_RECHARGE',
    amount_micro_usd: 0n,
    balance_after_micro_usd: 0n,
    source_game_id: `practice_${now}_k${roundKills}_d${Math.round(roundDurationSeconds)}`,
    created_at: new Date().toISOString(),
  });

  return c.json({
    success: true,
    energy_tickets: tickets,
    max_energy_tickets: maxTickets,
    energy_progress_pct: finalProgress,
    ticketAwarded,
    message: ticketAwarded
      ? '⚡ +1 ENERGY TICKET (EC) awarded from practice mastery!'
      : `⚡ Practice round synced: +25% EC progress (${finalProgress}% towards next ticket).`,
  });
});
