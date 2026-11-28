import {
  BOT_BOUNTY_MAX_LIVE_PER_GAME,
  BOT_BOUNTY_MAX_PER_GAME_HOUR,
  BOT_BOUNTY_MIN_POOL_MICRO_USD,
  BOT_BOUNTY_RESERVATION_TTL_SECONDS,
  drawBotBountyMicroUsd,
  happyHourExtraMicroUsd,
  type LiveConfigResponse,
} from '@mwar/shared';
import type { Env } from '../types';
import { logFinancialTransaction, walletBalance } from './audit-logger';
import { BOSS_POOL_ACCOUNT_ID } from './guards';
import { ledgerAfterUpdate } from './ledger';
import { bossPoolBalance } from './boss-bounty';
import { liveConfig } from './platform-settings';

/**
 * V1.2 Round C money helpers that draw from the Boss Bounty Pool (system_balances.boss_bounty_pool_micro_usd,
 * CHECK >= 0): Happy Hour 2x extras and cold-start bot bounties. Every draw is one D1 batch whose first statement
 * takes the amount out of the pool only if the pool still holds it; nothing is ever paid from an estimate.
 */
const nowSec = () => Math.floor(Date.now() / 1000);
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** HMAC-SHA256 `<base64url(json)>.<hex sig>` token the game server verifies with INTERNAL_API_SECRET. */
export async function signGameToken(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${hex(sig)}`;
}

// ---- Happy Hour 2x --------------------------------------------------------------------------------------------

/**
 * Happy Hour: credit `earnerMicroUsd` (the earner's 55 % share of a payout that was just settled) once more, from
 * the Boss Bounty Pool — all or nothing (falls back to 1x when the pool cannot cover it). One D1 batch:
 *   1. pool − x only if pool ≥ x          2. happy_hour_bonuses row (UNIQUE source_ref → each payout doubles once)
 *   3. wallet + x                          4. wallet_ledger HAPPY_HOUR_BONUS
 *   5. guard: a broken chain (no wallet) turns the bonus amount negative → CHECK → the whole batch rolls back
 * Returns the µUSD credited (0 = not happy hour / pool too low / already doubled).
 */
export async function payHappyHourBonus(
  env: Env,
  o: { userId: string; earnerMicroUsd: number; sourceRef: string; actionType: string; gameId?: string | null; cfg?: LiveConfigResponse }
): Promise<number> {
  const cfg = o.cfg ?? (await liveConfig(env));
  if (!cfg.happyHour.active) return 0;
  const x = happyHourExtraMicroUsd(o.earnerMicroUsd, await bossPoolBalance(env), true);
  if (x <= 0) return 0;
  const t = nowSec();
  const ref = o.sourceRef.slice(0, 120);
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare("UPDATE system_balances SET boss_bounty_pool_micro_usd = boss_bounty_pool_micro_usd - ?1, updated_at = ?2 WHERE id = 'global' AND boss_bounty_pool_micro_usd >= ?1").bind(x, t),
      env.DB.prepare('INSERT INTO happy_hour_bonuses (source_ref, user_id, action_type, amount_micro_usd, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() = 1').bind(ref, o.userId, o.actionType.slice(0, 32), x, t),
      env.DB.prepare('UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3 AND changes() = 1').bind(x, t, o.userId),
      ledgerAfterUpdate(env.DB, o.userId, x, 'HAPPY_HOUR_BONUS', ref, t),
      env.DB.prepare('UPDATE happy_hour_bonuses SET amount_micro_usd = CASE WHEN changes() = 1 THEN amount_micro_usd ELSE -1 END WHERE source_ref = ?1').bind(ref),
    ]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/UNIQUE|CHECK constraint failed/i.test(msg)) return 0; // already doubled / chain broke (rolled back)
    throw e;
  }
  if ((res[0].meta?.changes ?? 0) !== 1 || (res[2].meta?.changes ?? 0) !== 1) return 0; // pool raced below x
  const tag = `${t}_${crypto.randomUUID().slice(0, 8)}`;
  await logFinancialTransaction(env, {
    transaction_id: `tx_hh_${tag}`,
    user_id: o.userId,
    action_type: 'HAPPY_HOUR_BONUS',
    amount_micro_usd: BigInt(x),
    balance_after_micro_usd: await walletBalance(env.DB, o.userId),
    source_game_id: (o.gameId || ref).slice(0, 64),
    related_user_id: BOSS_POOL_ACCOUNT_ID,
  });
  return x;
}

// ---- Cold-start bot bounties -----------------------------------------------------------------------------------

export interface BotReservation {
  id: string;
  game_id: string;
  room_id: string | null;
  bot_id: string;
  amount_micro_usd: number;
  status: 'reserved' | 'claimed' | 'released';
  created_at: number;
  expires_at: number;
}

export const BOT_ID_RE = /^bot_[a-z0-9]{2,24}$/;

export async function loadBotReservation(env: Env, id: unknown): Promise<BotReservation | null> {
  if (typeof id !== 'string' || !/^bot_[0-9a-f-]{36}$/.test(id)) return null;
  return env.DB.prepare('SELECT * FROM bot_bounty_reservations WHERE id = ?1').bind(id).first<BotReservation>();
}

export type BotReserveResult =
  | { reserved: true; reservationId: string; amountMicroUsd: number; expiresAt: number }
  | { reserved: false; reason: 'disabled' | 'pool_low' | 'already_active' | 'room_cap' | 'raced'; poolMicroUsd?: number };

/**
 * Reserve a small bounty (10–50 C) for cold-start bot `botId` of game room `gameId`, from the Boss Bounty Pool only:
 * INSERT … WHERE pool ≥ max(amount, 1,000 C) AND the room is under its live / hourly caps, then pool − amount only
 * if the insert happened (same batch; the pool column is CHECK >= 0). 0 C bots simply get no reservation.
 */
export async function reserveBotBounty(env: Env, o: { gameId: string; roomId?: string | null; botId: string }, rand: () => number = Math.random): Promise<BotReserveResult> {
  const cfg = await liveConfig(env);
  if (!cfg.botFill.enabled) return { reserved: false, reason: 'disabled' };
  if (!BOT_ID_RE.test(o.botId)) return { reserved: false, reason: 'raced' };
  const t = nowSec();
  await releaseExpiredBotReservations(env, t).catch(() => {});
  const pool = await bossPoolBalance(env);
  const amount = drawBotBountyMicroUsd(pool, rand);
  if (amount <= 0) return { reserved: false, reason: 'pool_low', poolMicroUsd: pool };
  const id = `bot_${crypto.randomUUID()}`;
  const gameId = o.gameId.slice(0, 80);
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO bot_bounty_reservations (id, game_id, room_id, bot_id, amount_micro_usd, status, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5, 'reserved', ?6, ?7
         WHERE (SELECT boss_bounty_pool_micro_usd FROM system_balances WHERE id = 'global') >= MAX(?5, ?8)
           AND (SELECT COUNT(*) FROM bot_bounty_reservations WHERE game_id = ?2 AND status = 'reserved') < ?9
           AND (SELECT COUNT(*) FROM bot_bounty_reservations WHERE game_id = ?2 AND created_at >= ?6 - 3600) < ?10`
      ).bind(id, gameId, o.roomId ? String(o.roomId).slice(0, 80) : null, o.botId, amount, t, t + BOT_BOUNTY_RESERVATION_TTL_SECONDS, BOT_BOUNTY_MIN_POOL_MICRO_USD, BOT_BOUNTY_MAX_LIVE_PER_GAME, BOT_BOUNTY_MAX_PER_GAME_HOUR),
      env.DB.prepare("UPDATE system_balances SET boss_bounty_pool_micro_usd = boss_bounty_pool_micro_usd - ?1, updated_at = ?2 WHERE id = 'global' AND changes() = 1").bind(amount, t),
    ]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/UNIQUE constraint failed/i.test(msg)) return { reserved: false, reason: 'already_active' };
    if (/CHECK constraint failed/i.test(msg)) return { reserved: false, reason: 'raced' };
    throw e;
  }
  if ((res[0].meta?.changes ?? 0) !== 1) {
    const p = await bossPoolBalance(env);
    return { reserved: false, reason: p >= Math.max(amount, BOT_BOUNTY_MIN_POOL_MICRO_USD) ? 'room_cap' : 'pool_low', poolMicroUsd: p };
  }
  await logFinancialTransaction(env, {
    transaction_id: `tx_bot_reserve_${id.slice(4, 22)}`,
    user_id: BOSS_POOL_ACCOUNT_ID,
    action_type: 'BOT_BOUNTY_RESERVE',
    amount_micro_usd: BigInt(amount),
    balance_after_micro_usd: 0n,
    source_game_id: gameId.slice(0, 64),
  });
  return { reserved: true, reservationId: id, amountMicroUsd: amount, expiresAt: t + BOT_BOUNTY_RESERVATION_TTL_SECONDS };
}

/** Return a bot reservation to the pool — exactly once. Returns the µUSD returned (0 = already settled / unknown). */
export async function releaseBotReservation(env: Env, id: string, reason: string, t = nowSec()): Promise<number> {
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE bot_bounty_reservations SET status = 'released', settled_at = ?2, settle_ref = ?3 WHERE id = ?1 AND status = 'reserved'").bind(id, t, reason.slice(0, 80)),
    env.DB.prepare(
      `UPDATE system_balances SET boss_bounty_pool_micro_usd = boss_bounty_pool_micro_usd + (SELECT amount_micro_usd FROM bot_bounty_reservations WHERE id = ?1), updated_at = ?2
       WHERE id = 'global' AND changes() = 1`
    ).bind(id, t),
  ]);
  if ((res[0].meta?.changes ?? 0) !== 1) return 0;
  const r = await env.DB.prepare('SELECT amount_micro_usd, game_id FROM bot_bounty_reservations WHERE id = ?1').bind(id).first<{ amount_micro_usd: number; game_id: string }>();
  const amount = Number(r?.amount_micro_usd ?? 0);
  await logFinancialTransaction(env, {
    transaction_id: `tx_bot_release_${id.slice(4, 22)}`,
    user_id: BOSS_POOL_ACCOUNT_ID,
    action_type: 'BOT_BOUNTY_RELEASE',
    amount_micro_usd: BigInt(amount),
    balance_after_micro_usd: 0n,
    source_game_id: (r?.game_id ?? reason).slice(0, 64),
  });
  return amount;
}

/** Cron / reserve path: bot reservations past their TTL (game-server crash) go back to the pool. */
export async function releaseExpiredBotReservations(env: Env, t = nowSec()): Promise<{ count: number; microUsd: number }> {
  let rows: { id: string }[] = [];
  try {
    rows = (await env.DB.prepare("SELECT id FROM bot_bounty_reservations WHERE status = 'reserved' AND expires_at < ?1 LIMIT 200").bind(t).all<{ id: string }>()).results ?? [];
  } catch {
    return { count: 0, microUsd: 0 }; // table missing before migration 0028
  }
  let count = 0;
  let microUsd = 0;
  for (const r of rows) {
    const v = await releaseBotReservation(env, r.id, 'expired', t);
    if (v > 0) {
      count++;
      microUsd += v;
    }
  }
  return { count, microUsd };
}

/** Streamer rooms past their TTL are closed (their room code stops being served). */
export async function closeExpiredStreamerRooms(env: Env, t = nowSec()): Promise<number> {
  try {
    const r = await env.DB.prepare('UPDATE game_server_rooms SET is_active = 0, updated_at = ?1 WHERE is_streamer_room = 1 AND is_active = 1 AND expires_at IS NOT NULL AND expires_at < ?1').bind(t).run();
    return r.meta?.changes ?? 0;
  } catch {
    return 0;
  }
}
