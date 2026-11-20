import { Schema, MapSchema, type } from '@colyseus/schema';

export class PlayerState extends Schema {
  @type('string') id: string = '';
  @type('string') sessionId: string = '';
  @type('string') username: string = '';

  // Spatial coordinates
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') z: number = 0;
  @type('number') rotationY: number = 0;

  // Combat status
  @type('number') health: number = 100;
  @type('number') maxHealth: number = 100;

  // Prop-hide disguise mode (activated on crouch or unexpected disconnect)
  @type('boolean') isProp: boolean = false;
  @type('string') propType: string = 'wooden_crate';

  // Spectator mode upon death
  @type('boolean') isGhost: boolean = false;

  // Performance & Earnings stats
  @type('number') kills: number = 0;
  @type('number') deaths: number = 0;
  @type('number') chestsCollected: number = 0;
  @type('number') sessionEarningsMicroUsd: number = 0;

  // Internal anti-AFK timestamp (not serialized to network)
  lastActiveTime: number = Date.now();
  afkWarningSent: boolean = false;
}

export class ChestState extends Schema {
  @type('string') id: string = '';
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') z: number = 0;
  @type('number') health: number = 50;
  @type('number') maxHealth: number = 50;
  @type('number') rewardMicroUsd: number = 50_000; // $0.05
  @type('boolean') isDeathDrop: boolean = false;
  @type('number') spawnedAt: number = 0;
  @type('number') expiresAt: number = 0; // Timestamp when chest disappears if uncollected (15s for death drops)
}

export class GameState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: ChestState }) chests = new MapSchema<ChestState>();

  @type('string') mapMode: string = 'mini_30';
  @type('number') mapSizeX: number = 250;
  @type('number') mapSizeZ: number = 250;
  @type('number') activeChestsCount: number = 0;
  @type('number') activePlayersCount: number = 0;
}
