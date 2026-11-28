import { Room, Client } from 'colyseus';
import crypto from 'crypto';
import Redis from 'ioredis';
import {
  MAP_SPECS,
  GAME_TICK_INTERVAL_MS,
  GAME_BATCH_SYNC_INTERVAL_MS,
  AFK_WARNING_SECONDS,
  AFK_KICK_SECONDS,
  CHEST_LIFETIME_MS,
  HEADSHOT_RATIO_FLAG,
  HEADSHOT_MIN_SAMPLE_HITS,
  CHEST_RATE_SIGMA_LIMIT,
  CHEST_RATE_MIN_SAMPLE_PLAYERS,
  COLLUSION_REPEAT_KILL_LIMIT,
  COLLUSION_WINDOW_MS,
  WEAPON_MIN_SHOT_INTERVAL_MS,
  earnerAndBountyShares,
  mapKindForMode,
  LARGE_MAP_SPAWN_POINTS,
  LARGE_MAP_SIZE,
  SMALL_MAP_SIZE,
  BODY_ONLY_ROOM_TTL_SECONDS,
  CHEST_PAUSE_RADIUS_M,
  CHEST_MAX_AGE_MS,
  WEAPON_RANGE_M,
  KILL_BURST_LIMIT,
  KILL_BURST_WINDOW_MS,
  KILL_MINUTE_LIMIT,
} from '@mwar/shared';
import type { IncomingMessage } from 'http';
import type { BatchPayoutItem } from '@mwar/shared';
import { GameState, PlayerState, ChestState, DroppedWeaponState, MedkitState, clonePlayerState } from '../schema/GameState';
import { getRegistryRoom } from '../roomRegistry';
import { validateShot } from '../ballistics';

/**
 * Load-test harness switch: the legacy "trust the client's hit" rule, so scripted bots that do not aim can
 * still produce kills for payout / settlement checks. Never in production (index.ts refuses to start then).
 */
const RELAXED_BALLISTICS = process.env.MWAR_LOADTEST_TRUST_CLIENT_HITS === '1' && process.env.NODE_ENV !== 'production';

interface RoomOptions {
  mode?: 'mini_30' | 'standard_100' | 'fast_mini';
  /** Room from the admin registry (TH-01, TH-02, …): mode, map and caps come from the registry. */
  roomCode?: string;
  gameId?: string;
  workerApiUrl?: string;
  internalSecret?: string;
}

// 45+ Validated Spawn Coordinates (Streets, Intersections, Plaza, Courtyards & Rooftops)
// Never spawns inside solid walls of the 10 buildings or 20 houses.
export const ARENA_SPAWN_POINTS: Array<{ x: number; y: number; z: number }> = [
  // Central Plaza & Courtyards (Y = 0)
  { x: -6, y: 0, z: -14 },
  { x: 14, y: 0, z: 6 },
  { x: -18, y: 0, z: -18 },
  { x: 18, y: 0, z: -18 },
  { x: -18, y: 0, z: 18 },
  { x: 18, y: 0, z: 18 },
  { x: -2, y: 0, z: -40 },
  { x: 2, y: 0, z: 34 },
  { x: 32, y: 0, z: -2 },
  { x: -30, y: 0, z: 2 },
  { x: -25, y: 0, z: -25 },
  { x: 25, y: 0, z: -25 },
  { x: -25, y: 0, z: 25 },
  { x: 25, y: 0, z: 25 },
  // Street Intersections (x/z in [-60, 0, 60])
  { x: -60, y: 0, z: -60 },
  { x: -60, y: 0, z: 0 },
  { x: -60, y: 0, z: 60 },
  { x: 0, y: 0, z: -60 },
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 60 },
  { x: 60, y: 0, z: -60 },
  { x: 60, y: 0, z: 0 },
  { x: 60, y: 0, z: 60 },
  // Street Lanes & Midpoints
  { x: -60, y: 0, z: -30 },
  { x: -60, y: 0, z: 30 },
  { x: -60, y: 0, z: -90 },
  { x: -60, y: 0, z: 90 },
  { x: 0, y: 0, z: -30 },
  { x: 0, y: 0, z: 30 },
  { x: 0, y: 0, z: -90 },
  { x: 0, y: 0, z: 90 },
  { x: 60, y: 0, z: -30 },
  { x: 60, y: 0, z: 30 },
  { x: 60, y: 0, z: -90 },
  { x: 60, y: 0, z: 90 },
  { x: -30, y: 0, z: -60 },
  { x: 30, y: 0, z: -60 },
  { x: -90, y: 0, z: -60 },
  { x: 90, y: 0, z: -60 },
  { x: -30, y: 0, z: 60 },
  { x: 30, y: 0, z: 60 },
  { x: -90, y: 0, z: 60 },
  { x: 90, y: 0, z: 60 },
  // Rooftop Overwatch Posts
  { x: -41.25, y: 10.5, z: -41.25 },
  { x: 41.25, y: 7.0, z: -78.75 },
  { x: 78.75, y: 10.5, z: 78.75 },
  { x: 18.75, y: 7.0, z: -41.25 },
  { x: -78.75, y: 10.5, z: 41.25 },
  { x: 41.25, y: 10.5, z: 41.25 },
  { x: -78.75, y: 7.0, z: -78.75 },
  { x: -41.25, y: 10.5, z: 78.75 },
  { x: 78.75, y: 7.0, z: -18.75 },
  { x: -18.75, y: 10.5, z: 41.25 },
];

// 12 Outer-Ring Solid Props (vs 8 Inner-Ring Pass-Through Props)
export const SOLID_PROPS = new Set([
  'supply_crate',
  'oil_drum',
  'sandbag_barrier',
  'tire_stack',
  'park_bench',
  'trash_bin',
  'fire_hydrant',
  'potted_tree',
  'wooden_pallet',
  'generator_box',
  'mailbox',
  'ammo_chest',
]);

// Server Weapon Specifications
export const WEAPON_SPECS: Record<
  string,
  { magSize: number; reserve: number; damage: number; headMult: number; range: number }
> = {
  sniper: { magSize: 5, reserve: 20, damage: 92, headMult: 2.5, range: WEAPON_RANGE_M.sniper },
  ak47: { magSize: 30, reserve: 90, damage: 34, headMult: 2.0, range: WEAPON_RANGE_M.ak47 },
  m16: { magSize: 30, reserve: 90, damage: 27, headMult: 2.0, range: WEAPON_RANGE_M.m16 },
  uzi: { magSize: 40, reserve: 160, damage: 17, headMult: 1.6, range: WEAPON_RANGE_M.uzi },
  pistol: { magSize: 15, reserve: 45, damage: 24, headMult: 2.0, range: WEAPON_RANGE_M.pistol },
};

/** Server-only (never synced) per-session data used for payouts and anti-cheat. */
interface SessionMeta {
  /** True only for players who joined with a valid EC entry token from the API worker. */
  paid: boolean;
  ip: string;
  deviceId: string;
  joinedAt: number;
  lastShotAt: number;
  hits: number;
  headshots: number;
  /** Layer 2 flag (headshot ratio / chest rate): rewards for this session are zeroed. */
  flagged: string | null;
  /** Micro-USD already sent (or queued) for this session — clawed back on an AFK kick. */
  earned: number;
  /**
   * V1.1 ticket stake from the signed entry token: the user_energy_tickets row locked for this entry
   * and its real backed µUSD. A kill on this player pays exactly `ticketValue` (once): `ticketLive`
   * turns false when the stake is settled (killed, chest, forfeit) — later deaths pay no ticket value.
   */
  ticketId: string;
  ticketValue: number;
  ticketLive: boolean;
  /** V1.1 R2: this seat entered (or re-entered) a Paid-EC room with a ticket → its deaths need "Play again (-1 EC)". */
  paidSeat: boolean;
  /** Entry id of the life in play (the Worker chains "Play again" entries to it). */
  entryId: string;
  /** V1.1 R2 Fast & Mini: the seat's banner pot id (= its signed entry id), '' for guests. */
  fmPot: string;
  /** ms timestamp of the last death (Fast & Mini: pot credits after it fund the next life). */
  diedAt?: number;
  /**
   * V1.1 R3 live session (reported to the Worker for GET /api/game/active-session + Rejoin): true from the
   * start of an alive Paid-EC / Fast & Mini life until it ends (death / removal / room shutdown).
   */
  sessionLive?: boolean;
  /** ms start of the current life (session key with entryId; a late snapshot never revives an ended life). */
  lifeStartedAt?: number;
  /** Last snapshot sent to the Worker ('' = send again at the next flush). */
  sessionSig?: string;
  lastMoveAt?: number;
  /** H1 kill-rate guard: ms timestamps of this shooter's recent kills. */
  killTimes?: number[];
  /** H1: shots the server refused (range / aim / blocked / kill burst), for logs and the cashout audit. */
  rejectedShots?: number;
}

/** V1.1 R3 session report items (see GameSessionReportSchema in @mwar/shared). */
interface SessionUpsert {
  userId: string;
  entryId: string;
  roomCode: string | null;
  mode: 'mini_30' | 'standard_100' | 'fast_mini';
  mapName: string;
  hp: number;
  isPropHidden: boolean;
  propType: string | null;
  isDisconnected: boolean;
  lifeStartedAt: number;
  ticketId: string | null;
  potId: string | null;
}
interface SessionEnd {
  userId: string;
  entryId: string;
  reason: string;
  endedAt: number;
}

/** A victim's stake taken at death (travels with the kill payout or the death chest). */
interface TicketStake {
  victimId: string;
  victimSession: string;
  ticketId: string;
  value: number;
}

/**
 * Minimum time on the death screen before a FREE "Play again" (Fast & Mini / unpaid seats).
 * V1.1 R2: there is no automatic respawn in any server room any more — Paid-EC seats need a new
 * ticket ("Play again (-1 EC)" → player_restake), everyone else presses "Play again" (player_respawn).
 * Countdown auto-respawn exists only in client-side Practice / Solo Bot mode.
 */
const RESPAWN_DELAY_MS = 3000;
/** Gunshot radar blips are relayed this far (web minimap radius 70 m + 10 m slack). */
const FIRE_BLIP_RELAY_RANGE_M = 80;
const MEDKIT_DROP_CHANCE = 0.2;
const MEDKIT_TTL_MS = 600_000;
const MEDKIT_CAST_MS = 4000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TICKET_ID_RE = /^tkt_[A-Za-z0-9_-]{8,80}$/;

export interface EntryTokenClaims {
  uid: string;
  un: string;
  eid: string;
  bty: number;
  rc: string;
  /** V1.1: first locked ticket row id ('' for a token without a ticket → the seat's death pays nothing). */
  tid: string;
  /** V1.1: the ticket's real backed µUSD (what killing this player pays). */
  tv: number;
  /** V1.1 R2: Fast & Mini seat token (0 EC, no ticket — kills pay the victim's banner pot via the Worker). */
  fm: boolean;
  /** V1.1 R2: "Play again (-1 EC)" token (a new ticket for a dead player of the same account). */
  rs: boolean;
}

/** Verify the HMAC-SHA256 entry token minted by POST /api/game/enter (1 EC spent). */
export function verifyEntryToken(token: unknown, secret: string): EntryTokenClaims | null {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const json = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof json.exp !== 'number' || json.exp < Date.now() / 1000) return null;
    if (typeof json.uid !== 'string' || !UUID_RE.test(json.uid)) return null;
    // V1.1 R3: a Rejoin token is never an entry token (it carries no stake and must not open a new seat)
    if (json.rj !== undefined) return null;
    const bty = Number(json.bty);
    const tv = Number(json.tv);
    const tid = typeof json.tid === 'string' && TICKET_ID_RE.test(json.tid) ? json.tid : '';
    return {
      uid: json.uid,
      un: String(json.un ?? ''),
      eid: String(json.eid ?? ''),
      bty: Number.isFinite(bty) && bty > 0 ? Math.floor(bty) : 0,
      rc: typeof json.rc === 'string' ? json.rc : '',
      tid,
      tv: tid && Number.isFinite(tv) && tv > 0 ? Math.floor(tv) : 0,
      fm: json.fm === 1 || json.fm === true,
      rs: json.rs === 1 || json.rs === true,
    };
  } catch {
    return null;
  }
}

/**
 * V1.1 R3: verify a Rejoin token minted by GET /api/game/active-session?rejoin=1 (HMAC with the shared
 * INTERNAL_API_SECRET, 120 s). It names the account (uid), the life (eid) and the Colyseus room (rid): the
 * connection is re-attached to that existing alive body — never a new seat, never a new EC ticket.
 */
export function verifyRejoinToken(token: unknown, secret: string): { uid: string; eid: string; rid: string; un: string } | null {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const json = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (json.rj !== 1 || typeof json.exp !== 'number' || json.exp < Date.now() / 1000) return null;
    if (typeof json.uid !== 'string' || !UUID_RE.test(json.uid) || typeof json.eid !== 'string' || !json.eid || typeof json.rid !== 'string' || !json.rid) return null;
    return { uid: json.uid, eid: json.eid.slice(0, 64), rid: json.rid, un: String(json.un ?? '') };
  } catch {
    return null;
  }
}

export class ShootingRoom extends Room<GameState> {
  private meta = new Map<string, SessionMeta>();
  /** chestId → (sessionId → damage dealt): the top-damage dealer gets the bounty. */
  private chestDamage = new Map<string, Map<string, number>>();
  /** sessionId → last relayed gunshot time (minimap blip rate limit). */
  private lastFireBlip = new Map<string, number>();
  /** chestId → head bounty of the player whose suicide / environmental death dropped the chest. */
  private chestBounty = new Map<string, { victimId: string; victimSession: string; amount: number; ticketId: string }>();
  /** chestId → ticket stake of the player whose suicide / environmental death dropped the chest. */
  private chestStake = new Map<string, TicketStake>();
  /** chestId → ms of "nobody within 50 m" time left before the chest expires (paused while someone is near). */
  private chestRemaining = new Map<string, number>();
  private lastChestTick = 0;
  /** Unique id per queued payout item (the Worker de-duplicates re-sent batches with it). */
  private payoutSeq = 0;
  /** Head bounty the last elimination moved to the killer (for the victim's death summary). */
  private lastBountyLost = 0;
  /** "killerUserId>victimUserId" → recent kill timestamps (Layer 3 kill-farming check). */
  private pairKills = new Map<string, number[]>();
  private usedEntryIds = new Set<string>();
  private largeMap = false;
  /** V1.1 R2: Fast & Mini (free, banner-pot kills) — no tickets, no head bounty. */
  private fastMini = false;
  /** V1.1 R2: Paid-EC room (Skirmish / Warzone with an entry cost): paid seats re-stake after each death. */
  private paidRoom = true;
  private spawnPoints: Array<{ x: number; y: number; z: number }> = ARENA_SPAWN_POINTS;
  /** sessionId → medkit cast in progress (start time + position; any movement cancels). */
  private medkitCasts = new Map<string, { startedAt: number; x: number; z: number }>();

  maxClients = 30;
  /** Registry room code ('' for the legacy per-mode rooms). */
  private roomCode = '';
  /** Seat caps from the registry (0 = legacy: maxClients only). */
  private maxPlayers = 0;
  private maxSpectators = 0;
  private gameId: string = '';
  private workerApiUrl: string = 'http://127.0.0.1:8787';
  private internalSecret: string = 'local-dev-internal-game-secret-2026';
  private redis?: Redis;
  private pendingPayouts: BatchPayoutItem[] = [];
  /** V1.1 R3: ended lives not yet delivered to the Worker (retried with the payout batch). */
  private pendingSessionEnds: SessionEnd[] = [];
  /** V1.1 R3: client sessionId → body to re-attach (set in onAuth for a valid Rejoin token). */
  private rejoinTargets = new Map<string, { uid: string; eid: string }>();
  private rejoinIps = new Map<string, { ip: string; deviceId: string }>();
  /** V1.1 R3: old body key → new key after a Rejoin moved the body (grenades in flight etc.). */
  private sessionAlias = new Map<string, string>();
  /** V1.1 R3: shuts the room down when only disconnected bodies are left for BODY_ONLY_ROOM_TTL_SECONDS. */
  private bodyOnlyTimer?: { clear: () => void };
  private bodyOnlyTtlMs = BODY_ONLY_ROOM_TTL_SECONDS * 1000;
  private engineMode: 'mini_30' | 'standard_100' | 'fast_mini' = 'mini_30';
  private publicUrl = '';

  onCreate(options: RoomOptions) {
    this.setState(new GameState());

    // Registry rooms: mode, map and seat caps are whatever the admin configured for that room code
    const reg = options.roomCode ? getRegistryRoom(options.roomCode) : null;
    if (options.roomCode && !reg) throw new Error('This room is closed');
    const engineMode = reg ? reg.engineMode : options.mode ?? 'mini_30';
    const modeKey = engineMode === 'standard_100' ? 'STANDARD_100' : 'MINI_30';
    const spec = MAP_SPECS[modeKey] || MAP_SPECS.MINI_30;
    // Default map per mode: 100P Warzone → 960 m large map; 30P Skirmish + Fast & Mini → 240 m small map
    const kind = reg ? reg.mapSize : mapKindForMode(engineMode);
    this.largeMap = kind === 'large';
    this.spawnPoints = this.largeMap ? LARGE_MAP_SPAWN_POINTS : ARENA_SPAWN_POINTS;

    if (reg) {
      this.roomCode = reg.roomCode;
      this.maxPlayers = reg.maxPlayers;
      this.maxSpectators = reg.maxSpectators;
      this.maxClients = reg.maxPlayers + reg.maxSpectators;
    } else {
      this.maxClients = spec.maxPlayers;
    }
    this.fastMini = engineMode === 'fast_mini';
    this.engineMode = engineMode === 'standard_100' ? 'standard_100' : engineMode === 'fast_mini' ? 'fast_mini' : 'mini_30';
    this.paidRoom = !this.fastMini && (reg ? reg.entryCostEc > 0 : true);
    this.setMetadata({ roomCode: this.roomCode, mode: engineMode, mapSize: kind });
    this.state.mapMode = engineMode === 'fast_mini' ? 'fast_mini' : spec.id;
    this.state.mapSizeX = this.largeMap ? LARGE_MAP_SIZE : SMALL_MAP_SIZE;
    this.state.mapSizeZ = this.largeMap ? LARGE_MAP_SIZE : SMALL_MAP_SIZE;
    this.gameId = `game_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    // Never take the API URL or the shared secret from room options: those come from the first
    // client's joinOrCreate() call and would let a player redirect payouts or forge entry tokens.
    this.workerApiUrl = process.env.WORKER_API_URL || 'http://127.0.0.1:8787';
    this.internalSecret = process.env.INTERNAL_API_SECRET || 'local-dev-internal-game-secret-2026';
    // V1.1 R3: public ws(s):// origin shown to the Rejoin popup, and the body-only room lifetime (tests shorten it)
    this.publicUrl = (process.env.GAME_PUBLIC_URL || '').trim();
    const ttl = Number(process.env.BODY_ONLY_ROOM_TTL_SECONDS);
    if (Number.isFinite(ttl) && ttl > 0) this.bodyOnlyTtlMs = ttl * 1000;

    // 1. Connect Local Redis for Room Discovery & Metrics (Non-blocking fallback to RAM)
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl && redisUrl !== 'disabled') {
      try {
        this.redis = new Redis(redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          retryStrategy: () => null,
        });
        this.redis.on('error', () => {
          // Redis offline; game operates seamlessly in pure RAM
        });
        this.redis.connect().catch(() => {});
      } catch {
        // Ignored
      }
    }

    // 2. Client Messages Handling
    this.registerMessageHandlers();

    // 3. Game Tick Loop (20 Hz = 50ms) - Pure RAM processing
    this.setSimulationInterval((deltaTime) => this.update(deltaTime), GAME_TICK_INTERVAL_MS);
    this.setPatchRate(GAME_TICK_INTERVAL_MS);

    // 4. Bounty chests: only spawned on suicide / non-player death
    // 5. Financial Batching Interval (Every 10 Seconds)
    this.clock.setInterval(() => this.flushPayoutBatch(), GAME_BATCH_SYNC_INTERVAL_MS);
  }

  private registerMessageHandlers() {
    // ---- Medkits: walk-over / F pickup, 4 s stationary cast, +40–80 HP (cap 100) ----
    this.onMessage('player_pickup_medkit', (client, data: { medkitId: string }) => {
      const player = this.state.players.get(client.sessionId);
      const kit = data && this.state.medkits.get(String(data.medkitId));
      if (!player || !kit || player.isGhost || player.isSpectator || player.health <= 0) return;
      if (Math.hypot(player.x - kit.x, player.z - kit.z) > 3) return;
      this.state.medkits.delete(kit.id);
      player.medkits += 1;
      this.broadcast('medkit_picked_up', { medkitId: kit.id, sessionId: client.sessionId, count: player.medkits });
    });
    this.onMessage('player_medkit_start', (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.medkits <= 0 || player.health <= 0 || player.health >= 100) return;
      this.medkitCasts.set(client.sessionId, { startedAt: Date.now(), x: player.x, z: player.z });
    });
    this.onMessage('player_medkit_cancel', (client) => {
      this.medkitCasts.delete(client.sessionId);
    });
    this.onMessage('player_medkit_complete', (client) => {
      const player = this.state.players.get(client.sessionId);
      const cast = this.medkitCasts.get(client.sessionId);
      this.medkitCasts.delete(client.sessionId);
      if (!player || !cast || player.medkits <= 0 || player.health <= 0 || player.isGhost) return;
      // Server-validated cast: ≥ 3.8 s elapsed (network slack) and the player stayed put
      if (Date.now() - cast.startedAt < MEDKIT_CAST_MS - 200) return;
      if (Math.hypot(player.x - cast.x, player.z - cast.z) > 0.6) return;
      const heal = 40 + Math.floor(Math.random() * 41);
      player.medkits -= 1;
      player.health = Math.min(100, player.health + heal);
      client.send('medkit_used', { heal, health: player.health, count: player.medkits });
    });

    this.onMessage('ping', (client, data) => {
      client.send('pong', { reply: 'pong', echo: data });
    });

    // Player Movement & Aiming
    this.onMessage('player_move', (client, data: { x: number; y: number; z: number; rotationY?: number; stance?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isSpectator) return;
      // A dead player waiting for the 3 s respawn stays where they fell
      if (player.isGhost) return;

      // Update spatial coordinates (Server-Authoritative bounding to 240m map)
      if (![data.x, data.y, data.z].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
      const halfX = this.state.mapSizeX / 2;
      const halfZ = this.state.mapSizeZ / 2;
      // Anti-teleport: horizontal speed cap (sprint 6.2 m/s + jumps/falls, generous 3× slack)
      const now = Date.now();
      const m = this.meta.get(client.sessionId);
      const last = m ? (m as SessionMeta & { lastMoveAt?: number }).lastMoveAt ?? 0 : 0;
      const dt = Math.max(0.05, Math.min(2, (now - last) / 1000));
      if (last && !player.isGhost && Math.hypot(data.x - player.x, data.z - player.z) > 20 * dt + 1.5) {
        client.send('position_rejected', { x: player.x, y: player.y, z: player.z });
        return;
      }
      if (m) (m as SessionMeta & { lastMoveAt?: number }).lastMoveAt = now;
      player.x = Math.max(-halfX, Math.min(halfX, data.x));
      player.y = Math.max(-5, Math.min(this.largeMap ? 140 : 80, data.y));
      player.z = Math.max(-halfZ, Math.min(halfZ, data.z));
      if (typeof data.rotationY === 'number') {
        player.rotationY = data.rotationY;
      }
      if (data.stance === 'stand' || data.stance === 'crouch' || data.stance === 'prone') {
        player.stance = data.stance;
      }

      // Reset AFK timer
      player.lastActiveTime = Date.now();
      player.afkWarningSent = false;
    });

    // Player Deploy Loadout (Avatar + Primary Weapon)
    this.onMessage('player_deploy', (client, data: { avatarId?: string; primary?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      if (data?.avatarId) player.avatarId = data.avatarId;
      if (data?.primary) {
        player.primaryWeapon = data.primary;
        player.currentWeapon = data.primary;
        const spec = WEAPON_SPECS[data.primary] || WEAPON_SPECS.ak47;
        player.magAmmo = spec.magSize;
        player.reserveAmmo = spec.reserve;
      }
      player.grenadesRemaining = 2;
      player.lastActiveTime = Date.now();

      this.broadcast('player_deployed', {
        sessionId: client.sessionId,
        avatarId: player.avatarId,
        primaryWeapon: player.primaryWeapon,
      });
    });

    // Prop-Hide Disguise Toggle (Turn into wooden crate/barrel)
    this.onMessage('player_toggle_prop', (client, data?: { propType?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isGhost) return;

      player.isProp = !player.isProp;
      if (player.isProp && data?.propType) {
        player.propType = data.propType;
        player.disguisePropId = player.propType;
        player.isPropSolid = SOLID_PROPS.has(player.propType);
      } else {
        player.disguisePropId = '';
        player.isPropSolid = false;
      }
      player.lastActiveTime = Date.now();
      this.broadcast('prop_transformed', {
        sessionId: client.sessionId,
        isProp: player.isProp,
        propType: player.propType,
        isPropSolid: player.isPropSolid,
      });
    });

    // Explicit prop selection from the radial disguise menu (C key)
    this.onMessage('player_set_prop', (client, data: { isProp: boolean; propType?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isGhost) return;
      player.isProp = !!data?.isProp;
      if (player.isProp && typeof data?.propType === 'string') {
        player.propType = data.propType.slice(0, 32);
        player.disguisePropId = player.propType;
        player.isPropSolid = SOLID_PROPS.has(player.propType);
      } else {
        player.disguisePropId = '';
        player.isPropSolid = false;
      }
      player.lastActiveTime = Date.now();
      this.broadcast('prop_transformed', {
        sessionId: client.sessionId,
        isProp: player.isProp,
        propType: player.propType,
        isPropSolid: player.isPropSolid,
      });
    });

    // Drop/Swap Weapon (G Key)
    this.onMessage(
      'player_drop_weapon',
      (client, data: { weaponId: string; magAmmo: number; reserveAmmo: number; x: number; y: number; z: number }) => {
        const player = this.state.players.get(client.sessionId);
        if (!player || player.isGhost) return;

        // EMPTY WEAPON RULE: weapons with 0 total remaining ammo vanish immediately
        if (data.magAmmo <= 0 && data.reserveAmmo <= 0) {
          return;
        }

        this.spawnDroppedWeapon(data.weaponId, data.magAmmo, data.reserveAmmo, data.x, data.y, data.z);
        player.lastActiveTime = Date.now();
      }
    );

    // Pickup Weapon (F Key or Walk-over)
    this.onMessage('player_pickup_weapon', (client, data: { dropId: string; weaponId?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isGhost || player.isProp) return;

      const drop = this.state.droppedWeapons.get(data.dropId);
      if (!drop) return;

      // Update player loadout
      player.currentWeapon = drop.weaponId;
      player.magAmmo = drop.magAmmo;
      player.reserveAmmo = drop.reserveAmmo;
      player.lastActiveTime = Date.now();

      // Remove from world
      this.state.droppedWeapons.delete(data.dropId);
      this.state.activeDroppedWeaponsCount = this.state.droppedWeapons.size;

      this.broadcast('weapon_picked_up', {
        sessionId: client.sessionId,
        dropId: data.dropId,
        weaponId: drop.weaponId,
        magAmmo: drop.magAmmo,
        reserveAmmo: drop.reserveAmmo,
      });
    });

    // Frag Grenade Throw (3s Fuse)
    this.onMessage(
      'player_throw_grenade',
      (client, data: { x: number; y: number; z: number; vx: number; vy: number; vz: number }) => {
        const player = this.state.players.get(client.sessionId);
        if (!player || player.isGhost || player.isProp) return;
        if (player.grenadesRemaining <= 0) return;

        player.grenadesRemaining -= 1;
        player.lastActiveTime = Date.now();

        this.broadcast('grenade_thrown', {
          throwerSessionId: client.sessionId,
          x: data.x,
          y: data.y,
          z: data.z,
          vx: data.vx,
          vy: data.vy,
          vz: data.vz,
        });

        // 3.0-Second Server-Side Fuse Simulation
        this.clock.setTimeout(() => {
          // Estimated landing point after 3 seconds of arc
          const landX = data.x + data.vx * 3.0;
          const landZ = data.z + data.vz * 3.0;
          const landY = Math.max(0, data.y + data.vy * 3.0 - 0.5 * 18 * 9.0);

          this.handleGrenadeExplosion(client.sessionId, landX, landY, landZ);
        }, 3000);
      }
    );

    // Suicide / non-player death (self grenade, falling, environment, /suicide command):
    // The ONLY case that drops a 15-second Bounty Chest.
    this.onMessage('player_suicide', (client, data?: { cause?: string; x?: number; y?: number; z?: number }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isGhost) return;
      this.handlePlayerElimination(player, client.sessionId, undefined, undefined, String(data?.cause ?? 'suicide'));
    });

    // Weapon Shooting & Hit Verification
    this.onMessage(
      'player_shoot',
      (client, data: { targetType: 'player' | 'chest'; targetId: string; damage: number; headshot?: boolean; hit?: { x: number; y: number; z: number }; yaw?: number }) => {
        const shooter = this.state.players.get(client.sessionId);
        if (!shooter || shooter.isGhost || shooter.isProp) return;
        const m = this.meta.get(client.sessionId);
        const now = Date.now();

        // Anti-cheat rate limit: no faster than the equipped weapon can fire (20 % tolerance)
        const weapon = WEAPON_SPECS[shooter.currentWeapon] ? shooter.currentWeapon : 'ak47';
        const minGap = (WEAPON_MIN_SHOT_INTERVAL_MS[weapon] ?? 80) * 0.8;
        if (m && now - m.lastShotAt < minGap) return;
        if (m) m.lastShotAt = now;
        shooter.lastActiveTime = now;
        const spec = WEAPON_SPECS[weapon];

        if (data?.targetType === 'chest') {
          const chest = this.state.chests.get(String(data.targetId));
          if (!chest) return;
          // H1: chests obey the same range / aim / line-of-sight rules as players
          const v = RELAXED_BALLISTICS
            ? { ok: true, distance: 0, reason: undefined }
            : validateShot({ shooter, target: { x: chest.x, y: chest.y, z: chest.z, stance: 'prone' }, weapon, aimYaw: data.yaw, largeMap: this.largeMap });
          if (!v.ok) return this.rejectShot(client, m, String(data.targetId), v.reason ?? 'blocked', v.distance);
          this.handleChestHit(shooter, client, String(data.targetId), Math.min(Math.max(1, Math.round(data.damage || 25)), spec.damage, 100));
          return;
        }
        if (data?.targetType !== 'player') return;
        const target = this.state.players.get(String(data.targetId));
        if (!target || target.isGhost || target.isSpectator || data.targetId === client.sessionId) return;

        // H1 kill-rate guard: an impossible burst of kills → further hits are ignored for a while
        if (m) {
          m.killTimes = (m.killTimes ?? []).filter((t) => now - t < 60_000);
          const burst = m.killTimes.filter((t) => now - t < KILL_BURST_WINDOW_MS).length;
          if (burst >= KILL_BURST_LIMIT || m.killTimes.length >= KILL_MINUTE_LIMIT) return this.rejectShot(client, m, String(data.targetId), 'kill_rate', 0);
        }

        // H1 server-authoritative ballistics: range, aim cone, walls / buildings / terrain, server-side headshot
        // (load-test harness only: MWAR_LOADTEST_TRUST_CLIENT_HITS=1 keeps the legacy trust-the-client rule; refused in production)
        const v = RELAXED_BALLISTICS
          ? { ok: true, headshot: !!data.headshot, distance: 0, reason: undefined }
          : validateShot({ shooter, target, weapon, hit: data.hit, aimYaw: data.yaw, largeMap: this.largeMap });
        if (!v.ok) return this.rejectShot(client, m, String(data.targetId), v.reason ?? 'blocked', v.distance);
        if (typeof data.yaw === 'number' && Number.isFinite(data.yaw)) shooter.rotationY = data.yaw;

        // Damage clamp: never above the weapon's own damage (x head multiplier only for a SERVER headshot)
        const maxDmg = Math.round(spec.damage * (v.headshot ? spec.headMult : 1));
        const damage = Math.min(Math.max(1, Math.round(data.damage || spec.damage)), maxDmg, 100);

        if (m) {
          m.hits += 1;
          if (v.headshot) m.headshots += 1;
          // Layer 2: SERVER-computed headshot ratio > 85 % after enough hits → flag (rewards zeroed)
          if (!m.flagged && m.hits >= HEADSHOT_MIN_SAMPLE_HITS && m.headshots / m.hits > HEADSHOT_RATIO_FLAG) {
            m.flagged = `headshot_ratio_${(m.headshots / m.hits).toFixed(2)}`;
            console.warn(`[AntiCheat L2] ${shooter.id} flagged: ${m.flagged}`);
          }
        }
        this.handlePlayerHit(shooter, client, String(data.targetId), damage);
      }
    );

    // Gunshot radar blip: every shot is relayed (server position, not client-reported) so enemies
    // within radar range see a 2-second red dot on their minimap. Rate-limited per player.
    this.onMessage('player_fired', (client) => {
      const shooter = this.state.players.get(client.sessionId);
      if (!shooter || shooter.isGhost || shooter.isSpectator) return;
      const now = Date.now();
      const last = this.lastFireBlip.get(client.sessionId) ?? 0;
      if (now - last < 400) return;
      this.lastFireBlip.set(client.sessionId, now);
      // Only players whose minimap can show the blip (radius 70 m) get it; spectators always do
      const far: Client[] = [client];
      for (const c of this.clients) {
        if (c === client) continue;
        const p = this.state.players.get(c.sessionId);
        if (p && !p.isSpectator && (p.x - shooter.x) ** 2 + (p.z - shooter.z) ** 2 > FIRE_BLIP_RELAY_RANGE_M ** 2) far.push(c);
      }
      if (far.length < this.clients.length) {
        this.broadcast('player_fired', { sessionId: client.sessionId, x: shooter.x, z: shooter.z }, { except: far });
      }
    });

    // V1.1 R2: FREE "Play again" (Fast & Mini, unpaid / guest seats). A Paid-EC seat must re-stake instead.
    this.onMessage('player_respawn', (client, data: { x: number; y: number; z: number; primary?: string }) => {
      const player = this.state.players.get(client.sessionId);
      const m = this.meta.get(client.sessionId) as (SessionMeta & { lastMoveAt?: number }) | undefined;
      if (!player || player.isSpectator || !player.isGhost || !m?.diedAt || Date.now() - m.diedAt < RESPAWN_DELAY_MS) return;
      if (this.needsRestake(m)) {
        client.send('restake_required', { roomCode: this.roomCode, entryId: m.entryId });
        return;
      }
      void data;
      this.respawnPlayer(client.sessionId, player);
    });

    // V1.1 R2: "Play again (-1 EC)" — the client got a NEW signed ticket token from POST /api/game/enter
    // { restakeAfter }. Same HMAC + single-use eid rules as a join; only for a dead player of the same
    // account in the same room. A token that cannot be applied (already alive) is returned to the Worker.
    this.onMessage('player_restake', (client, data: { entryToken?: string }) => {
      const player = this.state.players.get(client.sessionId);
      const m = this.meta.get(client.sessionId);
      if (!player || !m || player.isSpectator) return;
      const entry = verifyEntryToken(data?.entryToken, this.internalSecret);
      const fail = (reason: string) => client.send('restake_result', { ok: false, reason });
      if (!entry || !entry.tid || entry.fm || this.fastMini || entry.rc !== this.roomCode) return fail('invalid_token');
      if (entry.uid !== player.id || !UUID_RE.test(player.id)) return fail('wrong_account');
      if (this.usedEntryIds.has(entry.eid)) return fail('used_token');
      this.usedEntryIds.add(entry.eid);
      if (!player.isGhost || m.ticketLive) {
        // Already alive / still staked: this ticket was never at stake → back to available
        this.pendingPayouts.push({ userId: player.id, amountMicroUsd: 0, actionType: 'TICKET_RETURN', gameId: this.gameId, metadata: { ticketId: entry.tid, entryId: entry.eid, reason: 'not_dead', pid: this.nextPid() } });
        return fail('not_dead');
      }
      m.paid = true;
      m.paidSeat = true;
      m.entryId = entry.eid;
      m.ticketId = entry.tid;
      m.ticketValue = entry.tv;
      m.ticketLive = true;
      player.ticketMicroUsd = entry.tv;
      this.respawnPlayer(client.sessionId, player);
      client.send('restake_result', { ok: true, entryId: entry.eid, ticketMicroUsd: entry.tv });
    });

    // Anti-AFK Captcha Verification Response
    this.onMessage('afk_captcha_solved', (client) => {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.lastActiveTime = Date.now();
        player.afkWarningSent = false;
        client.send('afk_cleared', { success: true });
      }
    });
  }

  private handleGrenadeExplosion(throwerSessionId: string, x: number, y: number, z: number) {
    const BLAST_RADIUS = 7.5;
    const MAX_DAMAGE = 130;

    this.broadcast('grenade_exploded', { x, y, z, radius: BLAST_RADIUS });

    this.state.players.forEach((target, targetSessionId) => {
      if (target.isGhost) return;
      const dist = Math.hypot(target.x - x, target.z - z);
      if (dist <= BLAST_RADIUS) {
        const falloff = 1 - dist / BLAST_RADIUS;
        const damage = Math.round(MAX_DAMAGE * falloff);

        target.health = Math.max(0, target.health - damage);

        if (target.health === 0) {
          // V1.1 R3: the thrower may have rejoined meanwhile (body moved to a new key)
          const tsid = this.sessionAlias.get(throwerSessionId) ?? throwerSessionId;
          const isSelf = targetSessionId === tsid;
          const thrower = this.state.players.get(tsid);
          if (isSelf || !thrower) {
            this.handlePlayerElimination(target, targetSessionId, undefined, undefined, 'grenade_suicide');
          } else {
            this.handlePlayerElimination(target, targetSessionId, thrower, tsid);
          }
        } else {
          this.broadcast('player_damaged', {
            targetSessionId,
            newHealth: target.health,
            damage,
          });
        }
      }
    });
  }

  /** H1: the server refused a hit — the shooter sees 0 damage (no health change, nothing paid). */
  private rejectShot(client: Client, m: SessionMeta | undefined, targetId: string, reason: string, distance: number) {
    if (m) m.rejectedShots = (m.rejectedShots ?? 0) + 1;
    const target = this.state.players.get(targetId);
    client.send('player_damaged', { targetSessionId: targetId, newHealth: target?.health ?? 0, damage: 0, rejected: reason });
    if (m && (m.rejectedShots ?? 0) % 50 === 1) console.warn(`[AntiCheat H1] shot refused (${reason}, ${distance.toFixed(1)} m) - ${m.rejectedShots} refused this session`);
  }

  private handlePlayerHit(shooter: PlayerState, shooterClient: Client, targetSessionId: string, damage: number) {
    const target = this.state.players.get(targetSessionId);
    if (!target || target.isGhost || targetSessionId === shooterClient.sessionId) return;
    void shooter; // line of sight (solid stairs included) is checked by validateShot before this point

    // Break prop disguise on damage
    if (target.isProp) {
      target.isProp = false;
      target.disguisePropId = '';
    }

    target.health = Math.max(0, target.health - damage);

    if (target.health === 0) {
      this.handlePlayerElimination(target, targetSessionId, shooter, shooterClient.sessionId);
    } else {
      // Only the victim and the shooter need the hit event (everyone else gets the new health from the
      // 20 Hz state patch). A room-wide broadcast here was ~100k WebSocket sends/s at 1,000 players.
      const msg = { targetSessionId, newHealth: target.health, damage };
      shooterClient.send('player_damaged', msg);
      this.clients.find((c) => c.sessionId === targetSessionId)?.send('player_damaged', msg);
    }
  }

  private handlePlayerElimination(
    target: PlayerState,
    targetSessionId: string,
    killer?: PlayerState,
    killerSessionId?: string,
    suicideCause?: string
  ) {
    target.isProp = false;
    target.health = 0;
    target.isGhost = true;
    target.deaths += 1;
    const tm = this.meta.get(targetSessionId);
    // What this life carried (ticket value still at stake) — shown on the victim's death summary
    const stakeHeldMicroUsd = tm && tm.ticketLive ? Math.max(0, tm.ticketValue) : 0;
    if (tm) tm.diedAt = Date.now();
    // V1.1 R3: the life is over → its live session ends now (delivered with this death's settlement items)
    this.endSession(targetSessionId, 'died');
    this.medkitCasts.delete(targetSessionId);
    // Any death: 20 % chance to drop a medkit (10-minute despawn)
    if (Math.random() < MEDKIT_DROP_CHANCE) this.spawnMedkit(target.x + 0.5, target.y, target.z - 0.3);

    // Drop carried weapon on death with 5-minute despawn (if it has ammo)
    if (target.magAmmo > 0 || target.reserveAmmo > 0) {
      this.spawnDroppedWeapon(
        target.currentWeapon || target.primaryWeapon || 'ak47',
        target.magAmmo,
        target.reserveAmmo,
        target.x,
        target.y,
        target.z
      );
    }

    if (killer && killerSessionId && killerSessionId !== targetSessionId) {
      // 1. Weapon/Combat Kill by another player:
      // Kills by another player do NOT drop a Bounty Chest!
      killer.kills += 1;
      const km0 = this.meta.get(killerSessionId);
      if (km0) (km0.killTimes ??= []).push(Date.now());
      const collusion = this.isCollusionKill(killerSessionId, targetSessionId, killer, target);
      if (collusion) console.warn(`[AntiCheat L3] kill ${killer.id} -> ${target.id} pays 0 (${collusion})`);
      // V1.1: the kill is worth exactly the victim's live ticket value (real ad backing), never a constant
      const stake = this.takeStake(targetSessionId, target);
      let killReward = 0;
      // V1.1 R2 Fast & Mini: the Worker pays 90 % of the victim's own verified banner pot (amount decided there)
      const fastMiniQueued = this.fastMini && !collusion ? this.queueFastMiniKill(killerSessionId, killer, targetSessionId, target) : false;
      if (stake && !collusion) {
        killReward = this.queuePayout(killerSessionId, killer, stake.value, 'GAME_KILL', {
          victimId: target.id,
          victimSession: targetSessionId,
          ticketId: stake.ticketId,
        });
      }
      // Collusion kill / unpaid or flagged killer / 0-value ticket: the stake goes to the platform
      if (stake && !this.stakeQueued(stake.ticketId)) this.queueTicketForfeit(stake, collusion ? 'collusion' : 'unpaid_kill');
      // The killer claims the victim's whole accumulated head bounty (never on a collusion kill)
      const vm = this.meta.get(targetSessionId);
      // (Fast & Mini has no head bounty: 0 %)
      const bountyClaimed = collusion || this.fastMini ? 0 : this.queueBountyClaim(killerSessionId, killer, target.bountyMicroUsd, target.id, vm?.ticketId ?? '');
      if (bountyClaimed > 0) target.bountyMicroUsd = 0;
      this.lastBountyLost = bountyClaimed;

      this.broadcast('player_killed', {
        killerId: killer.id,
        killerUsername: killer.username,
        victimId: target.id,
        victimUsername: target.username,
        rewardMicroUsd: killReward + bountyClaimed,
        bountyClaimedMicroUsd: bountyClaimed,
        /** The victim's ticket value V that was split 55/15/5/5/20 (0 = no live ticket). */
        ticketMicroUsd: stake && this.stakeQueued(stake.ticketId) ? stake.value : 0,
        /** Fast & Mini: the victim's banner pot is settled by the Worker (fast_mini_reward follows). */
        fastMini: fastMiniQueued,
      });
    } else {
      // 2. Suicide / Non-Player death:
      // Spawns 15-second Bounty Chest!
      this.spawnDeathChest(target.x, target.y, target.z, target, targetSessionId);
      this.broadcast('player_suicide', {
        victimUsername: target.username,
        cause: suicideCause || 'environment_hazard',
      });
    }

    // Notify the victim: V1.1 R2 death & round summary — no automatic respawn in any server room
    const victimClient = this.clients.find((c) => c.sessionId === targetSessionId);
    if (victimClient) {
      victimClient.send('player_eliminated', {
        killerUsername: killer?.username ?? null,
        respawnInMs: RESPAWN_DELAY_MS,
        /** 'restake' = Paid-EC seat: "Play again (-1 EC)" / lobby · 'free' = Fast & Mini / unpaid: "Play again" free */
        respawnMode: tm && this.needsRestake(tm) ? 'restake' : 'free',
        fastMini: this.fastMini,
        roomCode: this.roomCode,
        entryId: tm?.entryId ?? '',
        kills: target.kills,
        deaths: target.deaths,
        sessionEarningsMicroUsd: target.sessionEarningsMicroUsd,
        bountyMicroUsd: target.bountyMicroUsd,
        bountyLostMicroUsd: killer && killerSessionId !== targetSessionId ? Math.max(0, this.lastBountyLost) : 0,
        /** Ticket value this life held (taken by the killer's 55/15/5/5/20 split, or dropped in the chest). */
        stakeLostMicroUsd: stakeHeldMicroUsd,
      });
    }
    this.lastBountyLost = 0;
    // V1.1 R3: a disconnected body that died is removed shortly after (its owner is not there to choose
    // "Play again"); the settlement above already happened exactly like a live kill
    if (target.isDisconnected) {
      this.clock.setTimeout(() => {
        const p = this.state.players.get(targetSessionId);
        if (p && p.isDisconnected && p.isGhost) this.removeSeat(targetSessionId, p, 'died_away');
      }, 2000);
    }
  }

  private handleChestHit(shooter: PlayerState, shooterClient: Client, chestId: string, damage: number) {
    const chest = this.state.chests.get(chestId);
    if (!chest) return;

    const dealt = Math.min(damage, chest.health);
    chest.health = Math.max(0, chest.health - damage);
    const byPlayer = this.chestDamage.get(chestId) ?? new Map<string, number>();
    byPlayer.set(shooterClient.sessionId, (byPlayer.get(shooterClient.sessionId) ?? 0) + dealt);
    this.chestDamage.set(chestId, byPlayer);

    if (chest.health === 0) {
      // Spec 5.2: the reward goes to whoever dealt the MOST damage to the chest (not the last hit)
      let topSession = shooterClient.sessionId;
      let topDamage = -1;
      byPlayer.forEach((d, sid) => {
        if (d > topDamage && this.state.players.has(sid)) {
          topDamage = d;
          topSession = sid;
        }
      });
      const winner = this.state.players.get(topSession) ?? shooter;
      this.chestDamage.delete(chestId);
      this.chestRemaining.delete(chestId);
      this.state.chests.delete(chestId);
      this.state.activeChestsCount = this.state.chests.size;

      // Layer 2: chest-collect rate above room mean + 3σ → chest destroyed with no reward, account marked
      let reward = 0;
      // V1.1: the chest holds the dead player's ticket stake (its real backed value) — nothing else
      const stake = this.chestStake.get(chestId);
      this.chestStake.delete(chestId);
      if (this.chestRateAnomalous(topSession)) {
        const m = this.meta.get(topSession);
        if (m) m.flagged = m.flagged ?? 'chest_rate_3sigma';
        console.warn(`[AntiCheat L2] ${winner.id} chest rate > mean+3σ — chest voided`);
      } else {
        winner.chestsCollected += 1;
        // Opening your own suicide chest never turns your own ticket into cash
        if (stake && stake.victimId !== winner.id) {
          reward = this.queuePayout(topSession, winner, stake.value, 'CHEST_OPEN', {
            chestId,
            isDeathDrop: chest.isDeathDrop,
            topDamage,
            victimId: stake.victimId,
            ticketId: stake.ticketId,
          });
        }
        const cb = this.chestBounty.get(chestId);
        if (cb && cb.victimId !== winner.id) {
          const got = this.queueBountyClaim(topSession, winner, cb.amount, cb.victimId, cb.ticketId);
          if (got > 0) {
            reward += got;
            this.chestBounty.delete(chestId);
          }
        }
      }
      // Voided chest / own chest / unpaid opener: the stake goes to the platform
      if (stake && !this.stakeQueued(stake.ticketId)) this.queueTicketForfeit(stake, 'chest_unclaimed');
      this.returnChestBounty(chestId);

      this.broadcast('chest_destroyed', {
        chestId,
        collectedByUsername: winner.username,
        rewardMicroUsd: reward,
      });
    }
  }

  private spawnDeathChest(x: number, y: number, z: number, victim?: PlayerState, victimSession?: string) {
    const chestId = `death_chest_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    // The dead player's head bounty drops into their chest (claimed by whoever opens it)
    if (victim && victimSession && victim.bountyMicroUsd > 0 && UUID_RE.test(victim.id)) {
      const vm = this.meta.get(victimSession);
      if (vm?.ticketId) {
        this.chestBounty.set(chestId, { victimId: victim.id, victimSession, amount: victim.bountyMicroUsd, ticketId: vm.ticketId });
        victim.bountyMicroUsd = 0;
      }
    }
    // V1.1: ... and so does their live ticket stake (the chest's only cash value)
    const stake = victim && victimSession ? this.takeStake(victimSession, victim) : null;
    if (stake) this.chestStake.set(chestId, stake);
    const chest = new ChestState();
    chest.id = chestId;
    chest.x = Math.round(x);
    chest.y = Math.round(y);
    chest.z = Math.round(z);
    chest.health = 30; // Easier to break
    chest.rewardMicroUsd = stake?.value ?? 0; // the dead player's ticket value (0 = no live paid ticket)
    chest.isDeathDrop = true;
    chest.bountyMicroUsd = this.chestBounty.get(chestId)?.amount ?? 0;
    chest.spawnedAt = Date.now();
    // 30 minutes of "nobody within 50 m" time; the countdown pauses while anyone alive is near (update())
    chest.expiresAt = Date.now() + CHEST_LIFETIME_MS;
    this.chestRemaining.set(chestId, CHEST_LIFETIME_MS);

    this.state.chests.set(chestId, chest);
    this.state.activeChestsCount = this.state.chests.size;

    this.broadcast('chest_spawned', {
      id: chest.id,
      x: chest.x,
      y: chest.y,
      z: chest.z,
      rewardMicroUsd: chest.rewardMicroUsd,
      bountyMicroUsd: chest.bountyMicroUsd,
      isDeathDrop: true,
      expiresAt: chest.expiresAt,
    });
  }

  private spawnMedkit(x: number, y: number, z: number) {
    const kit = new MedkitState();
    kit.id = `medkit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    kit.x = Math.round(x * 100) / 100;
    kit.y = Math.round(y * 100) / 100;
    kit.z = Math.round(z * 100) / 100;
    kit.expiresAt = Date.now() + MEDKIT_TTL_MS;
    this.state.medkits.set(kit.id, kit);
    this.broadcast('medkit_spawned', { medkitId: kit.id, x: kit.x, y: kit.y, z: kit.z, expiresAt: kit.expiresAt });
  }

  private spawnDroppedWeapon(weaponId: string, magAmmo: number, reserveAmmo: number, x: number, y: number, z: number) {
    if (magAmmo <= 0 && reserveAmmo <= 0) return; // Empty weapon rule

    const dropId = `drop_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const drop = new DroppedWeaponState();
    drop.id = dropId;
    drop.weaponId = weaponId;
    drop.magAmmo = magAmmo;
    drop.reserveAmmo = reserveAmmo;
    drop.x = Math.round(x * 100) / 100;
    drop.y = Math.round(y * 100) / 100;
    drop.z = Math.round(z * 100) / 100;
    drop.droppedAt = Date.now();
    drop.expiresAt = Date.now() + 300_000; // 5-minute (300s) despawn timer

    this.state.droppedWeapons.set(dropId, drop);
    this.state.activeDroppedWeaponsCount = this.state.droppedWeapons.size;

    this.broadcast('weapon_dropped', {
      dropId: drop.id,
      weaponId: drop.weaponId,
      magAmmo: drop.magAmmo,
      reserveAmmo: drop.reserveAmmo,
      x: drop.x,
      y: drop.y,
      z: drop.z,
      expiresAt: drop.expiresAt,
    });
  }

  /** Spawn point far from every living combatant (and from where this player just died). */
  private pickRespawnPoint(self: PlayerState) {
    let best = this.spawnPoints[0];
    let bestScore = -1;
    for (const point of this.spawnPoints) {
      let minDist = Infinity;
      this.state.players.forEach((other) => {
        if (other === self || other.isGhost || other.isSpectator) return;
        minDist = Math.min(minDist, Math.hypot(other.x - point.x, other.z - point.z));
      });
      const fromDeath = Math.hypot(self.x - point.x, self.z - point.z);
      const score = Math.min(minDist, 200) + Math.min(fromDeath, 60) * 0.5 + Math.random() * 8;
      if (score > bestScore) {
        bestScore = score;
        best = point;
      }
    }
    return best;
  }

  /** Clean respawn: full HP, fresh starting ammo, new spawn point — synced to every client. */
  private respawnPlayer(sessionId: string, player: PlayerState) {
    const m = this.meta.get(sessionId) as (SessionMeta & { lastMoveAt?: number }) | undefined;
    const point = this.pickRespawnPoint(player);
    player.x = point.x;
    player.y = point.y;
    player.z = point.z;
    player.health = 100;
    player.isGhost = false;
    player.isProp = false;
    player.stance = 'stand';
    const primary = WEAPON_SPECS[player.primaryWeapon] ? player.primaryWeapon : 'ak47';
    const spec = WEAPON_SPECS[primary];
    player.primaryWeapon = primary;
    player.currentWeapon = primary;
    player.magAmmo = spec.magSize;
    player.reserveAmmo = spec.reserve;
    player.grenadesRemaining = 2;
    player.lastActiveTime = Date.now();
    if (m) {
      m.diedAt = undefined;
      m.lastMoveAt = Date.now();
    }
    this.startSession(sessionId, player);
    const client = this.clients.find((c) => c.sessionId === sessionId);
    client?.send('player_respawned', { x: point.x, y: point.y, z: point.z, primary });
  }

  // Update Game Loop (20 Hz)
  private update(deltaTime: number) {
    const now = Date.now();

    // 1. Death bounty chests: 30 min countdown that only runs while nobody alive is within 50 m
    const chestDt = this.lastChestTick ? Math.min(1000, now - this.lastChestTick) : 0;
    this.lastChestTick = now;
    this.state.chests.forEach((chest, id) => {
      if (!chest.isDeathDrop) return;
      let left = this.chestRemaining.get(id) ?? Math.max(0, chest.expiresAt - now);
      let near = false;
      this.state.players.forEach((p) => {
        if (near || p.isGhost || p.isSpectator || p.isDisconnected) return;
        if ((p.x - chest.x) ** 2 + (p.z - chest.z) ** 2 <= CHEST_PAUSE_RADIUS_M ** 2) near = true;
      });
      if (!near) left -= chestDt;
      this.chestRemaining.set(id, left);
      if (near !== chest.timerPaused) chest.timerPaused = near;
      // Keep expiresAt meaningful for clients: a paused chest's deadline slides forward (synced at most 1x/s)
      const shown = now + Math.max(0, left);
      if (Math.abs(shown - chest.expiresAt) > 1000) chest.expiresAt = shown;
      if (left <= 0 || now - chest.spawnedAt >= CHEST_MAX_AGE_MS) {
        this.state.chests.delete(id);
        this.chestRemaining.delete(id);
        this.chestDamage.delete(id);
        this.returnChestBounty(id);
        const stake = this.chestStake.get(id);
        this.chestStake.delete(id);
        if (stake) this.queueTicketForfeit(stake, 'chest_expired');
        this.broadcast('chest_expired', { chestId: id });
      }
    });

    // 2. Expire 5-minute dropped weapons
    this.state.droppedWeapons.forEach((drop, id) => {
      if (drop.expiresAt > 0 && now >= drop.expiresAt) {
        this.state.droppedWeapons.delete(id);
        this.broadcast('weapon_expired', { dropId: id });
      }
    });

    // 2b. Expire 10-minute medkits; cancel casts when the player moved
    this.state.medkits.forEach((kit, id) => {
      if (now >= kit.expiresAt) {
        this.state.medkits.delete(id);
        this.broadcast('medkit_expired', { medkitId: id });
      }
    });
    this.medkitCasts.forEach((cast, sid) => {
      const p = this.state.players.get(sid);
      if (!p || Math.hypot(p.x - cast.x, p.z - cast.z) > 0.6) this.medkitCasts.delete(sid);
    });
    this.state.activeDroppedWeaponsCount = this.state.droppedWeapons.size;

    // 3. Anti-AFK Detection Check
    // (V1.1 R2: no automatic respawn — dead players wait on the death & round summary until they choose)

    this.state.players.forEach((player, sessionId) => {
      if (player.isSpectator) return; // spectators are never AFK-kicked by combat rules
      // V1.1 R3: a disconnected body is never AFK-kicked (it stays killable until it dies / the room shuts down);
      // its away time does not count — the AFK clock restarts on Rejoin
      if (player.isDisconnected) return;
      const inactiveSec = (now - player.lastActiveTime) / 1000;

      // 5-Minute Inactive Rule: Warning & Captcha
      if (inactiveSec >= AFK_WARNING_SECONDS && !player.afkWarningSent) {
        player.afkWarningSent = true;
        const client = this.clients.find((c) => c.sessionId === sessionId);
        if (client) {
          client.send('afk_warning', {
            message: 'You have been inactive for 5 minutes. Please complete the quick verification to remain in the game.',
          });
        }
      }

      // 30-Minute Inactive Rule: Auto-Kick & Forfeit
      if (inactiveSec >= AFK_KICK_SECONDS) {
        const client = this.clients.find((c) => c.sessionId === sessionId);
        if (client && !player.afkKicked) {
          player.afkKicked = true;
          this.forfeitRoundEarnings(sessionId, player);
          client.send('afk_kicked', {
            message: 'Auto-kicked due to 30 minutes of inactivity. Round earnings forfeited.',
          });
          client.leave(4001, 'AFK timeout');
        }
      }
    });
  }

  /**
   * 30-minute AFK rule: the round's earnings go back to the platform. Unsent payouts are dropped and
   * anything already flushed to the wallet is clawed back with an AFK_FORFEIT debit.
   */
  private forfeitRoundEarnings(sessionId: string, player: PlayerState) {
    const m = this.meta.get(sessionId);
    let unsent = 0;
    const voided: TicketStake[] = [];
    this.pendingPayouts = this.pendingPayouts.filter((p) => {
      if (p.userId === player.id && (p.actionType === 'GAME_KILL' || p.actionType === 'CHEST_OPEN')) {
        unsent += earnerAndBountyShares(p.amountMicroUsd).earner; // only the 55 % was ever credited
        // The victim's ticket of a dropped kill still has to be closed: its value goes to the platform
        const md = (p.metadata || {}) as Record<string, unknown>;
        if (typeof md.ticketId === 'string' && typeof md.victimId === 'string') {
          voided.push({ victimId: md.victimId, victimSession: String(md.victimSession ?? ''), ticketId: md.ticketId, value: p.amountMicroUsd });
        }
        return false;
      }
      if (p.userId === player.id && p.actionType === 'FAST_MINI_KILL') return false; // never paid: the victim's pot stays theirs
      if (p.userId === player.id && p.actionType === 'BOUNTY_CLAIM') {
        unsent += p.amountMicroUsd; // not sent yet: the victim simply keeps that bounty
        return false;
      }
      return true;
    });
    for (const v of voided) this.queueTicketForfeit(v, 'afk_claw');
    const alreadyPaid = (m?.earned ?? 0) - unsent;
    if (alreadyPaid > 0 && UUID_RE.test(player.id)) {
      this.pendingPayouts.push({ userId: player.id, amountMicroUsd: alreadyPaid, actionType: 'AFK_FORFEIT', gameId: this.gameId, metadata: { reason: 'afk_30min', pid: this.nextPid() } });
    }
    // The AFK player's own live ticket goes to the platform too (zero-deficit: never refunded)
    const own = this.takeStake(sessionId, player);
    if (own) this.queueTicketForfeit(own, 'afk_kick');
    if (m) m.earned = 0;
    player.sessionEarningsMicroUsd = 0;
  }

  /** In-flight batch POSTs (onDispose waits for them, so a failure can still be retried). */
  private inFlightFlushes = new Set<Promise<boolean>>();

  /**
   * V1.1 R3 live-session report for this flush: a snapshot of every alive Paid-EC / Fast & Mini seat whose
   * state changed (HP, prop disguise, disconnected) + the lives that ended, + an implicit room heartbeat.
   * Returns null when the room has nothing to report.
   */
  private buildSessionReport(): { report: { roomId: string; serverUrl?: string; upsert: SessionUpsert[]; end: SessionEnd[] }; sent: Array<[SessionMeta, string]> } | null {
    const upsert: SessionUpsert[] = [];
    const sent: Array<[SessionMeta, string]> = [];
    let live = 0;
    this.state.players.forEach((p, sid) => {
      const m = this.meta.get(sid);
      if (!m?.sessionLive) return;
      live++;
      const sig = `${m.entryId}|${m.lifeStartedAt}|${p.health}|${p.isProp ? p.propType : '-'}|${p.isDisconnected ? 1 : 0}`;
      if (sig === m.sessionSig) return;
      m.sessionSig = sig;
      sent.push([m, sig]);
      upsert.push({
        userId: p.id,
        entryId: m.entryId,
        roomCode: this.roomCode || null,
        mode: this.engineMode,
        mapName: this.largeMap ? 'large' : 'small',
        hp: Math.max(0, Math.round(p.health)),
        isPropHidden: !!p.isProp,
        propType: p.isProp ? p.propType : null,
        isDisconnected: !!p.isDisconnected,
        lifeStartedAt: m.lifeStartedAt ?? Date.now(),
        ticketId: this.fastMini ? null : m.ticketId || null,
        potId: this.fastMini ? m.fmPot || null : null,
      });
    });
    const end = this.pendingSessionEnds.splice(0, this.pendingSessionEnds.length);
    if (!live && !upsert.length && !end.length) return null;
    return { report: { roomId: this.roomId, serverUrl: this.publicUrl || undefined, upsert, end }, sent };
  }

  private hasPendingSync() {
    return this.pendingPayouts.length > 0 || this.pendingSessionEnds.length > 0;
  }

  // Batch sync financial rewards to Cloudflare Workers API. Returns false when the batch was re-queued.
  private flushPayoutBatch(): Promise<boolean> {
    const sessions = this.buildSessionReport();
    if (this.pendingPayouts.length === 0 && !sessions) return Promise.resolve(true);

    const payoutsToFlush = this.pendingPayouts.splice(0, this.pendingPayouts.length);
    const p = (async () => {
      try {
        const res = await fetch(`${this.workerApiUrl}/api/game/batch-payout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gameId: this.gameId,
            timestamp: Math.floor(Date.now() / 1000),
            secret: this.internalSecret,
            payouts: payoutsToFlush,
            ...(sessions ? { sessions: sessions.report } : {}),
          }),
        });
        if (res.ok) {
          const j = (await res.json().catch(() => null)) as { fastMini?: Array<{ killerId: string; victimId: string; status: string; valueMicroUsd: number; shooterMicroUsd: number }> } | null;
          if (j && Array.isArray(j.fastMini)) this.applyFastMiniResults(j.fastMini);
          return true;
        }
      } catch {
        // connection error → re-queue below
      }
      this.pendingPayouts.push(...payoutsToFlush);
      if (sessions) {
        // ends are retried; snapshots are simply sent again (fresh) at the next flush
        this.pendingSessionEnds.unshift(...sessions.report.end);
        for (const [m, sig] of sessions.sent) if (m.sessionSig === sig) m.sessionSig = '';
      }
      return false;
    })();
    this.inFlightFlushes.add(p);
    void p.finally(() => this.inFlightFlushes.delete(p));
    return p;
  }

  /**
   * Room is closing: wait for in-flight batches, then retry what is still queued with backoff
   * (≈ 2 min in total) so a short Worker outage at the end of a round loses no earnings. Whatever is
   * still unsent after that is logged as [PayoutUnsent] JSON for manual reconciliation.
   */
  private async drainPayouts() {
    const delays = [0, 1000, 2000, 4000, 8000, 15000, 30000, 60000];
    for (const d of delays) {
      if (d) await new Promise((r) => setTimeout(r, d));
      await Promise.allSettled([...this.inFlightFlushes]);
      if (!this.hasPendingSync()) return;
      if (await this.flushPayoutBatch()) {
        if (!this.hasPendingSync()) return;
      }
    }
    if (this.hasPendingSync()) {
      console.error(`[PayoutUnsent] ${JSON.stringify({ gameId: this.gameId, payouts: this.pendingPayouts, sessionEnds: this.pendingSessionEnds })}`);
    }
  }

  /**
   * Paid seats: a valid EC entry token (signed by the API worker after spending 1 EC) makes the seat
   * earn Micro-USD. Everyone else may still play, but as an unpaid guest.
   */
  onAuth(client: Client, options: { entryToken?: string; rejoinToken?: string; deviceId?: string; spectator?: boolean }, request?: IncomingMessage) {
    const fwd = request?.headers?.['cf-connecting-ip'] || request?.headers?.['x-forwarded-for'];
    const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() || request?.socket?.remoteAddress || 'unknown';
    // V1.1 R3 Rejoin: a Worker-signed token for THIS room + an alive body of that account and life. The seat is
    // the existing body (already counted in the caps) — no new seat, no entry token, no EC.
    if (options?.rejoinToken !== undefined) {
      const rj = verifyRejoinToken(options.rejoinToken, this.internalSecret);
      if (!rj || rj.rid !== this.roomId) throw new Error('Invalid rejoin token');
      if (!this.findBody(rj.uid, rj.eid)) throw new Error('Your character is no longer in this match');
      this.rejoinTargets.set(client.sessionId, { uid: rj.uid, eid: rj.eid });
      this.rejoinIps.set(client.sessionId, { ip, deviceId: typeof options?.deviceId === 'string' ? options.deviceId.slice(0, 64) : '' });
      return { userId: rj.uid, username: rj.un, rejoin: true };
    }
    // Registry rooms keep separate player and spectator seat caps
    if (this.roomCode) {
      let players = 0;
      let spectators = 0;
      this.state.players.forEach((p) => (p.isSpectator ? spectators++ : players++));
      if (options?.spectator ? spectators >= this.maxSpectators : players >= this.maxPlayers) {
        throw new Error(options?.spectator ? 'Spectator seats are full' : 'This room is full');
      }
    }
    const entry = verifyEntryToken(options?.entryToken, this.internalSecret);
    // A paid ticket only counts in the room it was bought for (entry cost is set per room)
    const valid = !!entry && !this.usedEntryIds.has(entry.eid) && entry.rc === this.roomCode;
    if (valid && entry) this.usedEntryIds.add(entry.eid);
    // V1.1 R2: Fast & Mini seats carry a banner pot, never a ticket; ticket seats exist only outside Fast & Mini
    const fmSeat = valid && !!entry && this.fastMini && entry.fm;
    const paid = valid && !!entry && !this.fastMini && !entry.fm;
    if (valid && entry && this.fastMini && entry.tid && UUID_RE.test(entry.uid)) {
      // A ticket token in a free room was never at stake → back to available (defensive; the Worker never issues one)
      this.pendingPayouts.push({ userId: entry.uid, amountMicroUsd: 0, actionType: 'TICKET_RETURN', gameId: this.gameId, metadata: { ticketId: entry.tid, entryId: entry.eid, reason: 'free_room', pid: this.nextPid() } });
    }
    this.meta.set(client.sessionId, {
      paid,
      ip,
      deviceId: typeof options?.deviceId === 'string' ? options.deviceId.slice(0, 64) : '',
      joinedAt: Date.now(),
      lastShotAt: 0,
      hits: 0,
      headshots: 0,
      flagged: null,
      earned: 0,
      ticketId: paid && entry ? entry.tid : '',
      ticketValue: paid && entry ? entry.tv : 0,
      ticketLive: !!(paid && entry && entry.tid),
      paidSeat: !!(paid && entry && entry.tid),
      entryId: valid && entry ? entry.eid : '',
      fmPot: fmSeat && entry && UUID_RE.test(entry.eid) && UUID_RE.test(entry.uid) ? entry.eid : '',
    });
    return entry ? { userId: entry.uid, username: entry.un, bounty: paid ? entry.bty : 0, ticket: paid ? entry.tv : 0 } : { userId: null };
  }

  /** Queue a payout only for verified paid seats that are not flagged by anti-cheat. */
  private queuePayout(sessionId: string, player: PlayerState, amount: number, actionType: 'GAME_KILL' | 'CHEST_OPEN', metadata: Record<string, unknown>) {
    const m = this.meta.get(sessionId);
    if (!m?.paid || m.flagged || !UUID_RE.test(player.id) || amount <= 0) return 0;
    // 100 % split of V (applied by the Worker): 55 % to this player · 15 % uplines · 5 % onto this
    // player's own head bounty · 5 % platform · 20 % Energy Pool. The HUD shows the 55 % actually credited.
    const { earner, bounty } = earnerAndBountyShares(amount);
    m.earned += earner;
    player.sessionEarningsMicroUsd += earner;
    player.bountyMicroUsd += bounty;
    // Layer 2 telemetry for the cashout audit: the shooter's session hit / headshot totals so far
    const sm = this.meta.get(sessionId);
    const telemetry = sm ? { hits: sm.hits, headshots: sm.headshots } : {};
    this.pendingPayouts.push({ userId: player.id, amountMicroUsd: amount, actionType, gameId: this.gameId, metadata: { ...metadata, ...telemetry, pid: this.nextPid() } });
    return earner;
  }

  private nextPid() {
    return `${this.gameId}:${++this.payoutSeq}`;
  }

  /**
   * V1.1: take a player's live ticket stake at the moment it is decided (death). Returns null for
   * guests / spectators / tokens without a ticket / a stake that was already settled this match.
   */
  private takeStake(sessionId: string, player: PlayerState): TicketStake | null {
    const m = this.meta.get(sessionId);
    if (!m?.paid || !m.ticketLive || !m.ticketId || !UUID_RE.test(player.id)) return null;
    m.ticketLive = false;
    player.ticketMicroUsd = 0;
    return { victimId: player.id, victimSession: sessionId, ticketId: m.ticketId, value: Math.max(0, Math.floor(m.ticketValue)) };
  }

  /** The stake ended without a payout: tell the Worker so the ticket is closed (its backing → platform). */
  private queueTicketForfeit(stake: TicketStake, reason: string) {
    this.pendingPayouts.push({
      userId: stake.victimId,
      amountMicroUsd: Math.max(0, Math.floor(stake.value)),
      actionType: 'TICKET_FORFEIT',
      gameId: this.gameId,
      metadata: { ticketId: stake.ticketId, reason, pid: this.nextPid() },
    });
  }

  /** A GAME_KILL / CHEST_OPEN payout for this stake is waiting in the queue (synchronously just queued). */
  private stakeQueued(ticketId: string) {
    return this.pendingPayouts.some(
      (p) => (p.actionType === 'GAME_KILL' || p.actionType === 'CHEST_OPEN') && (p.metadata as Record<string, unknown> | undefined)?.ticketId === ticketId
    );
  }

  /** V1.1 R2: a Paid-EC seat (entered with a ticket in a paid room) must re-stake to play again. */
  private needsRestake(m: SessionMeta) {
    return this.paidRoom && !this.fastMini && m.paidSeat;
  }

  /**
   * V1.1 R2 Fast & Mini kill: queue FAST_MINI_KILL for the Worker, which pays the killer 90 % of the
   * VICTIM's own verified banner pot (credits up to `diedAt`) and 10 % to the platform. The amount is
   * never decided here. Both seats must be signed Fast & Mini seats; flagged shooters get nothing.
   */
  private queueFastMiniKill(killerSession: string, killer: PlayerState, victimSession: string, victim: PlayerState) {
    const km = this.meta.get(killerSession);
    const vm = this.meta.get(victimSession);
    if (!km?.fmPot || km.flagged || !vm?.fmPot || !UUID_RE.test(killer.id) || !UUID_RE.test(victim.id) || killer.id === victim.id) return false;
    this.pendingPayouts.push({
      userId: killer.id,
      amountMicroUsd: 0,
      actionType: 'FAST_MINI_KILL',
      gameId: this.gameId,
      metadata: { victimId: victim.id, victimSession, potId: vm.fmPot, diedAt: vm.diedAt ?? Date.now(), hits: km.hits, headshots: km.headshots, pid: this.nextPid() },
    });
    return true;
  }

  private queueFastMiniClose(userId: string, potId: string, reason: string) {
    if (!UUID_RE.test(userId) || !potId) return;
    this.pendingPayouts.push({ userId, amountMicroUsd: 0, actionType: 'FAST_MINI_CLOSE', gameId: this.gameId, metadata: { potId, reason, pid: this.nextPid() } });
  }

  /** What the Worker really paid for Fast & Mini kills → HUD round earnings + a message to killer and victim. */
  private applyFastMiniResults(list: Array<{ killerId: string; victimId: string; status: string; valueMicroUsd: number; shooterMicroUsd: number }>) {
    for (const r of list) {
      if (r.status !== 'paid') continue;
      const shooter = Math.max(0, Math.floor(Number(r.shooterMicroUsd) || 0));
      this.state.players.forEach((p, sid) => {
        if (p.id === r.killerId) {
          const m = this.meta.get(sid);
          if (m) m.earned += shooter;
          p.sessionEarningsMicroUsd += shooter;
          this.clients.find((c) => c.sessionId === sid)?.send('fast_mini_reward', { victimId: r.victimId, valueMicroUsd: r.valueMicroUsd, shooterMicroUsd: shooter });
        } else if (p.id === r.victimId) {
          this.clients.find((c) => c.sessionId === sid)?.send('fast_mini_pot_lost', { killerId: r.killerId, valueMicroUsd: r.valueMicroUsd });
        }
      });
    }
  }

  /** Queue the transfer of a victim's accumulated head bounty to the claimer (paid seats only). */
  private queueBountyClaim(sessionId: string, claimer: PlayerState, amount: number, victimId: string, victimTicketId: string) {
    const m = this.meta.get(sessionId);
    // V1.1: only a victim who entered with a paid ticket has a claimable bounty here (the Worker checks it)
    if (!m?.paid || m.flagged || !UUID_RE.test(claimer.id) || !UUID_RE.test(victimId) || claimer.id === victimId || amount <= 0 || !victimTicketId) return 0;
    m.earned += amount;
    claimer.sessionEarningsMicroUsd += amount;
    this.pendingPayouts.push({ userId: claimer.id, amountMicroUsd: Math.floor(amount), actionType: 'BOUNTY_CLAIM', gameId: this.gameId, metadata: { victimId, ticketId: victimTicketId, pid: this.nextPid() } });
    return amount;
  }

  /** An unclaimed chest bounty stays with its owner (it still lives in their wallet row). */
  private returnChestBounty(chestId: string) {
    const cb = this.chestBounty.get(chestId);
    if (!cb) return;
    this.chestBounty.delete(chestId);
    const owner = this.state.players.get(cb.victimSession);
    if (owner && owner.id === cb.victimId) owner.bountyMicroUsd += cb.amount;
  }

  /** Layer 3: same IP / device, or the same killer→victim pair farmed repeatedly, pays nothing. */
  private isCollusionKill(killerSession: string, victimSession: string, killer: PlayerState, victim: PlayerState) {
    const a = this.meta.get(killerSession);
    const b = this.meta.get(victimSession);
    if (!a || !b) return 'unknown_session';
    if (a.ip !== 'unknown' && a.ip === b.ip) return 'same_ip';
    if (a.deviceId && a.deviceId === b.deviceId) return 'same_device';
    const key = `${killer.id}>${victim.id}`;
    const now = Date.now();
    const recent = (this.pairKills.get(key) || []).filter((t) => now - t < COLLUSION_WINDOW_MS);
    recent.push(now);
    this.pairKills.set(key, recent);
    if (recent.length > COLLUSION_REPEAT_KILL_LIMIT) return 'repeat_victim';
    return null;
  }

  /** Layer 2: chest-collect rate (per minute in room) above mean + 3σ of the other players. */
  private chestRateAnomalous(sessionId: string) {
    const now = Date.now();
    const rates: number[] = [];
    let mine = 0;
    this.state.players.forEach((p, sid) => {
      const m = this.meta.get(sid);
      if (!m) return;
      const minutes = Math.max(1, (now - m.joinedAt) / 60_000);
      const r = (p.chestsCollected + (sid === sessionId ? 1 : 0)) / minutes;
      if (sid === sessionId) mine = r;
      else rates.push(r);
    });
    if (rates.length < CHEST_RATE_MIN_SAMPLE_PLAYERS) return false;
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    const sd = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length);
    return mine > mean + CHEST_RATE_SIGMA_LIMIT * Math.max(sd, 0.05);
  }

  onJoin(
    client: Client,
    options: { userId?: string; username?: string; avatarId?: string; primaryWeapon?: string; spectator?: boolean },
    auth?: { userId: string | null; username?: string; bounty?: number; ticket?: number; rejoin?: boolean }
  ) {
    if (auth?.rejoin) {
      this.attachRejoin(client);
      return;
    }
    console.log(`[ShootingRoom] Player joined: ${client.sessionId} (${options.username || 'Anon'})`);
    const player = new PlayerState();
    // Identity comes from the signed entry token only — a client-supplied userId is never trusted
    player.id = auth?.userId || `guest_${client.sessionId}`;
    player.sessionId = client.sessionId;
    player.username = (auth?.username || options.username || `Player_${client.sessionId.substring(0, 4)}`).slice(0, 24);
    player.bountyMicroUsd = auth?.bounty ?? 0; // accumulated head bounty from the database
    player.ticketMicroUsd = auth?.ticket ?? 0; // V1.1: this player's live ticket value (what a kill on them pays)
    player.avatarId = options.avatarId || 'specops';

    const chosenPrimary = options.primaryWeapon || 'ak47';
    player.primaryWeapon = chosenPrimary;
    player.currentWeapon = chosenPrimary;
    const spec = WEAPON_SPECS[chosenPrimary] || WEAPON_SPECS.ak47;
    player.magAmmo = spec.magSize;
    player.reserveAmmo = spec.reserve;
    player.grenadesRemaining = 2;

    // Select a validated spawn point from ARENA_SPAWN_POINTS (far from existing players)
    let bestPoint = this.spawnPoints[0];
    let maxDist = -1;

    for (const point of this.spawnPoints) {
      let minDistToOthers = Infinity;
      this.state.players.forEach((other) => {
        const d = Math.hypot(other.x - point.x, other.z - point.z);
        if (d < minDistToOthers) minDistToOthers = d;
      });
      if (minDistToOthers > maxDist) {
        maxDist = minDistToOthers;
        bestPoint = point;
      }
    }

    player.x = bestPoint.x;
    player.y = bestPoint.y;
    player.z = bestPoint.z;
    player.health = 100;
    player.lastActiveTime = Date.now();
    if (options?.spectator) {
      // Ghost Spectator: invisible flying observer — no body, no hitbox, never targetable or paid
      player.isSpectator = true;
      player.isGhost = true;
      player.health = 0;
      player.ticketMicroUsd = 0;
      const sm = this.meta.get(client.sessionId);
      if (sm) {
        // A spectator seat is never paid: a ticket that came with it is closed (→ platform) at once
        if (sm.ticketLive && sm.ticketId && UUID_RE.test(player.id)) {
          this.queueTicketForfeit({ victimId: player.id, victimSession: client.sessionId, ticketId: sm.ticketId, value: sm.ticketValue }, 'spectator');
        }
        sm.paid = false;
        sm.ticketLive = false;
        sm.paidSeat = false;
        if (sm.fmPot) this.queueFastMiniClose(player.id, sm.fmPot, 'spectator');
        sm.fmPot = '';
      }
    }

    this.state.players.set(client.sessionId, player);
    this.state.activePlayersCount = this.state.players.size;
    // V1.1 R3: an alive Paid-EC / Fast & Mini seat is a live session from now on (Rejoin-able if it disconnects)
    this.startSession(client.sessionId, player);
    this.refreshBodyState();

    // Update Redis room discovery asynchronously
    if (this.redis) {
      this.redis
        .hset(`room:${this.roomId}`, {
          clients: this.state.players.size,
          mapMode: this.state.mapMode,
          updatedAt: Date.now(),
        })
        .catch(() => {});
    }
  }

  async onLeave(client: Client, consented: boolean) {
    this.rejoinTargets.delete(client.sessionId);
    this.rejoinIps.delete(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    // No body under this key: it was moved to a newer connection by a Rejoin (or never created)
    if (!player) {
      this.refreshBodyState();
      return;
    }

    // V1.1 R3: an ALIVE Paid-EC / Fast & Mini seat that leaves — tab closed, navigation, socket loss, consented
    // or not — keeps its body in the arena (position, HP, hitbox, prop disguise, ticket value, head bounty,
    // pot): inputs frozen, never AFK-kicked, killable like anyone else. Nothing is settled or forfeited here;
    // settlement happens only when the body actually dies (or by the room-shutdown rule in onDispose).
    if (this.canPersist(client.sessionId, player)) {
      this.detachBody(client.sessionId, player);
      return;
    }

    if (!consented) {
      // Unexpected disconnect: Player turns into a Prop disguise
      player.isProp = true;
      player.propType = 'supply_crate';
      player.disguisePropId = 'supply_crate';
      player.isPropSolid = true;

      this.broadcast('player_disconnected_prop', {
        sessionId: client.sessionId,
        username: player.username,
        propType: player.propType,
      });

      // Allow 20s reconnection window
      try {
        await this.allowReconnection(client, 20);
        player.isProp = false; // Restored
        return;
      } catch {
        // Reconnect window expired
      }
    }

    // Guest-style 20 s window above expired, or the seat was dead / a spectator / AFK-kicked → removed
    const current = this.state.players.get(client.sessionId);
    if (current) this.removeSeat(client.sessionId, current, current.afkKicked ? 'afk_kick' : 'left');
    else this.refreshBodyState();
  }

  /**
   * Remove a seat from the room. A live ticket still at stake here (only AFK / non-live-room edge cases — an
   * alive Paid-EC seat never gets here, it stays as a body) keeps the V1.1 zero-deficit rule: forfeited.
   */
  private removeSeat(sessionId: string, player: PlayerState, reason: string) {
    const stake = this.takeStake(sessionId, player);
    if (stake) this.queueTicketForfeit(stake, reason === 'afk_kick' ? 'afk_kick' : 'left');
    // V1.1 R2 Fast & Mini: the pot closes with the seat (its unpaid credits → platform, by the Worker)
    const lm = this.meta.get(sessionId);
    if (lm?.fmPot) this.queueFastMiniClose(player.id, lm.fmPot, reason === 'afk_kick' ? 'afk_kick' : 'left');
    if (lm) lm.fmPot = '';
    this.endSession(sessionId, reason);
    this.medkitCasts.delete(sessionId);
    this.lastFireBlip.delete(sessionId);
    this.state.players.delete(sessionId);
    this.meta.delete(sessionId);
    this.state.activePlayersCount = this.state.players.size;
    // Spec 5.2: batch every 10 s OR when a player leaves the room
    void this.flushPayoutBatch();
    this.refreshBodyState();

    if (this.redis) {
      this.redis
        .hset(`room:${this.roomId}`, {
          clients: this.state.players.size,
          updatedAt: Date.now(),
        })
        .catch(() => {});
    }
  }

  // ---- V1.1 R3: persistent bodies, live sessions, Rejoin -------------------------------------------

  /** An alive seat that stays in the arena as a body when its client goes away (and is reported as a live session). */
  private canPersist(sessionId: string, player: PlayerState) {
    const m = this.meta.get(sessionId);
    if (!m || player.isSpectator || player.isGhost || player.health <= 0 || player.afkKicked || !UUID_RE.test(player.id)) return false;
    if (this.fastMini) return !!m.fmPot;
    return this.paidRoom && m.paid && m.ticketLive && !!m.ticketId;
  }

  private startSession(sessionId: string, player: PlayerState) {
    const m = this.meta.get(sessionId);
    if (!m || !m.entryId || !this.canPersist(sessionId, player)) return;
    m.sessionLive = true;
    m.lifeStartedAt = Date.now();
    m.sessionSig = '';
  }

  /** The life is over (death / removal / room shutdown): end its session once (retried until delivered). */
  private endSession(sessionId: string, reason: string) {
    const m = this.meta.get(sessionId);
    const p = this.state.players.get(sessionId);
    if (!m?.sessionLive || !p) return;
    m.sessionLive = false;
    m.sessionSig = '';
    this.pendingSessionEnds.push({ userId: p.id, entryId: m.entryId, reason: reason.slice(0, 24), endedAt: Math.max(Date.now(), m.lifeStartedAt ?? 0) });
  }

  /** The alive body of account `uid` for life `eid` (Rejoin target), or null. */
  private findBody(uid: string, eid: string): string | null {
    for (const [sid, m] of this.meta) {
      const p = this.state.players.get(sid);
      if (p && p.id === uid && m.entryId === eid && m.sessionLive && !p.isGhost && !p.isSpectator && p.health > 0) return sid;
    }
    return null;
  }

  /** The client left alive: freeze the body exactly as it is (prop disguise included) and keep it killable. */
  private detachBody(sessionId: string, player: PlayerState) {
    player.isDisconnected = true;
    player.disconnectedAt = Date.now();
    this.medkitCasts.delete(sessionId);
    const m = this.meta.get(sessionId);
    if (m) m.sessionSig = ''; // report the disconnect at once (Rejoin popup)
    console.log(`[ShootingRoom] ${player.username} left alive: body stays in the arena${player.isProp ? ` as ${player.propType}` : ''}`);
    this.refreshBodyState();
    void this.flushPayoutBatch();
  }

  /**
   * Keep the room alive while it holds disconnected bodies (Colyseus would dispose an empty room), and shut it
   * down after BODY_ONLY_ROOM_TTL_SECONDS with no client connected at all (room-shutdown rule → onDispose).
   */
  private refreshBodyState() {
    let bodies = 0;
    this.state.players.forEach((p) => {
      if (p.isDisconnected) bodies++;
    });
    this.autoDispose = bodies === 0;
    if (bodies > 0 && this.clients.length === 0) {
      if (!this.bodyOnlyTimer) {
        this.bodyOnlyTimer = this.clock.setTimeout(() => {
          this.bodyOnlyTimer = undefined;
          if (this.clients.length === 0) {
            console.log(`[ShootingRoom] ${this.roomId}: only disconnected bodies for ${this.bodyOnlyTtlMs / 1000} s, shutting the room down`);
            void this.disconnect();
          }
        }, this.bodyOnlyTtlMs);
      }
    } else if (this.bodyOnlyTimer) {
      this.bodyOnlyTimer.clear();
      this.bodyOnlyTimer = undefined;
    }
  }

  /**
   * Rejoin: move the existing body to the new connection's key (a still-attached older connection of the same
   * body is replaced — there is never a second body), unfreeze it and hand the client its exact state.
   */
  private attachRejoin(client: Client) {
    const target = this.rejoinTargets.get(client.sessionId);
    const net = this.rejoinIps.get(client.sessionId);
    this.rejoinTargets.delete(client.sessionId);
    this.rejoinIps.delete(client.sessionId);
    const oldKey = target ? this.findBody(target.uid, target.eid) : null;
    if (!target || !oldKey) throw new Error('Your character is no longer in this match');
    const old = this.state.players.get(oldKey)!;
    const m = this.meta.get(oldKey)!;
    const oldClient = this.clients.find((c) => c.sessionId === oldKey);
    const newKey = client.sessionId;
    const body = clonePlayerState(old, newKey);
    body.isDisconnected = false;
    body.disconnectedAt = 0;
    body.lastActiveTime = Date.now(); // pressing Rejoin is activity: the AFK clock restarts
    body.afkWarningSent = false;
    this.state.players.delete(oldKey);
    this.meta.delete(oldKey);
    this.state.players.set(newKey, body);
    this.meta.set(newKey, m);
    if (net) {
      m.ip = net.ip;
      if (net.deviceId) m.deviceId = net.deviceId;
    }
    m.lastMoveAt = Date.now();
    m.sessionSig = '';
    this.sessionAlias.set(oldKey, newKey);
    for (const [k, v] of this.sessionAlias) if (v === oldKey) this.sessionAlias.set(k, newKey);
    this.medkitCasts.delete(oldKey);
    this.lastFireBlip.delete(oldKey);
    for (const cb of this.chestBounty.values()) if (cb.victimSession === oldKey) cb.victimSession = newKey;
    for (const st of this.chestStake.values()) if (st.victimSession === oldKey) st.victimSession = newKey;
    for (const dmg of this.chestDamage.values()) {
      const d = dmg.get(oldKey);
      if (d !== undefined) {
        dmg.delete(oldKey);
        dmg.set(newKey, (dmg.get(newKey) ?? 0) + d);
      }
    }
    if (oldClient) {
      // A second connection for the same body: the newest one takes over, the older one is closed
      oldClient.send('session_replaced', { reason: 'rejoined_elsewhere' });
      oldClient.leave(4002, 'Rejoined from another connection');
    }
    console.log(`[ShootingRoom] ${body.username} rejoined their live body (${oldKey} -> ${newKey})${body.isProp ? ` still disguised as ${body.propType}` : ''}`);
    this.refreshBodyState();
    client.send('rejoined', {
      x: body.x,
      y: body.y,
      z: body.z,
      rotationY: body.rotationY,
      stance: body.stance,
      health: body.health,
      isProp: body.isProp,
      propType: body.propType,
      avatarId: body.avatarId,
      primaryWeapon: body.primaryWeapon,
      currentWeapon: body.currentWeapon,
      magAmmo: body.magAmmo,
      reserveAmmo: body.reserveAmmo,
      grenades: body.grenadesRemaining,
      medkits: body.medkits,
      kills: body.kills,
      deaths: body.deaths,
      ticketMicroUsd: body.ticketMicroUsd,
      bountyMicroUsd: body.bountyMicroUsd,
      sessionEarningsMicroUsd: body.sessionEarningsMicroUsd,
      entryId: m.entryId,
      fastMini: this.fastMini,
      roomCode: this.roomCode,
      respawnMode: this.needsRestake(m) ? 'restake' : 'free',
    });
    void this.flushPayoutBatch();
  }

  async onDispose() {
    this.bodyOnlyTimer?.clear();
    this.bodyOnlyTimer = undefined;
    for (const [sid, m] of this.meta) {
      const p = this.state.players.get(sid);
      // V1.1 R3 room-shutdown rule (body-only room TTL, server restart / SIGTERM): a body still ALIVE has no
      // outcome — its ticket is RETURNED to available (never paid, never forfeited) and its session ends.
      if (p && !p.isGhost && !p.isSpectator && p.health > 0) {
        const stake = this.takeStake(sid, p);
        if (stake) {
          this.pendingPayouts.push({ userId: stake.victimId, amountMicroUsd: 0, actionType: 'TICKET_RETURN', gameId: this.gameId, metadata: { ticketId: stake.ticketId, entryId: m.entryId, reason: 'room_shutdown', pid: this.nextPid() } });
        }
      }
      if (p) this.endSession(sid, 'room_shutdown');
      // V1.1 R2: Fast & Mini seats still present (no onLeave) → close their pots
      if (m.fmPot && p) this.queueFastMiniClose(p.id, m.fmPot, 'room_closed');
      m.fmPot = '';
    }
    // V1.1: unopened death chests still hold ticket stakes → close them (backing → platform)
    for (const [id, stake] of this.chestStake) {
      this.chestStake.delete(id);
      this.queueTicketForfeit(stake, 'room_closed');
    }
    // Flush any remaining payouts before room disposal (retried while the Worker is unreachable)
    await this.drainPayouts();
    if (this.redis) {
      this.redis.del(`room:${this.roomId}`).catch(() => {});
      this.redis.disconnect();
    }
  }
}
