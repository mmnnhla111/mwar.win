/**
 * V1.1 Round 3 — live sessions of alive characters (game_active_sessions, migration 0024).
 *
 *  · The game server reports every alive Paid-EC / Fast & Mini seat with its 10 s batch-payout POST
 *    (`sessions`: snapshot upserts + ends + a room heartbeat). Disconnected bodies stay in the arena and
 *    keep being reported (isDisconnected = true) until they actually die or the room shuts down.
 *  · No money lives here. Settlement stays on the existing path (batch-payout GAME_KILL / CHEST_OPEN /
 *    BOUNTY_CLAIM / TICKET_FORFEIT / TICKET_RETURN / FAST_MINI_*). A session is only "live" while its stake
 *    is still open (ticket in_match for this entry, or the Fast & Mini pot open), so a settled ticket is
 *    never shown or rejoinable even if an end report were lost.
 */
import { ACTIVE_SESSION_FRESH_SECONDS, ACTIVE_SESSION_SWEEP_GRACE_SECONDS, STALE_MATCH_TICKET_SECONDS, GameSessionReportSchema } from '@mwar/shared';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { ActiveGameSession } from '@mwar/shared';
import type { Env } from '../types';
import { logFinancialTransaction } from './audit-logger';

const nowSec = () => Math.floor(Date.now() / 1000);

export interface ActiveSessionRow {
  entry_id: string;
  user_id: string;
  room_id: string;
  room_code: string | null;
  mode: string;
  map_name: string;
  server_url: string | null;
  hp: number;
  is_prop_hidden: number;
  prop_type: string | null;
  is_disconnected: number;
  life_started_at: number;
  entered_at: number;
  heartbeat_at: number;
}

/**
 * Statements for one room report (same D1 batch). Ends and upserts are both guarded by the life start time,
 * so their order (or a late re-sent snapshot) can never end a newer life or revive an ended one.
 */
export function sessionReportStmts(db: D1Database, raw: unknown, gameId: string, now = nowSec()): { stmts: D1PreparedStatement[]; upserts: number; ends: number } {
  const parsed = GameSessionReportSchema.safeParse(raw);
  if (!parsed.success) return { stmts: [], upserts: 0, ends: 0 };
  const r = parsed.data;
  const stmts: D1PreparedStatement[] = [];
  const serverUrl = r.serverUrl && /^wss?:\/\/[^\s]+$/i.test(r.serverUrl) ? r.serverUrl.slice(0, 200) : null;
  for (const e of r.end) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO game_active_sessions (entry_id, user_id, room_id, mode, map_name, life_started_at, entered_at, heartbeat_at, ended_at, end_reason, updated_at)
           VALUES (?1, ?2, ?3, 'ended', 'small', 0, ?4, ?4, ?5, ?6, ?4)
           ON CONFLICT(entry_id) DO UPDATE SET ended_at = excluded.ended_at, end_reason = excluded.end_reason, updated_at = excluded.updated_at
           WHERE game_active_sessions.user_id = excluded.user_id
             AND excluded.ended_at >= game_active_sessions.life_started_at
             AND (game_active_sessions.ended_at IS NULL OR game_active_sessions.ended_at < excluded.ended_at)`
        )
        .bind(e.entryId, e.userId, r.roomId, now, Math.floor(e.endedAt), e.reason.slice(0, 24))
    );
  }
  for (const u of r.upsert) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO game_active_sessions (entry_id, user_id, room_id, room_code, mode, map_name, server_url, game_id, ticket_id, pot_id, hp,
                                             is_prop_hidden, prop_type, is_disconnected, life_started_at, entered_at, heartbeat_at, ended_at, end_reason, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, NULL, NULL, ?17)
           ON CONFLICT(entry_id) DO UPDATE SET
             room_id = excluded.room_id, room_code = excluded.room_code, mode = excluded.mode, map_name = excluded.map_name,
             server_url = excluded.server_url, game_id = excluded.game_id, ticket_id = excluded.ticket_id, pot_id = excluded.pot_id,
             hp = excluded.hp, is_prop_hidden = excluded.is_prop_hidden, prop_type = excluded.prop_type, is_disconnected = excluded.is_disconnected,
             entered_at = CASE WHEN game_active_sessions.life_started_at = excluded.life_started_at THEN game_active_sessions.entered_at ELSE excluded.entered_at END,
             life_started_at = excluded.life_started_at, heartbeat_at = excluded.heartbeat_at, updated_at = excluded.updated_at,
             ended_at = NULL, end_reason = NULL
           WHERE game_active_sessions.user_id = excluded.user_id
             AND excluded.life_started_at >= game_active_sessions.life_started_at
             AND (game_active_sessions.ended_at IS NULL OR excluded.life_started_at > game_active_sessions.ended_at)`
        )
        .bind(
          u.entryId,
          u.userId,
          r.roomId,
          u.roomCode ? u.roomCode.slice(0, 16) : null,
          u.mode,
          u.mapName === 'large' ? 'large' : 'small',
          serverUrl,
          gameId.slice(0, 80),
          u.ticketId ?? null,
          u.potId ?? null,
          Math.max(0, Math.floor(u.hp)),
          u.isPropHidden ? 1 : 0,
          u.isPropHidden && u.propType ? u.propType.slice(0, 32) : null,
          u.isDisconnected ? 1 : 0,
          Math.floor(u.lifeStartedAt),
          Math.floor(u.lifeStartedAt / 1000),
          now
        )
    );
  }
  // Room heartbeat: every still-open session of this room is fresh (a crashed server stops this)
  stmts.push(db.prepare('UPDATE game_active_sessions SET heartbeat_at = ?1 WHERE room_id = ?2 AND ended_at IS NULL').bind(now, r.roomId));
  return { stmts, upserts: r.upsert.length, ends: r.end.length };
}

/** The user's live character (newest), or null. Live = not ended, room heart-beating, stake still open. */
export async function loadActiveSession(db: D1Database, userId: string, now = nowSec()): Promise<ActiveSessionRow | null> {
  try {
    return await db
      .prepare(
        `SELECT s.entry_id, s.user_id, s.room_id, s.room_code, s.mode, s.map_name, s.server_url, s.hp, s.is_prop_hidden, s.prop_type,
                s.is_disconnected, s.life_started_at, s.entered_at, s.heartbeat_at
           FROM game_active_sessions s
          WHERE s.user_id = ?1 AND s.ended_at IS NULL AND s.heartbeat_at >= ?2
            AND ((s.mode <> 'fast_mini' AND EXISTS (SELECT 1 FROM user_energy_tickets t WHERE t.match_id = s.entry_id AND t.user_id = s.user_id AND t.status = 'in_match'))
              OR (s.mode = 'fast_mini' AND EXISTS (SELECT 1 FROM fast_mini_pots p WHERE p.id = s.entry_id AND p.user_id = s.user_id AND p.status = 'open')))
          ORDER BY s.life_started_at DESC
          LIMIT 1`
      )
      .bind(userId, now - ACTIVE_SESSION_FRESH_SECONDS)
      .first<ActiveSessionRow>();
  } catch {
    return null; // table missing (migration 0024 not applied yet): no persistence info
  }
}

export function toActiveSession(r: ActiveSessionRow): ActiveGameSession {
  return {
    roomId: r.room_id,
    roomCode: r.room_code,
    mode: r.mode,
    mapName: r.map_name === 'large' ? 'large' : 'small',
    serverUrl: r.server_url || '',
    hp: Math.max(0, Number(r.hp) || 0),
    isPropHidden: !!r.is_prop_hidden,
    propType: r.is_prop_hidden ? r.prop_type : null,
    isDisconnected: !!r.is_disconnected,
    enteredAt: Number(r.entered_at) || 0,
    entryId: r.entry_id,
  };
}

/**
 * Daily cron, crash rule: an in_match ticket older than STALE_MATCH_TICKET_SECONDS whose live session row
 * stopped heart-beating (the game server died while the body was alive) goes BACK to available — no outcome
 * happened, so it is neither paid nor forfeited. Tickets without a session row keep the old STALE_FORFEIT rule;
 * tickets whose session still heart-beats (body alive in a running room) are not swept at all.
 */
export async function returnCrashedSessionTickets(env: Env, now = nowSec()): Promise<{ tickets: number; microUsd: number }> {
  let rows: Array<{ id: string; user_id: string; match_id: string; v: number }> = [];
  try {
    rows =
      (
        await env.DB
          .prepare(
            `SELECT t.id, t.user_id, t.match_id, t.backed_micro_usd AS v
               FROM user_energy_tickets t
               JOIN game_active_sessions s ON s.entry_id = t.match_id AND s.user_id = t.user_id
              WHERE t.status = 'in_match' AND t.consumed_at < ?1 AND s.ended_at IS NULL AND s.heartbeat_at < ?2
              LIMIT 500`
          )
          .bind(now - STALE_MATCH_TICKET_SECONDS, now - ACTIVE_SESSION_SWEEP_GRACE_SECONDS)
          .all<{ id: string; user_id: string; match_id: string; v: number }>()
      ).results ?? [];
  } catch {
    return { tickets: 0, microUsd: 0 };
  }
  let tickets = 0;
  let microUsd = 0;
  for (const r of rows) {
    const res = await env.DB.batch([
      env.DB.prepare("UPDATE user_energy_tickets SET status = 'available', match_id = NULL, consumed_at = NULL WHERE id = ?1 AND status = 'in_match'").bind(r.id),
      env.DB.prepare("UPDATE users SET energy_tickets = (SELECT COUNT(*) FROM user_energy_tickets WHERE user_id = ?1 AND status = 'available') WHERE id = ?1").bind(r.user_id),
      env.DB.prepare("UPDATE game_active_sessions SET ended_at = ?2, end_reason = 'stale_return', updated_at = ?3 WHERE entry_id = ?1 AND ended_at IS NULL").bind(r.match_id, now * 1000, now),
    ]);
    if ((res[0].meta?.changes ?? 0) === 1) {
      tickets++;
      microUsd += Math.max(0, Number(r.v) || 0);
      await logFinancialTransaction(env, {
        transaction_id: `tx_tkt_stale_return_${r.id.slice(0, 24)}_${now}`,
        user_id: r.user_id,
        action_type: 'TICKET_RETURN',
        amount_micro_usd: BigInt(Math.max(0, Number(r.v) || 0)),
        balance_after_micro_usd: 0n,
        source_game_id: `stale_return:${r.match_id}`.slice(0, 64),
      });
    }
  }
  return { tickets, microUsd };
}

/** SQL fragment: this ticket's entry still has a heart-beating live session (excluded from the stale forfeit). */
export const LIVE_SESSION_GUARD_SQL = `NOT EXISTS (SELECT 1 FROM game_active_sessions s WHERE s.entry_id = user_energy_tickets.match_id AND s.user_id = user_energy_tickets.user_id AND s.ended_at IS NULL AND s.heartbeat_at >= ?3)`;

/** Daily cron housekeeping: ended / dead rows older than a day are removed (no money is stored here). */
export async function purgeOldSessions(env: Env, now = nowSec()) {
  try {
    await env.DB.prepare('DELETE FROM game_active_sessions WHERE (ended_at IS NOT NULL AND updated_at < ?1) OR heartbeat_at < ?2').bind(now - 86_400, now - 7 * 86_400).run();
  } catch {
    /* table missing */
  }
}
