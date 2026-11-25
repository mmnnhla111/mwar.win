import { Room, Client } from 'colyseus';
import crypto from 'crypto';
import Redis from 'ioredis';
import {
  MAP_SPECS,
  GAME_TICK_INTERVAL_MS,
  GAME_BATCH_SYNC_INTERVAL_MS,
  AFK_WARNING_SECONDS,
  AFK_KICK_SECONDS,
  CHEST_REWARD_BASE_MICRO_USD,
  KILL_REWARD_BASE_MICRO_USD,
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
} from '@mwar/shared';
import type { IncomingMessage } from 'http';
import type { BatchPayoutItem } from '@mwar/shared';
import { GameState, PlayerState, ChestState, DroppedWeaponState, MedkitState } from '../schema/GameState';
import { getRegistryRoom } from '../roomRegistry';

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
  sniper: { magSize: 5, reserve: 20, damage: 92, headMult: 2.5, range: 200 },
  ak47: { magSize: 30, reserve: 90, damage: 34, headMult: 2.0, range: 45 },
  m16: { magSize: 30, reserve: 90, damage: 27, headMult: 2.0, range: 55 },
  uzi: { magSize: 40, reserve: 160, damage: 17, headMult: 1.6, range: 22 },
  pistol: { magSize: 15, reserve: 45, damage: 24, headMult: 2.0, range: 25 },
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
}

/** Combat death → respawn delay (ELIMINATED overlay on the client). */
const RESPAWN_DELAY_MS = 3000;
const MEDKIT_DROP_CHANCE = 0.2;
const MEDKIT_TTL_MS = 600_000;
const MEDKIT_CAST_MS = 4000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verify the HMAC-SHA256 entry token minted by POST /api/game/enter (1 EC spent). */
export function verifyEntryToken(token: unknown, secret: string): { uid: string; un: string; eid: string; bty: number; rc: string } | null {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const json = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof json.exp !== 'number' || json.exp < Date.now() / 1000) return null;
    if (typeof json.uid !== 'string' || !UUID_RE.test(json.uid)) return null;
    const bty = Number(json.bty);
    return {
      uid: json.uid,
      un: String(json.un ?? ''),
      eid: String(json.eid ?? ''),
      bty: Number.isFinite(bty) && bty > 0 ? Math.floor(bty) : 0,
      rc: typeof json.rc === 'string' ? json.rc : '',
    };
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
  private chestBounty = new Map<string, { victimId: string; victimSession: string; amount: number }>();
  /** "killerUserId>victimUserId" → recent kill timestamps (Layer 3 kill-farming check). */
  private pairKills = new Map<string, number[]>();
  private usedEntryIds = new Set<string>();
  private largeMap = false;
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
    this.setMetadata({ roomCode: this.roomCode, mode: engineMode, mapSize: kind });
    this.state.mapMode = engineMode === 'fast_mini' ? 'fast_mini' : spec.id;
    this.state.mapSizeX = this.largeMap ? LARGE_MAP_SIZE : SMALL_MAP_SIZE;
    this.state.mapSizeZ = this.largeMap ? LARGE_MAP_SIZE : SMALL_MAP_SIZE;
    this.gameId = `game_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    // Never take the API URL or the shared secret from room options: those come from the first
    // client's joinOrCreate() call and would let a player redirect payouts or forge entry tokens.
    this.workerApiUrl = process.env.WORKER_API_URL || 'http://127.0.0.1:8787';
    this.internalSecret = process.env.INTERNAL_API_SECRET || 'local-dev-internal-game-secret-2026';

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
    this.onMessage('player_shoot', (client, data: { targetType: 'player' | 'chest'; targetId: string; damage: number; headshot?: boolean }) => {
      const shooter = this.state.players.get(client.sessionId);
      if (!shooter || shooter.isGhost) return;
      const m = this.meta.get(client.sessionId);
      const now = Date.now();

      // Anti-cheat rate limit: no faster than the equipped weapon can fire (20 % tolerance)
      const weapon = WEAPON_SPECS[shooter.currentWeapon] ? shooter.currentWeapon : 'ak47';
      const minGap = (WEAPON_MIN_SHOT_INTERVAL_MS[weapon] ?? 80) * 0.8;
      if (m && now - m.lastShotAt < minGap) return;
      if (m) m.lastShotAt = now;

      shooter.lastActiveTime = now;
      // Damage clamp: never above the weapon's own (head-shot) damage
      const spec = WEAPON_SPECS[weapon];
      const maxDmg = Math.round(spec.damage * (data.headshot ? spec.headMult : 1));
      const damage = Math.min(Math.max(1, Math.round(data.damage || 25)), maxDmg, 100);

      if (m && data.targetType === 'player') {
        m.hits += 1;
        if (data.headshot) m.headshots += 1;
        // Layer 2: aim headshot ratio > 85 % after enough hits → flag (rewards zeroed)
        if (!m.flagged && m.hits >= HEADSHOT_MIN_SAMPLE_HITS && m.headshots / m.hits > HEADSHOT_RATIO_FLAG) {
          m.flagged = `headshot_ratio_${(m.headshots / m.hits).toFixed(2)}`;
          console.warn(`[AntiCheat L2] ${shooter.id} flagged: ${m.flagged}`);
        }
      }

      if (data.targetType === 'player') {
        this.handlePlayerHit(shooter, client, data.targetId, damage);
      } else if (data.targetType === 'chest') {
        this.handleChestHit(shooter, client, data.targetId, damage);
      }
    });

    // Gunshot radar blip: every shot is relayed (server position, not client-reported) so enemies
    // within radar range see a 2-second red dot on their minimap. Rate-limited per player.
    this.onMessage('player_fired', (client) => {
      const shooter = this.state.players.get(client.sessionId);
      if (!shooter || shooter.isGhost || shooter.isSpectator) return;
      const now = Date.now();
      const last = this.lastFireBlip.get(client.sessionId) ?? 0;
      if (now - last < 400) return;
      this.lastFireBlip.set(client.sessionId, now);
      this.broadcast('player_fired', { sessionId: client.sessionId, x: shooter.x, z: shooter.z }, { except: client });
    });

    // Respawn request (fallback; the 20 Hz loop also respawns automatically after 3 s)
    this.onMessage('player_respawn', (client, data: { x: number; y: number; z: number; primary?: string }) => {
      const player = this.state.players.get(client.sessionId);
      const m = this.meta.get(client.sessionId) as (SessionMeta & { diedAt?: number; lastMoveAt?: number }) | undefined;
      if (!player || player.isSpectator || !player.isGhost || !m?.diedAt || Date.now() - m.diedAt < RESPAWN_DELAY_MS) return;
      void data;
      this.respawnPlayer(client.sessionId, player);
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
          const isSelf = targetSessionId === throwerSessionId;
          const thrower = this.state.players.get(throwerSessionId);
          if (isSelf || !thrower) {
            this.handlePlayerElimination(target, targetSessionId, undefined, undefined, 'grenade_suicide');
          } else {
            this.handlePlayerElimination(target, targetSessionId, thrower, throwerSessionId);
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

  private handlePlayerHit(shooter: PlayerState, shooterClient: Client, targetSessionId: string, damage: number) {
    const target = this.state.players.get(targetSessionId);
    if (!target || target.isGhost || targetSessionId === shooterClient.sessionId) return;

    // Break prop disguise on damage
    if (target.isProp) {
      target.isProp = false;
      target.disguisePropId = '';
    }

    target.health = Math.max(0, target.health - damage);

    if (target.health === 0) {
      this.handlePlayerElimination(target, targetSessionId, shooter, shooterClient.sessionId);
    } else {
      this.broadcast('player_damaged', {
        targetSessionId,
        newHealth: target.health,
        damage,
      });
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
    const tm = this.meta.get(targetSessionId) as (SessionMeta & { diedAt?: number }) | undefined;
    if (tm) tm.diedAt = Date.now();
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
      const collusion = this.isCollusionKill(killerSessionId, targetSessionId, killer, target);
      if (collusion) console.warn(`[AntiCheat L3] kill ${killer.id} -> ${target.id} pays 0 (${collusion})`);
      const killReward = collusion
        ? 0
        : this.queuePayout(killerSessionId, killer, Number(KILL_REWARD_BASE_MICRO_USD), 'GAME_KILL', {
            victimId: target.id,
            victimSession: targetSessionId,
          });
      // The killer claims the victim's whole accumulated head bounty (never on a collusion kill)
      const bountyClaimed = collusion ? 0 : this.queueBountyClaim(killerSessionId, killer, target.bountyMicroUsd, target.id);
      if (bountyClaimed > 0) target.bountyMicroUsd = 0;

      this.broadcast('player_killed', {
        killerId: killer.id,
        killerUsername: killer.username,
        victimId: target.id,
        victimUsername: target.username,
        rewardMicroUsd: killReward + bountyClaimed,
        bountyClaimedMicroUsd: bountyClaimed,
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

    // Notify victim they are now in Ghost spectator mode
    const victimClient = this.clients.find((c) => c.sessionId === targetSessionId);
    if (victimClient) {
      victimClient.send('player_eliminated', {
        killerUsername: killer?.username ?? null,
        respawnInMs: RESPAWN_DELAY_MS,
      });
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
      this.state.chests.delete(chestId);
      this.state.activeChestsCount = this.state.chests.size;

      // Layer 2: chest-collect rate above room mean + 3σ → chest destroyed with no reward, account marked
      let reward = 0;
      if (this.chestRateAnomalous(topSession)) {
        const m = this.meta.get(topSession);
        if (m) m.flagged = m.flagged ?? 'chest_rate_3sigma';
        console.warn(`[AntiCheat L2] ${winner.id} chest rate > mean+3σ — chest voided`);
      } else {
        winner.chestsCollected += 1;
        reward = this.queuePayout(topSession, winner, chest.rewardMicroUsd, 'CHEST_OPEN', { chestId, isDeathDrop: chest.isDeathDrop, topDamage });
        const cb = this.chestBounty.get(chestId);
        if (cb && cb.victimId !== winner.id) {
          const got = this.queueBountyClaim(topSession, winner, cb.amount, cb.victimId);
          if (got > 0) {
            reward += got;
            this.chestBounty.delete(chestId);
          }
        }
      }
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
      this.chestBounty.set(chestId, { victimId: victim.id, victimSession, amount: victim.bountyMicroUsd });
      victim.bountyMicroUsd = 0;
    }
    const chest = new ChestState();
    chest.id = chestId;
    chest.x = Math.round(x);
    chest.y = Math.round(y);
    chest.z = Math.round(z);
    chest.health = 30; // Easier to break
    chest.rewardMicroUsd = Number(CHEST_REWARD_BASE_MICRO_USD) * 2; // Double reward for player loot drops
    chest.isDeathDrop = true;
    chest.bountyMicroUsd = this.chestBounty.get(chestId)?.amount ?? 0;
    chest.spawnedAt = Date.now();
    chest.expiresAt = Date.now() + CHEST_LIFETIME_MS; // 15-second lifespan

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
    const m = this.meta.get(sessionId) as (SessionMeta & { diedAt?: number; lastMoveAt?: number }) | undefined;
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
    const client = this.clients.find((c) => c.sessionId === sessionId);
    client?.send('player_respawned', { x: point.x, y: point.y, z: point.z, primary });
  }

  // Update Game Loop (20 Hz)
  private update(deltaTime: number) {
    const now = Date.now();

    // 1. Expire 15-second death bounty chests
    this.state.chests.forEach((chest, id) => {
      if (chest.isDeathDrop && chest.expiresAt > 0 && now >= chest.expiresAt) {
        this.state.chests.delete(id);
        this.chestDamage.delete(id);
        this.returnChestBounty(id);
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
    // 3a. Combat death → clean respawn after 3 s (server authoritative: hp, ammo, spawn point)
    this.state.players.forEach((player, sessionId) => {
      if (!player.isGhost || player.isSpectator) return;
      const dm = this.meta.get(sessionId) as (SessionMeta & { diedAt?: number }) | undefined;
      if (dm?.diedAt && now - dm.diedAt >= RESPAWN_DELAY_MS) this.respawnPlayer(sessionId, player);
    });

    this.state.players.forEach((player, sessionId) => {
      if (player.isSpectator) return; // spectators are never AFK-kicked by combat rules
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
    this.pendingPayouts = this.pendingPayouts.filter((p) => {
      if (p.userId === player.id && (p.actionType === 'GAME_KILL' || p.actionType === 'CHEST_OPEN')) {
        unsent += earnerAndBountyShares(p.amountMicroUsd).earner; // only the 55 % was ever credited
        return false;
      }
      if (p.userId === player.id && p.actionType === 'BOUNTY_CLAIM') {
        unsent += p.amountMicroUsd; // not sent yet: the victim simply keeps that bounty
        return false;
      }
      return true;
    });
    const alreadyPaid = (m?.earned ?? 0) - unsent;
    if (alreadyPaid > 0 && UUID_RE.test(player.id)) {
      this.pendingPayouts.push({ userId: player.id, amountMicroUsd: alreadyPaid, actionType: 'AFK_FORFEIT', gameId: this.gameId, metadata: { reason: 'afk_30min' } });
    }
    if (m) m.earned = 0;
    player.sessionEarningsMicroUsd = 0;
  }

  // Batch sync financial rewards to Cloudflare Workers API
  private async flushPayoutBatch() {
    if (this.pendingPayouts.length === 0) return;

    const payoutsToFlush = this.pendingPayouts.splice(0, this.pendingPayouts.length);
    try {
      const res = await fetch(`${this.workerApiUrl}/api/game/batch-payout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameId: this.gameId,
          timestamp: Math.floor(Date.now() / 1000),
          secret: this.internalSecret,
          payouts: payoutsToFlush,
        }),
      });
      if (!res.ok) {
        // Requeue on failure
        this.pendingPayouts.push(...payoutsToFlush);
      }
    } catch {
      // Requeue on connection error
      this.pendingPayouts.push(...payoutsToFlush);
    }
  }

  /**
   * Paid seats: a valid EC entry token (signed by the API worker after spending 1 EC) makes the seat
   * earn Micro-USD. Everyone else may still play, but as an unpaid guest.
   */
  onAuth(client: Client, options: { entryToken?: string; deviceId?: string; spectator?: boolean }, request?: IncomingMessage) {
    const fwd = request?.headers?.['cf-connecting-ip'] || request?.headers?.['x-forwarded-for'];
    const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() || request?.socket?.remoteAddress || 'unknown';
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
    const paid = !!entry && !this.usedEntryIds.has(entry.eid) && entry.rc === this.roomCode;
    if (paid && entry) this.usedEntryIds.add(entry.eid);
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
    });
    return entry ? { userId: entry.uid, username: entry.un, bounty: paid ? entry.bty : 0 } : { userId: null };
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
    this.pendingPayouts.push({ userId: player.id, amountMicroUsd: amount, actionType, gameId: this.gameId, metadata });
    return earner;
  }

  /** Queue the transfer of a victim's accumulated head bounty to the claimer (paid seats only). */
  private queueBountyClaim(sessionId: string, claimer: PlayerState, amount: number, victimId: string) {
    const m = this.meta.get(sessionId);
    if (!m?.paid || m.flagged || !UUID_RE.test(claimer.id) || !UUID_RE.test(victimId) || claimer.id === victimId || amount <= 0) return 0;
    m.earned += amount;
    claimer.sessionEarningsMicroUsd += amount;
    this.pendingPayouts.push({ userId: claimer.id, amountMicroUsd: Math.floor(amount), actionType: 'BOUNTY_CLAIM', gameId: this.gameId, metadata: { victimId } });
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
    auth?: { userId: string | null; username?: string; bounty?: number }
  ) {
    console.log(`[ShootingRoom] Player joined: ${client.sessionId} (${options.username || 'Anon'})`);
    const player = new PlayerState();
    // Identity comes from the signed entry token only — a client-supplied userId is never trusted
    player.id = auth?.userId || `guest_${client.sessionId}`;
    player.sessionId = client.sessionId;
    player.username = (auth?.username || options.username || `Player_${client.sessionId.substring(0, 4)}`).slice(0, 24);
    player.bountyMicroUsd = auth?.bounty ?? 0; // accumulated head bounty from the database
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
      const sm = this.meta.get(client.sessionId);
      if (sm) sm.paid = false;
    }

    this.state.players.set(client.sessionId, player);
    this.state.activePlayersCount = this.state.players.size;

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
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

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

    this.state.players.delete(client.sessionId);
    this.meta.delete(client.sessionId);
    this.state.activePlayersCount = this.state.players.size;
    // Spec 5.2: batch every 10 s OR when a player leaves the room
    void this.flushPayoutBatch();

    if (this.redis) {
      this.redis
        .hset(`room:${this.roomId}`, {
          clients: this.state.players.size,
          updatedAt: Date.now(),
        })
        .catch(() => {});
    }
  }

  async onDispose() {
    // Flush any remaining payouts before room disposal
    await this.flushPayoutBatch();
    if (this.redis) {
      this.redis.del(`room:${this.roomId}`).catch(() => {});
      this.redis.disconnect();
    }
  }
}
