import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logFinancialTransaction } from '../utils/audit-logger';

export const practiceRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

const ClaimEcSchema = z.object({
  roundKills: z.number().int().min(10),
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

  // Anti-cheat rate limit: minimum 15 seconds between submissions
  const lastClaim = user.last_practice_claim || 0;
  if (now - lastClaim < 15) {
    return c.json(
      {
        error: 'Rate limit exceeded: Submissions must be at least 15 seconds apart.',
      },
      429
    );
  }

  // Credit +25% progress (4 rounds = 1 full ticket)
  const currentProgress = user.energy_progress_pct || 0;
  const newRawProgress = currentProgress + 25;
  const maxTickets = user.max_energy_tickets ?? 6;
  let tickets = user.energy_tickets ?? 6;
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
       WHERE id = ?4`
    )
    .bind(tickets, finalProgress, now, authUser.userId)
    .run();

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
