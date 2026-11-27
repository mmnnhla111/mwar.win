import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import {
  allocateEcProgress,
  parseSafetyMultiplierBp,
  safeAdMicroUsd,
  INITIAL_ENERGY_TICKETS,
  MAX_ENERGY_TICKETS,
  STALE_MATCH_TICKET_SECONDS,
  type EnergyTicketSource,
} from '@mwar/shared';
import type { Env } from '../types';
import { logFinancialTransaction } from './audit-logger';
import { ENERGY_POOL_ACCOUNT_ID, PLATFORM_ACCOUNT_ID } from './guards';

/**
 * V1.1 zero-deficit ticket-backed economy (D1 core_db, migration 0021).
 *
 *  · Every Energy Ticket (1 EC) is a `user_energy_tickets` row with the REAL µUSD that backs it.
 *  · Real ad revenue (live banner / direct link / network postback) → floor(gross × 0.90–0.95) into
 *    `users.pending_ec_micro_usd` while the EC bar fills; at 100 % a ticket is minted with that backing.
 *  · Simulated (test-mode) ads have no revenue: their backing is drawn from the Energy Pool's unspent
 *    balance (energy_pool − drawn), never more than it holds — an empty pool mints 0-value tickets.
 *  · A paid entry locks the oldest available ticket(s) (FIFO, status in_match); the kill that ends that
 *    life pays exactly the ticket's backing through the 55/15/5/5/20 split, once.
 *  · users.energy_tickets is the cached count of 'available' rows.
 */

const nowSec = () => Math.floor(Date.now() / 1000);
const newTicketId = () => `tkt_${crypto.randomUUID()}`;

/** Configured haircut (env AD_SAFETY_MULTIPLIER, e.g. "0.92"), always clamped to 0.90–0.95. */
export function safetyBp(env: Env): number {
  return parseSafetyMultiplierBp(env.AD_SAFETY_MULTIPLIER);
}

/** Safe (after-haircut) µUSD of a gross ad value. */
export function safeValue(env: Env, grossMicroUsd: number): number {
  return safeAdMicroUsd(grossMicroUsd, safetyBp(env));
}

/** Unspent Energy Pool balance (never negative). */
export async function energyPoolAvailable(db: D1Database): Promise<number> {
  const r = await db
    .prepare("SELECT energy_pool_micro_usd AS p, energy_pool_drawn_micro_usd AS d FROM system_balances WHERE id = 'global'")
    .first<{ p: number; d: number }>();
  return Math.max(0, Number(r?.p ?? 0) - Number(r?.d ?? 0));
}

/**
 * Accounts whose cached EC count is higher than their ticket rows (sign-up starter EC, admin grants,
 * rows from before migration 0021) get 0-backed promo rows for the difference — one atomic statement,
 * so parallel calls cannot over-insert. A 0-backed ticket pays nothing when its holder is killed.
 */
export function reconcileTicketRowsStmt(db: D1Database, userId: string, now = nowSec(), source: 'signup_promo' | 'admin_grant' = 'signup_promo'): D1PreparedStatement {
  return db
    .prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${MAX_ENERGY_TICKETS})
       INSERT INTO user_energy_tickets (id, user_id, source_type, country_code, backed_micro_usd, status, created_at)
       SELECT 'tkt_' || lower(hex(randomblob(16))), ?1, ?4, 'GLOBAL', 0, 'available', ?2
       FROM seq
       WHERE seq.n <= (SELECT MIN(MAX(COALESCE(energy_tickets, ?3), 0), ${MAX_ENERGY_TICKETS}) FROM users WHERE id = ?1)
                    - (SELECT COUNT(*) FROM user_energy_tickets WHERE user_id = ?1 AND status = 'available')`
    )
    .bind(userId, now, INITIAL_ENERGY_TICKETS, source);
}

/**
 * Staff lowered a user's EC: the surplus available rows (lowest value first) are revoked and their
 * backing goes to the platform. Two statements for the same D1 batch, AFTER the users count update.
 */
export function revokeSurplusTicketStmts(db: D1Database, userId: string, now = nowSec()): D1PreparedStatement[] {
  const pick = `SELECT id FROM user_energy_tickets WHERE user_id = ?1 AND status = 'available'
                ORDER BY backed_micro_usd ASC, created_at DESC, id DESC
                LIMIT MAX(0, (SELECT COUNT(*) FROM user_energy_tickets WHERE user_id = ?1 AND status = 'available')
                           - (SELECT COALESCE(energy_tickets, 0) FROM users WHERE id = ?1))`;
  return [
    db
      .prepare(
        `UPDATE system_balances SET platform_micro_usd = platform_micro_usd
           + (SELECT COALESCE(SUM(backed_micro_usd), 0) FROM user_energy_tickets WHERE id IN (${pick})), updated_at = ?2
         WHERE id = 'global'`
      )
      .bind(userId, now),
    db
      .prepare(`UPDATE user_energy_tickets SET status = 'settled', settle_action = 'ADMIN_REVOKE', settled_at = ?2, settled_micro_usd = 0 WHERE id IN (${pick})`)
      .bind(userId, now),
  ];
}

/** The starter ticket of a brand-new account: 1 EC worth 0 µUSD (multi-account sign-ups can never drain cash). */
export function signupTicketStmt(db: D1Database, userId: string, now = nowSec()): D1PreparedStatement {
  return db
    .prepare("INSERT INTO user_energy_tickets (id, user_id, source_type, country_code, backed_micro_usd, status, created_at) VALUES (?1, ?2, 'signup_promo', 'GLOBAL', 0, 'available', ?3)")
    .bind(newTicketId(), userId, now);
}

export interface LockedStake {
  entryId: string;
  ticketIds: string[];
  backedMicroUsd: number;
  energyTickets: number;
}

/**
 * POST /api/game/enter: atomically move the user's `cost` oldest available tickets (FIFO) to in_match
 * for this entry, all or nothing, and refresh the cached EC count + match stats in the same batch.
 */
export async function lockEntryTickets(env: Env, userId: string, cost: number, entryId: string, expPerMatch: number): Promise<LockedStake | null> {
  const now = nowSec();
  const db = env.DB;
  await reconcileTicketRowsStmt(db, userId, now).run();
  const res = await db.batch([
    db
      .prepare(
        `UPDATE user_energy_tickets SET status = 'in_match', match_id = ?2, consumed_at = ?3
         WHERE id IN (SELECT id FROM user_energy_tickets WHERE user_id = ?1 AND status = 'available' ORDER BY created_at ASC, id ASC LIMIT ?4)
           AND status = 'available'
           AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND status = 'active')`
      )
      .bind(userId, entryId, now, cost),
    db
      .prepare(
        `UPDATE users SET energy_tickets = (SELECT COUNT(*) FROM user_energy_tickets WHERE user_id = ?1 AND status = 'available'),
                          total_matches = total_matches + 1, exp = COALESCE(exp, 0) + ?3
         WHERE id = ?1 AND changes() = ?2`
      )
      .bind(userId, cost, expPerMatch),
  ]);
  const locked = res[0].meta?.changes ?? 0;
  if (locked !== cost) {
    // Fewer than `cost` tickets were available: release whatever this entry grabbed (all or nothing)
    if (locked > 0) await unlockEntryTickets(env, userId, entryId);
    return null;
  }
  const rows = await db
    .prepare("SELECT id, backed_micro_usd FROM user_energy_tickets WHERE match_id = ?1 AND user_id = ?2 AND status = 'in_match' ORDER BY created_at ASC, id ASC")
    .bind(entryId, userId)
    .all<{ id: string; backed_micro_usd: number }>();
  const list = rows.results ?? [];
  const left = await db.prepare('SELECT energy_tickets FROM users WHERE id = ?1').bind(userId).first<{ energy_tickets: number }>();
  return {
    entryId,
    ticketIds: list.map((r) => r.id),
    backedMicroUsd: list.reduce((a, r) => a + Math.max(0, Number(r.backed_micro_usd) || 0), 0),
    energyTickets: Number(left?.energy_tickets ?? 0),
  };
}

/** Undo a lock whose entry could not be completed (tickets back to available, count refreshed). */
export async function unlockEntryTickets(env: Env, userId: string, entryId: string) {
  await env.DB.batch([
    env.DB.prepare("UPDATE user_energy_tickets SET status = 'available', match_id = NULL, consumed_at = NULL WHERE match_id = ?1 AND user_id = ?2 AND status = 'in_match'").bind(entryId, userId),
    env.DB.prepare("UPDATE users SET energy_tickets = (SELECT COUNT(*) FROM user_energy_tickets WHERE user_id = ?1 AND status = 'available') WHERE id = ?1").bind(userId),
  ]);
}

export interface VictimStake {
  matchId: string;
  rows: number;
  inMatch: number;
  backedMicroUsd: number;
}

/**
 * The stake behind a ticket id named in a payout item: every ticket of the same entry, owned by the
 * victim. Returns null when the ticket does not exist or does not belong to `victimId`.
 */
export async function loadVictimStake(db: D1Database, ticketId: unknown, victimId: unknown): Promise<VictimStake | null> {
  if (typeof ticketId !== 'string' || !/^tkt_[A-Za-z0-9_-]{8,80}$/.test(ticketId) || typeof victimId !== 'string' || !victimId) return null;
  const t = await db.prepare('SELECT match_id, user_id FROM user_energy_tickets WHERE id = ?1').bind(ticketId).first<{ match_id: string | null; user_id: string }>();
  if (!t || t.user_id !== victimId || !t.match_id) return null;
  const agg = await db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'in_match' THEN 1 ELSE 0 END) AS live, COALESCE(SUM(backed_micro_usd), 0) AS v
       FROM user_energy_tickets WHERE match_id = ?1 AND user_id = ?2`
    )
    .bind(t.match_id, victimId)
    .first<{ n: number; live: number; v: number }>();
  return { matchId: t.match_id, rows: Number(agg?.n ?? 0), inMatch: Number(agg?.live ?? 0), backedMicroUsd: Math.max(0, Number(agg?.v ?? 0)) };
}

/**
 * Settlement guard — put it FIRST in the payout's D1 batch. It flips every ticket of the stake from
 * in_match to settled; a ticket that is not in_match any more is written as 'conflict', which violates
 * the status CHECK and rolls the whole batch back. So a stake is paid out at most once, even when the
 * game server re-sends a batch or two batches race.
 */
export function settleStakeStmt(
  db: D1Database,
  s: { matchId: string; victimId: string; action: string; toUserId: string | null; paidMicroUsd: number; ref: string | null },
  now = nowSec()
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE user_energy_tickets
          SET status = CASE WHEN status = 'in_match' THEN 'settled' ELSE 'conflict' END,
              settled_at = ?3, settle_action = ?4, settled_to_user_id = ?5,
              settled_micro_usd = CASE WHEN id = (SELECT MIN(id) FROM user_energy_tickets WHERE match_id = ?1 AND user_id = ?2) THEN ?6 ELSE 0 END,
              settle_ref = ?7
        WHERE match_id = ?1 AND user_id = ?2`
    )
    .bind(s.matchId, s.victimId, now, s.action, s.toUserId, Math.max(0, Math.floor(s.paidMicroUsd)), s.ref ? s.ref.slice(0, 80) : null);
}

/** A D1 error caused by the settlement guard (stake already settled / raced). */
export function isSettleConflict(err: unknown): boolean {
  return /CHECK constraint failed/i.test(String((err as Error)?.message ?? err));
}

/**
 * The stake ended without a kill payout (holder left / AFK kick / collusion kill / unopened chest /
 * game-server crash sweep): its whole backing goes to the platform. Idempotent (guarded).
 */
export async function forfeitStake(env: Env, stake: VictimStake, victimId: string, action: string, ref: string | null): Promise<number> {
  const now = nowSec();
  try {
    await env.DB.batch([
      settleStakeStmt(env.DB, { matchId: stake.matchId, victimId, action, toUserId: null, paidMicroUsd: 0, ref }, now),
      env.DB.prepare(
        `INSERT INTO system_balances (id, platform_micro_usd, updated_at) VALUES ('global', ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET platform_micro_usd = platform_micro_usd + ?1, updated_at = ?2`
      ).bind(stake.backedMicroUsd, now),
    ]);
  } catch (e) {
    if (isSettleConflict(e)) return -1;
    throw e;
  }
  if (stake.backedMicroUsd > 0) {
    await logFinancialTransaction(env, {
      transaction_id: `tx_tkt_forfeit_${stake.matchId.slice(0, 18)}_${now}`,
      user_id: PLATFORM_ACCOUNT_ID,
      action_type: 'TICKET_FORFEIT',
      amount_micro_usd: BigInt(stake.backedMicroUsd),
      balance_after_micro_usd: 0n,
      source_game_id: ref ? ref.slice(0, 64) : null,
      related_user_id: victimId,
    });
  }
  return stake.backedMicroUsd;
}

/** Daily cron: in_match tickets nobody settled for 6 h (game-server crash) → forfeited to the platform. */
export async function sweepStaleMatchTickets(env: Env, now = nowSec()): Promise<{ tickets: number; microUsd: number }> {
  const cutoff = now - STALE_MATCH_TICKET_SECONDS;
  const agg = await env.DB
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(backed_micro_usd), 0) AS v FROM user_energy_tickets WHERE status = 'in_match' AND consumed_at < ?1")
    .bind(cutoff)
    .first<{ n: number; v: number }>();
  if (!Number(agg?.n)) return { tickets: 0, microUsd: 0 };
  // One transaction: the platform gets exactly the backing of the rows flipped by the second statement
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE system_balances SET platform_micro_usd = platform_micro_usd
         + (SELECT COALESCE(SUM(backed_micro_usd), 0) FROM user_energy_tickets WHERE status = 'in_match' AND consumed_at < ?1), updated_at = ?2
       WHERE id = 'global'`
    ).bind(cutoff, now),
    env.DB.prepare(
      "UPDATE user_energy_tickets SET status = 'settled', settled_at = ?2, settle_action = 'STALE_FORFEIT', settled_micro_usd = 0 WHERE status = 'in_match' AND consumed_at < ?1"
    ).bind(cutoff, now),
  ]);
  return { tickets: Number(agg?.n ?? 0), microUsd: Number(agg?.v ?? 0) };
}

export interface EcBacking {
  /** Real µUSD (already after the safety haircut) that backs this EC progress. */
  microUsd: number;
  source: EnergyTicketSource;
  country: string;
  /** Simulated ads: draw the backing from the Energy Pool (capped by what it holds). */
  fromPool?: boolean;
}

/**
 * Credit EC progress (+ its real backing) to the user's D1 balance. Every 10 000 bp mints +1 ticket
 * row carrying the pending backing (up to MAX_ENERGY_TICKETS = 300; when full the bar stays < 100 %
 * and the backing keeps accumulating in pending_ec_micro_usd). One D1 batch per attempt:
 *   1. users CAS (bp, pending, count) — and, for pool-backed credits, only if the pool still holds X
 *   2. Energy Pool draw of X (only if 1 changed the row)
 *   3. ticket INSERTs (each only if the previous statement changed a row)
 * so the backing allocated to the user always equals what left the pool / what the ad earned.
 */
export async function creditEcProgress(env: Env, userId: string, addBp: number, sourceId: string, backing?: EcBacking) {
  const db = env.DB;
  for (let attempt = 0; attempt < 4; attempt++) {
    const u = await db
      .prepare('SELECT energy_tickets, max_energy_tickets, energy_progress_bp, pending_ec_micro_usd FROM users WHERE id = ?1')
      .bind(userId)
      .first<{ energy_tickets: number | null; max_energy_tickets: number | null; energy_progress_bp: number | null; pending_ec_micro_usd: number | null }>();
    if (!u) return null;
    const maxTickets = Math.min(u.max_energy_tickets ?? MAX_ENERGY_TICKETS, MAX_ENERGY_TICKETS);
    const prevBp = u.energy_progress_bp ?? 0;
    const prevPending = Math.max(0, Number(u.pending_ec_micro_usd ?? 0));
    const prevTickets = u.energy_tickets ?? INITIAL_ENERGY_TICKETS;
    const want = Math.max(0, Math.floor(Number(backing?.microUsd ?? 0)));
    const fromPool = !!backing?.fromPool && want > 0;
    const add = fromPool ? Math.min(want, await energyPoolAvailable(db)) : want;
    const alloc = allocateEcProgress({ prevBp, prevPending, addBp, addMicroUsd: add, tickets: prevTickets, maxTickets });
    const now = nowSec();
    const usePool = fromPool && add > 0;
    const stmts: D1PreparedStatement[] = [
      db
        .prepare(
          `UPDATE users SET energy_tickets = ?1, energy_progress_bp = ?2, energy_progress_pct = ?3, pending_ec_micro_usd = ?4
           WHERE id = ?5 AND COALESCE(energy_progress_bp, 0) = ?6 AND COALESCE(pending_ec_micro_usd, 0) = ?7 AND COALESCE(energy_tickets, ?8) = ?9
             ${usePool ? "AND (SELECT energy_pool_micro_usd - energy_pool_drawn_micro_usd FROM system_balances WHERE id = 'global') >= ?10" : ''}`
        )
        .bind(...[alloc.tickets, alloc.newBp, Math.floor(alloc.newBp / 100), alloc.newPending, userId, prevBp, prevPending, INITIAL_ENERGY_TICKETS, prevTickets, ...(usePool ? [add] : [])]),
    ];
    if (usePool) {
      stmts.push(
        db.prepare("UPDATE system_balances SET energy_pool_drawn_micro_usd = energy_pool_drawn_micro_usd + ?1, updated_at = ?2 WHERE id = 'global' AND changes() = 1").bind(add, now)
      );
    }
    const ids: string[] = [];
    for (const value of alloc.mintedBacking) {
      const id = newTicketId();
      ids.push(id);
      stmts.push(
        db
          .prepare(
            `INSERT INTO user_energy_tickets (id, user_id, source_type, country_code, backed_micro_usd, status, created_at)
             SELECT ?1, ?2, ?3, ?4, ?5, 'available', ?6 WHERE changes() = 1`
          )
          .bind(id, userId, backing?.source ?? 'ad_charge', (backing?.country || 'GLOBAL').slice(0, 8), value, now)
      );
    }
    const res = await db.batch(stmts);
    if ((res[0].meta?.changes ?? 0) !== 1) continue; // concurrent update (or the pool was drained meanwhile): re-read and retry
    await logFinancialTransaction(env, {
      transaction_id: `ec_ad_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      user_id: userId,
      action_type: 'AD_EC_RECHARGE',
      amount_micro_usd: BigInt(add),
      balance_after_micro_usd: 0n,
      source_game_id: `${sourceId}:+${addBp}bp:t${alloc.tickets}`.slice(0, 64),
    });
    if (usePool) {
      await logFinancialTransaction(env, {
        transaction_id: `tx_pool_draw_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
        user_id: ENERGY_POOL_ACCOUNT_ID,
        action_type: 'ENERGY_POOL_DRAW',
        amount_micro_usd: BigInt(add),
        balance_after_micro_usd: 0n,
        source_game_id: sourceId.slice(0, 64),
        related_user_id: userId,
      });
    }
    for (let i = 0; i < ids.length; i++) {
      await logFinancialTransaction(env, {
        transaction_id: `tx_mint_${ids[i].slice(4, 22)}`,
        user_id: userId,
        action_type: 'TICKET_MINT',
        amount_micro_usd: BigInt(alloc.mintedBacking[i]),
        balance_after_micro_usd: 0n,
        source_game_id: ids[i].slice(0, 64),
      });
    }
    return {
      energyTickets: alloc.tickets,
      maxEnergyTickets: maxTickets,
      energyProgressBp: alloc.newBp,
      energyProgressPct: alloc.newBp / 100,
      ticketsAwarded: alloc.tickets - prevTickets,
      full: alloc.tickets >= maxTickets,
      backedAddedMicroUsd: add,
      pendingEcMicroUsd: alloc.newPending,
      mintedTicketMicroUsd: alloc.mintedBacking,
    };
  }
  throw new Error('EC progress update conflicted, try again');
}

/** Wallet summary of a user's tickets (bootstrap / wallet screens). */
export async function ticketSummary(db: D1Database, userId: string) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(backed_micro_usd), 0) AS v,
              (SELECT backed_micro_usd FROM user_energy_tickets WHERE user_id = ?1 AND status = 'available' ORDER BY created_at ASC, id ASC LIMIT 1) AS next_v,
              (SELECT pending_ec_micro_usd FROM users WHERE id = ?1) AS pending
       FROM user_energy_tickets WHERE user_id = ?1 AND status = 'available'`
    )
    .bind(userId)
    .first<{ n: number; v: number; next_v: number | null; pending: number | null }>();
  return {
    availableTickets: Number(r?.n ?? 0),
    availableBackedMicroUsd: Number(r?.v ?? 0),
    nextTicketMicroUsd: Number(r?.next_v ?? 0),
    pendingEcMicroUsd: Number(r?.pending ?? 0),
  };
}
