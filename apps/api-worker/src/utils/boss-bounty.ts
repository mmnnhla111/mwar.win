import {
  BOSS_BOUNTY_MIN_POOL_MICRO_USD,
  BOSS_BOUNTY_RESERVATION_TTL_SECONDS,
  drawBossBountyMicroUsd,
} from '@mwar/shared';
import type { Env } from '../types';
import { logFinancialTransaction } from './audit-logger';
import { BOSS_POOL_ACCOUNT_ID } from './guards';

/**
 * V1.2 Golden Boss Bounty ("เป้าหมายค่าหัวทองคำ") — zero-deficit reservations (D1 core_db, migration 0026).
 *
 * The game server never decides an amount. It asks the Worker (internal secret) to RESERVE a draw for one
 * player of its room: the Worker picks 500 C – 2,000 C (capped by the pool), and in ONE D1 batch inserts a
 * boss_bounty_reservations row ('reserved') and takes exactly that amount out of
 * system_balances.boss_bounty_pool_micro_usd (only if the pool still holds it; the pool column is CHECK >= 0).
 * Afterwards the reservation ends exactly once:
 *   · claimed  — the boss was eliminated: BOSS_BOUNTY_CLAIM pays it through 55/15/5/5/20 (game.ts, guarded
 *                by a status flip that writes 'conflict' → CHECK failure → the whole batch rolls back)
 *   · released — boss left / died otherwise / event expired / room closed / Worker cron after the TTL: the
 *                amount returns to the pool (status-guarded UPDATE + pool credit only when it changed a row)
 */

const nowSec = () => Math.floor(Date.now() / 1000);

export interface BossReservation {
  id: string;
  game_id: string;
  room_id: string | null;
  target_user_id: string;
  target_entry_id: string | null;
  amount_micro_usd: number;
  status: 'reserved' | 'claimed' | 'released';
  created_at: number;
  expires_at: number;
}

export async function bossPoolBalance(env: Env): Promise<number> {
  const r = await env.DB.prepare("SELECT boss_bounty_pool_micro_usd AS b FROM system_balances WHERE id = 'global'").first<{ b: number }>();
  return Math.max(0, Number(r?.b ?? 0));
}

export async function loadReservation(env: Env, id: unknown): Promise<BossReservation | null> {
  if (typeof id !== 'string' || !/^bbr_[0-9a-f-]{36}$/.test(id)) return null;
  return env.DB.prepare('SELECT * FROM boss_bounty_reservations WHERE id = ?1').bind(id).first<BossReservation>();
}

export type ReserveResult =
  | { reserved: true; reservationId: string; amountMicroUsd: number; expiresAt: number; poolAfterMicroUsd: number }
  | { reserved: false; reason: 'pool_low' | 'already_active' | 'not_eligible' | 'raced'; poolMicroUsd?: number };

/** Reserve a Golden Boss draw for `targetUserId` in game room `gameId` (one live reservation per room). */
export async function reserveBossBounty(
  env: Env,
  opts: { gameId: string; roomId?: string | null; targetUserId: string; entryId?: string | null },
  rand: () => number = Math.random
): Promise<ReserveResult> {
  const now = nowSec();
  await releaseExpiredReservations(env, now).catch(() => {});
  // The boss must be a live paid seat right now: a ticket of that entry still in_match
  if (opts.entryId) {
    const t = await env.DB
      .prepare("SELECT 1 AS ok FROM user_energy_tickets WHERE user_id = ?1 AND match_id = ?2 AND status = 'in_match' LIMIT 1")
      .bind(opts.targetUserId, opts.entryId)
      .first<{ ok: number }>();
    if (!t) return { reserved: false, reason: 'not_eligible' };
  } else return { reserved: false, reason: 'not_eligible' };
  const pool = await bossPoolBalance(env);
  const amount = drawBossBountyMicroUsd(pool, rand);
  if (amount <= 0) return { reserved: false, reason: 'pool_low', poolMicroUsd: pool };
  const id = `bbr_${crypto.randomUUID()}`;
  const expiresAt = now + BOSS_BOUNTY_RESERVATION_TTL_SECONDS;
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO boss_bounty_reservations (id, game_id, room_id, target_user_id, target_entry_id, amount_micro_usd, status, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'reserved', ?7, ?8
         WHERE (SELECT boss_bounty_pool_micro_usd FROM system_balances WHERE id = 'global') >= MAX(?6, ?9)`
      ).bind(id, opts.gameId.slice(0, 80), opts.roomId ? String(opts.roomId).slice(0, 80) : null, opts.targetUserId, opts.entryId ?? null, amount, now, expiresAt, BOSS_BOUNTY_MIN_POOL_MICRO_USD),
      env.DB.prepare(
        "UPDATE system_balances SET boss_bounty_pool_micro_usd = boss_bounty_pool_micro_usd - ?1, updated_at = ?2 WHERE id = 'global' AND changes() = 1"
      ).bind(amount, now),
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e))) return { reserved: false, reason: 'already_active' };
    if (/CHECK constraint failed/i.test(String((e as Error)?.message ?? e))) return { reserved: false, reason: 'raced' };
    throw e;
  }
  if ((res[0].meta?.changes ?? 0) !== 1) return { reserved: false, reason: 'raced' };
  await logFinancialTransaction(env, {
    transaction_id: `tx_boss_reserve_${id.slice(4, 22)}`,
    user_id: BOSS_POOL_ACCOUNT_ID,
    action_type: 'BOSS_BOUNTY_RESERVE',
    amount_micro_usd: BigInt(amount),
    balance_after_micro_usd: 0n,
    source_game_id: opts.gameId.slice(0, 64),
    related_user_id: opts.targetUserId,
  });
  return { reserved: true, reservationId: id, amountMicroUsd: amount, expiresAt, poolAfterMicroUsd: await bossPoolBalance(env) };
}

/**
 * Return a reservation to the pool — exactly once (the pool is credited only when the status flip changed a row).
 * Returns the µUSD returned (0 = already claimed / released / unknown).
 */
export async function releaseBossReservation(env: Env, id: string, reason: string, now = nowSec()): Promise<number> {
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE boss_bounty_reservations SET status = 'released', settled_at = ?2, settle_ref = ?3 WHERE id = ?1 AND status = 'reserved'").bind(id, now, reason.slice(0, 80)),
    env.DB.prepare(
      `UPDATE system_balances SET boss_bounty_pool_micro_usd = boss_bounty_pool_micro_usd + (SELECT amount_micro_usd FROM boss_bounty_reservations WHERE id = ?1), updated_at = ?2
       WHERE id = 'global' AND changes() = 1`
    ).bind(id, now),
  ]);
  if ((res[0].meta?.changes ?? 0) !== 1) return 0;
  const r = await env.DB.prepare('SELECT amount_micro_usd, target_user_id, game_id FROM boss_bounty_reservations WHERE id = ?1').bind(id).first<{ amount_micro_usd: number; target_user_id: string; game_id: string }>();
  const amount = Number(r?.amount_micro_usd ?? 0);
  await logFinancialTransaction(env, {
    transaction_id: `tx_boss_release_${id.slice(4, 22)}`,
    user_id: BOSS_POOL_ACCOUNT_ID,
    action_type: 'BOSS_BOUNTY_RELEASE',
    amount_micro_usd: BigInt(amount),
    balance_after_micro_usd: 0n,
    source_game_id: (r?.game_id ?? reason).slice(0, 64),
    related_user_id: r?.target_user_id ?? null,
  });
  return amount;
}

/** Cron / reserve path: reservations past their TTL (game-server crash) go back to the pool. */
export async function releaseExpiredReservations(env: Env, now = nowSec()): Promise<{ count: number; microUsd: number }> {
  const rows = await env.DB
    .prepare("SELECT id FROM boss_bounty_reservations WHERE status = 'reserved' AND expires_at < ?1 LIMIT 200")
    .bind(now)
    .all<{ id: string }>();
  let count = 0;
  let microUsd = 0;
  for (const r of rows.results ?? []) {
    const v = await releaseBossReservation(env, r.id, 'expired', now);
    if (v > 0) {
      count++;
      microUsd += v;
    }
  }
  return { count, microUsd };
}
