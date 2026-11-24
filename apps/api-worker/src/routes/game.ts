import { Hono } from 'hono';
import {
  GameBatchPayoutSchema,
  BatchPayoutItemSchema,
  formatMicroUsd,
  EC_COST_PER_PAID_MATCH,
  MAX_ENERGY_TICKETS,
} from '@mwar/shared';
import { z } from 'zod';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { applyRewardSplit, claimHeadBounty } from '../utils/reward-split';
import { logFinancialTransaction, walletBalance } from '../utils/audit-logger';
import { trackQuestAction, getUtcDateKey } from './quests';

export const gameRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** HMAC-SHA256 entry ticket the Colyseus server verifies with the shared INTERNAL_API_SECRET. */
async function signEntryToken(secret: string, payload: Record<string, unknown>) {
  const body = b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${hex(sig)}`;
}

/**
 * POST /api/game/enter — spend 1 Energy Ticket (EC) to enter a paid (cash) arena.
 * The decrement is atomic (energy_tickets > 0 guard); if the user was at the 6-ticket cap the hourly
 * recharge clock starts now. Returns a 2-minute signed entry token for the game server: only players
 * who join with a valid token earn Micro-USD (guests / token-less joins play for free, no payouts).
 */
gameRouter.post('/enter', authMiddleware, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const mode = body?.mode === 'standard_100' ? 'standard_100' : body?.mode === 'fast_mini' ? 'fast_mini' : 'mini_30';
  const now = Math.floor(Date.now() / 1000);
  const res = await c.env.DB
    .prepare(
      `UPDATE users
         SET last_energy_recharge = CASE WHEN energy_tickets >= MIN(max_energy_tickets, ?3) THEN ?2 ELSE last_energy_recharge END,
             energy_tickets = energy_tickets - ?4,
             total_matches = total_matches + 1
       WHERE id = ?1 AND energy_tickets >= ?4`
    )
    .bind(user.userId, now, MAX_ENERGY_TICKETS, EC_COST_PER_PAID_MATCH)
    .run();
  if ((res.meta?.changes ?? 0) !== 1) {
    return c.json({ error: 'No Energy Tickets left. Play Practice mode or wait for the hourly recharge.', code: 'NO_EC' }, 402);
  }
  const entryId = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO arena_entries (id, user_id, room_mode, created_at) VALUES (?1, ?2, ?3, ?4)').bind(entryId, user.userId, mode, now).run();
  // Q_PLAY_MATCH: entering a paid arena round counts as playing a match
  await trackQuestAction(c.env.DB, user.userId, 'finish_game_match', 1).catch(() => {});
  const left = await c.env.DB.prepare('SELECT energy_tickets FROM users WHERE id = ?1').bind(user.userId).first<{ energy_tickets: number }>();
  await logFinancialTransaction(c.env, {
    transaction_id: `ec_enter_${entryId.slice(0, 18)}`,
    user_id: user.userId,
    action_type: 'EC_CONSUME',
    amount_micro_usd: 0n,
    balance_after_micro_usd: await walletBalance(c.env.DB, user.userId),
    source_game_id: `${mode}:${entryId}`.slice(0, 64),
  });
  const bountyRow = await c.env.DB.prepare('SELECT bounty_micro_usd FROM wallets WHERE user_id = ?1').bind(user.userId).first<{ bounty_micro_usd: number }>();
  const entryToken = await signEntryToken(c.env.INTERNAL_API_SECRET, {
    uid: user.userId,
    un: user.username,
    bty: bountyRow?.bounty_micro_usd ?? 0, // current head bounty (shown in-match, claimed by the killer)
    eid: entryId,
    mode,
    exp: now + 120,
  });
  return c.json({ success: true, entryToken, energyTickets: left?.energy_tickets ?? 0 });
});

// Batch Payout Sync Endpoint from Colyseus Game Engine
gameRouter.post('/batch-payout', async (c) => {
  const body = await c.req.json().catch(() => null);

  // Validate the envelope; items are validated one by one so a single bad item (e.g. a guest id)
  // can never poison the whole batch and make the game server re-queue it forever.
  const envelope = z
    .object({ gameId: z.string(), timestamp: z.number(), secret: z.string(), payouts: z.array(z.unknown()) })
    .safeParse(body);
  if (!envelope.success) {
    return c.json({ error: 'Validation failed', details: envelope.error.format() }, 400);
  }
  void GameBatchPayoutSchema;
  const { gameId, secret } = envelope.data;
  const rejected: unknown[] = [];
  const payouts = envelope.data.payouts.flatMap((p) => {
    const r = BatchPayoutItemSchema.safeParse(p);
    if (!r.success) rejected.push(p);
    return r.success ? [r.data] : [];
  });

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
  let earnerCredited = 0;
  let bountyClaimed = 0;
  // Public profile stat: kills per player in this batch, written as one UPDATE per player
  const killsByUser = new Map<string, number>();

  for (const item of payouts) {
    if (item.actionType === 'AFK_FORFEIT') {
      // 30-minute AFK kick: claw back the round's already-flushed earnings (never below 0)
      statements.push(
        c.env.DB.prepare(
          'UPDATE wallets SET balance_micro_usd = MAX(0, balance_micro_usd - ?1), total_earned_micro_usd = MAX(0, total_earned_micro_usd - ?1), updated_at = ?2 WHERE user_id = ?3'
        ).bind(item.amountMicroUsd, now, item.userId)
      );
      logItems.push({
        transaction_id: `tx_afk_${gameId.slice(0, 8)}_${item.userId.slice(0, 6)}_${now}_${Math.random().toString(36).substring(2, 7)}`,
        user_id: item.userId,
        action_type: 'AFK_FORFEIT',
        amount_micro_usd: BigInt(item.amountMicroUsd),
        balance_after_micro_usd: 0n,
        source_game_id: gameId,
      });
      continue;
    }
    if (item.actionType === 'BOUNTY_CLAIM') {
      // The victim's accumulated head bounty (5 % of each of their past rewards) goes to the claimer
      const victimId = typeof item.metadata?.victimId === 'string' ? item.metadata.victimId : '';
      const got = await claimHeadBounty(c.env, item.userId, victimId, gameId);
      if (got > 0) bountyClaimed += got;
      continue;
    }

    if (item.actionType === 'GAME_KILL') killsByUser.set(item.userId, (killsByUser.get(item.userId) || 0) + 1);

    // Track daily quests for player: match played
    await trackQuestAction(c.env.DB, item.userId, 'finish_game_match', 1, dateKey);

    // 100 % reward split of V: 75 % earner · 15 % uplines (5/4/3/2/1) · 5 % head bounty · 5 % platform
    const split = await applyRewardSplit(c.env, {
      earnerId: item.userId,
      grossMicroUsd: item.amountMicroUsd,
      actionType: item.actionType as 'GAME_KILL' | 'CHEST_OPEN',
      sourceId: gameId,
      dateKey,
    });
    earnerCredited += Number(split.earnerMicroUsd);
  }

  for (const [uid, kills] of killsByUser) {
    statements.push(c.env.DB.prepare('UPDATE users SET total_kills = total_kills + ?1 WHERE id = ?2').bind(kills, uid));
  }

  // Atomic batch commit in Cloudflare D1
  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  // Push audit logs (with the real post-batch wallet balance for wallet-affecting rows)
  const balances = new Map<string, bigint>();
  for (const log of logItems) {
    if (log.action_type === 'AFK_FORFEIT') {
      if (!balances.has(log.user_id)) balances.set(log.user_id, await walletBalance(c.env.DB, log.user_id));
      log.balance_after_micro_usd = balances.get(log.user_id)!;
    }
    await logFinancialTransaction(c.env, log);
  }

  return c.json({
    success: true,
    gameId,
    processedItems: payouts.length,
    rejectedItems: rejected.length,
    earnerCreditedMicroUsd: earnerCredited,
    bountyClaimedMicroUsd: bountyClaimed,
    statementsExecuted: statements.length,
  });
});
