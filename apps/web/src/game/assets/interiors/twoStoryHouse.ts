import type { Frame, Kit } from '../kit';
import { GROUND_WINDOW, SLAB_T, STORY, WALL_H, windowsAlong, type StructureInfo } from '../structure';
import { PROPS, type PropId } from '../disguiseProps';
import { placeDisguiseProp } from '../propPlacement';

/**
 * Interior furnishing of the two-storey houses (buildTwo in assets/houses.ts, 10 configs). Called once per placed instance right after the house factory, in the
 * house's own local frame `f`. `variant` is the config index 0..9 (SINGLE_CONFIGS / TWO_CONFIGS in houses.ts).
 * Every object is a Prop-Hunt disguise prop placed with placeDisguiseProp (assets/propPlacement.ts).
 *
 * The layout is computed by a small deterministic planner (no randomness): each wish is tried at its preferred spot and then scanned
 * outwards along the wall; a candidate is rejected when it would leave the room, touch another prop, stand in a door / stair
 * clearance zone, or (for tall props) hide a window. So every variant gets a legal layout that adapts to its own dimensions.
 */

/** Shell geometry of TWO_CONFIGS (assets/houses.ts), duplicated to avoid an import cycle. The geometry test asserts it matches. */
export interface TwoStoryGeom {
  w: number;
  d: number;
  stairSide: 'e' | 'w';
  terrace: boolean;
  balcony: 'front' | 'side' | 'back' | 'wrap' | 'twin';
}
export const TWO_STORY_GEOM: TwoStoryGeom[] = [
  { w: 10, d: 9, stairSide: 'e', terrace: false, balcony: 'front' },
  { w: 10, d: 10, stairSide: 'e', terrace: true, balcony: 'side' },
  { w: 9, d: 10, stairSide: 'e', terrace: false, balcony: 'twin' },
  { w: 11, d: 9.5, stairSide: 'e', terrace: false, balcony: 'back' },
  { w: 10, d: 9, stairSide: 'e', terrace: false, balcony: 'wrap' },
  { w: 11, d: 10, stairSide: 'w', terrace: false, balcony: 'front' },
  { w: 9, d: 9.5, stairSide: 'w', terrace: false, balcony: 'side' },
  { w: 10, d: 10.5, stairSide: 'e', terrace: false, balcony: 'front' },
  { w: 10, d: 10, stairSide: 'w', terrace: true, balcony: 'twin' },
  { w: 12, d: 9.5, stairSide: 'e', terrace: false, balcony: 'back' },
];

export interface PropPlacement {
  id: PropId;
  /** Centre in the house's local frame. */
  x: number;
  z: number;
  quarterTurns: number;
  /** 0 = ground floor, 1 = upper floor. */
  floor: 0 | 1;
}

const T = 0.3; // outer wall thickness (buildStories default)
const WALL_GAP = 0.06; // props stand this far from a wall face (>= 0.05)
const PROP_GAP = 0.05; // minimum space between two props
const DOOR_W = 1.4;
const DOOR_CLEAR = 1.4; // free depth in front of / behind every door
const STAIR_W = 1.3;
const STAIR_CLEAR = 1.2;
const TALL = 0.95; // props taller than this must not stand in front of a window

type Side = 'n' | 's' | 'w' | 'e';
interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

const SIZE = new Map<PropId, [number, number, number]>(PROPS.map((p) => [p.id, p.size]));

const overlap = (a: Rect, b: Rect, gap = 0) => a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.z0 < b.z1 + gap && a.z1 > b.z0 - gap;

/** Rectangle footprint of prop `id` centred at (x,z) with `qt` quarter turns. */
export function footprint(id: PropId, x: number, z: number, qt: number): Rect {
  const [w, d] = SIZE.get(id)!;
  const odd = qt % 2 !== 0;
  const hw = (odd ? d : w) / 2;
  const hd = (odd ? w : d) / 2;
  return { x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd };
}

/** Keep-out zones of one floor, derived from the same rules buildStories / buildTwo use. */
export function floorZones(g: TwoStoryGeom, floor: 0 | 1) {
  const { w, d } = g;
  const hw = w / 2;
  const hd = d / 2;
  const sideLen = d - 2 * T;
  const inner: Rect = { x0: -hw + T + WALL_GAP, x1: hw - T - WALL_GAP, z0: -hd + T + WALL_GAP, z1: hd - T - WALL_GAP };
  const hard: Rect[] = [];
  const windowZones: Rect[] = [];

  // Doors (ground: n at w/2, s at 0.3w; upper: balcony doors, see buildTwo)
  const doors: Record<Side, number[]> = { n: [], s: [], w: [], e: [] };
  if (floor === 0) {
    doors.n = [w / 2];
    doors.s = [w * 0.3];
  } else {
    if (g.balcony === 'front' || g.balcony === 'wrap') doors.n = [w / 2];
    if (g.balcony === 'twin') doors.n = [w * 0.25, w * 0.75];
    if (g.balcony === 'back') doors.s = [w / 2];
    if (g.balcony === 'side' || g.balcony === 'wrap') {
      if (g.stairSide === 'e') doors.w = [sideLen * 0.7];
      else doors.e = [sideLen * 0.7];
    }
  }
  const half = DOOR_W / 2 + 0.2;
  for (const at of doors.n) hard.push({ x0: -hw + at - half, x1: -hw + at + half, z0: -hd, z1: -hd + T + DOOR_CLEAR });
  for (const at of doors.s) hard.push({ x0: -hw + at - half, x1: -hw + at + half, z0: hd - T - DOOR_CLEAR, z1: hd });
  for (const at of doors.w) hard.push({ x0: -hw, x1: -hw + T + DOOR_CLEAR, z0: -hd + T + at - half, z1: -hd + T + at + half });
  for (const at of doors.e) hard.push({ x0: hw - T - DOOR_CLEAR, x1: hw, z0: -hd + T + at - half, z1: -hd + T + at + half });

  // Windows (buildStories: n = max(2, round(w/3)), s = 3, w = e = 2)
  const counts: Record<Side, number> = { n: Math.max(2, Math.round(w / 3)), s: 3, w: 2, e: 2 };
  (['n', 's', 'w', 'e'] as Side[]).forEach((s) => {
    const len = s === 'n' || s === 's' ? w : sideLen;
    const avoid = doors[s].map((at): [number, number] => [at - DOOR_W / 2 - 0.3, at + DOOR_W / 2 + 0.3]);
    const wins = windowsAlong(len, counts[s], { avoid, ...(floor === 0 ? GROUND_WINDOW : {}) });
    for (const o of wins) {
      const a = o.at - o.width / 2 - 0.1;
      const b = o.at + o.width / 2 + 0.1;
      if (s === 'n') windowZones.push({ x0: -hw + a, x1: -hw + b, z0: -hd, z1: -hd + T + 1.0 });
      if (s === 's') windowZones.push({ x0: -hw + a, x1: -hw + b, z0: hd - T - 1.0, z1: hd });
      if (s === 'w') windowZones.push({ x0: -hw, x1: -hw + T + 1.0, z0: -hd + T + a, z1: -hd + T + b });
      if (s === 'e') windowZones.push({ x0: hw - T - 1.0, x1: hw, z0: -hd + T + a, z1: -hd + T + b });
    }
  });

  // Stairs: flight 0 hugs `stairSide` (z0 = front + T + 1.0, run 5); terrace roof flight hugs the other side (visible on the upper floor).
  const run = Math.min(5.0, d - 2 * T - 2.2);
  const zs0 = -hd + T + 1.0;
  const zs1 = zs0 + run;
  const stairBand = (side: 'e' | 'w'): Rect => {
    const xc = side === 'e' ? hw - T - STAIR_W / 2 - 0.02 : -hw + T + STAIR_W / 2 + 0.02;
    return { x0: xc - STAIR_W / 2 - 0.05, x1: xc + STAIR_W / 2 + 0.05, z0: zs0 - 0.05, z1: zs1 };
  };
  const addStair = (side: 'e' | 'w', upper: boolean) => {
    const b = stairBand(side);
    const z0 = b.z0 - STAIR_CLEAR;
    const z1 = b.z1 + STAIR_CLEAR;
    void upper;
    if (side === 'e') hard.push({ x0: b.x0 - STAIR_CLEAR, x1: hw, z0, z1 });
    else hard.push({ x0: -hw, x1: b.x1 + STAIR_CLEAR, z0, z1 });
  };
  if (floor === 0) addStair(g.stairSide, false);
  else {
    addStair(g.stairSide, true); // top landing of flight 0 + well edge
    if (g.terrace) addStair(g.stairSide === 'e' ? 'w' : 'e', true); // foot of the roof flight
  }
  return { inner, hard, windowZones };
}

class Planner {
  readonly out: PropPlacement[] = [];
  private readonly hard: Rect[];
  private readonly windowZones: Rect[];
  private readonly inner: Rect;
  private readonly placed: Rect[] = [];
  private readonly sx: 1 | -1;
  constructor(private readonly g: TwoStoryGeom, private readonly floor: 0 | 1) {
    const z = floorZones(g, floor);
    this.hard = z.hard;
    this.windowZones = z.windowZones;
    this.inner = z.inner;
    this.sx = g.stairSide === 'e' ? 1 : -1;
  }

  get hw() {
    return this.g.w / 2;
  }
  get hd() {
    return this.g.d / 2;
  }

  private ok(id: PropId, x: number, z: number, qt: number): boolean {
    const r = footprint(id, x, z, qt);
    const i = this.inner;
    if (r.x0 < i.x0 - 1e-6 || r.x1 > i.x1 + 1e-6 || r.z0 < i.z0 - 1e-6 || r.z1 > i.z1 + 1e-6) return false;
    for (const h of this.hard) if (overlap(r, h, 0.01)) return false;
    if (SIZE.get(id)![2] > TALL) for (const wz of this.windowZones) if (overlap(r, wz)) return false;
    for (const p of this.placed) if (overlap(r, p, PROP_GAP)) return false;
    return true;
  }

  private commit(id: PropId, x: number, z: number, qt: number) {
    this.placed.push(footprint(id, x, z, qt));
    this.out.push({ id, x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, quarterTurns: ((qt % 4) + 4) % 4, floor: this.floor });
  }

  /** Mirror a template side / coordinate so layouts are written once for "stairs on the east". */
  private side(s: Side): Side {
    if (this.sx === 1) return s;
    return s === 'e' ? 'w' : s === 'w' ? 'e' : s;
  }

  /**
   * Stand `id` against wall `s` (template side), facing into the room, as close as possible to `along`
   * (template coordinate: x for n/s walls, z for w/e walls). Returns true when placed.
   */
  wall(s: Side, id: PropId, along: number): boolean {
    const side = this.side(s);
    const qt = side === 'n' ? 0 : side === 's' ? 2 : side === 'w' ? 1 : 3;
    const [w, d] = SIZE.get(id)!;
    const dep = qt % 2 === 0 ? d : w;
    const len = qt % 2 === 0 ? w : d;
    const a0 = side === 'n' || side === 's' ? along * this.sx : along;
    const i = this.inner;
    const lo = (side === 'n' || side === 's' ? i.x0 : i.z0) + len / 2;
    const hi = (side === 'n' || side === 's' ? i.x1 : i.z1) - len / 2;
    for (let k = 0; k <= 60; k++) {
      for (const sg of k === 0 ? [0] : [1, -1]) {
        const a = Math.min(hi, Math.max(lo, a0 + sg * k * 0.1));
        let x: number;
        let z: number;
        if (side === 'n') [x, z] = [a, i.z0 + dep / 2];
        else if (side === 's') [x, z] = [a, i.z1 - dep / 2];
        else if (side === 'w') [x, z] = [i.x0 + dep / 2, a];
        else [x, z] = [i.x1 - dep / 2, a];
        if (this.ok(id, x, z, qt)) {
          this.commit(id, x, z, qt);
          return true;
        }
      }
    }
    return false;
  }

  /** Free-standing prop at template position (x mirrored with the stairs), scanning a small neighbourhood if blocked. */
  free(id: PropId, x: number, z: number, qt: number): boolean {
    const q = this.sx === 1 || qt % 2 === 0 ? qt : (qt + 2) % 4;
    const xm = x * this.sx;
    for (let k = 0; k <= 8; k++) {
      for (const [dx, dz] of k === 0 ? [[0, 0]] : [[k, 0], [-k, 0], [0, k], [0, -k], [k, k], [-k, k], [k, -k], [-k, -k]]) {
        if (this.ok(id, xm + dx * 0.1, z + dz * 0.1, q)) {
          this.commit(id, xm + dx * 0.1, z + dz * 0.1, q);
          return true;
        }
      }
    }
    return false;
  }
}

/** Ground floor: living room, dining, kitchen run, entry. Written for "stairs on the east". */
function groundFloor(p: Planner, v: number, g: TwoStoryGeom) {
  const hw = g.w / 2;
  const hd = g.d / 2;
  const lv = v % 3;
  // Living room
  if (lv === 0) {
    p.wall('w', 'tv_stand', -0.3);
    p.free('sofa', -hw + 3.3, -0.3, 3);
    p.wall('w', 'flower_pot', -hd + 1.0);
    p.wall('w', 'planter_box', hd - 2.0);
  } else if (lv === 1) {
    p.wall('w', 'tv_stand', 0.9);
    p.free('sofa', -hw + 3.3, 0.9, 3);
    p.wall('w', 'flower_pot', -hd + 1.0);
    p.wall('n', 'planter_box', -hw + 1.4);
  } else {
    p.wall('n', 'tv_stand', -hw + 2.3);
    p.free('sofa', -hw + 2.3, -hd + 3.3, 2);
    p.wall('w', 'park_bench', 1.2);
    p.wall('n', 'flower_pot', -hw + 0.8);
  }
  p.free('potted_tree', -hw + 1.0, hd - 1.0, 0);
  // Dining (office desk as table + chairs)
  const dz = 1.9 + (v % 2) * 0.4;
  p.free('office_desk', 0.7, dz, 0);
  p.free('office_chair', 0.7, dz - 0.95, 0);
  p.free('office_chair', 0.7, dz + 0.95, 2);
  // Kitchen run along the back wall (east end)
  p.wall('s', 'metal_locker', hw);
  p.wall('s', 'filing_cabinet', hw);
  p.wall('s', 'trash_bin', hw);
  p.wall('s', 'water_cooler', 0.5);
  // Pantry / mudroom
  p.wall('w', 'storage_shelf', hd);
  p.wall('n', 'wooden_pallet', hw);
  p.wall('n', 'cardboard_box', 0.9);
  p.wall('s', 'cardboard_box', -hw);
}

/** Upper floor: bedrooms, study, lounge. Written for "stairs on the east". */
function upperFloor(p: Planner, v: number, g: TwoStoryGeom) {
  const hw = g.w / 2;
  const hd = g.d / 2;
  // Bedroom on the free side
  void (p.wall('w', 'bunk_bed', -hd + 2.4) || p.wall('n', 'bunk_bed', -hw + 3.0) || p.wall('s', 'bunk_bed', -hw + 3.0) || p.wall('e', 'bunk_bed', hd) || p.free('bunk_bed', -1.5, -0.8, 1) || p.free('bunk_bed', 1.5, -0.8, 3));
  p.wall('w', 'metal_locker', -hd + 4.4);
  p.wall('w', 'filing_cabinet', -hd + 0.9);
  p.wall('n', 'flower_pot', -hw + 0.8);
  // Study
  p.wall('s', 'office_desk', -hw + 1.6);
  p.free('office_chair', -hw + 1.8, hd - 1.6, 0);
  p.wall('s', 'storage_shelf', -hw);
  p.wall('s', 'filing_cabinet', 0);
  // Lounge
  if (v % 2 === 0) {
    p.wall('n', 'tv_stand', 0);
    p.free('sofa', 0, -hd + 3.3, 2);
  } else {
    p.wall('s', 'tv_stand', 1.0);
    p.free('sofa', 0.6, hd - 3.3, 0);
  }
  p.wall('n', 'potted_tree', hw);
  p.wall('s', 'trash_bin', hw);
  p.wall('s', 'cardboard_box', hw);
  p.wall('e', 'cardboard_box', hd);
}

const cache = new Map<number, PropPlacement[]>();

/** Pure, deterministic layout of both floors of two-storey house `variant` (0..9), in the house's local frame. */
export function layoutTwoStory(variant: number): PropPlacement[] {
  const v = ((variant % TWO_STORY_GEOM.length) + TWO_STORY_GEOM.length) % TWO_STORY_GEOM.length;
  let out = cache.get(v);
  if (out) return out;
  const g = TWO_STORY_GEOM[v];
  const ground = new Planner(g, 0);
  groundFloor(ground, v, g);
  const upper = new Planner(g, 1);
  upperFloor(upper, v, g);
  out = [...ground.out, ...upper.out];
  cache.set(v, out);
  return out;
}

/** Walking surface heights (local): ground floor 0, upper floor = slab top (WALL_H + SLAB_T = STORY). */
export const FLOOR_Y: [number, number] = [0, WALL_H + SLAB_T];
void STORY;

export function furnish(kit: Kit, f: Frame, info: StructureInfo, variant: number): void {
  void info;
  for (const p of layoutTwoStory(variant)) {
    placeDisguiseProp(kit, f, p.id, p.x, FLOOR_Y[p.floor], p.z, p.quarterTurns);
  }
}
