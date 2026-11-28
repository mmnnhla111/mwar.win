/**
 * Server-authoritative ballistics (audit H1, spec §5.1 / §5.4 / §6).
 *
 * A `player_shoot` hit is accepted only when the SERVER agrees with it:
 *   1. range   — shooter eye → target is within the weapon's range (+10 % + 2 m latency tolerance)
 *   2. aim     — the target lies inside the aim cone of where the shooter is facing
 *   3. sight   — at least one point of the target (the claimed hit point, head, chest, hip, feet) is visible
 *                from the shooter's eye through every static bullet-blocking box of the map (buildings, walls,
 *                cover, solid stairs, props — generated from the client builders) and above the terrain
 *   4. headshot — decided here from the visible hit point's height on the target's stance, never from the
 *                client's `headshot` flag
 * The module is pure (no Colyseus): the ballistics tests call it directly.
 */
import {
  AabbIndex,
  SHOT_AIM_CONE_DEG,
  largeMapTerrainHeight,
  segmentBelowTerrain,
  weaponMaxShotRange,
} from '@mwar/shared';
import obstacles from './maps/obstacles.json';

let smallIdx: AabbIndex | null = null;
let largeIdx: AabbIndex | null = null;
/** Static bullet-blocking boxes of a map (built once per process). */
export function obstacleIndexForMap(large: boolean): AabbIndex {
  if (large) return (largeIdx ??= new AabbIndex((obstacles as { large: number[] }).large));
  return (smallIdx ??= new AabbIndex((obstacles as { small: number[] }).small));
}

export const EYE_HEIGHT: Record<string, number> = { stand: 1.7, crouch: 1.05, prone: 0.4 };
export const BODY_HEIGHT: Record<string, number> = { stand: 1.8, crouch: 1.2, prone: 0.5 };
/** Head zone starts at this share of the body height (client rig: head ≈ top 16 % standing / crouching). */
const HEAD_FROM = 0.84;
/** Ignore obstacle contacts this close to either end (window sill / floor under the target). */
const END_MARGIN = 0.35;

export interface ShotActor {
  x: number;
  y: number;
  z: number;
  stance?: string;
  rotationY?: number;
  isProp?: boolean;
}

export interface ShotInput {
  shooter: ShotActor;
  target: ShotActor;
  weapon: string;
  /** Where the client says its ray met the target (optional; validated against the target's hit volume). */
  hit?: { x: number; y: number; z: number } | null;
  /** The shooter's camera yaw at the moment of the shot (accepted within 90° of the last reported yaw). */
  aimYaw?: number | null;
  largeMap: boolean;
}

export type ShotReject = 'range' | 'aim' | 'blocked';
export interface ShotResult {
  ok: boolean;
  reason?: ShotReject;
  headshot: boolean;
  distance: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const angleDiff = (a: number, b: number) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
};

function visible(eye: [number, number, number], p: [number, number, number], large: boolean): boolean {
  const idx = obstacleIndexForMap(large);
  if (idx.blocksSegment(eye[0], eye[1], eye[2], p[0], p[1], p[2], END_MARGIN)) return false;
  if (large && segmentBelowTerrain(largeMapTerrainHeight, eye[0], eye[1], eye[2], p[0], p[1], p[2])) return false;
  return true;
}

export function validateShot(s: ShotInput): ShotResult {
  const sh = s.shooter;
  const tg = s.target;
  const stance = sh.stance && EYE_HEIGHT[sh.stance] !== undefined ? sh.stance : 'stand';
  const tStance = tg.stance && BODY_HEIGHT[tg.stance] !== undefined ? tg.stance : 'stand';
  const eye: [number, number, number] = [sh.x, sh.y + EYE_HEIGHT[stance], sh.z];
  const h = tg.isProp ? 1.6 : BODY_HEIGHT[tStance];
  const chest: [number, number, number] = [tg.x, tg.y + h * 0.55, tg.z];
  const distance = Math.hypot(chest[0] - eye[0], chest[1] - eye[1], chest[2] - eye[2]);

  // 1. range
  if (distance > weaponMaxShotRange(s.weapon)) return { ok: false, reason: 'range', headshot: false, distance };

  // 2. aim cone (forward = (-sin yaw, -cos yaw), the client camera convention)
  const horiz = Math.hypot(tg.x - sh.x, tg.z - sh.z);
  if (horiz > 2 && finite(sh.rotationY)) {
    const yaw = finite(s.aimYaw) && angleDiff(s.aimYaw, sh.rotationY) <= Math.PI / 2 ? s.aimYaw : sh.rotationY;
    const toTarget = Math.atan2(-(tg.x - sh.x), -(tg.z - sh.z));
    const allowed = (SHOT_AIM_CONE_DEG * Math.PI) / 180 + Math.atan2(tg.isProp ? 1.5 : 0.8, horiz);
    if (angleDiff(toTarget, yaw) > allowed) return { ok: false, reason: 'aim', headshot: false, distance };
  }

  // 3. line of sight — the claimed hit point first (only if it lies on the target's hit volume)
  let hit: [number, number, number] | null = null;
  if (s.hit && finite(s.hit.x) && finite(s.hit.y) && finite(s.hit.z)) {
    const r = Math.hypot(s.hit.x - tg.x, s.hit.z - tg.z);
    const rel = s.hit.y - tg.y;
    const maxR = tg.isProp ? 3 : 1.0;
    if (r <= maxR && rel >= -0.4 && rel <= h + 0.4) hit = [s.hit.x, s.hit.y, s.hit.z];
  }
  if (hit && visible(eye, hit, s.largeMap)) {
    const headshot = !tg.isProp && tStance !== 'prone' && hit[1] - tg.y >= h * HEAD_FROM;
    return { ok: true, headshot, distance };
  }
  const samples: Array<[number, number, number]> = [[tg.x, tg.y + h * 0.92, tg.z], chest, [tg.x, tg.y + h * 0.3, tg.z], [tg.x, tg.y + 0.12, tg.z]];
  for (const p of samples) if (visible(eye, p, s.largeMap)) return { ok: true, headshot: false, distance };
  return { ok: false, reason: 'blocked', headshot: false, distance };
}
