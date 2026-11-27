import { Hono } from 'hono';
import {
  GameBatchPayoutSchema,
  BatchPayoutItemSchema,
  formatMicroUsd,
  EC_COST_PER_PAID_MATCH,
  ROOM_MODE_ENGINE,
  EXP_PER_MATCH,
  EXP_PER_KILL,
} from '@mwar/shared';
import { z } from 'zod';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { applyRewardSplit, claimHeadBounty } from '../utils/reward-split';
import { ledgerClampedDebit, recordDeviceLink } from '../utils/ledger';
import { forfeitStake, isSettleConflict, loadVictimStake, lockEntryTickets, settleStakeStmt, unlockEntryTickets } from '../utils/energy-tickets';
import { logFinancialTransaction, walletBalance } from '../utils/audit-logger';
import { trackQuestAction, getUtcDateKey } from './quests';
import { loadRooms } from './games';

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
 * POST /api/game/enter — spend Energy Ticket(s) (EC) to enter a paid (cash) arena.
 * V1.1: the user's oldest available ticket row(s) (FIFO) are locked atomically (status in_match,
 * match_id = this entry), and their exact backed µUSD travels inside the signed entry token
 * (`tid` first ticket id, `tv` backed value, `tn` ticket count). Whoever kills this player is paid
 * exactly that value — never a constant. EC never regenerates over time (spec §7.3).
 * Returns a 2-minute signed entry token for the game server: only players who join with a valid token
 * earn Micro-USD (guests / token-less joins play for free, no payouts).
 */
gameRouter.post('/enter', authMiddleware, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  let mode: string = body?.mode === 'standard_100' ? 'standard_100' : body?.mode === 'fast_mini' ? 'fast_mini' : 'mini_30';
  let cost = EC_COST_PER_PAID_MATCH;
  // Admin room registry: the room code decides mode and entry cost (never the client)
  const roomCode = typeof body?.roomCode === 'string' ? body.roomCode.trim().toUpperCase().slice(0, 16) : '';
  if (roomCode) {
    const cfg = (await loadRooms(c, 'fps')).find((r) => r.roomCode === roomCode);
    if (!cfg || !cfg.isActive) return c.json({ error: 'This room is closed', code: 'ROOM_CLOSED' }, 404);
    if (cfg.mode === 'solo_bot') return c.json({ error: 'Practice rooms need no entry ticket' }, 400);
    mode = ROOM_MODE_ENGINE[cfg.mode];
    cost = cfg.entryCostEc;
  }
  const now = Math.floor(Date.now() / 1000);
  // Free room: no EC spent and no entry token, so the match plays without cash payouts
  if (cost <= 0) {
    const left0 = await c.env.DB.prepare('SELECT energy_tickets FROM users WHERE id = ?1').bind(user.userId).first<{ energy_tickets: number }>();
    return c.json({ success: true, free: true, entryToken: null, energyTickets: left0?.energy_tickets ?? 0 });
  }
  // Layer 3: remember this account's hashed IP (collusion graph); never blocks the entry
  c.executionCtx.waitUntil(recordDeviceLink(c.env.DB, c.env.JWT_SECRET, user.userId, c.req.header('CF-Connecting-IP')));
  const entryId = crypto.randomUUID();
  const stake = await lockEntryTickets(c.env, user.userId, cost, entryId, EXP_PER_MATCH);
  if (!stake) {
    return c.json({ error: 'No Energy Tickets left. Watch an ad or Cheer to recharge EC.', code: 'NO_EC' }, 402);
  }
  try {
    await c.env.DB.prepare('INSERT INTO arena_entries (id, user_id, room_mode, created_at) VALUES (?1, ?2, ?3, ?4)').bind(entryId, user.userId, mode, now).run();
  } catch (e) {
    await unlockEntryTickets(c.env, user.userId, entryId);
    throw e;
  }
  // Q_PLAY_MATCH: entering a paid arena round counts as playing a match
  await trackQuestAction(c.env.DB, user.userId, 'finish_game_match', 1).catch(() => {});
  await logFinancialTransaction(c.env, {
    transaction_id: `ec_enter_${entryId.slice(0, 18)}`,
    user_id: user.userId,
    action_type: 'EC_CONSUME',
    amount_micro_usd: BigInt(stake.backedMicroUsd), // the ticket value now at stake in the arena (no wallet change)
    balance_after_micro_usd: await walletBalance(c.env.DB, user.userId),
    source_game_id: `${mode}:${entryId}`.slice(0, 64),
  });
  const bountyRow = await c.env.DB.prepare('SELECT bounty_micro_usd FROM wallets WHERE user_id = ?1').bind(user.userId).first<{ bounty_micro_usd: number }>();
  const entryToken = await signEntryToken(c.env.INTERNAL_API_SECRET, {
    uid: user.userId,
    un: user.username,
    bty: bountyRow?.bounty_micro_usd ?? 0, // current head bounty (shown in-match, claimed by the killer)
    eid: entryId,
    tid: stake.ticketIds[0], // ticket row the game server must name when it settles this life
    tv: stake.backedMicroUsd, // the ticket's real backed µUSD = what a kill on this player pays
    tn: stake.ticketIds.length,
    mode,
    rc: roomCode || undefined, // the game server only accepts the token in this room
    exp: now + 120,
  });
  return c.json({
    success: true,
    entryToken,
    energyTickets: stake.energyTickets,
    ticketId: stake.ticketIds[0],
    ticketValueMicroUsd: stake.backedMicroUsd,
  });
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

  // V1.1 settlement counters (returned to the game server / load test)
  const v11 = { ticketsSettled: 0, ticketsForfeited: 0, rejectedTicket: 0, duplicates: 0, settledMicroUsd: 0, forfeitedMicroUsd: 0, cappedItems: 0 };
  const md = (it: { metadata?: Record<string, unknown> }) => (it.metadata || {}) as Record<string, unknown>;
  /** Items without a ticket (bounty claims, AFK claw-backs) are de-duplicated by the game server's payout id. */
  const firstTime = async (it: { metadata?: Record<string, unknown> }) => {
    const pid = md(it).pid;
    if (typeof pid !== 'string' || !pid || pid.length > 120) return true;
    const r = await c.env.DB.prepare('INSERT OR IGNORE INTO game_payout_receipts (payout_id, game_id, created_at) VALUES (?1, ?2, ?3)').bind(pid, gameId.slice(0, 80), now).run();
    return (r.meta?.changes ?? 0) === 1;
  };

  for (const item of payouts) {
    if (item.actionType === 'AFK_FORFEIT') {
      if (!(await firstTime(item))) {
        v11.duplicates++;
        continue;
      }
      if (item.amountMicroUsd <= 0) continue;
      // 30-minute AFK kick: claw back the round's already-flushed earnings (never below 0)
      statements.push(
        ledgerClampedDebit(c.env.DB, item.userId, item.amountMicroUsd, 'AFK_FORFEIT', gameId, now),
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
      // The victim's accumulated head bounty (5 % of each of their past rewards) goes to the claimer.
      // V1.1: only for a victim who really held a paid ticket (named by the game server)
      const victimId = typeof md(item).victimId === 'string' ? (md(item).victimId as string) : '';
      const stake = await loadVictimStake(c.env.DB, md(item).ticketId, victimId);
      if (!stake || victimId === item.userId) {
        v11.rejectedTicket++;
        continue;
      }
      if (!(await firstTime(item))) {
        v11.duplicates++;
        continue;
      }
      const got = await claimHeadBounty(c.env, item.userId, victimId, gameId);
      if (got > 0) bountyClaimed += got;
      continue;
    }
    if (item.actionType === 'TICKET_FORFEIT') {
      // The holder's in_match ticket ended without a kill payout → its backing goes to the platform
      const stake = await loadVictimStake(c.env.DB, md(item).ticketId, item.userId);
      if (!stake || stake.inMatch !== stake.rows || stake.rows === 0) {
        if (stake) v11.duplicates++;
        else v11.rejectedTicket++;
        continue;
      }
      const reason = typeof md(item).reason === 'string' ? String(md(item).reason).slice(0, 24) : 'left';
      const got = await forfeitStake(c.env, stake, item.userId, `TICKET_FORFEIT:${reason}`, gameId);
      if (got < 0) v11.duplicates++;
      else {
        v11.ticketsForfeited++;
        v11.forfeitedMicroUsd += got;
      }
      continue;
    }
    if (item.actionType !== 'GAME_KILL' && item.actionType !== 'CHEST_OPEN') {
      rejected.push(item); // AD_WATCH etc. never come from a game server
      continue;
    }

    // ---- GAME_KILL / CHEST_OPEN: V = the victim's ticket value, never what the game server claims ----
    const victimId = typeof md(item).victimId === 'string' ? (md(item).victimId as string) : '';
    const stake = await loadVictimStake(c.env.DB, md(item).ticketId, victimId);
    if (!stake || victimId === item.userId || stake.rows === 0) {
      v11.rejectedTicket++;
      continue;
    }
    if (stake.inMatch !== stake.rows) {
      v11.duplicates++; // already settled (a re-sent batch, or a second claim on the same life)
      continue;
    }
    // The earner must have entered a paid arena with a ticket of their own in the last 24 h
    const earnerEntered = await c.env.DB
      .prepare("SELECT 1 AS ok FROM user_energy_tickets WHERE user_id = ?1 AND status IN ('in_match', 'settled') AND consumed_at >= ?2 LIMIT 1")
      .bind(item.userId, now - 86_400)
      .first<{ ok: number }>();
    if (!earnerEntered) {
      v11.rejectedTicket++;
      continue;
    }
    const value = Math.min(Math.max(0, Math.floor(item.amountMicroUsd)), stake.backedMicroUsd);
    if (value !== item.amountMicroUsd) v11.cappedItems++;
    const extra = stake.backedMicroUsd - value; // part of the ticket the game server did not claim → platform
    if (value <= 0) {
      const got = await forfeitStake(c.env, stake, victimId, `${item.actionType}:zero`, gameId);
      if (got < 0) v11.duplicates++;
      else {
        v11.ticketsForfeited++;
        v11.forfeitedMicroUsd += got;
      }
      continue;
    }

    // 100 % reward split of V: 55 % earner · 15 % uplines (5/4/3/2/1) · 5 % head bounty · 5 % platform · 20 % Energy Pool,
    // committed in ONE batch with the ticket settlement guard (a settled ticket aborts the batch)
    let split: Awaited<ReturnType<typeof applyRewardSplit>>;
    try {
      split = await applyRewardSplit(c.env, {
        earnerId: item.userId,
        grossMicroUsd: value,
        actionType: item.actionType as 'GAME_KILL' | 'CHEST_OPEN',
        sourceId: gameId,
        dateKey,
        guard: [settleStakeStmt(c.env.DB, { matchId: stake.matchId, victimId, action: item.actionType, toUserId: item.userId, paidMicroUsd: value, ref: gameId }, now)],
        extraPlatformMicroUsd: extra,
      });
    } catch (e) {
      if (isSettleConflict(e)) {
        v11.duplicates++;
        continue;
      }
      throw e;
    }
    v11.ticketsSettled++;
    v11.settledMicroUsd += value;
    earnerCredited += Number(split.earnerMicroUsd);
    if (item.actionType === 'GAME_KILL') killsByUser.set(item.userId, (killsByUser.get(item.userId) || 0) + 1);
    // Track daily quests for player: match played
    await trackQuestAction(c.env.DB, item.userId, 'finish_game_match', 1, dateKey);
    // Layer 2/3 telemetry (victim, shooter's session hits / headshots) for the cashout audit
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO combat_events (id, user_id, game_id, action_type, victim_id, gross_micro_usd, earner_micro_usd, session_hits, session_headshots, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      ).bind(
        `ce_${crypto.randomUUID()}`,
        item.userId,
        gameId.slice(0, 80),
        item.actionType,
        victimId.slice(0, 64),
        value,
        Number(split.earnerMicroUsd),
        num(md(item).hits),
        num(md(item).headshots),
        now
      )
    );
  }

  for (const [uid, kills] of killsByUser) {
    statements.push(c.env.DB.prepare('UPDATE users SET total_kills = total_kills + ?1, exp = COALESCE(exp, 0) + ?3 WHERE id = ?2').bind(kills, uid, kills * EXP_PER_KILL));
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
      // Log what was actually clawed back (clamped at the balance), so PostgreSQL equals the D1 ledger
      const taken = await c.env.DB.prepare(
        "SELECT COALESCE(-SUM(delta_micro_usd), 0) AS d FROM wallet_ledger WHERE user_id = ?1 AND action_type = 'AFK_FORFEIT' AND ref_id = ?2 AND created_at = ?3"
      ).bind(log.user_id, gameId.slice(0, 80), now).first<{ d: number }>();
      log.amount_micro_usd = BigInt(taken?.d ?? 0);
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
    ...v11,
  });
});
