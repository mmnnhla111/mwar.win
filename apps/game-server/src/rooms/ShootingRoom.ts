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
} from '@mwar/shared';
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

/** Server-authoritative fire-rate floor (ms between accepted hits) per weapon. */
const MIN_HIT_INTERVAL_MS: Record<string, number> = { sniper: 900, ak47: 85, m16: 70, uzi: 50, pistol: 110 };
const MAX_CHEST_HIT_DAMAGE = 25;


export class ShootingRoom extends Room<GameState> {
  maxClients = 30;
  private gameId: string = '';
  private workerApiUrl: string = 'http://127.0.0.1:8787';
  private internalSecret: string = 'local-dev-internal-game-secret-2026';
  private lastHitAt = new Map<string, number>();
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
    this.gameId = options.gameId || `game_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.workerApiUrl = options.workerApiUrl || process.env.WORKER_API_URL || 'http://127.0.0.1:8787';
    this.internalSecret = options.internalSecret || process.env.INTERNAL_API_SECRET || 'local-dev-internal-game-secret-2026';

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
      const halfX = this.state.mapSizeX / 2;
      const halfZ = this.state.mapSizeZ / 2;
      player.x = Math.max(-halfX, Math.min(halfX, data.x));
      player.y = data.y;
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
    this.onMessage('player_shoot', (client, data: { targetType: 'player' | 'chest'; targetId: string; damage: number; weaponId?: string }) => {
      const shooter = this.state.players.get(client.sessionId);
      if (!shooter || shooter.isGhost || shooter.isProp) return;

      const now = Date.now();
      shooter.lastActiveTime = now;
      // Only weapons the shooter actually holds (primary / picked-up weapon, or the universal pistol)
      const weaponId = data.weaponId === 'pistol' ? 'pistol' : shooter.currentWeapon || shooter.primaryWeapon;
      const spec = WEAPON_SPECS[weaponId] || WEAPON_SPECS.ak47;
      const last = this.lastHitAt.get(client.sessionId) || 0;
      if (now - last < (MIN_HIT_INTERVAL_MS[weaponId] ?? 60)) return; // faster than the weapon can fire
      this.lastHitAt.set(client.sessionId, now);
      const maxDamage = data.targetType === 'chest' ? MAX_CHEST_HIT_DAMAGE : Math.min(100, Math.ceil(spec.damage * spec.headMult));
      const damage = Math.min(Math.max(1, Number(data.damage) || 1), maxDamage);

      if (data.targetType === 'player') {
        this.handlePlayerHit(shooter, client, data.targetId, damage);
      } else if (data.targetType === 'chest') {
        this.handleChestHit(shooter, client, data.targetId, damage);
      }
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
      // Guests can fight but never earn Micro-USD (no verified account to credit)
      // 1. Weapon/Combat Kill by another player:
      // Kills by another player do NOT drop a Bounty Chest!
      killer.kills += 1;
      const killReward = Number(KILL_REWARD_BASE_MICRO_USD);
      killer.sessionEarningsMicroUsd += killReward;

      if (!killer.id.startsWith('guest_')) this.pendingPayouts.push({
        userId: killer.id,
        amountMicroUsd: killReward,
        actionType: 'GAME_KILL',
        gameId: this.gameId,
        metadata: { victimId: target.id, victimSession: targetSessionId },
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

    chest.health = Math.max(0, chest.health - damage);

    if (chest.health === 0) {
      const reward = chest.rewardMicroUsd;
      shooter.chestsCollected += 1;
      shooter.sessionEarningsMicroUsd += reward;

      if (!shooter.id.startsWith('guest_')) this.pendingPayouts.push({
        userId: shooter.id,
        amountMicroUsd: reward,
        actionType: 'CHEST_OPEN',
        gameId: this.gameId,
        metadata: { chestId, isDeathDrop: chest.isDeathDrop },
      });

      this.state.chests.delete(chestId);
      this.state.activeChestsCount = this.state.chests.size;

      this.broadcast('chest_destroyed', {
        chestId,
        collectedByUsername: shooter.username,
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
    chest.expiresAt = Date.now() + 15_000; // 15-second lifespan

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
        // Forfeit unflushed round earnings back to the system (anti bot-farm rule)
        this.pendingPayouts = this.pendingPayouts.filter((p) => p.userId !== player.id);
        player.sessionEarningsMicroUsd = 0;
        const client = this.clients.find((c) => c.sessionId === sessionId);
        if (client) {
          client.send('afk_kicked', {
            message: 'Auto-kicked due to 30 minutes of inactivity. Round earnings forfeited.',
          });
          client.leave(4001, 'AFK timeout');
        }
      }
    });
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
   * Identity is verified server-side: the client sends its API JWT and we resolve it through the
   * Worker (/api/auth/me). Client-supplied userIds are ignored, so nobody can earn into (or as)
   * another account. No / invalid token = guest (can play, never earns).
   */
  async onAuth(_client: Client, options: { token?: string }) {
    if (!options?.token) return { guest: true };
    try {
      const res = await fetch(`${this.workerApiUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${options.token}` } });
      if (!res.ok) return { guest: true };
      const data = (await res.json()) as { user?: { id?: string; username?: string } };
      if (!data.user?.id) return { guest: true };
      return { guest: false, userId: data.user.id, username: data.user.username };
    } catch {
      return { guest: true };
    }
  }

  onJoin(
    client: Client,
    options: { userId?: string; username?: string; avatarId?: string; primaryWeapon?: string },
    auth?: { guest?: boolean; userId?: string; username?: string }
  ) {
    console.log(`[ShootingRoom] Player joined: ${client.sessionId} (${options.username || 'Anon'})`);
    const player = new PlayerState();
    player.id = auth && !auth.guest && auth.userId ? auth.userId : `guest_${client.sessionId}`;
    player.sessionId = client.sessionId;
    player.username = (auth && !auth.guest && auth.username) || options.username || `Player_${client.sessionId.substring(0, 4)}`;
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
    this.state.activePlayersCount = this.state.players.size;
    this.lastHitAt.delete(client.sessionId);
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
