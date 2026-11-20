import { Room, Client } from 'colyseus';
import crypto from 'crypto';
import Redis from 'ioredis';
import {
  MAP_SPECS,
  GAME_TICK_INTERVAL_MS,
  CHEST_EVENT_INTERVAL_MS,
  GAME_BATCH_SYNC_INTERVAL_MS,
  AFK_WARNING_SECONDS,
  AFK_KICK_SECONDS,
  CHEST_REWARD_BASE_MICRO_USD,
  KILL_REWARD_BASE_MICRO_USD,
} from '@mwar/shared';
import type { BatchPayoutItem } from '@mwar/shared';
import { GameState, PlayerState, ChestState } from '../schema/GameState';

interface RoomOptions {
  mode?: 'mini_30' | 'standard_100';
  gameId?: string;
  workerApiUrl?: string;
  internalSecret?: string;
}

export class ShootingRoom extends Room<GameState> {
  maxClients = 30;
  private gameId: string = '';
  private workerApiUrl: string = 'http://127.0.0.1:8787';
  private internalSecret: string = 'local-dev-internal-game-secret-2026';
  private redis?: Redis;
  private pendingPayouts: BatchPayoutItem[] = [];

  onCreate(options: RoomOptions) {
    this.setState(new GameState());

    const modeKey = options.mode === 'standard_100' ? 'STANDARD_100' : 'MINI_30';
    const spec = MAP_SPECS[modeKey];

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

    // 3. Game Tick Loop (20 Hz = 50ms) - Pure RAM processing, NO DB
    this.setSimulationInterval((deltaTime) => this.update(deltaTime), GAME_TICK_INTERVAL_MS);
    this.setPatchRate(GAME_TICK_INTERVAL_MS);

    // 4. Chest Spawner Event (Every 15 Seconds)
    this.clock.setInterval(() => this.spawnRandomChest(), CHEST_EVENT_INTERVAL_MS);

    // 5. Financial Batching Interval (Every 10 Seconds)
    this.clock.setInterval(() => this.flushPayoutBatch(), GAME_BATCH_SYNC_INTERVAL_MS);

    // Initial Chest Spawns
    for (let i = 0; i < 5; i++) {
      this.spawnRandomChest();
    }
  }

  private registerMessageHandlers() {
    this.onMessage('ping', (client, data) => {
      client.send('pong', { reply: 'pong', echo: data });
    });

    // Player Movement & Aiming
    this.onMessage('player_move', (client, data: { x: number; y: number; z: number; rotationY?: number }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      // Update spatial coordinates (Server-Authoritative bounding)
      const halfX = this.state.mapSizeX / 2;
      const halfZ = this.state.mapSizeZ / 2;
      player.x = Math.max(-halfX, Math.min(halfX, data.x));
      player.y = data.y;
      player.z = Math.max(-halfZ, Math.min(halfZ, data.z));
      if (typeof data.rotationY === 'number') {
        player.rotationY = data.rotationY;
      }

      // Reset AFK timer
      player.lastActiveTime = Date.now();
      player.afkWarningSent = false;
    });

    // Prop-Hide Disguise Toggle (Turn into wooden crate/barrel)
    this.onMessage('player_toggle_prop', (client, data?: { propType?: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isGhost) return;

      player.isProp = !player.isProp;
      if (player.isProp && data?.propType) {
        player.propType = data.propType;
      }
      player.lastActiveTime = Date.now();
      this.broadcast('prop_transformed', { sessionId: client.sessionId, isProp: player.isProp, propType: player.propType });
    });

    // Weapon Shooting & Hit Verification
    this.onMessage('player_shoot', (client, data: { targetType: 'player' | 'chest'; targetId: string; damage: number }) => {
      const shooter = this.state.players.get(client.sessionId);
      if (!shooter || shooter.isGhost) return;

      shooter.lastActiveTime = Date.now();
      const damage = Math.min(Math.max(1, data.damage || 25), 100);

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

  private handlePlayerHit(shooter: PlayerState, shooterClient: Client, targetSessionId: string, damage: number) {
    const target = this.state.players.get(targetSessionId);
    if (!target || target.isGhost || targetSessionId === shooterClient.sessionId) return;

    // Break prop disguise on damage
    if (target.isProp) {
      target.isProp = false;
    }

    target.health = Math.max(0, target.health - damage);

    if (target.health === 0) {
      // 1. Player Eliminated -> Enter Ghost Spectator Mode
      target.isGhost = true;
      target.deaths += 1;
      shooter.kills += 1;

      const killReward = Number(KILL_REWARD_BASE_MICRO_USD);
      shooter.sessionEarningsMicroUsd += killReward;

      // 2. Drop 15-Second Treasure Chest at death location
      this.spawnDeathChest(target.x, target.y, target.z);

      // 3. Queue reward for batch payout to Cloudflare Workers
      this.pendingPayouts.push({
        userId: shooter.id,
        amountMicroUsd: killReward,
        actionType: 'GAME_KILL',
        gameId: this.gameId,
        metadata: { victimId: target.id, victimSession: targetSessionId },
      });

      this.broadcast('player_killed', {
        killerId: shooter.id,
        killerUsername: shooter.username,
        victimId: target.id,
        victimUsername: target.username,
        rewardMicroUsd: killReward,
      });

      // Notify victim they are now in Ghost spectator mode
      const victimClient = this.clients.find((c) => c.sessionId === targetSessionId);
      if (victimClient) {
        victimClient.send('entered_ghost_mode', {
          message: 'You were eliminated. You are now in Ghost Spectator mode!',
        });
      }
    } else {
      this.broadcast('player_damaged', {
        targetSessionId,
        newHealth: target.health,
        damage,
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

      this.pendingPayouts.push({
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

  private spawnRandomChest() {
    const chestId = `chest_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const halfX = (this.state.mapSizeX / 2) - 10;
    const halfZ = (this.state.mapSizeZ / 2) - 10;

    const chest = new ChestState();
    chest.id = chestId;
    chest.x = Math.round((Math.random() * 2 - 1) * halfX);
    chest.y = 0; // Flat ground
    chest.z = Math.round((Math.random() * 2 - 1) * halfZ);
    chest.health = 50;
    chest.rewardMicroUsd = Number(CHEST_REWARD_BASE_MICRO_USD);
    chest.isDeathDrop = false;
    chest.spawnedAt = Date.now();

    this.state.chests.set(chestId, chest);
    this.state.activeChestsCount = this.state.chests.size;

    this.broadcast('chest_spawned', {
      id: chest.id,
      x: chest.x,
      y: chest.y,
      z: chest.z,
      rewardMicroUsd: chest.rewardMicroUsd,
      isDeathDrop: false,
    });
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
    chest.expiresAt = Date.now() + 15_000; // 15s lifespan

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

  // Update Game Loop (20 Hz)
  private update(deltaTime: number) {
    const now = Date.now();

    // 1. Expire 15-second death chests
    this.state.chests.forEach((chest, id) => {
      if (chest.isDeathDrop && chest.expiresAt > 0 && now >= chest.expiresAt) {
        this.state.chests.delete(id);
        this.broadcast('chest_expired', { chestId: id });
      }
    });

    // 2. Anti-AFK Detection Check
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

  onJoin(client: Client, options: { userId?: string; username?: string }) {
    console.log(`[ShootingRoom] Player joined: ${client.sessionId} (${options.username || 'Anon'})`);
    const player = new PlayerState();
    player.id = options.userId || crypto.randomUUID();
    player.sessionId = client.sessionId;
    player.username = options.username || `Player_${client.sessionId.substring(0, 4)}`;

    // Random spawn position within boundary
    const halfX = (this.state.mapSizeX / 2) - 15;
    const halfZ = (this.state.mapSizeZ / 2) - 15;
    player.x = Math.round((Math.random() * 2 - 1) * halfX);
    player.y = 0;
    player.z = Math.round((Math.random() * 2 - 1) * halfZ);
    player.health = 100;
    player.lastActiveTime = Date.now();

    this.state.players.set(client.sessionId, player);
    this.state.activePlayersCount = this.state.players.size;

    // Update Redis room discovery asynchronously
    if (this.redis) {
      this.redis.hset(`room:${this.roomId}`, {
        clients: this.state.players.size,
        mapMode: this.state.mapMode,
        updatedAt: Date.now(),
      }).catch(() => {});
    }
  }

  async onLeave(client: Client, consented: boolean) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (!consented) {
      // Unexpected disconnect: Player turns into a Prop (wooden crate) disguise
      player.isProp = true;
      player.propType = 'wooden_crate';
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

    if (this.redis) {
      this.redis.hset(`room:${this.roomId}`, {
        clients: this.state.players.size,
        updatedAt: Date.now(),
      }).catch(() => {});
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
