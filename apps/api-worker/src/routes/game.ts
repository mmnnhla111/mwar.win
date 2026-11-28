import { safeEqual } from '../utils/guards';
import { Hono } from 'hono';
import {
  GameBatchPayoutSchema,
  BatchPayoutItemSchema,
  formatMicroUsd,
  EC_COST_PER_PAID_MATCH,
  ROOM_MODE_ENGINE,
  EXP_PER_MATCH,
  EXP_PER_KILL,
  STALE_MATCH_TICKET_SECONDS,
  RESTAKE_REISSUE_SECONDS,
  REJOIN_TOKEN_SECONDS,
} from '@mwar/shared';
import type { ActiveGameSessionResponse } from '@mwar/shared';
import { z } from 'zod';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { applyRewardSplit, claimHeadBounty } from '../utils/reward-split';
import { ledgerClampedDebit, recordDeviceLink } from '../utils/ledger';
import { forfeitStake, isSettleConflict, loadVictimStake, lockEntryTickets, returnUnusedStake, settleStakeStmt, unlockEntryTickets } from '../utils/energy-tickets';
import { closeFastMiniPot, openPotStmt, settleFastMiniKill, type FastMiniKillResult } from '../utils/fast-mini';
import { logFinancialTransaction, walletBalance } from '../utils/audit-logger';
import { trackQuestAction, getUtcDateKey } from './quests';
import { loadRooms, gameServersOnline, fpsRoomsBody } from './games';
import { loadActiveSession, sessionReportStmts, toActiveSession } from '../utils/active-sessions';
import { loadReservation, releaseBossReservation, reserveBossBounty } from '../utils/boss-bounty';
import { loadBotReservation, payHappyHourBonus, releaseBotReservation, reserveBotBounty, BOT_ID_RE } from '../utils/live-economy';
import { liveConfig } from '../utils/platform-settings';
import { SKIN_BY_SLUG } from '@mwar/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 *
 * V1.1 Round 2:
 *  · No entry while every game server is offline (503 GAME_SERVERS_OFFLINE) — no EC is ever locked for
 *    a room that cannot be joined.
 *  · Fast & Mini is free: no ticket, never any EC; a signed token with `fm: 1` + a banner pot (id = eid).
 *  · "Play again (-1 EC)" after a death in a Paid-EC room: `{ roomCode, restakeAfter: <entryId of the
 *    life that just ended> }` locks ONE new ticket for a NEW entry that names the entry it follows (UNIQUE:
 *    one successor per entry → never two tickets for one death). A retry within 120 s gets the same
 *    entry's token back (the game server accepts each eid once), so a lost response never costs twice.
 */
type EnterTokenInput = { mode: string; roomCode: string; entryId: string; ticketIds: string[]; backedMicroUsd: number; restake: boolean };

async function signPaidToken(c: { env: Env }, user: AuthUserPayload, t: EnterTokenInput, now: number) {
  const bountyRow = await c.env.DB.prepare('SELECT bounty_micro_usd FROM wallets WHERE user_id = ?1').bind(user.userId).first<{ bounty_micro_usd: number }>();
  const skins = await equippedSkins(c.env, user.userId);
  return signEntryToken(c.env.INTERNAL_API_SECRET, {
    uid: user.userId,
    un: user.username,
    ws: skins.weapon || undefined, // V1.2 C cosmetic weapon finish (equipped + still owned, from D1)
    os: skins.outfit || undefined, // V1.2 C cosmetic outfit tint
    bty: bountyRow?.bounty_micro_usd ?? 0, // current head bounty (shown in-match, claimed by the killer)
    eid: t.entryId,
    tid: t.ticketIds[0], // ticket row the game server must name when it settles this life
    tv: t.backedMicroUsd, // the ticket's real backed µUSD = what a kill on this player pays
    tn: t.ticketIds.length,
    mode: t.mode,
    rc: t.roomCode || undefined, // the game server only accepts the token in this room
    rs: t.restake ? 1 : undefined, // "Play again" token: only accepted for a dead player of the same account
    exp: now + 120,
  });
}

/** V1.2 C: the slugs of the user's equipped (and still owned) cosmetic skins, for the signed entry token. */
async function equippedSkins(env: Env, userId: string): Promise<{ weapon: string | null; outfit: string | null }> {
  try {
    const r = await env.DB
      .prepare(
        `SELECT (SELECT s.skin_slug FROM user_skins s WHERE s.id = u.equipped_weapon_skin_id AND s.owner_id = u.id) AS w,
                (SELECT s.skin_slug FROM user_skins s WHERE s.id = u.equipped_outfit_skin_id AND s.owner_id = u.id) AS o
         FROM users u WHERE u.id = ?1`
      )
      .bind(userId)
      .first<{ w: string | null; o: string | null }>();
    const ok = (v: string | null | undefined) => (v && SKIN_BY_SLUG[v] ? v : null);
    return { weapon: ok(r?.w), outfit: ok(r?.o) };
  } catch {
    return { weapon: null, outfit: null }; // before migration 0028
  }
}

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
  // Fast & Mini never costs EC (whatever the registry row says)
  if (mode === 'fast_mini') cost = 0;
  const now = Math.floor(Date.now() / 1000);
  // R2: live PvP needs an online game server (heartbeat ≤ 90 s or the live /rooms check)
  if (!(await gameServersOnline(c))) {
    return c.json({ error: 'Live PvP servers are offline right now. Practice mode is still open.', code: 'GAME_SERVERS_OFFLINE' }, 503);
  }
  const ecLeft = async () =>
    Number((await c.env.DB.prepare('SELECT energy_tickets FROM users WHERE id = ?1').bind(user.userId).first<{ energy_tickets: number }>())?.energy_tickets ?? 0);
  const prevId = typeof body?.restakeAfter === 'string' ? body.restakeAfter.slice(0, 64) : '';

  // V1.1 R3: one alive character per account. While a body of this user is still alive in a live room
  // (connected or a disconnected body), a new seat is refused — the client rejoins that body instead (no new
  // EC). "Play again" after that same life's death is not blocked (its session ends with the death report).
  if (cost > 0 || mode === 'fast_mini') {
    const active = await loadActiveSession(c.env.DB, user.userId, now);
    if (active && !(prevId && active.entry_id === prevId)) {
      return c.json(
        { error: 'Your character is still alive in a match — rejoin it first', code: 'ACTIVE_SESSION', session: toActiveSession(active), energyTickets: await ecLeft() },
        409
      );
    }
  }

  if (mode === 'fast_mini') {
    // Free entry + banner pot: kills pay 90 % of the victim's own verified banner value (Worker ledger)
    c.executionCtx.waitUntil(recordDeviceLink(c.env.DB, c.env.JWT_SECRET, user.userId, c.req.header('CF-Connecting-IP')));
    const entryId = crypto.randomUUID();
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO arena_entries (id, user_id, room_mode, created_at, room_code) VALUES (?1, ?2, ?3, ?4, ?5)').bind(entryId, user.userId, mode, now, roomCode || null),
      openPotStmt(c.env, entryId, user.userId, roomCode || null, now),
    ]);
    const fmSkins = await equippedSkins(c.env, user.userId);
    const entryToken = await signEntryToken(c.env.INTERNAL_API_SECRET, { uid: user.userId, un: user.username, bty: 0, eid: entryId, fm: 1, mode, rc: roomCode || undefined, ws: fmSkins.weapon || undefined, os: fmSkins.outfit || undefined, exp: now + 120 });
    return c.json({ success: true, free: true, fastMini: true, entryToken, entryId, potId: entryId, energyTickets: await ecLeft() });
  }
  // Other free room: no EC spent and no entry token, so the match plays without cash payouts
  if (cost <= 0) {
    return c.json({ success: true, free: true, entryToken: null, energyTickets: await ecLeft() });
  }

  if (prevId) {
    const prev = await c.env.DB
      .prepare('SELECT user_id, room_mode, room_code, created_at FROM arena_entries WHERE id = ?1')
      .bind(prevId)
      .first<{ user_id: string; room_mode: string; room_code: string | null; created_at: number }>();
    if (!prev || prev.user_id !== user.userId || prev.room_mode !== mode || (prev.room_code || '') !== roomCode || now - prev.created_at > STALE_MATCH_TICKET_SECONDS) {
      return c.json({ error: 'This round cannot be continued — rejoin from the lobby', code: 'RESTAKE_INVALID' }, 400);
    }
    const next = await c.env.DB.prepare('SELECT id, created_at FROM arena_entries WHERE prev_entry_id = ?1').bind(prevId).first<{ id: string; created_at: number }>();
    if (next) {
      // Idempotent retry: the same successor entry's token again (never a second ticket for one death)
      const rows = await c.env.DB
        .prepare("SELECT id, backed_micro_usd FROM user_energy_tickets WHERE match_id = ?1 AND user_id = ?2 AND status = 'in_match' ORDER BY created_at ASC, id ASC")
        .bind(next.id, user.userId)
        .all<{ id: string; backed_micro_usd: number }>();
      const list = rows.results ?? [];
      if (now - next.created_at <= RESTAKE_REISSUE_SECONDS && list.length > 0) {
        const backed = list.reduce((a, r) => a + Math.max(0, Number(r.backed_micro_usd) || 0), 0);
        const entryToken = await signPaidToken(c, user, { mode, roomCode, entryId: next.id, ticketIds: list.map((r) => r.id), backedMicroUsd: backed, restake: true }, now);
        return c.json({ success: true, reissued: true, restake: true, entryToken, entryId: next.id, energyTickets: await ecLeft(), ticketId: list[0].id, ticketValueMicroUsd: backed });
      }
      return c.json({ error: 'This life was already continued', code: 'ALREADY_RESTAKED' }, 409);
    }
  }

  // Layer 3: remember this account's hashed IP (collusion graph); never blocks the entry
  c.executionCtx.waitUntil(recordDeviceLink(c.env.DB, c.env.JWT_SECRET, user.userId, c.req.header('CF-Connecting-IP')));
  const entryId = crypto.randomUUID();
  if (prevId) {
    // Claim the successor slot FIRST (UNIQUE prev_entry_id): a parallel second request fails here, before any lock
    try {
      await c.env.DB
        .prepare('INSERT INTO arena_entries (id, user_id, room_mode, created_at, room_code, prev_entry_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(entryId, user.userId, mode, now, roomCode || null, prevId)
        .run();
    } catch (e) {
      if (/UNIQUE/i.test(String((e as Error)?.message ?? e))) return c.json({ error: 'This life was already continued', code: 'ALREADY_RESTAKED' }, 409);
      throw e;
    }
  }
  const stake = await lockEntryTickets(c.env, user.userId, cost, entryId, EXP_PER_MATCH);
  if (!stake) {
    // Release the successor slot again so the player can charge EC and retry
    if (prevId) await c.env.DB.prepare('DELETE FROM arena_entries WHERE id = ?1 AND user_id = ?2').bind(entryId, user.userId).run();
    return c.json({ error: 'No Energy Tickets left. Watch an ad or Cheer to recharge EC.', code: 'NO_EC', energyTickets: await ecLeft() }, 402);
  }
  if (!prevId) {
    try {
      await c.env.DB
        .prepare('INSERT INTO arena_entries (id, user_id, room_mode, created_at, room_code) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(entryId, user.userId, mode, now, roomCode || null)
        .run();
    } catch (e) {
      await unlockEntryTickets(c.env, user.userId, entryId);
      throw e;
    }
  }
  // Q_PLAY_MATCH: entering a paid arena round counts as playing a match
  await trackQuestAction(c.env.DB, user.userId, 'finish_game_match', 1).catch(() => {});
  await logFinancialTransaction(c.env, {
    transaction_id: `ec_enter_${entryId.slice(0, 18)}`,
    user_id: user.userId,
    action_type: 'EC_CONSUME',
    amount_micro_usd: BigInt(stake.backedMicroUsd), // the ticket value now at stake in the arena (no wallet change)
    balance_after_micro_usd: await walletBalance(c.env.DB, user.userId),
    source_game_id: `${prevId ? 'restake' : mode}:${entryId}`.slice(0, 64),
  });
  const entryToken = await signPaidToken(c, user, { mode, roomCode, entryId, ticketIds: stake.ticketIds, backedMicroUsd: stake.backedMicroUsd, restake: !!prevId }, now);
  return c.json({
    success: true,
    restake: !!prevId,
    entryToken,
    entryId,
    energyTickets: stake.energyTickets,
    ticketId: stake.ticketIds[0],
    ticketValueMicroUsd: stake.backedMicroUsd,
  });
});

/**
 * GET /api/game/active-session — V1.1 R3: the user's alive character still in a live PvP room (connected or a
 * disconnected body), or `{ session: null }`. Live = the game server reported it in the last 90 s, its life
 * has not ended and its stake is still open (ticket in_match / Fast & Mini pot open) — derived from the
 * money tables, so a settled ticket is never offered for Rejoin.
 * `?rejoin=1` also returns a 120 s HMAC token bound to this user + entry + room id; the game server re-attaches
 * the connection to that existing body (never a new EC ticket, never a second body).
 */
gameRouter.get('/active-session', authMiddleware, async (c) => {
  const user = c.get('user');
  const now = Math.floor(Date.now() / 1000);
  const row = await loadActiveSession(c.env.DB, user.userId, now);
  c.header('Cache-Control', 'no-store');
  if (!row) return c.json<ActiveGameSessionResponse>({ session: null });
  const out: ActiveGameSessionResponse = { session: toActiveSession(row) };
  if (c.req.query('rejoin') === '1') {
    out.rejoinToken = await signEntryToken(c.env.INTERNAL_API_SECRET, {
      uid: user.userId,
      un: user.username,
      eid: row.entry_id,
      rid: row.room_id,
      rj: 1, // rejoin token: never accepted as an entry token (and vice versa)
      exp: now + REJOIN_TOKEN_SECONDS,
    });
  }
  return c.json(out);
});

/** GET /api/game/rooms — same body as GET /api/games/fps/rooms (live PvP rooms hidden while servers are offline). */
gameRouter.get('/rooms', async (c) => c.json(await fpsRoomsBody(c)));

/**
 * POST /api/game/boss-bounty/reserve — V1.2 Golden Boss draw (game server only: INTERNAL_API_SECRET).
 * Body { secret, gameId, roomId, targetUserId, entryId }. The Worker decides the amount (500 C – 2,000 C,
 * capped by the Boss Bounty Pool) and moves it from the pool into a reservation row in one D1 batch; the game
 * server only gets the reservation id + amount to show. Settled by BOSS_BOUNTY_CLAIM / BOSS_BOUNTY_RELEASE items.
 */
gameRouter.post('/boss-bounty/reserve', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({ secret: z.string().optional(), gameId: z.string().min(1).max(80), roomId: z.string().max(80).optional(), targetUserId: z.string().uuid(), entryId: z.string().max(64).optional() })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed' }, 400);
  const secret = parsed.data.secret || c.req.header('X-Internal-Secret');
  if (!safeEqual(secret, c.env.INTERNAL_API_SECRET)) return c.json({ error: 'Unauthorized game server secret' }, 401);
  const r = await reserveBossBounty(c.env, { gameId: parsed.data.gameId, roomId: parsed.data.roomId ?? null, targetUserId: parsed.data.targetUserId, entryId: parsed.data.entryId ?? null });
  return c.json(r);
});

/**
 * GET /api/game/live-config — V1.2 C cold-start state (public): bot fill on/off + target, Happy Hour window
 * (the badge in the lobby / HUD), streamer share and skin market fee. The game server polls it; it decides
 * nothing about money (Happy Hour extras are decided and paid by the Worker at settlement time).
 */
gameRouter.get('/live-config', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await liveConfig(c.env));
});

/**
 * GET /api/game/viewer-token — V1.2 C: a signed-in spectator's identity for the game server (room chat, gift
 * display names). HMAC with INTERNAL_API_SECRET, 120 s, k: 'viewer' — never accepted as an entry / rejoin token.
 */
gameRouter.get('/viewer-token', authMiddleware, async (c) => {
  const user = c.get('user');
  const now = Math.floor(Date.now() / 1000);
  c.header('Cache-Control', 'no-store');
  return c.json({ viewerToken: await signEntryToken(c.env.INTERNAL_API_SECRET, { k: 'viewer', uid: user.userId, un: user.username, exp: now + 120 }) });
});

/**
 * POST /api/game/bot-bounty/reserve — V1.2 C cold-start bot bounty (game server only: INTERNAL_API_SECRET).
 * Body { secret, gameId, roomId, botId }. The Worker picks 10–50 C (only while the Boss Bounty Pool holds ≥ 1,000 C,
 * never more than it holds, per-room live / hourly caps) and moves it into a reservation in one D1 batch.
 * Settled by BOT_BOUNTY_CLAIM (a paid player eliminated the bot) / BOT_BOUNTY_RELEASE (despawn, room closed).
 */
gameRouter.post('/bot-bounty/reserve', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ secret: z.string().optional(), gameId: z.string().min(1).max(80), roomId: z.string().max(80).optional(), botId: z.string().regex(BOT_ID_RE) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed' }, 400);
  const secret = parsed.data.secret || c.req.header('X-Internal-Secret');
  if (!safeEqual(secret, c.env.INTERNAL_API_SECRET)) return c.json({ error: 'Unauthorized game server secret' }, 401);
  return c.json(await reserveBotBounty(c.env, { gameId: parsed.data.gameId, roomId: parsed.data.roomId ?? null, botId: parsed.data.botId }));
});

// Batch Payout Sync Endpoint from Colyseus Game Engine
gameRouter.post('/batch-payout', async (c) => {
  const body = await c.req.json().catch(() => null);

  // Validate the envelope; items are validated one by one so a single bad item (e.g. a guest id)
  // can never poison the whole batch and make the game server re-queue it forever.
  const envelope = z
    .object({ gameId: z.string(), timestamp: z.number(), secret: z.string(), payouts: z.array(z.unknown()), sessions: z.unknown().optional() })
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
  if (!safeEqual(secret, c.env.INTERNAL_API_SECRET)) {
    return c.json({ error: 'Unauthorized game server secret' }, 401);
  }

  // V1.1 R3: the live-session report rides along (applied after this request's payout items, below)
  const sessionReport = envelope.data.sessions;
  if (payouts.length === 0) {
    const s = sessionReport ? sessionReportStmts(c.env.DB, sessionReport, gameId) : null;
    if (s?.stmts.length) await c.env.DB.batch(s.stmts);
    return c.json({ success: true, processedCount: 0, sessionUpserts: s?.upserts ?? 0, sessionEnds: s?.ends ?? 0 });
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
  const v11 = { ticketsSettled: 0, ticketsForfeited: 0, rejectedTicket: 0, duplicates: 0, settledMicroUsd: 0, forfeitedMicroUsd: 0, cappedItems: 0, ticketsReturned: 0 };
  // V1.1 R2 Fast & Mini results (the game server credits the HUD with what the Worker really paid)
  const fastMini: Array<{ pid: string; killerId: string; victimId: string; status: FastMiniKillResult['status']; valueMicroUsd: number; shooterMicroUsd: number; platformMicroUsd: number }> = [];
  const fm = { kills: 0, paidMicroUsd: 0, potsClosed: 0, forfeitedMicroUsd: 0 };
  // V1.2 Golden Boss results (the game server shows what the Worker really paid)
  const boss = { claimed: 0, claimedMicroUsd: 0, released: 0, releasedMicroUsd: 0 };
  const bossResults: Array<{ reservationId: string; killerId: string; victimId: string; amountMicroUsd: number; shooterMicroUsd: number }> = [];
  // V1.2 C cold-start bot bounties + Happy Hour 2x extras (paid from the Boss Bounty Pool, decided here)
  const bot = { claimed: 0, claimedMicroUsd: 0, released: 0, releasedMicroUsd: 0 };
  const botResults: Array<{ reservationId: string; botId: string; killerId: string; amountMicroUsd: number; shooterMicroUsd: number; happyHourMicroUsd: number }> = [];
  const hh = { bonuses: 0, microUsd: 0 };
  const cfg = await liveConfig(c.env);
  const happy = async (userId: string, earnerMicroUsd: number, sourceRef: string, actionType: string) => {
    if (!cfg.happyHour.active || earnerMicroUsd <= 0) return 0;
    const x = await payHappyHourBonus(c.env, { userId, earnerMicroUsd, sourceRef, actionType, gameId, cfg });
    if (x > 0) {
      hh.bonuses++;
      hh.microUsd += x;
      earnerCredited += x;
    }
    return x;
  };
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
    if (item.actionType === 'TICKET_RETURN') {
      // R2: an unused "Play again" ticket (the room could not apply it) → back to available
      // R3 room_shutdown: an alive body's ticket when its room shut down (no outcome) → back to available, entry kept
      // V1.2 C bot_kill: a cold-start bot eliminated this paid seat — bots never earn, so the stake is returned (entry kept)
      const shutdown = md(item).reason === 'room_shutdown' || md(item).reason === 'bot_kill';
      const n = await returnUnusedStake(c.env, md(item).ticketId, item.userId, md(item).entryId, { keepEntry: shutdown, reason: shutdown ? (md(item).reason === 'bot_kill' ? 'bot_kill' : 'shutdown') : undefined });
      if (n > 0) v11.ticketsReturned += n;
      else v11.duplicates++;
      continue;
    }
    if (item.actionType === 'FAST_MINI_KILL') {
      // R2: V = the victim's OWN verified banner pot up to the death (Worker ledger), never item.amountMicroUsd
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
      const r = await settleFastMiniKill(c.env, {
        killerId: item.userId,
        victimId: md(item).victimId,
        potId: md(item).potId,
        diedAtMs: md(item).diedAt,
        pid: md(item).pid,
        gameId,
        hits: num(md(item).hits),
        headshots: num(md(item).headshots),
      });
      if (r.status === 'rejected') v11.rejectedTicket++;
      else if (r.status === 'duplicate') v11.duplicates++;
      else if (r.status === 'paid') {
        fm.kills++;
        fm.paidMicroUsd += r.valueMicroUsd;
        earnerCredited += r.shooterMicroUsd;
        await trackQuestAction(c.env.DB, item.userId, 'finish_game_match', 1, dateKey);
      }
      fastMini.push({ pid: String(md(item).pid ?? ''), killerId: item.userId, victimId: String(md(item).victimId ?? ''), ...r });
      continue;
    }
    if (item.actionType === 'FAST_MINI_CLOSE') {
      const reason = typeof md(item).reason === 'string' ? String(md(item).reason).slice(0, 24) : 'left';
      const got = await closeFastMiniPot(c.env, { potId: md(item).potId, userId: item.userId, reason, ref: gameId });
      if (got < 0) v11.duplicates++;
      else {
        fm.potsClosed++;
        fm.forfeitedMicroUsd += got;
      }
      continue;
    }
    if (item.actionType === 'BOSS_BOUNTY_RELEASE') {
      // V1.2: the Golden Boss reservation ended unclaimed → back to the pool (exactly once)
      const res = await loadReservation(c.env, md(item).reservationId);
      if (!res || res.game_id !== gameId.slice(0, 80)) {
        v11.rejectedTicket++;
        continue;
      }
      const reason = typeof md(item).reason === 'string' ? String(md(item).reason).slice(0, 24) : 'ended';
      const back = await releaseBossReservation(c.env, res.id, reason, now);
      if (back > 0) {
        boss.released++;
        boss.releasedMicroUsd += back;
      } else v11.duplicates++;
      continue;
    }
    if (item.actionType === 'BOSS_BOUNTY_CLAIM') {
      // V1.2: userId eliminated the Golden Boss → the reservation's amount (from D1, never the item's) is paid
      // through 55/15/5/5/20 in ONE batch with the status guard (a reservation that is not 'reserved' any more
      // aborts the batch) — so a reservation is paid at most once and only to a real paid seat
      const res = await loadReservation(c.env, md(item).reservationId);
      const victimId = typeof md(item).victimId === 'string' ? (md(item).victimId as string) : '';
      if (!res || res.game_id !== gameId.slice(0, 80) || res.target_user_id !== victimId || victimId === item.userId) {
        v11.rejectedTicket++;
        continue;
      }
      if (res.status !== 'reserved') {
        v11.duplicates++;
        continue;
      }
      const earnerEntered = await c.env.DB
        .prepare("SELECT 1 AS ok FROM user_energy_tickets WHERE user_id = ?1 AND status IN ('in_match', 'settled') AND consumed_at >= ?2 LIMIT 1")
        .bind(item.userId, now - 86_400)
        .first<{ ok: number }>();
      if (!earnerEntered) {
        // not a paid seat: nobody wins it → the reservation returns to the pool
        await releaseBossReservation(c.env, res.id, 'claim_rejected', now);
        v11.rejectedTicket++;
        continue;
      }
      let split: Awaited<ReturnType<typeof applyRewardSplit>>;
      try {
        split = await applyRewardSplit(c.env, {
          earnerId: item.userId,
          grossMicroUsd: Number(res.amount_micro_usd),
          actionType: 'BOSS_BOUNTY_CLAIM',
          sourceId: `boss:${res.id}`.slice(0, 80),
          dateKey,
          guard: [
            c.env.DB.prepare(
              `UPDATE boss_bounty_reservations SET status = CASE WHEN status = 'reserved' THEN 'claimed' ELSE 'conflict' END,
                     settled_at = ?2, claimed_by_user_id = ?3, settle_ref = ?4
               WHERE id = ?1`
            ).bind(res.id, now, item.userId, typeof md(item).pid === 'string' ? String(md(item).pid).slice(0, 80) : gameId.slice(0, 80)),
          ],
        });
      } catch (e) {
        if (isSettleConflict(e)) {
          v11.duplicates++;
          continue;
        }
        throw e;
      }
      boss.claimed++;
      boss.claimedMicroUsd += Number(res.amount_micro_usd);
      earnerCredited += Number(split.earnerMicroUsd);
      await happy(item.userId, Number(split.earnerMicroUsd), `hh:boss:${res.id}`, 'BOSS_BOUNTY_CLAIM');
      bossResults.push({ reservationId: res.id, killerId: item.userId, victimId, amountMicroUsd: Number(res.amount_micro_usd), shooterMicroUsd: Number(split.earnerMicroUsd) });
      continue;
    }
    if (item.actionType === 'BOT_BOUNTY_RELEASE') {
      // V1.2 C: a cold-start bot despawned / the room closed with its bounty unclaimed → back to the pool, once
      const res = await loadBotReservation(c.env, md(item).reservationId);
      if (!res || res.game_id !== gameId.slice(0, 80)) {
        v11.rejectedTicket++;
        continue;
      }
      const back = await releaseBotReservation(c.env, res.id, typeof md(item).reason === 'string' ? String(md(item).reason).slice(0, 24) : 'despawn', now);
      if (back > 0) {
        bot.released++;
        bot.releasedMicroUsd += back;
      } else v11.duplicates++;
      continue;
    }
    if (item.actionType === 'BOT_BOUNTY_CLAIM') {
      // V1.2 C: userId (a paid seat) eliminated the bot → the reservation amount (from D1, never the item's) is
      // paid 55/15/5/5/20 once, guarded by the status flip (a reservation that is not 'reserved' aborts the batch)
      const res = await loadBotReservation(c.env, md(item).reservationId);
      if (!res || res.game_id !== gameId.slice(0, 80) || res.bot_id !== md(item).botId || !UUID_RE.test(item.userId)) {
        v11.rejectedTicket++;
        continue;
      }
      if (res.status !== 'reserved') {
        v11.duplicates++;
        continue;
      }
      const earnerEntered = await c.env.DB
        .prepare("SELECT 1 AS ok FROM user_energy_tickets WHERE user_id = ?1 AND status IN ('in_match', 'settled') AND consumed_at >= ?2 LIMIT 1")
        .bind(item.userId, now - 86_400)
        .first<{ ok: number }>();
      if (!earnerEntered) {
        await releaseBotReservation(c.env, res.id, 'claim_rejected', now);
        v11.rejectedTicket++;
        continue;
      }
      let split: Awaited<ReturnType<typeof applyRewardSplit>>;
      try {
        split = await applyRewardSplit(c.env, {
          earnerId: item.userId,
          grossMicroUsd: Number(res.amount_micro_usd),
          actionType: 'BOT_BOUNTY_CLAIM',
          sourceId: `botb:${res.id}`.slice(0, 80),
          dateKey,
          guard: [
            c.env.DB.prepare(
              `UPDATE bot_bounty_reservations SET status = CASE WHEN status = 'reserved' THEN 'claimed' ELSE 'conflict' END,
                     settled_at = ?2, claimed_by_user_id = ?3, settle_ref = ?4
               WHERE id = ?1`
            ).bind(res.id, now, item.userId, typeof md(item).pid === 'string' ? String(md(item).pid).slice(0, 80) : gameId.slice(0, 80)),
          ],
        });
      } catch (e) {
        if (isSettleConflict(e)) {
          v11.duplicates++;
          continue;
        }
        throw e;
      }
      bot.claimed++;
      bot.claimedMicroUsd += Number(res.amount_micro_usd);
      earnerCredited += Number(split.earnerMicroUsd);
      const x = await happy(item.userId, Number(split.earnerMicroUsd), `hh:bot:${res.id}`, 'BOT_BOUNTY_CLAIM');
      botResults.push({ reservationId: res.id, botId: res.bot_id, killerId: item.userId, amountMicroUsd: Number(res.amount_micro_usd), shooterMicroUsd: Number(split.earnerMicroUsd), happyHourMicroUsd: x });
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
    // V1.2 C Happy Hour 2x: the extra 55 % share from the Boss Bounty Pool (kills only; the base payout is unchanged)
    if (item.actionType === 'GAME_KILL') await happy(item.userId, Number(split.earnerMicroUsd), `hh:kill:${stake.matchId}:${victimId}`, 'GAME_KILL');
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
  // V1.1 R3: live sessions of this room — after the settlement above, so a death's payout and the end of its
  // session land in the same request (the session also stops counting the moment its ticket is settled)
  const sess = sessionReport ? sessionReportStmts(c.env.DB, sessionReport, gameId, now) : null;
  if (sess?.stmts.length) await c.env.DB.batch(sess.stmts);

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
    fastMini,
    fastMiniKills: fm.kills,
    fastMiniPaidMicroUsd: fm.paidMicroUsd,
    fastMiniPotsClosed: fm.potsClosed,
    fastMiniForfeitedMicroUsd: fm.forfeitedMicroUsd,
    bossClaims: boss.claimed,
    bossClaimedMicroUsd: boss.claimedMicroUsd,
    bossReleases: boss.released,
    bossReleasedMicroUsd: boss.releasedMicroUsd,
    boss: bossResults,
    botClaims: bot.claimed,
    botClaimedMicroUsd: bot.claimedMicroUsd,
    botReleases: bot.released,
    botReleasedMicroUsd: bot.releasedMicroUsd,
    bots: botResults,
    happyHourActive: cfg.happyHour.active,
    happyHourBonuses: hh.bonuses,
    happyHourMicroUsd: hh.microUsd,
    sessionUpserts: sess?.upserts ?? 0,
    sessionEnds: sess?.ends ?? 0,
  });
});
