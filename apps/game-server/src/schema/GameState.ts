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
  // Stance: 'stand' | 'crouch' | 'prone' (drives the 3rd-person posture + hitbox on other clients)
  @type('string') stance: string = 'stand';

  // Combat status
  @type('number') health: number = 100;
  @type('number') maxHealth: number = 100;

  // Avatar (8 male/female operators: 'specops', 'mercenary', 'desert_sniper', 'heavy_striker', 'bodysuit_agent', 'urban_scout', 'crimson_operative', 'cyber_valkyrie')
  @type('string') avatarId: string = 'specops';

  // Prop-hide disguise mode (20 radial wheel props)
  @type('boolean') isProp: boolean = false;
  @type('string') propType: string = 'supply_crate';
  @type('string') disguisePropId: string = '';
  @type('boolean') isPropSolid: boolean = false;

  // Multi-Weapon Loadout & Ammo (sniper, ak47, m16, uzi, pistol, grenades)
  @type('string') primaryWeapon: string = 'ak47';
  @type('string') currentWeapon: string = 'ak47';
  @type('number') magAmmo: number = 30;
  @type('number') reserveAmmo: number = 90;
  @type('number') grenadesRemaining: number = 2;

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

export class DroppedWeaponState extends Schema {
  @type('string') id: string = '';
  @type('string') weaponId: string = 'ak47';
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') z: number = 0;
  @type('number') magAmmo: number = 30;
  @type('number') reserveAmmo: number = 90;
  @type('number') droppedAt: number = 0;
  @type('number') expiresAt: number = 0; // 300s (5-minute despawn timer)
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
  @type('number') expiresAt: number = 0; // 15s lifespan for suicide bounty chests
}

export class GameState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: ChestState }) chests = new MapSchema<ChestState>();
  @type({ map: DroppedWeaponState }) droppedWeapons = new MapSchema<DroppedWeaponState>();

  @type('string') mapMode: string = 'mini_30';
  @type('number') mapSizeX: number = 240;
  @type('number') mapSizeZ: number = 240;
  @type('number') activeChestsCount: number = 0;
  @type('number') activePlayersCount: number = 0;
  @type('number') activeDroppedWeaponsCount: number = 0;
}
