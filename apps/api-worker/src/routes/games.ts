import { Hono } from 'hono';
import type { Context } from 'hono';
import { FPS_ROOMS, SOCIAL_PAGE_SIZE, ROOM_MODE_ENGINE, MAP_LABELS, ROOM_MODES, GAME_NODE_FRESH_SECONDS } from '@mwar/shared';
import type {
  FpsRosterEntry,
  FpsRoomsResponse,
  FpsRoomRosterResponse,
  FpsRoomLive,
  GamesResponse,
  GameRecord,
  GameRoomConfig,
  GameDirectoryItem,
  RoomMode,
  RoomsConfigResponse,
  GameStatus,
} from '@mwar/shared';
import type { Env } from '../types';
import { edgeCachedValue } from '../utils/edge-cache';

/**
 * Multi-game hub + XSHOT-style room browser, driven by the admin registry (D1 `games` + `game_server_rooms`).
 *
 * Config reads are edge-cached 20 s (purged on every admin write); live room numbers come from the game
 * server's read-only GET /rooms (RAM only), fetched at most once per 15 s per Cloudflare colo.
 */
export const gamesRouter = new Hono<{ Bindings: Env }>();

/** Edge-cache keys admin writes purge. */
export const GAMES_CACHE_KEYS = ['games-registry', 'games-directory', 'rooms-config', 'fps-live-rooms'];
export const roomsCacheKey = (gameId: string) => `game-rooms:${gameId}`;
const CONFIG_TTL = 20;
const SNAPSHOT_TTL = 15;
const ROSTER_CAP = 120;

// ---------------------------------------------------------------------------
// Registry reads (shared with the admin router)
// ---------------------------------------------------------------------------
const parseList = (v: unknown): string[] => {
  try {
    const a = JSON.parse(String(v || '[]'));
    return Array.isArray(a) ? a.map(String).slice(0, 8) : [];
  } catch {
    return [];
  }
};

export function rowToGame(r: any): GameRecord {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    subtitle: r.subtitle || null,
    description: r.description || null,
    genreTags: parseList(r.genre_tags),
    logoUrl: r.logo_url || null,
    coverUrl: r.cover_url || null,
    routePath: r.route_path,
    status: r.status as GameStatus,
    sortOrder: Number(r.sort_order) || 0,
    updatedAt: Number(r.updated_at) || 0,
  };
}

export function rowToRoom(r: any): GameRoomConfig {
  return {
    id: r.id,
    gameId: r.game_id,
    nodeId: r.node_id || null,
    roomCode: r.room_code,
    name: r.name,
    mode: ((ROOM_MODES as readonly string[]).includes(r.mode) ? r.mode : 'skirmish') as RoomMode,
    mapSize: r.map_size === 'large' ? 'large' : 'small',
    maxPlayers: Number(r.max_players) || 0,
    maxSpectators: Number(r.max_spectators) || 0,
    entryCostEc: Number(r.entry_cost_ec) || 0,
    isActive: !!r.is_active,
    sortOrder: Number(r.sort_order) || 0,
    rules: parseList(r.rules),
    updatedAt: Number(r.updated_at) || 0,
  };
}

/** Built-in rooms, used only until migration 0012 has run. */
const FALLBACK_ROOMS: GameRoomConfig[] = FPS_ROOMS.map((d, i) => ({
  id: `fps-${d.id}`,
  gameId: 'fps',
  nodeId: d.multiplayer ? 'mwar-game-server-1' : null,
  roomCode: d.id,
  name: d.name,
  mode: d.mode === 'standard_100' ? 'warzone' : d.mode === 'mini_30' ? 'skirmish' : d.mode === 'fast_mini' ? 'fast_mini' : 'solo_bot',
  mapSize: d.mapSize,
  maxPlayers: d.capacity ?? 20,
  maxSpectators: d.multiplayer ? 50 : 0,
  entryCostEc: d.costEc,
  isActive: true,
  sortOrder: (i + 1) * 10,
  rules: [...d.rules],
  updatedAt: 0,
}));

export async function loadGames(c: Context<any>): Promise<GameRecord[]> {
  return edgeCachedValue<GameRecord[]>(c, 'games-registry', CONFIG_TTL, async () => {
    try {
      const { results } = await (c.env as Env).DB.prepare('SELECT * FROM games ORDER BY sort_order, title').all<any>();
      return (results || []).map(rowToGame);
    } catch {
      return [
        { id: 'fps', slug: 'fps', title: 'MWAR Tactical FPS', subtitle: null, description: null, genreTags: ['3D FPS', 'Play-to-Earn', 'Mobile & PC'], logoUrl: null, coverUrl: null, routePath: '/games/fps', status: 'active', sortOrder: 0, updatedAt: 0 },
      ];
    }
  });
}

export async function loadRooms(c: Context<any>, gameId: string): Promise<GameRoomConfig[]> {
  return edgeCachedValue<GameRoomConfig[]>(c, roomsCacheKey(gameId), CONFIG_TTL, async () => {
    try {
      const { results } = await (c.env as Env).DB
        .prepare('SELECT * FROM game_server_rooms WHERE game_id = ?1 ORDER BY sort_order, room_code')
        .bind(gameId)
        .all<any>();
      return (results || []).map(rowToRoom);
    } catch {
      return gameId === 'fps' ? FALLBACK_ROOMS : [];
    }
  });
}

// ---------------------------------------------------------------------------
// Live snapshot from the game server
// ---------------------------------------------------------------------------
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

type LiveBucket = { players?: number; spectators?: number; roster?: Array<Partial<FpsRosterEntry>> };
interface GameServerRoomsPayload {
  /** Per configured room code (game servers from this round on). */
  rooms?: Record<string, LiveBucket>;
  /** Per engine mode (older game servers). */
  modes?: Record<string, LiveBucket>;
}

const cleanRoster = (list: Array<Partial<FpsRosterEntry>> | undefined): FpsRosterEntry[] =>
  (list || []).slice(0, ROSTER_CAP).map((p) => ({
    username: String(p.username || 'Player').slice(0, 24),
    userId: typeof p.userId === 'string' && !p.userId.startsWith('guest_') ? p.userId : null,
    kills: Number(p.kills) || 0,
    deaths: Number(p.deaths) || 0,
    status: p.status === 'dead' || p.status === 'spectating' ? p.status : 'alive',
  }));

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
    const configs = (await loadRooms(c, 'fps')).filter((r) => r.isActive);
    const usedModes = new Set<string>();
    const rooms: LiveRoom[] = configs.map((cfg) => {
      let b: LiveBucket | undefined;
      if (cfg.mode !== 'solo_bot') {
        if (payload?.rooms) b = payload.rooms[cfg.roomCode];
        else {
          // Older game server: counts per mode, credited to the first room of that mode only
          const eng = ROOM_MODE_ENGINE[cfg.mode];
          if (!usedModes.has(eng)) {
            usedModes.add(eng);
            b = payload?.modes?.[eng];
          }
        }
      }
      return { id: cfg.roomCode, players: Math.max(0, Number(b?.players) || 0), spectators: Math.max(0, Number(b?.spectators) || 0), roster: cleanRoster(b?.roster) };
    });
    return { rooms, serverOnline: !!payload, updatedAt: Date.now() };
  });
}

/**
 * V1.1 R2: are any Ubuntu game servers up? True when a game node (role 'all' or 'game') sent a heartbeat
 * in the last 90 s (POST /api/nodes/heartbeat writes game_nodes.last_heartbeat = unixepoch()), OR the live
 * GET /rooms health check of the game server answered (edge-cached 15 s). The node lookup is not cached,
 * so a node that stops reporting drops out after 90 s.
 */
export async function freshGameNodeCount(env: Env): Promise<number> {
  try {
    const r = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM game_nodes WHERE role IN ('all', 'game') AND last_heartbeat IS NOT NULL AND unixepoch() - last_heartbeat <= ?1")
      .bind(GAME_NODE_FRESH_SECONDS)
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch {
    return 0; // table missing (very old schema): rely on the live check only
  }
}

export async function gameServersOnline(c: Context<any>, snapshot?: LiveSnapshot): Promise<boolean> {
  const [nodes, snap] = await Promise.all([freshGameNodeCount(c.env as Env), snapshot ? Promise.resolve(snapshot) : getLiveRoomsSnapshot(c)]);
  return nodes > 0 || snap.serverOnline;
}

/** Room list body for the lobby: live PvP rooms are hidden completely (never mocked) while every game server is offline. */
export async function fpsRoomsBody(c: Context<any>): Promise<FpsRoomsResponse> {
  const snapshot = await getLiveRoomsSnapshot(c);
  const online = await gameServersOnline(c, snapshot);
  const configs = (await loadRooms(c, 'fps')).filter((r) => r.isActive);
  const all = configs.map((cfg) => roomToLive(cfg, snapshot.rooms.find((r) => r.id === cfg.roomCode)));
  const liveRooms = online ? all.filter((r) => r.multiplayer) : [];
  const rooms = all.filter((r) => !r.multiplayer || online);
  return { rooms, liveRooms, gameServersOnline: online, serverOnline: online, updatedAt: snapshot.updatedAt };
}

const MODE_LABELS: Record<RoomMode, string> = {
  warzone: 'Warzone',
  skirmish: 'Skirmish',
  fast_mini: 'Fast & Mini',
  solo_bot: 'Solo Bot',
};

export function roomToLive(cfg: GameRoomConfig, live?: LiveRoom): FpsRoomLive {
  const solo = cfg.mode === 'solo_bot';
  const players = live?.players ?? 0;
  return {
    id: cfg.roomCode,
    name: cfg.name,
    mode: ROOM_MODE_ENGINE[cfg.mode],
    modeLabel: solo ? `Solo Bot (${cfg.maxPlayers} Bots)` : `${cfg.maxPlayers}P ${MODE_LABELS[cfg.mode]}`,
    map: MAP_LABELS[cfg.mapSize],
    mapSize: cfg.mapSize,
    capacity: solo ? null : cfg.maxPlayers,
    // V1.1 R2: Fast & Mini is always free (0 EC), whatever the registry row says
    costEc: solo || cfg.mode === 'fast_mini' ? 0 : cfg.entryCostEc,
    multiplayer: !solo,
    rules: cfg.rules,
    maxSpectators: cfg.maxSpectators,
    players,
    spectators: live?.spectators ?? 0,
    isFull: !solo && players >= cfg.maxPlayers,
  };
}

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------

/** GET /api/games — game directory (logo, cover, status, Total Players + Online Now), edge-cached 20 s. */
gamesRouter.get('/', async (c) => {
  const data = await edgeCachedValue<GamesResponse>(c, 'games-directory', CONFIG_TTL, async () => {
    const [games, total, snapshot] = await Promise.all([
      loadGames(c),
      edgeCachedValue<number>(c, 'games-total-players', 300, async () => {
        const r = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
        return r?.n || 0;
      }),
      getLiveRoomsSnapshot(c),
    ]);
    const fpsOnline = snapshot.rooms.reduce((s, r) => s + r.players + r.spectators, 0);
    const items: GameDirectoryItem[] = games.map((g) => ({
      ...g,
      // Only the FPS reports live numbers today; a new game shows its own once its server does
      totalPlayers: g.slug === 'fps' ? total : 0,
      onlineNow: g.slug === 'fps' ? fpsOnline : 0,
    }));
    return { games: items, updatedAt: Date.now() };
  });
  // Server status is read per request (90 s heartbeat window), outside the 20 s directory cache
  return c.json({ ...data, gameServersOnline: await gameServersOnline(c) });
});

/** GET /api/games/rooms-config — room registry for the game servers (no secrets inside). */
gamesRouter.get('/rooms-config', async (c) => {
  const data = await edgeCachedValue<RoomsConfigResponse>(c, 'rooms-config', CONFIG_TTL, async () => {
    const games = await loadGames(c);
    // Node display names too: a server's NODE_ID (written by the installer) may be the id or the name
    const names = new Map<string, string>();
    try {
      const { results } = await c.env.DB.prepare('SELECT id, node_name FROM game_nodes').all<{ id: string; node_name: string }>();
      for (const n of results || []) names.set(n.id, n.node_name);
    } catch {
      /* table missing: ids only */
    }
    const rooms: RoomsConfigResponse['rooms'] = [];
    for (const g of games) {
      for (const r of await loadRooms(c, g.id)) {
        rooms.push({
          roomCode: r.roomCode,
          nodeId: r.nodeId,
          nodeName: r.nodeId ? names.get(r.nodeId) ?? null : null,
          mode: r.mode,
          engineMode: ROOM_MODE_ENGINE[r.mode],
          mapSize: r.mapSize,
          maxPlayers: r.maxPlayers,
          maxSpectators: r.maxSpectators,
          entryCostEc: r.entryCostEc,
          isActive: r.isActive && g.status === 'active',
          gameSlug: g.slug,
        });
      }
    }
    return { rooms, updatedAt: Date.now() };
  });
  return c.json(data);
});

/** GET /api/games/media/:kind/:file — admin-uploaded game logos / covers (R2, immutable names). */
gamesRouter.get('/media/:kind/:file', async (c) => {
  const kind = c.req.param('kind');
  const file = c.req.param('file');
  if ((kind !== 'logos' && kind !== 'covers') || !/^[a-z0-9-]{1,40}\.webp$/.test(file)) return c.json({ error: 'Not found' }, 404);
  const obj = await c.env.MEDIA_BUCKET.get(`games/${kind}/${file}`);
  if (!obj) return c.json({ error: 'Not found' }, 404);
  return new Response(obj.body as any, {
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
});

/**
 * GET /api/games/fps/rooms — active rooms + live counts (config 20 s, live 15 s edge cache).
 * GET /api/games/fps/rooms?room=TH-02&cursor=0 — that room's live roster, 10 per page.
 */
gamesRouter.get('/fps/rooms', async (c) => {
  const roomId = c.req.query('room');
  if (roomId) {
    const snapshot = await getLiveRoomsSnapshot(c);
    const live = snapshot.rooms.find((r) => r.id === roomId);
    if (!live) return c.json({ error: 'Room not found' }, 404);
    const start = Math.max(0, Number(c.req.query('cursor')) || 0);
    const items = live.roster.slice(start, start + SOCIAL_PAGE_SIZE);
    const next = start + SOCIAL_PAGE_SIZE < live.roster.length ? String(start + SOCIAL_PAGE_SIZE) : null;
    const body: FpsRoomRosterResponse = { roomId, items, nextCursor: next, total: live.roster.length };
    return c.json(body);
  }
  return c.json(await fpsRoomsBody(c));
});
