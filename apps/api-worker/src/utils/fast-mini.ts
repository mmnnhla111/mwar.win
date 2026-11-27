import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { calculateFastMiniSplit, splitFastMiniBanner, FAST_MINI_POT_STALE_SECONDS, ACTIVE_SESSION_SWEEP_GRACE_SECONDS, EXP_PER_KILL } from '@mwar/shared';
import type { Env } from '../types';
import { ledgerAfterUpdate } from './ledger';
import { logFinancialTransaction, walletBalance } from './audit-logger';
import { ENERGY_POOL_ACCOUNT_ID, PLATFORM_ACCOUNT_ID } from './guards';

/**
 * V1.1 Round 2 — Fast & Mini (free, 0 EC) banner-funded pots (D1 core_db, migration 0023).
 *
 * WHOSE MONEY PAYS A KILL: the VICTIM's own pot. Every Fast & Mini entry gets a pot row (id = the entry
 * id signed into the game token). While that player plays, each of THEIR OWN verified banner impressions
 * (POST /api/ads/impression live, /api/ads/simulate-view test mode — the same 28 s gate + anti-idle as
 * everywhere) is valued by the Worker (country eCPM → safety haircut 0.90–0.95) and that safe value S is
 * split once: 50 % into the pot (a fast_mini_pot_credits row), 50 % into normal EC backing. Nothing the
 * game server or the client sends is ever used as an amount:
 *   · FAST_MINI_KILL {killer, victimId, potId, diedAt}: V = Σ open credits of the victim's pot created up
 *     to the moment of death → 90 % shooter wallet (ledger GAME_KILL) / 10 % platform, credits → paid.
 *     Credits after the death fund the victim's next life. Each credit can be paid at most once (CHECK).
 *   · FAST_MINI_CLOSE (left / AFK / room closed) and the daily stale sweep: open credits → platform.
 * Test-mode (simulated) banners earn no revenue, so their pot share is drawn from the Energy Pool's
 * unspent balance (capped atomically, exactly like simulated EC backing) — never created from nothing.
 */

const nowSec = () => Math.floor(Date.now() / 1000);
const POT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isPotId = (v: unknown): v is string => typeof v === 'string' && POT_ID_RE.test(v);

/** Open a pot for a new Fast & Mini entry (statement for the entry's batch). */
export function openPotStmt(env: Env, potId: string, userId: string, roomCode: string | null, now = nowSec()): D1PreparedStatement {
  return env.DB.prepare('INSERT INTO fast_mini_pots (id, user_id, room_code, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(potId, userId, roomCode, 'open', now);
}

/** Open (unpaid) value of a pot. */
export async function potOpenValue(env: Env, potId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(micro_usd), 0) AS v FROM fast_mini_pot_credits WHERE pot_id = ?1 AND status = 'open'").bind(potId).first<{ v: number }>();
  return Number(r?.v ?? 0);
}

export interface FastMiniBannerResult {
  /** µUSD credited into the pot (0 = no open pot of this user / pool empty → the banner credits EC normally). */
  potMicroUsd: number;
  /** What remains for normal EC backing and the EC progress it buys. */
  ecMicroUsd: number;
  ecBp: number;
  potOpenMicroUsd: number;
}

/**
 * A verified banner credit of `safeMicroUsd` (after the haircut) that would normally buy `ecBp` EC
 * progress: if `potId` is this user's open Fast & Mini pot, 50 % goes into the pot (pool-backed for
 * simulated banners) and the rest stays EC backing. pot + EC === safeMicroUsd (never counted twice).
 */
export async function creditFastMiniBanner(
  env: Env,
  opts: { userId: string; potId: unknown; safeMicroUsd: number; ecBp: number; fromPool: boolean; ref: string }
): Promise<FastMiniBannerResult> {
  const none = { potMicroUsd: 0, ecMicroUsd: Math.max(0, Math.floor(opts.safeMicroUsd)), ecBp: opts.ecBp, potOpenMicroUsd: 0 };
  if (!isPotId(opts.potId)) return none;
  const split = splitFastMiniBanner(opts.safeMicroUsd, opts.ecBp);
  if (split.potMicroUsd <= 0) return none;
  const now = nowSec();
  const id = `fmc_${crypto.randomUUID()}`;
  const db = env.DB;
  const poolGuard = opts.fromPool ? "AND (SELECT energy_pool_micro_usd - energy_pool_drawn_micro_usd FROM system_balances WHERE id = 'global') >= ?4" : '';
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO fast_mini_pot_credits (id, pot_id, user_id, micro_usd, ec_micro_usd, source, status, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7
         WHERE EXISTS (SELECT 1 FROM fast_mini_pots WHERE id = ?2 AND user_id = ?3 AND status = 'open' AND created_at >= ?8) ${poolGuard}`
      )
      .bind(id, opts.potId, opts.userId, split.potMicroUsd, split.ecMicroUsd, opts.fromPool ? 'banner_sim' : 'banner_live', now, now - FAST_MINI_POT_STALE_SECONDS),
    db.prepare('UPDATE fast_mini_pots SET funded_micro_usd = funded_micro_usd + ?1 WHERE id = ?2 AND changes() = 1').bind(split.potMicroUsd, opts.potId),
  ];
  if (opts.fromPool) {
    stmts.push(
      db
        .prepare("UPDATE system_balances SET energy_pool_drawn_micro_usd = energy_pool_drawn_micro_usd + ?1, updated_at = ?2 WHERE id = 'global' AND changes() = 1")
        .bind(split.potMicroUsd, now)
    );
  }
  const res = await db.batch(stmts);
  if ((res[0].meta?.changes ?? 0) !== 1) return none; // pot closed / not this user's / pool empty
  await logFinancialTransaction(env, {
    transaction_id: `tx_fm_pot_${id.slice(4, 22)}`,
    user_id: opts.userId,
    action_type: 'FAST_MINI_POT_CREDIT',
    amount_micro_usd: BigInt(split.potMicroUsd),
    balance_after_micro_usd: 0n,
    source_game_id: `${opts.potId}:${opts.ref}`.slice(0, 64),
  });
  if (opts.fromPool) {
    await logFinancialTransaction(env, {
      transaction_id: `tx_pool_draw_fm_${id.slice(4, 22)}`,
      user_id: ENERGY_POOL_ACCOUNT_ID,
      action_type: 'ENERGY_POOL_DRAW',
      amount_micro_usd: BigInt(split.potMicroUsd),
      balance_after_micro_usd: 0n,
      source_game_id: `fm:${opts.potId}`.slice(0, 64),
      related_user_id: opts.userId,
    });
  }
  return { potMicroUsd: split.potMicroUsd, ecMicroUsd: split.ecMicroUsd, ecBp: split.ecBp, potOpenMicroUsd: await potOpenValue(env, opts.potId) };
}

export interface FastMiniKillResult {
  status: 'paid' | 'empty' | 'duplicate' | 'rejected';
  valueMicroUsd: number;
  shooterMicroUsd: number;
  platformMicroUsd: number;
}

const isDupOrConflict = (e: unknown) => /UNIQUE constraint failed|CHECK constraint failed/i.test(String((e as Error)?.message ?? e));

/**
 * FAST_MINI_KILL: the killer is paid 90 % of the victim's open pot credits up to the death (10 % to the
 * platform), in ONE D1 batch whose first statement is the payout receipt (pid, UNIQUE) and second the
 * credit flip open → paid (CHECK-guarded) — a re-sent / parallel batch can never pay twice.
 */
export async function settleFastMiniKill(
  env: Env,
  opts: { killerId: string; victimId: unknown; potId: unknown; diedAtMs: unknown; pid: unknown; gameId: string; hits?: number | null; headshots?: number | null }
): Promise<FastMiniKillResult> {
  const rej: FastMiniKillResult = { status: 'rejected', valueMicroUsd: 0, shooterMicroUsd: 0, platformMicroUsd: 0 };
  const db = env.DB;
  const pid = typeof opts.pid === 'string' && opts.pid.length > 0 && opts.pid.length <= 120 ? opts.pid : '';
  const victimId = typeof opts.victimId === 'string' ? opts.victimId : '';
  if (!pid || !isPotId(opts.potId) || !victimId || victimId === opts.killerId) return rej;
  const potId = opts.potId;
  const now = nowSec();
  const pot = await db.prepare('SELECT user_id, created_at FROM fast_mini_pots WHERE id = ?1').bind(potId).first<{ user_id: string; created_at: number }>();
  if (!pot || pot.user_id !== victimId) return rej;
  // The killer must have entered Fast & Mini themselves in the last 24 h (a real seat, not a guest)
  const killerSeat = await db.prepare('SELECT 1 AS ok FROM fast_mini_pots WHERE user_id = ?1 AND created_at >= ?2 LIMIT 1').bind(opts.killerId, now - 86_400).first<{ ok: number }>();
  if (!killerSeat) return rej;
  const died = Number(opts.diedAtMs);
  const cutoff = Number.isFinite(died) && died > 0 ? Math.min(now, Math.floor(died / 1000)) : now;
  const rows = await db
    .prepare("SELECT id, micro_usd FROM fast_mini_pot_credits WHERE pot_id = ?1 AND status = 'open' AND created_at <= ?2 ORDER BY created_at, id LIMIT 500")
    .bind(potId, cutoff)
    .all<{ id: string; micro_usd: number }>();
  const credits = rows.results ?? [];
  const value = credits.reduce((a, r) => a + Math.max(0, Number(r.micro_usd) || 0), 0);
  if (value <= 0) {
    const r = await db.prepare('INSERT OR IGNORE INTO game_payout_receipts (payout_id, game_id, created_at) VALUES (?1, ?2, ?3)').bind(pid, opts.gameId.slice(0, 80), now).run();
    return { status: (r.meta?.changes ?? 0) === 1 ? 'empty' : 'duplicate', valueMicroUsd: 0, shooterMicroUsd: 0, platformMicroUsd: 0 };
  }
  const split = calculateFastMiniSplit(value);
  const shooter = Number(split.shooterMicroUsd);
  const platform = Number(split.platformMicroUsd);
  const ref = `fm:${potId}`.slice(0, 80);
  try {
    await db.batch([
      db.prepare('INSERT INTO game_payout_receipts (payout_id, game_id, created_at) VALUES (?1, ?2, ?3)').bind(pid, opts.gameId.slice(0, 80), now),
      db
        .prepare(
          `UPDATE fast_mini_pot_credits SET status = CASE WHEN status = 'open' THEN 'paid' ELSE 'conflict' END, settle_ref = ?2, settled_at = ?3
           WHERE id IN (SELECT value FROM json_each(?1))`
        )
        .bind(JSON.stringify(credits.map((r) => r.id)), pid.slice(0, 120), now),
      db.prepare('UPDATE fast_mini_pots SET paid_micro_usd = paid_micro_usd + ?1, kills_paid = kills_paid + 1 WHERE id = ?2').bind(value, potId),
      db
        .prepare('UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3')
        .bind(shooter, now, opts.killerId),
      ledgerAfterUpdate(db, opts.killerId, shooter, 'GAME_KILL', ref, now),
      // 10 % to the platform (+ the shooter share too if the shooter has no wallet row: nothing is lost)
      db
        .prepare(
          `INSERT INTO system_balances (id, platform_micro_usd, updated_at) VALUES ('global', ?1 + CASE WHEN EXISTS (SELECT 1 FROM wallets WHERE user_id = ?3) THEN 0 ELSE ?2 END, ?4)
           ON CONFLICT(id) DO UPDATE SET platform_micro_usd = platform_micro_usd + ?1 + CASE WHEN EXISTS (SELECT 1 FROM wallets WHERE user_id = ?3) THEN 0 ELSE ?2 END, updated_at = ?4`
        )
        .bind(platform, shooter, opts.killerId, now),
      db
        .prepare(
          `INSERT INTO combat_events (id, user_id, game_id, action_type, victim_id, gross_micro_usd, earner_micro_usd, session_hits, session_headshots, created_at)
           VALUES (?1, ?2, ?3, 'GAME_KILL', ?4, ?5, ?6, ?7, ?8, ?9)`
        )
        .bind(`ce_${crypto.randomUUID()}`, opts.killerId, opts.gameId.slice(0, 80), victimId.slice(0, 64), value, shooter, opts.hits ?? null, opts.headshots ?? null, now),
      db.prepare('UPDATE users SET total_kills = total_kills + 1, exp = COALESCE(exp, 0) + ?2 WHERE id = ?1').bind(opts.killerId, EXP_PER_KILL),
    ]);
  } catch (e) {
    if (isDupOrConflict(e)) return { status: 'duplicate', valueMicroUsd: 0, shooterMicroUsd: 0, platformMicroUsd: 0 };
    throw e;
  }
  const src = `fm:${opts.gameId}`.slice(0, 64);
  await logFinancialTransaction(env, {
    transaction_id: `tx_fm_kill_${pid.slice(-24)}_${now}`,
    user_id: opts.killerId,
    action_type: 'GAME_KILL',
    amount_micro_usd: BigInt(shooter),
    balance_after_micro_usd: await walletBalance(db, opts.killerId),
    source_game_id: src,
    related_user_id: victimId,
  });
  await logFinancialTransaction(env, {
    transaction_id: `tx_fm_platform_${pid.slice(-24)}_${now}`,
    user_id: PLATFORM_ACCOUNT_ID,
    action_type: 'PLATFORM_FEE',
    amount_micro_usd: BigInt(platform),
    balance_after_micro_usd: 0n,
    source_game_id: src,
    related_user_id: opts.killerId,
  });
  return { status: 'paid', valueMicroUsd: value, shooterMicroUsd: shooter, platformMicroUsd: platform };
}

/**
 * FAST_MINI_CLOSE / stale sweep: the pot closes once (CHECK-guarded), its still-open credits go to the
 * platform. Returns the forfeited µUSD, or -1 when it was already closed / not this user's pot.
 */
export async function closeFastMiniPot(env: Env, opts: { potId: unknown; userId?: string; reason: string; ref?: string | null }): Promise<number> {
  if (!isPotId(opts.potId)) return -1;
  const potId = opts.potId;
  const db = env.DB;
  const pot = await db.prepare('SELECT user_id, status FROM fast_mini_pots WHERE id = ?1').bind(potId).first<{ user_id: string; status: string }>();
  if (!pot || (opts.userId && pot.user_id !== opts.userId) || pot.status !== 'open') return -1;
  const now = nowSec();
  const open = "(SELECT COALESCE(SUM(micro_usd), 0) FROM fast_mini_pot_credits WHERE pot_id = ?1 AND status = 'open')";
  const value = await potOpenValue(env, potId);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE fast_mini_pots SET status = CASE WHEN status = 'open' THEN 'closed' ELSE 'conflict' END,
                 forfeited_micro_usd = forfeited_micro_usd + ${open}, closed_at = ?2, close_reason = ?3
           WHERE id = ?1`
        )
        .bind(potId, now, opts.reason.slice(0, 24)),
      db.prepare(`UPDATE system_balances SET platform_micro_usd = platform_micro_usd + ${open}, updated_at = ?2 WHERE id = 'global'`).bind(potId, now),
      db.prepare("UPDATE fast_mini_pot_credits SET status = 'forfeited', settle_ref = ?2, settled_at = ?3 WHERE pot_id = ?1 AND status = 'open'").bind(potId, `close:${opts.reason}`.slice(0, 120), now),
    ]);
  } catch (e) {
    if (isDupOrConflict(e)) return -1;
    throw e;
  }
  if (value > 0) {
    await logFinancialTransaction(env, {
      transaction_id: `tx_fm_forfeit_${potId.slice(0, 18)}_${now}`,
      user_id: PLATFORM_ACCOUNT_ID,
      action_type: 'FAST_MINI_POT_FORFEIT',
      amount_micro_usd: BigInt(value),
      balance_after_micro_usd: 0n,
      source_game_id: (opts.ref ?? `fm:${potId}`).slice(0, 64),
      related_user_id: pot.user_id,
    });
  }
  return value;
}

/** Daily cron: Fast & Mini pots left open for 6 h (game-server crash) are closed (open credits → platform). */
export async function sweepStaleFastMiniPots(env: Env, now = nowSec()): Promise<{ pots: number; microUsd: number }> {
  const rows = await env.DB
    // V1.1 R3: never the pot of a body still alive in a heart-beating room (it closes when that body dies / the room shuts down)
    .prepare(
      `SELECT id FROM fast_mini_pots WHERE status = 'open' AND created_at < ?1
         AND NOT EXISTS (SELECT 1 FROM game_active_sessions s WHERE s.entry_id = fast_mini_pots.id AND s.ended_at IS NULL AND s.heartbeat_at >= ?2)
       LIMIT 500`
    )
    .bind(now - FAST_MINI_POT_STALE_SECONDS, now - ACTIVE_SESSION_SWEEP_GRACE_SECONDS)
    .all<{ id: string }>();
  let pots = 0;
  let microUsd = 0;
  for (const r of rows.results ?? []) {
    const v = await closeFastMiniPot(env, { potId: r.id, reason: 'stale' });
    if (v >= 0) {
      pots++;
      microUsd += v;
    }
  }
  return { pots, microUsd };
}
