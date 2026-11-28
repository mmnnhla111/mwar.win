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
  /** 'stand' | 'crouch' | 'prone' — drives the 3rd-person posture on other clients. */
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
  // Joined in "Spectate Match" mode: invisible, no collision / damage, never respawns
  @type('boolean') isSpectator: boolean = false;

  // Performance & Earnings stats
  @type('number') kills: number = 0;
  @type('number') deaths: number = 0;
  @type('number') chestsCollected: number = 0;
  @type('number') sessionEarningsMicroUsd: number = 0;
  // Head bounty: 5 % of every reward this player earns; claimed by whoever eliminates them
  @type('number') bountyMicroUsd: number = 0;
  // V1.1: real backed value of this player's live Energy Ticket — exactly what a kill on them pays (0 after settled)
  @type('number') ticketMicroUsd: number = 0;
  // V1.2 Golden Boss ("เป้าหมายค่าหัวทองคำ"): reserved reward on this player's head (0 = not the boss). Clients
  // draw a golden crown above them; the amount is decided and held by the Worker (reservation), not here.
  @type('number') goldenBossMicroUsd: number = 0;
  // Medkits carried (slot 4). Healing is a 4 s stationary cast validated by the server.
  @type('number') medkits: number = 0;

  // Internal anti-AFK timestamp (not serialized to network)
  lastActiveTime: number = Date.now();
  afkWarningSent: boolean = false;
  afkKicked: boolean = false;
  /**
   * V1.1 R3 (server-only, never synced — other clients must not be able to tell a disconnected body or a
   * disguised one apart from a live player): the client left while alive; the body stays in the arena with
   * its exact position, HP, hitbox and prop disguise, inputs frozen, until it dies or the room shuts down.
   */
  isDisconnected: boolean = false;
  disconnectedAt: number = 0;
}

/** Synced + internal fields of a player, copied when a Rejoin moves the body to the new connection's key. */
const PLAYER_FIELDS = [
  'id', 'username', 'x', 'y', 'z', 'rotationY', 'stance', 'health', 'maxHealth', 'avatarId', 'isProp', 'propType', 'disguisePropId',
  'isPropSolid', 'primaryWeapon', 'currentWeapon', 'magAmmo', 'reserveAmmo', 'grenadesRemaining', 'isGhost', 'isSpectator', 'kills',
  'deaths', 'chestsCollected', 'sessionEarningsMicroUsd', 'bountyMicroUsd', 'ticketMicroUsd', 'goldenBossMicroUsd', 'medkits', 'lastActiveTime',
  'afkWarningSent', 'afkKicked', 'isDisconnected', 'disconnectedAt',
] as const;

export function clonePlayerState(src: PlayerState, sessionId: string): PlayerState {
  const p = new PlayerState();
  for (const k of PLAYER_FIELDS) (p as any)[k] = (src as any)[k];
  p.sessionId = sessionId;
  return p;
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

export class MedkitState extends Schema {
  @type('string') id: string = '';
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') z: number = 0;
  @type('number') expiresAt: number = 0; // 600 s (10-minute despawn)
}

export class ChestState extends Schema {
  @type('string') id: string = '';
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') z: number = 0;
  @type('number') health: number = 50;
  @type('number') maxHealth: number = 50;
  @type('number') rewardMicroUsd: number = 0; // V1.1: the dead player's ticket value (no fixed reward)
  @type('boolean') isDeathDrop: boolean = false;
  // The dead player's head bounty carried inside their suicide / environmental-death chest
  @type('number') bountyMicroUsd: number = 0;
  @type('number') spawnedAt: number = 0;
  @type('number') expiresAt: number = 0; // 30 min of "nobody within 50 m" time (slides forward while paused)
  /** True while someone alive is within 50 m (the chest's countdown is paused). */
  @type('boolean') timerPaused: boolean = false;
}

export class GameState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: ChestState }) chests = new MapSchema<ChestState>();
  @type({ map: DroppedWeaponState }) droppedWeapons = new MapSchema<DroppedWeaponState>();
  @type({ map: MedkitState }) medkits = new MapSchema<MedkitState>();

  @type('string') mapMode: string = 'mini_30';
  @type('number') mapSizeX: number = 240;
  @type('number') mapSizeZ: number = 240;
  @type('number') activeChestsCount: number = 0;
  @type('number') activePlayersCount: number = 0;
  @type('number') activeDroppedWeaponsCount: number = 0;
}
