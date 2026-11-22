import * as THREE from 'three';
import { CollisionWorld, MoveBody } from '../physics/collision';
import { NavNode } from '../assets/mapLayout';
import { animateCharacter, createCharacter, CharacterRig, randomCharacterId } from '../assets/characters';
import { PRIMARY_IDS, PrimaryId, WEAPONS } from '../weapons';
import { CombatEffects } from '../effects';

/**
 * Single-player tactical AI ("70 % skill" bots) for the Practice Range / Energy Recharge mode.
 *
 * Behaviour per bot (finite-state machine):
 *  PATROL   – walk the street navigation graph (or hold an elevated overwatch post)
 *  ENGAGE   – line-of-sight confirmed (walls block it) → human-like reaction delay, strafe,
 *             burst fire with ~70 % base accuracy (falls off with range / target movement)
 *  COVER    – when hurt, move to a nearby node without LOS to the player, then re-peek
 *  SEARCH   – lost sight: move to the last known position, then resume patrol
 *  DEAD     – fall over, respawn out of sight after a delay
 */

export type BotState = 'patrol' | 'engage' | 'cover' | 'search' | 'dead';

export interface BotTargetInfo {
  /** Player feet position. */
  position: THREE.Vector3;
  /** Player eye position. */
  eye: THREE.Vector3;
  speed: number;
  crouching: boolean;
  alive: boolean;
  /** Prop disguise makes the player much harder to notice. */
  disguised: boolean;
}

export interface BotEvents {
  onPlayerHit(damage: number, from: THREE.Vector3, botName: string): void;
  onShot?(from: THREE.Vector3): void;
}

interface Bot {
  id: number;
  name: string;
  rig: CharacterRig;
  weapon: PrimaryId;
  crouchT: number;
  deathPos: THREE.Vector3;
  body: MoveBody;
  yaw: number;
  hp: number;
  state: BotState;
  kind: 'patrol' | 'overwatch';
  post: THREE.Vector3 | null;
  node: number;
  targetNode: number;
  coverPoint: THREE.Vector3 | null;
  stateTime: number;
  seenTime: number;
  reaction: number;
  lastSeen: THREE.Vector3;
  lastSeenAt: number;
  hasLos: boolean;
  burstLeft: number;
  shotTimer: number;
  strafeDir: number;
  strafeTimer: number;
  stuckTimer: number;
  lastPos: THREE.Vector3;
  deadTime: number;
  thinkTimer: number;
  alertedUntil: number;
  speed: number;
  animT: number;
}

const CALLSIGNS = ['Viper', 'Ghost', 'Rook', 'Falcon', 'Havoc', 'Nomad', 'Raven', 'Specter', 'Bishop', 'Cobra', 'Wolf', 'Echo'];

export interface BotManagerOptions {
  count: number;
  /** Base hit probability of a single shot (0.7 = 70 % skill). */
  accuracy: number;
  playerHalf: number;
  /** Pool of valid spawn points (streets, courtyards, houses, rooftops). */
  spawnPoints: THREE.Vector3[];
}

/** Overwatch bots favour the sniper; street patrols carry assault rifles / SMGs. */
function pickBotWeapon(overwatch: boolean): PrimaryId {
  if (overwatch) return Math.random() < 0.6 ? 'sniper' : PRIMARY_IDS[Math.floor(Math.random() * PRIMARY_IDS.length)];
  const street: PrimaryId[] = ['ak47', 'm16', 'uzi', 'ak47', 'm16'];
  return street[Math.floor(Math.random() * street.length)];
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

export class BotManager {
  readonly bots: Bot[] = [];
  private group = new THREE.Group();
  private time = 0;
  private hitMeshes: THREE.Object3D[] = [];
  private activeShooters = 0;

  constructor(
    scene: THREE.Scene,
    private world: CollisionWorld,
    private nav: NavNode[],
    private posts: THREE.Vector3[],
    private effects: CombatEffects,
    private events: BotEvents,
    private opts: BotManagerOptions
  ) {
    scene.add(this.group);
    // Pick overwatch posts spread across the map (about a third of the squad)
    const postPool = posts.slice().sort(() => Math.random() - 0.5);
    const overwatchCount = Math.min(postPool.length, Math.round(opts.count * 0.35));
    for (let i = 0; i < opts.count; i++) {
      const overwatch = i < overwatchCount;
      const weapon = pickBotWeapon(overwatch);
      const rig = createCharacter(randomCharacterId(), { name: `BOT ${CALLSIGNS[i % CALLSIGNS.length]}`, weapon });
      rig.hitMeshes.forEach((m) => (m.userData.botId = i));
      this.hitMeshes.push(...rig.hitMeshes);
      this.group.add(rig.root);
      const node = Math.floor(Math.random() * nav.length);
      const bot: Bot = {
        id: i,
        name: CALLSIGNS[i % CALLSIGNS.length],
        rig,
        weapon,
        crouchT: 0,
        deathPos: new THREE.Vector3(),
        body: { x: 0, y: 0, z: 0, velY: 0, onGround: true, radius: 0.38, height: 1.8 },
        yaw: Math.random() * Math.PI * 2,
        hp: 100,
        state: 'patrol',
        kind: overwatch ? 'overwatch' : 'patrol',
        post: overwatch ? postPool[i].clone() : null,
        node,
        targetNode: node,
        coverPoint: null,
        stateTime: 0,
        seenTime: 0,
        reaction: 0.35 + Math.random() * 0.35,
        lastSeen: new THREE.Vector3(),
        lastSeenAt: -100,
        hasLos: false,
        burstLeft: 0,
        shotTimer: 0,
        strafeDir: Math.random() < 0.5 ? -1 : 1,
        strafeTimer: 0,
        stuckTimer: 0,
        lastPos: new THREE.Vector3(),
        deadTime: 0,
        thinkTimer: Math.random() * 0.2,
        alertedUntil: 0,
        speed: 0,
        animT: Math.random() * 10,
      };
      this.bots.push(bot);
      this.respawn(bot, null);
    }
  }

  get targets(): THREE.Object3D[] {
    return this.hitMeshes;
  }

  aliveCount() {
    return this.bots.filter((b) => b.state !== 'dead').length;
  }

  botById(id: number) {
    return this.bots[id];
  }

  /**
   * Random respawn: pick a point from the spawn pool that is far from where the bot died, away
   * from the player and out of the player's direct line of sight. Overwatch bots take a random
   * free rooftop post instead of always the same one.
   */
  private respawn(bot: Bot, player: BotTargetInfo | null) {
    bot.hp = 100;
    bot.state = 'patrol';
    bot.stateTime = 0;
    bot.seenTime = 0;
    bot.burstLeft = 0;
    bot.coverPoint = null;
    bot.crouchT = 0;
    bot.rig.root.visible = true;
    bot.rig.body.rotation.set(0, 0, 0);
    bot.yaw = Math.random() * Math.PI * 2;
    // Fresh primary for the new life
    const weapon = pickBotWeapon(bot.kind === 'overwatch');
    if (weapon !== bot.weapon) {
      bot.weapon = weapon;
      bot.rig.setWeapon(weapon);
    }
    const hasDeath = bot.deathPos.lengthSq() > 0;
    const ok = (c: THREE.Vector3, minDeath: number, minPlayer: number) => {
      if (hasDeath && c.distanceTo(bot.deathPos) < minDeath) return false;
      if (this.bots.some((o) => o !== bot && o.state !== 'dead' && Math.hypot(o.body.x - c.x, o.body.z - c.z) < 4)) return false;
      if (!player) return true;
      if (c.distanceTo(player.position) < minPlayer) return false;
      return !this.world.lineOfSight(c.x, c.y + 1.6, c.z, player.eye.x, player.eye.y, player.eye.z);
    };
    let p: THREE.Vector3 | null = null;
    if (bot.kind === 'overwatch' && this.posts.length) {
      const taken = new Set(this.bots.filter((o) => o !== bot && o.post).map((o) => o.post));
      const free = this.posts.filter((q) => !Array.from(taken).some((t) => t && t.distanceTo(q) < 1));
      const shuffled = free.sort(() => Math.random() - 0.5);
      p = shuffled.find((c) => ok(c, 30, 25)) ?? shuffled.find((c) => ok(c, 0, 15)) ?? null;
      if (p) bot.post = p.clone();
    }
    if (!p) {
      const pool = this.opts.spawnPoints.length ? this.opts.spawnPoints : this.nav.map((n) => n.p);
      const shuffled = pool.slice().sort(() => Math.random() - 0.5);
      p = shuffled.find((c) => ok(c, 40, 35)) ?? shuffled.find((c) => ok(c, 20, 20)) ?? shuffled[0];
      if (bot.kind === 'overwatch') bot.post = null;
    }
    bot.node = this.nearestNode(p);
    bot.targetNode = bot.node;
    bot.body.x = p.x;
    bot.body.y = p.y;
    bot.body.z = p.z;
    bot.body.velY = 0;
    bot.body.onGround = true;
    bot.lastPos.set(p.x, p.y, p.z);
  }

  private nearestNode(p: THREE.Vector3) {
    let best = 0;
    let bd = Infinity;
    for (const n of this.nav) {
      const d = n.p.distanceToSquared(p);
      if (d < bd) {
        bd = d;
        best = n.id;
      }
    }
    return best;
  }

  private eye(bot: Bot, out: THREE.Vector3) {
    return out.set(bot.body.x, bot.body.y + 1.6, bot.body.z);
  }

  /** Apply player damage to a bot. Returns true if this shot eliminated it. */
  damage(botId: number, amount: number, from: THREE.Vector3): boolean {
    const bot = this.bots[botId];
    if (!bot || bot.state === 'dead') return false;
    bot.hp -= amount;
    bot.alertedUntil = this.time + 4;
    bot.lastSeen.copy(from);
    bot.lastSeenAt = this.time;
    bot.seenTime = Math.max(bot.seenTime, bot.reaction * 0.6); // react faster when shot
    if (bot.hp <= 0) {
      bot.state = 'dead';
      bot.deathPos.set(bot.body.x, bot.body.y, bot.body.z);
      bot.deadTime = 0;
      bot.stateTime = 0;
      return true;
    }
    if (bot.hp < 45 && bot.kind === 'patrol' && bot.state !== 'cover') this.enterCover(bot, from);
    return false;
  }

  private enterCover(bot: Bot, threat: THREE.Vector3) {
    const here = tmpA.set(bot.body.x, 0, bot.body.z);
    let best: THREE.Vector3 | null = null;
    let bestD = Infinity;
    for (const n of this.nav) {
      const d = n.p.distanceTo(here);
      if (d > 22 || d < 2) continue;
      if (this.world.lineOfSight(n.p.x, 1.5, n.p.z, threat.x, threat.y, threat.z)) continue;
      if (d < bestD) {
        bestD = d;
        best = n.p;
      }
    }
    if (best) {
      bot.coverPoint = best.clone();
      bot.state = 'cover';
      bot.stateTime = 0;
    }
  }

  private moveToward(bot: Bot, tx: number, tz: number, speed: number, dt: number) {
    const dx = tx - bot.body.x;
    const dz = tz - bot.body.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return d;
    const step = Math.min(d, speed * dt);
    this.world.moveBody(bot.body, (dx / d) * step, (dz / d) * step, dt);
    return d;
  }

  private faceToward(bot: Bot, tx: number, tz: number, rate: number, dt: number) {
    const target = Math.atan2(-(tx - bot.body.x), -(tz - bot.body.z));
    let diff = target - bot.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    bot.yaw += THREE.MathUtils.clamp(diff, -rate * dt, rate * dt);
    return Math.abs(diff);
  }

  private canSee(bot: Bot, player: BotTargetInfo): boolean {
    if (!player.alive) return false;
    const eye = this.eye(bot, tmpA);
    const dist = eye.distanceTo(player.eye);
    const maxRange = player.disguised ? 9 : bot.kind === 'overwatch' ? 85 : 70;
    if (dist > maxRange) return false;
    const alerted = this.time < bot.alertedUntil;
    if (!alerted && dist > 10) {
      const fx = -Math.sin(bot.yaw);
      const fz = -Math.cos(bot.yaw);
      const dx = (player.eye.x - eye.x) / dist;
      const dz = (player.eye.z - eye.z) / dist;
      if (fx * dx + fz * dz < Math.cos(THREE.MathUtils.degToRad(68))) return false;
    }
    // Check head and chest so peeking over cover still gets spotted.
    if (this.world.lineOfSight(eye.x, eye.y, eye.z, player.eye.x, player.eye.y, player.eye.z)) return true;
    return this.world.lineOfSight(eye.x, eye.y, eye.z, player.position.x, player.position.y + 1.0, player.position.z);
  }

  private shoot(bot: Bot, player: BotTargetInfo) {
    const muzzle = bot.rig.muzzle.getWorldPosition(tmpA);
    const dist = muzzle.distanceTo(player.eye);
    // 70 % skill: base accuracy with fall-off for range and target / shooter movement
    let p = this.opts.accuracy;
    p *= THREE.MathUtils.clamp(1.12 - dist / 110, 0.5, 1);
    if (player.speed > 4) p *= 0.8;
    else if (player.speed > 1) p *= 0.9;
    if (player.crouching) p *= 0.88;
    if (bot.speed > 1) p *= 0.88;
    if (bot.seenTime < bot.reaction + 0.6) p *= 0.75; // first shots less accurate
    const def = WEAPONS[bot.weapon];
    if (bot.weapon === 'uzi') p *= THREE.MathUtils.clamp(1.2 - dist / 40, 0.35, 1);
    if (bot.weapon === 'sniper') p = Math.min(0.9, p * (dist > 25 ? 1.15 : 0.8));
    const chest = tmpB.set(player.position.x, player.position.y + (player.crouching ? 0.8 : 1.25), player.position.z);
    const clear = this.world.lineOfSight(muzzle.x, muzzle.y, muzzle.z, chest.x, chest.y, chest.z);
    const hit = clear && Math.random() < p;
    const end = chest.clone();
    if (!hit) {
      end.x += (Math.random() - 0.5) * 2.4;
      end.y += (Math.random() - 0.2) * 1.4;
      end.z += (Math.random() - 0.5) * 2.4;
      const dir = end.clone().sub(muzzle).normalize();
      const wall = this.world.raycast(muzzle.x, muzzle.y, muzzle.z, dir.x, dir.y, dir.z, 120);
      if (wall) {
        end.set(wall.point.x, wall.point.y, wall.point.z);
        this.effects.impact(end, new THREE.Vector3(wall.normal.x, wall.normal.y, wall.normal.z));
      } else end.addScaledVector(dir, 30);
    }
    this.effects.tracer(muzzle.clone(), end, true);
    this.events.onShot?.(muzzle.clone());
    if (hit) this.events.onPlayerHit(Math.max(4, Math.round(def.damage * 0.3 * (0.85 + Math.random() * 0.3))), muzzle.clone(), bot.name);
  }

  update(dt: number, player: BotTargetInfo) {
    this.time += dt;
    this.activeShooters = 0;
    for (const bot of this.bots) {
      bot.stateTime += dt;
      bot.animT += dt;
      const prevX = bot.body.x;
      const prevZ = bot.body.z;

      if (bot.state === 'dead') {
        bot.deadTime += dt;
        const fall = Math.min(1, bot.deadTime / 0.45);
        bot.rig.body.rotation.x = -fall * (Math.PI / 2);
        bot.rig.body.position.y = -fall * 0.1;
        if (bot.deadTime > 2.6) bot.rig.root.visible = false;
        if (bot.deadTime > 7) this.respawn(bot, player);
        this.syncRig(bot, 0, false);
        continue;
      }

      // Perception (throttled ~6 Hz)
      bot.thinkTimer -= dt;
      if (bot.thinkTimer <= 0) {
        bot.thinkTimer = 0.16;
        bot.hasLos = this.canSee(bot, player);
        if (bot.hasLos) {
          bot.lastSeen.copy(player.eye);
          bot.lastSeenAt = this.time;
          if (bot.state === 'patrol' || bot.state === 'search') {
            bot.state = 'engage';
            bot.stateTime = 0;
            bot.alertedUntil = this.time + 5;
          }
        }
      }
      if (bot.hasLos) bot.seenTime += dt;
      else bot.seenTime = Math.max(0, bot.seenTime - dt * 0.5);

      let aiming = false;
      switch (bot.state) {
        case 'patrol': {
          if (bot.kind === 'overwatch' && bot.post) {
            // Scan the area slowly
            bot.yaw += Math.sin(bot.animT * 0.4) * 0.5 * dt;
            this.moveToward(bot, bot.post.x, bot.post.z, 1.2, dt);
          } else {
            const target = this.nav[bot.targetNode]?.p;
            if (!target) break;
            const d = this.moveToward(bot, target.x, target.z, 2.6, dt);
            this.faceToward(bot, target.x, target.z, 5, dt);
            if (d < 0.8) {
              bot.node = bot.targetNode;
              const links = this.nav[bot.node].links;
              bot.targetNode = links.length ? links[Math.floor(Math.random() * links.length)] : bot.node;
            }
          }
          break;
        }
        case 'engage': {
          aiming = true;
          const tx = bot.lastSeen.x;
          const tz = bot.lastSeen.z;
          this.faceToward(bot, tx, tz, 4.5, dt);
          if (!bot.hasLos && this.time - bot.lastSeenAt > 2.5) {
            bot.state = 'search';
            bot.stateTime = 0;
            break;
          }
          // Strafe / spacing
          bot.strafeTimer -= dt;
          if (bot.strafeTimer <= 0) {
            bot.strafeDir = Math.random() < 0.5 ? -1 : 1;
            bot.strafeTimer = 0.7 + Math.random() * 1.0;
          }
          const dist = Math.hypot(tx - bot.body.x, tz - bot.body.z);
          const fx = (tx - bot.body.x) / Math.max(0.01, dist);
          const fz = (tz - bot.body.z) / Math.max(0.01, dist);
          let mx = -fz * bot.strafeDir;
          let mz = fx * bot.strafeDir;
          if (bot.kind === 'patrol') {
            if (dist > 32) {
              mx += fx * 1.2;
              mz += fz * 1.2;
            } else if (dist < 8) {
              mx -= fx;
              mz -= fz;
            }
            const len = Math.hypot(mx, mz) || 1;
            this.world.moveBody(bot.body, (mx / len) * 2.6 * dt, (mz / len) * 2.6 * dt, dt);
          } else if (bot.post) {
            // Overwatch: shuffle sideways but never walk off the roof edge
            const nx = bot.body.x + mx * 1.4 * dt;
            const nz = bot.body.z + mz * 1.4 * dt;
            const ground = this.world.groundHeightAt(nx, nz, bot.body.radius, bot.body.y + 0.3);
            if (Math.hypot(nx - bot.post.x, nz - bot.post.z) < 2.2 && Math.abs(ground - bot.post.y) < 0.4) {
              this.world.moveBody(bot.body, mx * 1.4 * dt, mz * 1.4 * dt, dt);
            } else bot.strafeDir *= -1;
          }
          // Fire bursts after a human-like reaction delay
          if (bot.hasLos && bot.seenTime >= bot.reaction && player.alive && this.activeShooters < 3) {
            this.activeShooters++;
            bot.shotTimer -= dt;
            if (bot.shotTimer <= 0) {
              const def = WEAPONS[bot.weapon];
              if (bot.burstLeft <= 0) {
                bot.burstLeft = bot.weapon === 'sniper' ? 1 : bot.weapon === 'uzi' ? 5 + Math.floor(Math.random() * 4) : 3 + Math.floor(Math.random() * 3);
              }
              this.shoot(bot, player);
              bot.burstLeft--;
              const pause = bot.weapon === 'sniper' ? 1.8 + Math.random() * 1.2 : 0.55 + Math.random() * 0.7;
              bot.shotTimer = bot.burstLeft > 0 ? def.fireInterval * 1.15 + Math.random() * 0.03 : pause;
            }
          }
          break;
        }
        case 'cover': {
          aiming = false;
          if (bot.coverPoint) {
            const d = this.moveToward(bot, bot.coverPoint.x, bot.coverPoint.z, 4.2, dt);
            this.faceToward(bot, bot.coverPoint.x, bot.coverPoint.z, 6, dt);
            if (d < 0.8 && bot.stateTime > 2.2 + Math.random()) {
              bot.state = 'search';
              bot.stateTime = 0;
              bot.hp = Math.min(100, bot.hp + 25); // patched up behind cover
            }
          }
          if (bot.stateTime > 6) {
            bot.state = 'search';
            bot.stateTime = 0;
          }
          break;
        }
        case 'search': {
          if (bot.kind === 'overwatch' && bot.post) {
            this.faceToward(bot, bot.lastSeen.x, bot.lastSeen.z, 3, dt);
            this.moveToward(bot, bot.post.x, bot.post.z, 1.5, dt);
          } else {
            const d = this.moveToward(bot, bot.lastSeen.x, bot.lastSeen.z, 3.0, dt);
            this.faceToward(bot, bot.lastSeen.x, bot.lastSeen.z, 5, dt);
            if (d < 1.5) bot.stateTime += dt * 2;
          }
          if (bot.stateTime > 7) {
            bot.state = 'patrol';
            bot.stateTime = 0;
            if (bot.kind === 'patrol') {
              bot.node = this.nearestNode(tmpA.set(bot.body.x, 0, bot.body.z));
              bot.targetNode = bot.node;
            }
          }
          break;
        }
      }

      // Stuck detection for patrols → pick another node
      const moved = Math.hypot(bot.body.x - prevX, bot.body.z - prevZ);
      bot.speed = moved / Math.max(dt, 1e-4);
      if (bot.state === 'patrol' && bot.kind === 'patrol') {
        bot.stuckTimer = moved < 0.2 * dt ? bot.stuckTimer + dt : 0;
        if (bot.stuckTimer > 1.4) {
          bot.stuckTimer = 0;
          const links = this.nav[bot.node]?.links ?? [];
          bot.targetNode = links.length ? links[Math.floor(Math.random() * links.length)] : this.nearestNode(tmpA.set(bot.body.x, 0, bot.body.z));
        }
      }
      // Keep inside the arena
      this.world.clampToBounds(bot.body, 1.2);
      // Gravity when not moving this frame
      if (moved === 0) this.world.moveBody(bot.body, 0, 0, dt);
      // Crouch behind cover once there
      const wantCrouch = bot.state === 'cover' && !!bot.coverPoint && Math.hypot(bot.coverPoint.x - bot.body.x, bot.coverPoint.z - bot.body.z) < 1 ? 1 : 0;
      bot.crouchT = THREE.MathUtils.damp(bot.crouchT, wantCrouch, 6, dt);
      this.syncRig(bot, bot.speed, aiming);
    }
  }

  /** Explosion damage to every bot within radius (occluded by solid walls). Returns killed ids. */
  explosion(center: THREE.Vector3, radius: number, maxDamage: number): number[] {
    const killed: number[] = [];
    for (const bot of this.bots) {
      if (bot.state === 'dead') continue;
      const c = tmpA.set(bot.body.x, bot.body.y + 1.0, bot.body.z);
      const d = c.distanceTo(center);
      if (d > radius) continue;
      if (!this.world.lineOfSight(center.x, center.y + 0.2, center.z, c.x, c.y, c.z)) continue;
      const dmg = maxDamage * (1 - d / radius) ** 0.8;
      if (this.damage(bot.id, dmg, center)) killed.push(bot.id);
    }
    return killed;
  }

  private syncRig(bot: Bot, speed: number, aiming: boolean) {
    bot.rig.root.position.set(bot.body.x, bot.body.y, bot.body.z);
    bot.rig.root.rotation.y = bot.yaw;
    if (bot.state !== 'dead') animateCharacter(bot.rig, bot.animT, speed, aiming, bot.crouchT);
  }

  dispose() {
    this.bots.forEach((b) => b.rig.dispose());
    this.group.parent?.remove(this.group);
  }
}

void tmpB;
