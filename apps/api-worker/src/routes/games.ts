import { Hono } from 'hono';
import type { Context } from 'hono';
import { FPS_ROOMS, SOCIAL_PAGE_SIZE } from '@mwar/shared';
import type { FpsRosterEntry, FpsRoomsResponse, FpsRoomRosterResponse, GamesResponse, FpsRoomLive } from '@mwar/shared';
import type { Env } from '../types';
import { edgeCachedValue } from '../utils/edge-cache';

/**
 * Multi-game hub + XSHOT-style room browser.
 *
 * Live room numbers come from the game server's read-only GET /rooms (RAM only, no D1), fetched at most
 * once per 15 s per Cloudflare colo thanks to caches.default. The only D1 read is the registered-player
 * total, cached for 5 minutes.
 */
export const gamesRouter = new Hono<{ Bindings: Env }>();

interface LiveRoom {
  id: string;
  players: number;
  spectators: number;
  roster: FpsRosterEntry[];
}
export interface LiveSnapshot {
  rooms: LiveRoom[];
  serverOnline: boolean;
  updatedAt: number;
}

const SNAPSHOT_TTL = 15;
const ROSTER_CAP = 120;

interface GameServerRoomsPayload {
  modes?: Record<string, { players?: number; spectators?: number; roster?: Array<Partial<FpsRosterEntry>> }>;
}

export async function getLiveRoomsSnapshot(c: Context<any>): Promise<LiveSnapshot> {
  return edgeCachedValue<LiveSnapshot>(c, 'fps-live-rooms', SNAPSHOT_TTL, async () => {
    const base = ((c.env as Env).GAME_SERVER_HTTP_URL || 'https://game.mwar.win').replace(/\/+$/, '');
    let payload: GameServerRoomsPayload | null = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${base}/rooms`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      clearTimeout(t);
      if (res.ok) payload = (await res.json()) as GameServerRoomsPayload;
    } catch {
      payload = null;
    }
    const rooms: LiveRoom[] = FPS_ROOMS.map((def) => {
      const m = def.multiplayer ? payload?.modes?.[def.mode] : undefined;
      const roster: FpsRosterEntry[] = (m?.roster || []).slice(0, ROSTER_CAP).map((p) => ({
        username: String(p.username || 'Player').slice(0, 24),
        userId: typeof p.userId === 'string' && !p.userId.startsWith('guest_') ? p.userId : null,
        kills: Number(p.kills) || 0,
        deaths: Number(p.deaths) || 0,
        status: p.status === 'dead' || p.status === 'spectating' ? p.status : 'alive',
      }));
      return { id: def.id, players: Math.max(0, Number(m?.players) || 0), spectators: Math.max(0, Number(m?.spectators) || 0), roster };
    });
    return { rooms, serverOnline: !!payload, updatedAt: Date.now() };
  });
}

function toLive(snapshot: LiveSnapshot): FpsRoomLive[] {
  return FPS_ROOMS.map((def) => {
    const live = snapshot.rooms.find((r) => r.id === def.id);
    const players = live?.players ?? 0;
    return {
      ...def,
      rules: [...def.rules],
      players,
      spectators: live?.spectators ?? 0,
      isFull: def.capacity !== null && players >= def.capacity,
    };
  });
}

/** GET /api/games — game directory with Total Players + Online Now (edge-cached 20 s). */
gamesRouter.get('/', async (c) => {
  const data = await edgeCachedValue<GamesResponse>(c, 'games-directory', 20, async () => {
    const [total, snapshot] = await Promise.all([
      edgeCachedValue<number>(c, 'games-total-players', 300, async () => {
        const r = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
        return r?.n || 0;
      }),
      getLiveRoomsSnapshot(c),
    ]);
    const online = snapshot.rooms.reduce((s, r) => s + r.players + r.spectators, 0);
    return {
      games: [
        {
          id: 'fps',
          name: 'MWAR Tactical FPS',
          href: '/games/fps',
          tags: ['3D FPS', 'Play-to-Earn', 'Mobile & PC'],
          totalPlayers: total,
          onlineNow: online,
          live: true,
        },
      ],
      updatedAt: Date.now(),
    };
  });
  return c.json(data);
});

/**
 * GET /api/games/fps/rooms — room list (edge-cached 15 s).
 * GET /api/games/fps/rooms?room=TH-02&cursor=0 — that room's live roster, 10 per page (same snapshot).
 */
gamesRouter.get('/fps/rooms', async (c) => {
  const snapshot = await getLiveRoomsSnapshot(c);
  const roomId = c.req.query('room');
  if (roomId) {
    const live = snapshot.rooms.find((r) => r.id === roomId);
    if (!live) return c.json({ error: 'Room not found' }, 404);
    const start = Math.max(0, Number(c.req.query('cursor')) || 0);
    const items = live.roster.slice(start, start + SOCIAL_PAGE_SIZE);
    const next = start + SOCIAL_PAGE_SIZE < live.roster.length ? String(start + SOCIAL_PAGE_SIZE) : null;
    const body: FpsRoomRosterResponse = { roomId, items, nextCursor: next, total: live.roster.length };
    return c.json(body);
  }
  const body: FpsRoomsResponse = { rooms: toLive(snapshot), serverOnline: snapshot.serverOnline, updatedAt: snapshot.updatedAt };
  return c.json(body);
});
