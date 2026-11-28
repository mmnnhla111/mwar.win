import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  RANK_TIERS,
  STREAMER_MIN_RANK_ID,
  STREAMER_ROOM_MAX_PLAYERS,
  STREAMER_ROOM_MAX_SPECTATORS,
  STREAMER_ROOM_TTL_SECONDS,
  StreamerRoomOpenSchema,
  getRankForDownlines,
  type StreamerStatus,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { edgeCachePurge } from '../utils/edge-cache';
import { GAMES_CACHE_KEYS, roomsCacheKey } from './games';
import { liveConfig } from '../utils/platform-settings';

/**
 * /api/streamer — V1.2 C Streamer Showcase Rooms (spec §7.6 / §8.1: Silver I+). A streamer room is a normal
 * registry room (game_server_rooms, is_streamer_room = 1, code LIVE-XXXXXX) listed in the lobby's
 * "🔴 LIVE สตรีมเมอร์" section, with up to 500 spectators who can chat and send gifts. The streamer earns 30–50 %
 * (default 40 %) of the VERIFIED ad value of spectators watching that room (ad-networks.ts applyVerifiedVisit).
 *   GET    /me              eligibility (rank ≥ Silver I) + the open room
 *   POST   /rooms           { title, mode } open (or return) the streamer's room
 *   DELETE /rooms/:code     close it
 */
type AppEnv = { Bindings: Env; Variables: { user: AuthUserPayload } };
type Ctx = Context<AppEnv>;
export const streamerRouter = new Hono<AppEnv>();
streamerRouter.use('*', authMiddleware);
const nowSec = () => Math.floor(Date.now() / 1000);
const MIN_RANK_INDEX = RANK_TIERS.findIndex((r) => r.id === STREAMER_MIN_RANK_ID);

async function rankOf(env: Env, userId: string) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM network_trees WHERE ancestor_id = ?1 AND depth >= 1').bind(userId).first<{ n: number }>();
  const rank = getRankForDownlines(Number(r?.n ?? 0));
  return { rank, eligible: RANK_TIERS.findIndex((t) => t.id === rank.id) >= MIN_RANK_INDEX };
}

async function openRoom(env: Env, userId: string) {
  return env.DB
    .prepare("SELECT room_code, name, mode, created_at, expires_at FROM game_server_rooms WHERE streamer_user_id = ?1 AND is_streamer_room = 1 AND is_active = 1 AND game_id = 'fps'")
    .bind(userId)
    .first<{ room_code: string; name: string; mode: string; created_at: number; expires_at: number | null }>();
}

async function purge(c: Ctx) {
  await Promise.all([...GAMES_CACHE_KEYS, roomsCacheKey('fps')].map((k) => edgeCachePurge(c, k)));
}

async function statusOf(c: Ctx): Promise<StreamerStatus> {
  const me = c.get('user');
  const [{ rank, eligible }, room, cfg] = await Promise.all([rankOf(c.env, me.userId), openRoom(c.env, me.userId).catch(() => null), liveConfig(c.env)]);
  return {
    eligible,
    rankId: rank.id,
    minRankId: STREAMER_MIN_RANK_ID,
    room: room ? { roomCode: room.room_code, title: room.name, mode: room.mode, createdAt: room.created_at, expiresAt: Number(room.expires_at) || room.created_at + STREAMER_ROOM_TTL_SECONDS } : null,
    sharePct: cfg.streamerSharePct,
  };
}

streamerRouter.get('/me', async (c) => c.json(await statusOf(c)));

const code6 = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => abc[x % abc.length]).join('');
};

streamerRouter.post('/rooms', async (c) => {
  const me = c.get('user');
  const parsed = StreamerRoomOpenSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid room', code: 'INVALID' }, 400);
  const { eligible, rank } = await rankOf(c.env, me.userId);
  if (!eligible) return c.json({ error: 'Streamer Rooms unlock at Silver I', code: 'RANK_TOO_LOW', rankId: rank.id, minRankId: STREAMER_MIN_RANK_ID }, 403);
  const existing = await openRoom(c.env, me.userId);
  if (existing) return c.json({ success: true, existing: true, ...(await statusOf(c)) });
  const t = nowSec();
  const mode = parsed.data.mode;
  const rules = JSON.stringify([`Streamer: ${me.username}`, 'Spectators can chat and send gifts', 'Kill bounty paid on every elimination']);
  for (let attempt = 0; attempt < 4; attempt++) {
    const roomCode = `LIVE-${code6()}`;
    try {
      await c.env.DB
        .prepare(
          `INSERT INTO game_server_rooms (id, game_id, node_id, room_code, name, mode, map_size, max_players, max_spectators, entry_cost_ec, is_active, sort_order, rules, created_at, updated_at, is_streamer_room, streamer_user_id, expires_at)
           VALUES (?1, 'fps', NULL, ?2, ?3, ?4, 'small', ?5, ?6, 1, 1, 5, ?7, ?8, ?8, 1, ?9, ?10)`
        )
        .bind(`fps-${roomCode}`, roomCode, parsed.data.title, mode, mode === 'fast_mini' ? 16 : STREAMER_ROOM_MAX_PLAYERS, STREAMER_ROOM_MAX_SPECTATORS, rules, t, me.userId, t + STREAMER_ROOM_TTL_SECONDS)
        .run();
      await purge(c);
      return c.json({ success: true, ...(await statusOf(c)) });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/idx_game_rooms_streamer_live|streamer_user_id/i.test(msg)) return c.json({ success: true, existing: true, ...(await statusOf(c)) });
      if (!/UNIQUE/i.test(msg)) throw e; // room-code collision: try another code
    }
  }
  return c.json({ error: 'Could not open a room, try again' }, 503);
});

streamerRouter.delete('/rooms/:code', async (c) => {
  const me = c.get('user');
  const code = c.req.param('code').toUpperCase();
  const r = await c.env.DB
    .prepare("UPDATE game_server_rooms SET is_active = 0, updated_at = ?3 WHERE room_code = ?1 AND streamer_user_id = ?2 AND is_streamer_room = 1 AND is_active = 1 AND game_id = 'fps'")
    .bind(code, me.userId, nowSec())
    .run();
  if ((r.meta?.changes ?? 0) !== 1) return c.json({ error: 'Room not found', code: 'NOT_FOUND' }, 404);
  await purge(c);
  return c.json({ success: true, ...(await statusOf(c)) });
});
