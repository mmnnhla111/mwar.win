import { Frame, Kit } from './kit';
import type { CollisionWorld } from '../physics/collision';
import { propDef, type PropId } from './disguiseProps';
import { placeDisguiseProp } from './propPlacement';
import type { StructureInfo } from './structure';

/**
 * Natural street / intersection / building-exterior population with REAL Prop-Hunt disguise props
 * (bench, trash bin, dumpster, hydrant, utility box, planter, mailbox, cones, bollards, pallets, crates,
 * drums, tyres, road barriers, sandbags, potted trees) so a hider morphed into one of them blends in outdoors.
 *
 * Both maps share this module:
 *  - assets/mapLayout.ts  → populateSmallMapStreetProps (240 m Metro Block)
 *  - maps/largeMap.ts     → populateLargeMapStreetProps (960 m Grand Valley: 2 cities, 5 towns, 10 villages, highways)
 *
 * Every object goes through placeDisguiseProp. Placement is fully deterministic (own integer hash, no
 * Math.random, no use of the map builders' RNG streams) and every candidate is validated first:
 *   - sits exactly on the surface it stands on (sidewalk 0.08, plaza 0.06, grass / terrain), never straddling two
 *   - never inside roads / kerbs, building footprints, existing colliders (cars, lights, trees, walls...), stairs
 *   - never in front of a door (entrance corridor), never next to a wall opening (probed in the collision world)
 *   - never overlaps another street prop
 */

export interface StreetPropRecord {
  map: 'small' | 'large';
  id: PropId;
  /** Base centre + base height (the surface the prop stands on). */
  x: number;
  y: number;
  z: number;
  turns: number;
  /** Half extents of the world-space AABB footprint, and prop height. */
  hx: number;
  hz: number;
  h: number;
  solid: boolean;
  tag: string;
}

/** Debug / test hook: every street prop placed by the last build of each map. */
export const streetPropDebug: { small: StreetPropRecord[]; large: StreetPropRecord[]; stats: Record<string, number> } = { small: [], large: [], stats: {} };
const stat = (k: string) => {
  streetPropDebug.stats[k] = (streetPropDebug.stats[k] ?? 0) + 1;
};

interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
interface Disc {
  x: number;
  z: number;
  r: number;
}
export interface OpenLotInfo {
  x: number;
  z: number;
  /** Quarter turns so that local -z faces the street. */
  turns: number;
  /** i % 4 as used by the map builders: 0 / 2 park, 1 tactical yard, 3 parking. */
  type: number;
}

// ---------------------------------------------------------------------------------------------------------
// Deterministic hash (never Math.random)
// ---------------------------------------------------------------------------------------------------------

function hash(...n: number[]): number {
  let h = 2166136261 >>> 0;
  for (const v of n) {
    h ^= Math.round(v * 8) | 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 2246822519) >>> 0;
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 3266489917) >>> 0;
  return (h >>> 0) / 4294967296;
}

/** Quarter turns so that a prop's / building's front (local -z) faces the direction (dx, dz). */
function turnsToward(dx: number, dz: number) {
  if (Math.abs(dz) >= Math.abs(dx)) return dz < 0 ? 0 : 2;
  return dx < 0 ? 1 : 3;
}

/**
 * placeDisguiseProp convention: a directional prop's FRONT faces local +Z at quarterTurns 0. Quarter turns so that the
 * prop's front faces the direction (dx, dz).
 */
function faceDir(dx: number, dz: number) {
  return (turnsToward(dx, dz) + 2) % 4;
}

const WORLD_FRAME = new Frame(0, 0, 0);
const TAU = (n: number) => ((n % 4) + 4) % 4;

// ---------------------------------------------------------------------------------------------------------
// Placer: validation + placement + bookkeeping
// ---------------------------------------------------------------------------------------------------------

interface PlacerCtx {
  map: 'small' | 'large';
  kit: Kit;
  world: CollisionWorld;
  structures: StructureInfo[];
  /** Play-area half size. */
  half: number;
  /** Visual surface height (m) at (x, z), NaN where props must never stand (roads, kerbs, plaza strips). */
  surface: (x: number, z: number) => number;
  /** Height of the road surface at (x, z) (NaN off-road); only used for the few road-edge cones. */
  roadSurface: (x: number, z: number) => number;
  /** Extra keep-out discs (chests, spawns...). */
  keepDiscs: Disc[];
}

interface PlaceOpts {
  /** Extra clearance to existing colliders (default 0.1). */
  gap?: number;
  /** Stand on the road surface (traffic cones next to chicane barriers). */
  onRoad?: boolean;
  tag?: string;
  /** Skip the door-corridor test (used for props that are meant to flank a door, never to block it). */
  ignoreCorridor?: boolean;
  /**
   * Footprint of the structure this prop belongs to: the prop may stand inside it (structure footprints include
   * porches / yards, the real wall can be several metres further in; the world colliders still apply).
   */
  allow?: Rect;
}

class Placer {
  readonly records: StreetPropRecord[] = [];
  private readonly boxCell = 8;
  private readonly boxGrid = new Map<number, number[]>();
  private readonly boxes: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }[];
  private readonly recGrid = new Map<number, number[]>();
  private readonly corridors: Rect[] = [];
  private readonly stairRects: Rect[] = [];
  private readonly footprints: Rect[] = [];
  private stamp = 0;
  private stamps: number[] = [];
  rejected = 0;

  constructor(readonly ctx: PlacerCtx) {
    this.boxes = ctx.world.allBoxes.map((b) => ({ minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY, minZ: b.minZ, maxZ: b.maxZ }));
    this.stamps = new Array(this.boxes.length).fill(0);
    this.boxes.forEach((b, i) => this.cells(b.minX, b.minZ, b.maxX, b.maxZ, (k) => this.push(this.boxGrid, k, i)));
    for (const s of ctx.world.stairs) this.stairRects.push({ minX: s.minX - 0.1, maxX: s.maxX + 0.1, minZ: s.minZ - 0.1, maxZ: s.maxZ + 0.1 });
    for (const st of ctx.structures) {
      this.footprints.push(st.footprint);
      this.corridors.push(this.doorCorridor(st));
    }
  }

  private cells(minX: number, minZ: number, maxX: number, maxZ: number, cb: (k: number) => void) {
    const c = this.boxCell;
    for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) for (let cz = Math.floor(minZ / c); cz <= Math.floor(maxZ / c); cz++) cb((cx + 512) * 2048 + (cz + 512));
  }

  private push(m: Map<number, number[]>, k: number, v: number) {
    let l = m.get(k);
    if (!l) m.set(k, (l = []));
    l.push(v);
  }

  /** Rectangle in front of a structure's main entrance that must stay free (never block a door). */
  private doorCorridor(st: StructureInfo): Rect {
    const fp = st.footprint;
    const [ex, , ez] = st.entrance;
    const d = [Math.abs(ez - fp.minZ), Math.abs(ez - fp.maxZ), Math.abs(ex - fp.minX), Math.abs(ex - fp.maxX)];
    const side = d.indexOf(Math.min(...d));
    const W = 2.0;
    const L = 8;
    if (side === 0) return { minX: ex - W, maxX: ex + W, minZ: fp.minZ - L, maxZ: fp.minZ + 0.8 };
    if (side === 1) return { minX: ex - W, maxX: ex + W, minZ: fp.maxZ - 0.8, maxZ: fp.maxZ + L };
    if (side === 2) return { minX: fp.minX - L, maxX: fp.minX + 0.8, minZ: ez - W, maxZ: ez + W };
    return { minX: fp.maxX - 0.8, maxX: fp.maxX + L, minZ: ez - W, maxZ: ez + W };
  }

  /** True when the corridor / point lies in front of a structure door. */
  inDoorCorridor(minX: number, maxX: number, minZ: number, maxZ: number) {
    return this.corridors.some((c) => !(maxX <= c.minX || minX >= c.maxX || maxZ <= c.minZ || minZ >= c.maxZ));
  }

  private hitsWorld(minX: number, maxX: number, minZ: number, maxZ: number, y0: number, y1: number) {
    const st = ++this.stamp;
    let hit = false;
    this.cells(minX, minZ, maxX, maxZ, (k) => {
      if (hit) return;
      const l = this.boxGrid.get(k);
      if (!l) return;
      for (const i of l) {
        if (this.stamps[i] === st) continue;
        this.stamps[i] = st;
        const b = this.boxes[i];
        if (b.maxX <= minX || b.minX >= maxX || b.maxZ <= minZ || b.minZ >= maxZ) continue;
        if (b.maxY <= y0 + 0.04 || b.minY >= y1 - 0.02) continue;
        hit = true;
        return;
      }
    });
    return hit;
  }

  private hitsRecords(minX: number, maxX: number, minZ: number, maxZ: number, y0: number, y1: number, pad: number) {
    let hit = false;
    this.cells(minX - pad, minZ - pad, maxX + pad, maxZ + pad, (k) => {
      if (hit) return;
      const l = this.recGrid.get(k);
      if (!l) return;
      for (const i of l) {
        const r = this.records[i];
        if (r.y + r.h <= y0 + 0.02 || r.y >= y1 - 0.02) continue; // stacked props (crate on crate) do not collide
        if (r.x + r.hx + pad <= minX || r.x - r.hx - pad >= maxX || r.z + r.hz + pad <= minZ || r.z - r.hz - pad >= maxZ) continue;
        hit = true;
        return;
      }
    });
    return hit;
  }

  /**
   * Validate + place a disguise prop with its base centre at (x, z). Returns whether it was placed.
   * `turns` rotates the prop (front = local -z) by quarter turns, exactly as placeDisguiseProp does.
   */
  place(id: PropId, x: number, z: number, turns: number, o: PlaceOpts = {}): boolean {
    const def = propDef(id);
    const q = TAU(turns);
    const odd = q % 2 === 1;
    const hx = (odd ? def.size[1] : def.size[0]) / 2;
    const hz = (odd ? def.size[0] : def.size[1]) / 2;
    const h = def.size[2];
    const c = this.ctx;
    const lim = c.half - 2.5;
    if (Math.abs(x) + hx > lim || Math.abs(z) + hz > lim) return this.reject('bounds');
    // Surface: one height under the whole footprint
    const surf = o.onRoad ? c.roadSurface : c.surface;
    const y = surf(x, z);
    if (!Number.isFinite(y)) return this.reject('surfaceNaN');
    for (const [px, pz] of [[x - hx, z - hz], [x + hx, z - hz], [x - hx, z + hz], [x + hx, z + hz], [x, z - hz], [x, z + hz], [x - hx, z], [x + hx, z]]) {
      const s = surf(px, pz);
      if (!Number.isFinite(s) || Math.abs(s - y) > 0.02) return this.reject('surfaceMix');
    }
    const gap = o.gap ?? 0.1;
    const minX = x - hx - gap;
    const maxX = x + hx + gap;
    const minZ = z - hz - gap;
    const maxZ = z + hz + gap;
    // Building footprints (never inside), stairs, discs
    if (this.footprints.some((f) => f !== o.allow && !(maxX <= f.minX + 0.02 || minX >= f.maxX - 0.02 || maxZ <= f.minZ + 0.02 || minZ >= f.maxZ - 0.02))) return this.reject('footprint');
    if (this.stairRects.some((f) => !(maxX <= f.minX || minX >= f.maxX || maxZ <= f.minZ || minZ >= f.maxZ))) return this.reject('stairs');
    if (!o.ignoreCorridor && this.inDoorCorridor(x - hx, x + hx, z - hz, z + hz)) return this.reject('door');
    for (const d of c.keepDiscs) {
      const nx = Math.max(x - hx, Math.min(d.x, x + hx));
      const nz = Math.max(z - hz, Math.min(d.z, z + hz));
      if (Math.hypot(nx - d.x, nz - d.z) < d.r) return this.reject('disc');
    }
    if (this.hitsWorld(minX, maxX, minZ, maxZ, y, y + h)) return this.reject('collider');
    const solid = def.solid;
    if (this.hitsRecords(x - hx, x + hx, z - hz, z + hz, y, y + h, solid ? 0.12 : 0.04)) return this.reject('overlapProp');

    placeDisguiseProp(c.kit, WORLD_FRAME, id, x, y, z, q);
    const rec: StreetPropRecord = { map: c.map, id, x, y, z, turns: q, hx, hz, h, solid, tag: o.tag ?? '' };
    const idx = this.records.push(rec) - 1;
    this.cells(x - hx, z - hz, x + hx, z + hz, (k) => this.push(this.recGrid, k, idx));
    return true;
  }

  private reject(why: string) {
    this.rejected++;
    stat(`reject:${why}`);
    return false;
  }

  /** Is (x, 0.3 / 0.9, z) inside any movement-blocking solid (wall probe)? */
  solidAt(x: number, z: number) {
    return this.ctx.world.pointInSolid(x, 0.3, z) && this.ctx.world.pointInSolid(x, 0.9, z);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Street clusters along a road side
// ---------------------------------------------------------------------------------------------------------

interface Lane {
  alongX: boolean;
  /** World coordinate of the centre line (z for roads along x, x for roads along z). */
  c: number;
}

/** Offsets from the road centre line: kerb-side furniture, outer sidewalk, lot frontage. */
interface Verge {
  kerb: number;
  outer: number;
  lot: number;
}
const CITY_VERGE: Verge = { kerb: 5.85, outer: 7.0, lot: 8.35 };
const LANE_VERGE: Verge = { kerb: 3.9, outer: 4.5, lot: 5.7 };

class Anchor {
  readonly face: number;
  constructor(
    readonly P: Placer,
    readonly lane: Lane,
    readonly side: 1 | -1,
    readonly t: number,
    readonly v: Verge,
    readonly seed: number,
    readonly tag: string
  ) {
    this.face = lane.alongX ? faceDir(0, -side) : faceDir(-side, 0);
  }
  /** Place at along-road offset `du` and distance `dv` from the centre line; tries small slides along the road. */
  put(id: PropId, du: number, dv: number, extraTurns = 0, slide = true, opts: PlaceOpts = {}) {
    const slides = slide ? [0, 0.7, -0.7, 1.4, -1.4] : [0];
    for (const s of slides) {
      const t = this.t + du + s;
      const x = this.lane.alongX ? t : this.lane.c + this.side * dv;
      const z = this.lane.alongX ? this.lane.c + this.side * dv : t;
      if (this.P.place(id, x, z, this.face + extraTurns, { tag: this.tag, ...opts })) return true;
    }
    return false;
  }
  r(k: number) {
    return hash(this.seed, k);
  }
}

type ClusterFn = (a: Anchor) => void;

/** Cluster library for sidewalks / road shoulders. */
const STREET_CLUSTERS: { name: string; weight: number; fn: ClusterFn }[] = [
  {
    name: 'benchStop',
    weight: 3,
    fn: (a) => {
      a.put('park_bench', 0, a.v.outer);
      a.put('trash_bin', 2.1, a.v.outer);
      if (a.r(1) > 0.45) a.put('potted_tree', -2.3, a.v.outer, 0, false);
    },
  },
  {
    name: 'planterRow',
    weight: 2,
    fn: (a) => {
      a.put('planter_box', -1.0, a.v.outer, 0, false);
      a.put('planter_box', 1.0, a.v.outer, 0, false);
      a.put('stone_bollard', -2.5, a.v.kerb, 0, false);
      a.put('stone_bollard', 2.5, a.v.kerb, 0, false);
    },
  },
  {
    name: 'utilityPost',
    weight: 2,
    fn: (a) => {
      a.put('utility_box', 0, a.v.outer);
      a.put('stone_bollard', -1.4, a.v.kerb, 0, false);
      a.put('stone_bollard', 1.4, a.v.kerb, 0, false);
      if (a.r(2) > 0.5) a.put('traffic_cone', 2.6, a.v.kerb, 0, false);
    },
  },
  {
    name: 'hydrantMail',
    weight: 2,
    fn: (a) => {
      a.put('fire_hydrant', 0, a.v.kerb);
      a.put('mailbox', 2.4, a.v.outer);
      if (a.r(3) > 0.5) a.put('trash_bin', 4.0, a.v.outer);
    },
  },
  {
    name: 'workZone',
    weight: 2,
    fn: (a) => {
      a.put('road_barrier', -1.0, a.v.lot);
      a.put('road_barrier', 1.0, a.v.lot);
      a.put('traffic_cone', -2.3, a.v.lot - 0.6, 0, false);
      a.put('traffic_cone', 2.3, a.v.lot - 0.6, 0, false);
      a.put('traffic_cone', 0, a.v.lot - 0.9, 0, false);
      if (a.r(4) > 0.4) a.put('supply_crate', 0.2, a.v.lot + 1.5);
    },
  },
  {
    name: 'stash',
    weight: 3,
    fn: (a) => {
      a.put('supply_crate', 0, a.v.lot + 0.2);
      a.put('wooden_pallet', 1.8, a.v.lot + 0.1);
      a.put('oil_drum', -1.2, a.v.lot);
      a.put('oil_drum', -1.2, a.v.lot + 0.85, 0, false);
      if (a.r(5) > 0.5) a.put('cardboard_box', 0.9, a.v.lot - 0.9, 1, false);
    },
  },
  {
    name: 'trashRow',
    weight: 2,
    fn: (a) => {
      a.put('trash_bin', -0.5, a.v.outer);
      a.put('trash_bin', 0.5, a.v.outer, 0, false);
      a.put('cardboard_box', 1.6, a.v.outer, 0, false);
      if (a.r(6) > 0.6) a.put('dumpster', 0.3, a.v.lot + 0.7);
    },
  },
  {
    name: 'tyres',
    weight: 1,
    fn: (a) => {
      a.put('tire_stack', 0, a.v.lot);
      a.put('tire_stack', 1.0, a.v.lot, 0, false);
      a.put('tire_stack', 0.5, a.v.lot + 0.9, 0, false);
      a.put('oil_drum', -1.4, a.v.lot);
    },
  },
  {
    name: 'sandbagNest',
    weight: 1,
    fn: (a) => {
      a.put('sandbag_barrier', -1.0, a.v.lot);
      a.put('sandbag_barrier', 1.0, a.v.lot);
      a.put('supply_crate', 3.0, a.v.lot);
    },
  },
];
const CLUSTER_TOTAL = STREET_CLUSTERS.reduce((s, c) => s + c.weight, 0);

function pickCluster(r: number) {
  let acc = r * CLUSTER_TOTAL;
  for (const c of STREET_CLUSTERS) {
    acc -= c.weight;
    if (acc < 0) return c;
  }
  return STREET_CLUSTERS[0];
}

/** Anchors along a lane side inside [from, to] (world t coordinates). */
function streetSpan(P: Placer, lane: Lane, side: 1 | -1, from: number, to: number, v: Verge, seed: number, perSpan: number, density: number, tag: string) {
  const len = to - from;
  if (len < 8) return;
  for (let k = 0; k < perSpan; k++) {
    const hs = hash(seed, lane.c, side, from, k);
    if (hs > density) continue;
    const frac = (k + 0.5) / perSpan + (hash(seed, from, k, 7) - 0.5) * (0.5 / perSpan);
    const t = from + 3 + (len - 6) * frac;
    const a = new Anchor(P, lane, side, t, v, hash(seed, lane.c, side, t), tag);
    pickCluster(hash(seed, lane.c, side, t, 3)).fn(a);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Intersection corners
// ---------------------------------------------------------------------------------------------------------

/**
 * Props on the four sidewalk corners of an intersection at (ix, iz). (sx, sz) pick the corner; offsets are
 * measured from the intersection centre along each road.
 */
function cornerCluster(P: Placer, ix: number, iz: number, sx: number, sz: number, seed: number, verge: Verge) {
  const k = Math.floor(hash(seed, ix, iz, sx * 2 + sz) * 6);
  const tag = 'corner';
  const faceNS = faceDir(-sx, 0); // facing the N-S road (props on an east/west sidewalk)
  const faceEW = faceDir(0, -sz); // facing the E-W road
  /** Try each (ax, az) offset from the intersection centre until one fits. */
  const put = (id: PropId, turns: number, ...opts: [number, number][]) => {
    for (const [ax, az] of opts) if (P.place(id, ix + sx * ax, iz + sz * az, turns, { tag })) return true;
    return false;
  };
  const o = verge.outer;
  const c = verge.kerb + 0.6; // 6.45: the corner pad
  switch (k) {
    case 0: // hydrant on the corner, mailbox + bin along the sidewalks
      put('fire_hydrant', faceNS, [c, c]);
      put('mailbox', faceNS, [o, 9.4], [o, 10.4]);
      put('trash_bin', faceEW, [9.6, o], [10.6, o]);
      break;
    case 1: // utility box + bollards
      put('utility_box', faceNS, [o, 8.2], [o, 9.6]);
      put('stone_bollard', 0, [c, c]);
      put('stone_bollard', 0, [c, c + 1.2]);
      put('stone_bollard', 0, [c + 1.2, c]);
      break;
    case 2: // bench along the N-S sidewalk, bin on the corner
      put('trash_bin', faceEW, [c, c]);
      put('park_bench', faceNS, [o, 10.6], [o, 12.0]);
      break;
    case 3: // potted tree + planter
      put('potted_tree', 0, [c, c]);
      put('planter_box', faceEW, [10.2, o], [11.6, o]);
      put('traffic_cone', 0, [o, 9.2]);
      break;
    case 4: // hydrant + utility box on the E-W side
      put('fire_hydrant', faceEW, [c, c]);
      put('utility_box', faceEW, [9.2, o], [10.6, o]);
      put('stone_bollard', 0, [9.6, c]);
      break;
    default: // mailbox + bin + cones (roadworks corner)
      put('mailbox', faceNS, [c, c]);
      put('traffic_cone', 0, [9.0, c]);
      put('traffic_cone', 0, [9.8, c]);
      put('trash_bin', faceNS, [o, 9.8]);
      break;
  }
}

/** Two cones at the kerb-side end of each Jersey barrier chicane (barriers themselves are placed by the map builders). */
function chicaneCones(P: Placer, ix: number, iz: number) {
  // barrier A: centre (ix + 2.2, iz - 10) running along x (x: ix + 0.7 .. ix + 3.7)
  P.place('traffic_cone', ix + 4.3, iz - 10, 0, { onRoad: true, tag: 'chicane', gap: 0.02 });
  // barrier B: centre (ix - 10, iz - 2.2) running along z (z: iz - 3.7 .. iz - 0.7)
  P.place('traffic_cone', ix - 10, iz - 4.3, 0, { onRoad: true, tag: 'chicane', gap: 0.02 });
}

// ---------------------------------------------------------------------------------------------------------
// Building exteriors
// ---------------------------------------------------------------------------------------------------------

interface Side {
  nx: number;
  nz: number;
  /** Footprint edge coordinate on the normal axis, and the lateral range [a, b]. */
  edge: number;
  a: number;
  b: number;
  alongX: boolean;
}

function sidesOf(fp: Rect): Side[] {
  return [
    { nx: 0, nz: -1, edge: fp.minZ, a: fp.minX, b: fp.maxX, alongX: true },
    { nx: 0, nz: 1, edge: fp.maxZ, a: fp.minX, b: fp.maxX, alongX: true },
    { nx: -1, nz: 0, edge: fp.minX, a: fp.minZ, b: fp.maxZ, alongX: false },
    { nx: 1, nz: 0, edge: fp.maxX, a: fp.minZ, b: fp.maxZ, alongX: false },
  ];
}

const sideXZ = (s: Side, t: number, out: number): [number, number] => (s.alongX ? [t, s.edge + s.nz * out] : [s.edge + s.nx * out, t]);

type Slot = { id: PropId; dt: number; out?: number; turn?: number; minOut?: number }[];

/** Bundles per exterior role. `out` = extra distance from the wall; turn = extra quarter turns (0 = front faces away from the wall). */
const REAR_BUNDLES: Slot[] = [
  [{ id: 'dumpster', dt: 0 }, { id: 'trash_bin', dt: 1.85 }, { id: 'cardboard_box', dt: -1.5, out: 0.1 }],
  [{ id: 'dumpster', dt: 0 }],
  [{ id: 'wooden_pallet', dt: 0 }, { id: 'supply_crate', dt: 1.45 }],
  [{ id: 'oil_drum', dt: 0 }, { id: 'oil_drum', dt: 0.85 }, { id: 'oil_drum', dt: 0.42, out: 0.75 }],
  [{ id: 'trash_bin', dt: 0 }, { id: 'trash_bin', dt: 0.95 }, { id: 'cardboard_box', dt: 1.9 }],
  [{ id: 'tire_stack', dt: 0 }, { id: 'tire_stack', dt: 1.0 }],
  [{ id: 'utility_box', dt: 0 }, { id: 'supply_crate', dt: 1.6 }],
  [{ id: 'wooden_pallet', dt: 0 }, { id: 'wooden_pallet', dt: 1.3 }, { id: 'cardboard_box', dt: 0.1, out: 1.2 }],
];
const SIDE_BUNDLES: Slot[] = [
  [{ id: 'utility_box', dt: 0 }],
  [{ id: 'trash_bin', dt: 0 }, { id: 'cardboard_box', dt: 1.1 }],
  [{ id: 'planter_box', dt: 0 }],
  [{ id: 'supply_crate', dt: 0 }, { id: 'cardboard_box', dt: 1.1 }],
  [{ id: 'oil_drum', dt: 0 }, { id: 'oil_drum', dt: 0.85 }],
  [{ id: 'fire_hydrant', dt: 0 }],
];
const FRONT_BUNDLES: Slot[] = [
  [{ id: 'planter_box', dt: 0 }],
  [{ id: 'park_bench', dt: 0 }, { id: 'trash_bin', dt: 1.9 }],
  [{ id: 'stone_bollard', dt: 0, out: 1.6 }, { id: 'stone_bollard', dt: 1.2, out: 1.6 }],
  [{ id: 'potted_tree', dt: 0, minOut: 2.6 }],
  [{ id: 'planter_box', dt: 0 }, { id: 'stone_bollard', dt: 1.5, out: 0.6 }],
  [{ id: 'mailbox', dt: 0 }],
];

/**
 * Outward distance (from the footprint edge) of the wall face at lateral position `u`, found by marching inwards
 * through the collision world; null when nothing solid is met (door / gap / recessed corner).
 */
function wallFace(P: Placer, s: Side, u: number): number | null {
  for (let o = 0.5; o >= -6; o -= 0.1) {
    const [x, z] = sideXZ(s, u, o);
    if (P.solidAt(x, z)) return o + 0.05;
  }
  return null;
}

/** Walk along one side of a structure placing bundles of props flush against its wall. */
function exteriorSide(P: Placer, st: StructureInfo, s: Side, role: 'front' | 'rear' | 'side', budget: { n: number }, seed: number, density: number) {
  const bundles = role === 'rear' ? REAR_BUNDLES : role === 'front' ? FRONT_BUNDLES : SIDE_BUNDLES;
  const turnOut = faceDir(s.nx, s.nz);
  const entLat = s.alongX ? st.entrance[0] : st.entrance[2];
  const step = role === 'rear' ? 3.8 : 4.2;
  const len = s.b - s.a;
  const slots = Math.max(0, Math.floor((len - 2.4) / step) + 1);
  const start = s.a + (len - (slots - 1) * step) / 2;
  for (let k = 0; k < slots && budget.n > 0; k++) {
    const hs = hash(seed, st.entrance[0], st.entrance[2], s.nx * 3 + s.nz, k);
    if (hs > density) continue;
    const t = start + k * step;
    const bundle = bundles[Math.floor(hash(seed, t, s.edge, 11) * bundles.length)];
    // Lateral extent of the whole bundle along the wall
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of bundle) {
      const w = propDef(b.id).size[0] / 2;
      lo = Math.min(lo, t + b.dt - w);
      hi = Math.max(hi, t + b.dt + w);
    }
    if (lo < s.a + 0.25 || hi > s.b - 0.25) continue;
    if (role === 'front' && (Math.abs((lo + hi) / 2 - entLat) < 3.2 || (lo < entLat + 1.6 && hi > entLat - 1.6))) continue;
    // The wall must be one continuous face (no door / gap / step) along the bundle plus a 0.6 m margin each side.
    let wmin = Infinity;
    let wmax = -Infinity;
    let ok = true;
    for (let u = Math.max(s.a + 0.05, lo - 0.6); u <= Math.min(s.b - 0.05, hi + 0.6) + 1e-6; u += 0.4) {
      const f = wallFace(P, s, u);
      if (f === null) {
        ok = false;
        break;
      }
      wmin = Math.min(wmin, f);
      wmax = Math.max(wmax, f);
    }
    ok = ok && wmax - wmin <= 0.2;
    stat(ok ? `slot:${role}:ok` : `slot:${role}:wallFail`);
    if (!ok) continue;
    for (const b of bundle) {
      if (budget.n <= 0) break;
      const depth = propDef(b.id).size[1];
      // Props face away from the wall, so their local depth is perpendicular to it.
      const out = wmax + (b.minOut ? b.minOut + depth / 2 : (b.out ?? 0) + 0.17 + depth / 2);
      const [x, z] = sideXZ(s, t + b.dt, out);
      if (P.place(b.id, x, z, turnOut + (b.turn ?? 0), { tag: `exterior:${role}`, allow: st.footprint, gap: 0.03 })) budget.n--;
    }
  }
}

function buildingExterior(P: Placer, st: StructureInfo, seed: number, budgetN: number, density: number) {
  const fp = st.footprint;
  const sides = sidesOf(fp);
  const [ex, , ez] = st.entrance;
  // front = side whose edge line is closest to the entrance point
  let fi = 0;
  let best = Infinity;
  sides.forEach((s, i) => {
    const lat = s.alongX ? ex : ez;
    const nrm = s.alongX ? ez : ex;
    const d = Math.abs(nrm - s.edge);
    if (lat >= s.a - 0.5 && lat <= s.b + 0.5 && d < best) {
      best = d;
      fi = i;
    }
  });
  const front = sides[fi];
  const budget = { n: budgetN };
  const isHouse = /house/i.test(st.name);
  sides.forEach((s) => {
    const role = s === front ? 'front' : s.nx === -front.nx && s.nz === -front.nz ? 'rear' : 'side';
    // House front yards carry fences, hedges and the porch (visual-only parts): leave them untouched.
    if (role === 'front' && isHouse) return;
    exteriorSide(P, st, s, role, budget, seed, density);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Open lots (parks, tactical yards, parking) and plazas
// ---------------------------------------------------------------------------------------------------------

function lotProps(P: Placer, lot: OpenLotInfo, seed: number, budget: number) {
  const f = new Frame(lot.x, lot.z, lot.turns);
  // Props are listed most characteristic first; only `budget` of them are placed per lot.
  const left = { n: budget };
  const put = (id: PropId, lx: number, lz: number, extra = 0, o: PlaceOpts = {}) => {
    if (left.n <= 0) return false;
    const [x, z] = f.toWorld(lx, lz);
    // extra 0 = front faces the street (local -z of the lot frame); the prop convention is front = +Z, hence + 2
    const ok = P.place(id, x, z, f.quarterTurns + 2 + extra, { tag: 'lot', ...o });
    if (ok) left.n--;
    return ok;
  };
  const v = hash(seed, lot.x, lot.z);
  if (lot.type === 0 || lot.type === 2) {
    // park: second bench with a bin, planters, potted trees, gate bollards
    put('park_bench', -7.2, 3.5, 3);
    put('trash_bin', -7.0, 5.7);
    put('planter_box', v > 0.5 ? -5.2 : 5.2, -9.9);
    put('potted_tree', v > 0.4 ? 8.6 : -8.8, v > 0.4 ? 8.4 : -6.2);
    put('park_bench', 7.2, -2.5, 1);
    put('trash_bin', 3.6, -8.4);
    put('stone_bollard', -2.0, -10.4);
    put('stone_bollard', 2.0, -10.4);
  } else if (lot.type === 1) {
    // tactical yard: drums, tyres, pallets, sandbag walls, supply boxes
    put('wooden_pallet', 8.2, -8.4);
    put('oil_drum', 8.0, 7.6);
    put('tire_stack', -8.6, -1.2);
    put('sandbag_barrier', -2.0, -9.8);
    put('supply_crate', -8.8, 9.0);
    put('wooden_pallet', 8.2, -7.0);
    put('oil_drum', 8.0, 8.5);
    put('tire_stack', -8.6, 0.0);
    put('road_barrier', -8.6, 5.2, 1);
    put('cardboard_box', 6.8, 9.0, 1);
  } else {
    // parking lot: dumpster + bin at the back, cones on the bay ends, planters, utility box
    put('dumpster', 8.0, 9.4, 2);
    put('traffic_cone', -6.4, -3.6);
    put('trash_bin', 5.6, 9.9, 2);
    put('planter_box', v > 0.5 ? -4.8 : 4.8, -9.9);
    put('utility_box', -9.6, 8.6, 1);
    put('traffic_cone', 6.4, -3.4);
    put('tire_stack', -9.0, -4.8);
    put('stone_bollard', -2.0, 10.4);
  }
}

export interface PlazaInfo {
  x: number;
  z: number;
  /** Side of the city centre the plaza lies on (+1 / -1 on each axis). */
  sx: number;
  sz: number;
}

function plazaProps(P: Placer, plaza: PlazaInfo, seed: number, budget: number) {
  const { x: px, z: pz, sx, sz } = plaza;
  const left = { n: budget };
  // ax / az: offsets from the plaza centre, positive = away from the central intersection
  const put = (id: PropId, ax: number, az: number, turns = 0) => {
    if (left.n <= 0) return false;
    const ok = P.place(id, px + sx * ax, pz + sz * az, turns, { tag: 'plaza' });
    if (ok) left.n--;
    return ok;
  };
  const h = hash(seed, px, pz);
  put('park_bench', 8.6, 6.2, faceDir(-sx, 0));
  put('planter_box', 0.0, 9.6, faceDir(0, -sz));
  put('trash_bin', -7.2, 5.4);
  put('stone_bollard', -9.6, 3.1);
  put('stone_bollard', -9.6, 6.2);
  put('stone_bollard', 3.1, -9.6);
  put('stone_bollard', 6.2, -9.6);
  put('planter_box', 9.6, 0.0, faceDir(-sx, 0));
  put('utility_box', -9.9, 8.4, faceDir(-sx, 0));
  put('park_bench', 3.2, 9.9, faceDir(0, -sz));
  if (h > 0.5) put('fire_hydrant', -9.9, -5.2, faceDir(-sx, 0));
  put('trash_bin', 4.4, -8.4);
  put('potted_tree', 9.9, -9.9);
  put('potted_tree', -9.9, 9.9);
  put('traffic_cone', 1.8, 3.6);
}

// ---------------------------------------------------------------------------------------------------------
// City street grid (shared by the small map and the two large-map cities)
// ---------------------------------------------------------------------------------------------------------

interface CityOpts {
  cx: number;
  cz: number;
  lines: number[]; // [-60, 0, 60]
  /** Half length of the street grid that may be populated. */
  extent: number;
  perSpan: number;
  density: number;
  cornerDensity: number;
  seed: number;
}

function cityStreets(P: Placer, o: CityOpts) {
  const E = o.extent;
  const cuts = o.lines;
  // spans between intersections, relative to the city centre
  const bounds: number[] = [-E];
  for (const l of cuts) bounds.push(l - 12, l + 12);
  bounds.push(E);
  const spans: [number, number][] = [];
  for (let i = 0; i < bounds.length; i += 2) spans.push([bounds[i], bounds[i + 1]]);
  for (const l of o.lines) {
    for (const side of [1, -1] as const) {
      spans.forEach(([a, b], si) => {
        // N-S road at x = cx + l  (runs along z); E-W road at z = cz + l (runs along x)
        streetSpan(P, { alongX: false, c: o.cx + l }, side, o.cz + a, o.cz + b, CITY_VERGE, o.seed + si, o.perSpan, o.density, 'sidewalk');
        streetSpan(P, { alongX: true, c: o.cz + l }, side, o.cx + a, o.cx + b, CITY_VERGE, o.seed + 31 + si, o.perSpan, o.density, 'sidewalk');
      });
    }
  }
  for (const ix of o.lines) {
    for (const iz of o.lines) {
      for (const sx of [1, -1]) {
        for (const sz of [1, -1]) {
          if (hash(o.seed, ix, iz, sx, sz) > o.cornerDensity) continue;
          cornerCluster(P, o.cx + ix, o.cz + iz, sx, sz, o.seed, CITY_VERGE);
        }
      }
      if (ix === 0 && iz === 0) continue;
      chicaneCones(P, o.cx + ix, o.cz + iz);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Public: small map
// ---------------------------------------------------------------------------------------------------------

export interface SmallMapStreetCtx {
  kit: Kit;
  world: CollisionWorld;
  structures: StructureInfo[];
  openLots: OpenLotInfo[];
  plazaLots: { x: number; z: number }[];
  chestSpots: { x: number; z: number }[];
  playerSpawns: { x: number; z: number }[];
}

const SMALL_LINES = [-60, 0, 60];
const SMALL_HALF = 112;

function smallSurface(plazas: { x: number; z: number }[]) {
  return (x: number, z: number) => {
    if (Math.abs(x) > 120 || Math.abs(z) > 120) return NaN;
    let dx = Infinity;
    let dz = Infinity;
    for (const l of SMALL_LINES) {
      dx = Math.min(dx, Math.abs(x - l));
      dz = Math.min(dz, Math.abs(z - l));
    }
    if (dx < 5.3 || dz < 5.3) return NaN; // road + kerb
    for (const p of plazas) {
      if (Math.abs(x - p.x) <= 11.4 && Math.abs(z - p.z) <= 11.4) {
        if (Math.abs(Math.abs(z - p.z) - 11.25) < 0.3) return NaN; // 8 cm edge strips (z edges only)
        if (Math.abs(x - p.x) > 11.25 || Math.abs(z - p.z) > 11.25) return NaN;
        return 0.06;
      }
    }
    if (dx <= 7.5 || dz <= 7.5) return 0.08; // sidewalk
    return 0;
  };
}

export function populateSmallMapStreetProps(c: SmallMapStreetCtx): StreetPropRecord[] {
  const surface = smallSurface(c.plazaLots);
  const roadSurface = (x: number, z: number) => {
    let dx = Infinity;
    let dz = Infinity;
    for (const l of SMALL_LINES) {
      dx = Math.min(dx, Math.abs(x - l));
      dz = Math.min(dz, Math.abs(z - l));
    }
    return (dx < 5 && dx > 3.3) || (dz < 5 && dz > 3.3) ? 0.02 : NaN;
  };
  const keepDiscs: Disc[] = [...c.chestSpots.map((p) => ({ x: p.x, z: p.z, r: 1.6 })), ...c.playerSpawns.map((p) => ({ x: p.x, z: p.z, r: 2.0 }))];
  const P = new Placer({ map: 'small', kit: c.kit, world: c.world, structures: c.structures, half: SMALL_HALF, surface, roadSurface, keepDiscs });
  const seed = 7001;
  cityStreets(P, { cx: 0, cz: 0, lines: SMALL_LINES, extent: 108, perSpan: 2, density: 0.55, cornerDensity: 0.7, seed });
  c.plazaLots.forEach((p) => plazaProps(P, { x: p.x, z: p.z, sx: Math.sign(p.x), sz: Math.sign(p.z) }, seed, 8));
  c.openLots.forEach((l) => lotProps(P, l, seed, 4));
  c.structures.forEach((st) => buildingExterior(P, st, seed, 3, 0.8));
  streetPropDebug.small = P.records;
  return P.records;
}

// ---------------------------------------------------------------------------------------------------------
// Public: large map
// ---------------------------------------------------------------------------------------------------------

export interface LargeMapStreetCtx {
  kit: Kit;
  world: CollisionWorld;
  structures: StructureInfo[];
  half: number;
  terrainHeight: (x: number, z: number) => number;
  /** Axis-aligned road rectangles (centre x/z + full size) incl. dirt lanes. */
  roads: { x: number; z: number; w: number; d: number }[];
  plazas: PlazaInfo[];
  openLots: OpenLotInfo[];
  cities: { x: number; z: number }[];
  towns: { x: number; z: number }[];
  villages: { x: number; z: number; halfLen: number }[];
  highways: number[];
  chestSpots: { x: number; z: number }[];
}

export function populateLargeMapStreetProps(c: LargeMapStreetCtx): StreetPropRecord[] {
  const roads = c.roads;
  const inRoad = (x: number, z: number, pad: number) => roads.some((r) => Math.abs(x - r.x) < r.w / 2 + pad && Math.abs(z - r.z) < r.d / 2 + pad);
  const surface = (x: number, z: number) => {
    if (Math.abs(x) > c.half + 6 || Math.abs(z) > c.half + 6) return NaN;
    if (inRoad(x, z, 0.3)) return NaN;
    const th = c.terrainHeight(x, z);
    for (const p of c.plazas) if (Math.abs(x - p.x) <= 11.25 && Math.abs(z - p.z) <= 11.25) return Math.abs(x - p.x) > 11.0 || Math.abs(z - p.z) > 11.0 ? NaN : 0.06;
    return th;
  };
  // Outer 1.7 m of a road (never the centre lanes): traffic cones next to the chicane barriers.
  const roadSurface = (x: number, z: number) => {
    let any = false;
    for (const r of roads) {
      const ax = Math.abs(x - r.x);
      const az = Math.abs(z - r.z);
      if (ax >= r.w / 2 || az >= r.d / 2) continue;
      const edge = Math.min(r.w / 2 - ax, r.d / 2 - az);
      if (edge < 0.25 || edge > 1.7) return NaN;
      any = true;
    }
    return any ? 0.05 : NaN;
  };
  const keepDiscs: Disc[] = c.chestSpots.map((p) => ({ x: p.x, z: p.z, r: 1.6 }));
  const P = new Placer({ map: 'large', kit: c.kit, world: c.world, structures: c.structures, half: c.half, surface, roadSurface, keepDiscs });
  const seed = 96011;

  // Cities: same street grid as the Metro Block, sparser
  for (const [ci, city] of c.cities.entries()) {
    cityStreets(P, { cx: city.x, cz: city.z, lines: SMALL_LINES, extent: 108, perSpan: 1, density: 0.38, cornerDensity: 0.25, seed: seed + ci * 101 });
  }
  c.plazas.forEach((p) => plazaProps(P, p, seed, 4));
  c.openLots.forEach((l, i) => lotProps(P, l, seed, i % 2 === 0 ? 2 : 1));

  // Towns: only the two highways through the junction
  c.towns.forEach((t, ti) => {
    const s = seed + 500 + ti * 17;
    for (const side of [1, -1] as const) {
      for (const [a, b] of [[-62, -12], [12, 62]] as [number, number][]) {
        streetSpan(P, { alongX: false, c: t.x }, side, t.z + a, t.z + b, CITY_VERGE, s, 1, 0.5, 'town');
        streetSpan(P, { alongX: true, c: t.z }, side, t.x + a, t.x + b, CITY_VERGE, s + 9, 1, 0.5, 'town');
      }
    }
    for (const sx of [1, -1]) for (const sz of [1, -1]) if (hash(s, sx, sz) < 0.7) cornerCluster(P, t.x, t.z, sx, sz, s, CITY_VERGE);
  });

  // Villages: lane-side clusters
  c.villages.forEach((v, vi) => {
    const s = seed + 900 + vi * 13;
    for (const side of [1, -1] as const) {
      streetSpan(P, { alongX: true, c: v.z }, side, v.x - v.halfLen + 4, v.x + v.halfLen - 4, LANE_VERGE, s + side, 1, 0.8, 'village');
    }
  });

  // Roadside sites on the open highways (work zones, stashes, bus stops...)
  const settlementBoxes = [...c.cities.map((q) => ({ ...q, r: 135 })), ...c.towns.map((q) => ({ ...q, r: 72 })), ...c.villages.map((q) => ({ x: q.x, z: q.z, r: 20 + q.halfLen }))];
  for (const line of c.highways) {
    for (const alongX of [false, true]) {
      for (let t0 = -430; t0 <= 430; t0 += 46) {
        const t = t0 + (hash(seed, line, alongX ? 1 : 0, t0) - 0.5) * 18;
        const side = hash(seed, line, t0, 5) < 0.5 ? 1 : -1;
        if (hash(seed, line, t0, 6) > 0.55) continue; // not every slot
        // skip near crossing highways and all settlements
        if (c.highways.some((o) => Math.abs(o - t) < 26)) continue;
        const px = alongX ? t : line;
        const pz = alongX ? line : t;
        if (settlementBoxes.some((q) => Math.abs(px - q.x) < q.r && Math.abs(pz - q.z) < q.r)) continue;
        const a = new Anchor(P, { alongX, c: line }, side as 1 | -1, t, CITY_VERGE, hash(seed, line, t0), 'highway');
        pickCluster(hash(seed, line, t0, 9)).fn(a);
      }
    }
  }

  c.structures.forEach((st, i) => buildingExterior(P, st, seed + i * 3, 2, 0.22));
  streetPropDebug.large = P.records;
  return P.records;
}
