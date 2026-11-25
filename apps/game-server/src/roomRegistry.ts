/**
 * Admin room registry (D1 `game_server_rooms`, served by the API worker at GET /api/games/rooms-config).
 * Refreshed every 60 s; if the worker is unreachable the last good copy (or the built-in defaults) is used.
 * A room's mode, map, player cap, spectator cap and entry cost always come from here, never from a client.
 */
export interface RegistryRoom {
  roomCode: string;
  nodeId: string | null;
  nodeName?: string | null;
  mode: 'warzone' | 'skirmish' | 'fast_mini' | 'solo_bot';
  engineMode: 'standard_100' | 'mini_30' | 'fast_mini' | 'practice';
  mapSize: 'small' | 'large';
  maxPlayers: number;
  maxSpectators: number;
  entryCostEc: number;
  isActive: boolean;
  gameSlug: string;
}

const DEFAULT_ROOMS: RegistryRoom[] = [
  { roomCode: 'TH-01', nodeId: null, mode: 'warzone', engineMode: 'standard_100', mapSize: 'large', maxPlayers: 100, maxSpectators: 100, entryCostEc: 1, isActive: true, gameSlug: 'fps' },
  { roomCode: 'TH-02', nodeId: null, mode: 'skirmish', engineMode: 'mini_30', mapSize: 'small', maxPlayers: 30, maxSpectators: 50, entryCostEc: 1, isActive: true, gameSlug: 'fps' },
  { roomCode: 'TH-03', nodeId: null, mode: 'fast_mini', engineMode: 'fast_mini', mapSize: 'small', maxPlayers: 16, maxSpectators: 30, entryCostEc: 1, isActive: true, gameSlug: 'fps' },
];

let rooms = new Map<string, RegistryRoom>(DEFAULT_ROOMS.map((r) => [r.roomCode, r]));
let lastOk = 0;

const NODE_ID = () => process.env.NODE_ID || '';

/** This server hosts the room when it is not pinned to another node (NODE_ID may hold the node id or its name). */
export function hostsRoom(r: RegistryRoom): boolean {
  const me = NODE_ID().trim().toLowerCase();
  if (!r.nodeId || !me) return true;
  return r.nodeId.toLowerCase() === me || (r.nodeName || '').trim().toLowerCase() === me;
}

const playable = (r: RegistryRoom) => r.isActive && r.gameSlug === 'fps' && r.engineMode !== 'practice';

/**
 * Rooms this server serves. Safety net: when NODE_ID matches none of the pinned rooms (e.g. the node was
 * renamed), the pinning is ignored so a single-server setup never closes every room.
 */
export function registryRooms(): RegistryRoom[] {
  const all = [...rooms.values()].filter(playable);
  const mine = all.filter(hostsRoom);
  return mine.length ? mine : all;
}

export function getRegistryRoom(code: unknown): RegistryRoom | null {
  if (typeof code !== 'string') return null;
  const want = code.trim().toUpperCase();
  return registryRooms().find((r) => r.roomCode === want) ?? null;
}

export async function refreshRegistry(): Promise<void> {
  // WORKER_API_URL, or API_BASE_URL as written by the 1-click node installer
  const base = (process.env.WORKER_API_URL || process.env.API_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${base}/api/games/rooms-config`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { rooms?: RegistryRoom[] };
    if (!Array.isArray(body.rooms)) throw new Error('bad payload');
    const next = new Map<string, RegistryRoom>();
    for (const r of body.rooms) {
      if (typeof r?.roomCode !== 'string') continue;
      next.set(r.roomCode, {
        ...r,
        maxPlayers: Math.max(2, Math.min(200, Number(r.maxPlayers) || 30)),
        maxSpectators: Math.max(0, Math.min(500, Number(r.maxSpectators) || 0)),
      });
    }
    rooms = next;
    lastOk = Date.now();
  } catch (err) {
    if (Date.now() - lastOk > 5 * 60_000) console.warn('[Game Server] Room registry refresh failed, using last known rooms:', (err as Error).message);
  }
}

export function startRegistryRefresh() {
  refreshRegistry();
  setInterval(refreshRegistry, 60_000).unref?.();
}
