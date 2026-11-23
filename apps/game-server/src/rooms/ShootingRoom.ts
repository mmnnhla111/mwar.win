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
} from '@mwar/shared';
import type { IncomingMessage } from 'http';
import type { BatchPayoutItem } from '@mwar/shared';
import { GameState, PlayerState, ChestState, DroppedWeaponState } from '../schema/GameState';

interface RoomOptions {
  mode?: 'mini_30' | 'standard_100';
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
  uzi: { magSize: 32, reserve: 128, damage: 17, headMult: 1.6, range: 18 },
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verify the HMAC-SHA256 entry token minted by POST /api/game/enter (1 EC spent). */
export function verifyEntryToken(token: unknown, secret: string): { uid: string; un: string; eid: string } | null {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const json = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof json.exp !== 'number' || json.exp < Date.now() / 1000) return null;
    if (typeof json.uid !== 'string' || !UUID_RE.test(json.uid)) return null;
    return { uid: json.uid, un: String(json.un ?? ''), eid: String(json.eid ?? '') };
  } catch {
    return null;
  }
}

export class ShootingRoom extends Room<GameState> {
  private meta = new Map<string, SessionMeta>();
  /** chestId → (sessionId → damage dealt): the top-damage dealer gets the bounty. */
  private chestDamage = new Map<string, Map<string, number>>();
  /** "killerUserId>victimUserId" → recent kill timestamps (Layer 3 kill-farming check). */
  private pairKills = new Map<string, number[]>();
  private usedEntryIds = new Set<string>();

  maxClients = 30;
  private gameId: string = '';
  private workerApiUrl: string = 'http://127.0.0.1:8787';
  private internalSecret: string = 'local-dev-internal-game-secret-2026';
  private redis?: Redis;
  private pendingPayouts: BatchPayoutItem[] = [];

  onCreate(options: RoomOptions) {
    this.setState(new GameState());

    const modeKey = options.mode === 'standard_100' ? 'STANDARD_100' : 'MINI_30';
    const spec = MAP_SPECS[modeKey] || MAP_SPECS.MINI_30;

    this.maxClients = spec.maxPlayers;
    this.state.mapMode = spec.id;
    this.state.mapSizeX = spec.sizeX;
    this.state.mapSizeZ = spec.sizeZ;
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
    this.onMessage('ping', (client, data) => {
      client.send('pong', { reply: 'pong', echo: data });
    });

    // Player Movement & Aiming
    this.onMessage('player_move', (client, data: { x: number; y: number; z: number; rotationY?: number; stance?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

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
      player.y = Math.max(-5, Math.min(80, data.y));
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

    // Respawn after death (client waits ~4 s): revive the ghost at the reported spawn point
    this.onMessage('player_respawn', (client, data: { x: number; y: number; z: number; primary?: string }) => {
      const player = this.state.players.get(client.sessionId);
      const m = this.meta.get(client.sessionId) as (SessionMeta & { diedAt?: number; lastMoveAt?: number }) | undefined;
      if (!player || !player.isGhost || !m?.diedAt || Date.now() - m.diedAt < 3000) return;
      if (![data?.x, data?.y, data?.z].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
      const halfX = this.state.mapSizeX / 2;
      const halfZ = this.state.mapSizeZ / 2;
      player.x = Math.max(-halfX, Math.min(halfX, data.x));
      player.y = Math.max(-5, Math.min(80, data.y));
      player.z = Math.max(-halfZ, Math.min(halfZ, data.z));
      player.health = 100;
      player.isGhost = false;
      player.isProp = false;
      const primary = data.primary && WEAPON_SPECS[data.primary] ? data.primary : player.primaryWeapon || 'ak47';
      const spec = WEAPON_SPECS[primary];
      player.primaryWeapon = primary;
      player.currentWeapon = primary;
      player.magAmmo = spec.magSize;
      player.reserveAmmo = spec.reserve;
      player.grenadesRemaining = 2;
      player.lastActiveTime = Date.now();
      m.diedAt = undefined;
      m.lastMoveAt = Date.now();
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

      this.broadcast('player_killed', {
        killerId: killer.id,
        killerUsername: killer.username,
        victimId: target.id,
        victimUsername: target.username,
        rewardMicroUsd: killReward,
      });
    } else {
      // 2. Suicide / Non-Player death:
      // Spawns 15-second Bounty Chest!
      this.spawnDeathChest(target.x, target.y, target.z);
      this.broadcast('player_suicide', {
        victimUsername: target.username,
        cause: suicideCause || 'environment_hazard',
      });
    }

    // Notify victim they are now in Ghost spectator mode
    const victimClient = this.clients.find((c) => c.sessionId === targetSessionId);
    if (victimClient) {
      victimClient.send('entered_ghost_mode', {
        message: 'You died. You are now in Ghost Spectator mode!',
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
      }

      this.broadcast('chest_destroyed', {
        chestId,
        collectedByUsername: winner.username,
        rewardMicroUsd: reward,
      });
    }
  }

  private spawnDeathChest(x: number, y: number, z: number) {
    const chestId = `death_chest_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const chest = new ChestState();
    chest.id = chestId;
    chest.x = Math.round(x);
    chest.y = Math.round(y);
    chest.z = Math.round(z);
    chest.health = 30; // Easier to break
    chest.rewardMicroUsd = Number(CHEST_REWARD_BASE_MICRO_USD) * 2; // Double reward for player loot drops
    chest.isDeathDrop = true;
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
      isDeathDrop: true,
      expiresAt: chest.expiresAt,
    });
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

  // Update Game Loop (20 Hz)
  private update(deltaTime: number) {
    const now = Date.now();

    // 1. Expire 15-second death bounty chests
    this.state.chests.forEach((chest, id) => {
      if (chest.isDeathDrop && chest.expiresAt > 0 && now >= chest.expiresAt) {
        this.state.chests.delete(id);
        this.chestDamage.delete(id);
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
    this.state.activeDroppedWeaponsCount = this.state.droppedWeapons.size;

    // 3. Anti-AFK Detection Check
    this.state.players.forEach((player, sessionId) => {
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
        unsent += p.amountMicroUsd;
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
  onAuth(client: Client, options: { entryToken?: string; deviceId?: string }, request?: IncomingMessage) {
    const fwd = request?.headers?.['cf-connecting-ip'] || request?.headers?.['x-forwarded-for'];
    const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() || request?.socket?.remoteAddress || 'unknown';
    const entry = verifyEntryToken(options?.entryToken, this.internalSecret);
    const paid = !!entry && !this.usedEntryIds.has(entry.eid);
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
    return entry ? { userId: entry.uid, username: entry.un } : { userId: null };
  }

  /** Queue a payout only for verified paid seats that are not flagged by anti-cheat. */
  private queuePayout(sessionId: string, player: PlayerState, amount: number, actionType: 'GAME_KILL' | 'CHEST_OPEN', metadata: Record<string, unknown>) {
    const m = this.meta.get(sessionId);
    if (!m?.paid || m.flagged || !UUID_RE.test(player.id) || amount <= 0) return 0;
    m.earned += amount;
    player.sessionEarningsMicroUsd += amount;
    this.pendingPayouts.push({ userId: player.id, amountMicroUsd: amount, actionType, gameId: this.gameId, metadata });
    return amount;
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
    options: { userId?: string; username?: string; avatarId?: string; primaryWeapon?: string },
    auth?: { userId: string | null; username?: string }
  ) {
    console.log(`[ShootingRoom] Player joined: ${client.sessionId} (${options.username || 'Anon'})`);
    const player = new PlayerState();
    // Identity comes from the signed entry token only — a client-supplied userId is never trusted
    player.id = auth?.userId || `guest_${client.sessionId}`;
    player.sessionId = client.sessionId;
    player.username = (auth?.username || options.username || `Player_${client.sessionId.substring(0, 4)}`).slice(0, 24);
    player.avatarId = options.avatarId || 'specops';

    const chosenPrimary = options.primaryWeapon || 'ak47';
    player.primaryWeapon = chosenPrimary;
    player.currentWeapon = chosenPrimary;
    const spec = WEAPON_SPECS[chosenPrimary] || WEAPON_SPECS.ak47;
    player.magAmmo = spec.magSize;
    player.reserveAmmo = spec.reserve;
    player.grenadesRemaining = 2;

    // Select a validated spawn point from ARENA_SPAWN_POINTS (far from existing players)
    let bestPoint = ARENA_SPAWN_POINTS[0];
    let maxDist = -1;

    for (const point of ARENA_SPAWN_POINTS) {
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
