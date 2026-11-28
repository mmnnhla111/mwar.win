import type { Frame, Kit } from '../kit';
import type { StructureInfo } from '../structure';
import { GROUND_WINDOW, windowsAlong } from '../structure';
import { PROPS, type PropId } from '../disguiseProps';
import { placeDisguiseProp } from '../propPlacement';

/**
 * Interior furnishing of the single-storey houses (buildSingle in assets/houses.ts, 10 configs). Called once per placed instance right after the house factory, in the
 * house's own local frame `f`. `variant` is the config index 0..9 (SINGLE_CONFIGS / TWO_CONFIGS in houses.ts).
 * Every object must be a Prop-Hunt disguise prop placed with placeDisguiseProp (assets/propPlacement.ts).
 *
 * The layout is computed by `layoutSingleHouse` (pure, deterministic: no randomness, the variant is the only input).
 * Every candidate placement is validated against the walls, door clearances, window clearances and the props already
 * placed; a candidate that does not fit is nudged along its wall and finally skipped, so all 10 shells stay walkable.
 */

// Mirror of the shell dimensions in houses.ts SINGLE_CONFIGS (kept local to avoid a houses <-> interior import cycle).
interface ShellCfg {
  w: number;
  d: number;
  doorAt?: number;
  partition?: boolean;
  wing?: { w: number; d: number };
  garage?: boolean;
}
export const SINGLE_SHELLS: ShellCfg[] = [
  { w: 9, d: 8 },
  { w: 12, d: 8, partition: true },
  { w: 10, d: 9, partition: true },
  { w: 10, d: 7.5, wing: { w: 4.5, d: 4.5 } },
  { w: 9, d: 8.5, garage: true },
  { w: 8.5, d: 8, doorAt: 3 },
  { w: 8, d: 9 },
  { w: 11, d: 9, partition: true },
  { w: 9.5, d: 9.5, wing: { w: 4, d: 4 } },
  { w: 13, d: 8, partition: true, doorAt: 4.5 },
];

export interface PlacedProp {
  id: PropId;
  x: number;
  z: number;
  quarterTurns: number;
  /** half extents in the house frame (after rotation) */
  hx: number;
  hz: number;
  h: number;
}

/** Walking surface of the ground floor (top of the 0.012 m floor finish laid by the factory). */
export const FLOOR_Y = 0.01;

const T = 0.25; // wall thickness used by buildSingle
type Side = 'n' | 's' | 'w' | 'e';
interface R {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}
const WALL_QT: Record<Side, number> = { n: 0, s: 2, w: 1, e: 3 };
const INWARD: Record<Side, [number, number]> = { n: [0, 1], s: [0, -1], w: [1, 0], e: [-1, 0] };
const SIZE = new Map(PROPS.map((p) => [p.id, p.size] as const));

export function layoutSingleHouse(variant: number): PlacedProp[] {
  const cfg = SINGLE_SHELLS[((variant % 10) + 10) % 10];
  const { w, d } = cfg;
  const doorAt = cfg.doorAt ?? w / 2;
  const main: R = { x0: -w / 2 + T, z0: -d / 2 + T, x1: w / 2 - T, z1: d / 2 - T };

  // ---- rooms ---------------------------------------------------------------------------------
  let rooms: Record<string, R>;
  const zones: { r: R; all: boolean }[] = []; // all: forbidden for every prop
  const windowZones: { r: R; tallR: R }[] = [];
  const addZone = (r: R) => zones.push({ r, all: true });
  let pz = 0;
  let px = 0;
  if (cfg.partition) {
    px = -w / 2 + w * 0.45;
    pz = main.z0 + (d - 2 * T) * 0.6;
    rooms = { W: { ...main, x1: px - 0.075 }, E: { ...main, x0: px + 0.075 } };
    addZone({ x0: px - 1.4, x1: px + 1.4, z0: pz - 0.8, z1: pz + 0.8 });
  } else {
    rooms = { M: main };
  }
  if (cfg.wing) {
    const wx0 = w / 2 - cfg.wing.w;
    rooms.G = { x0: wx0 + T, x1: w / 2 - T, z0: d / 2, z1: d / 2 + cfg.wing.d - T };
  }

  // ---- door clearances (>= 1.4 m in front of / behind every door) ----------------------------
  const fdx = -w / 2 + doorAt;
  addZone({ x0: fdx - 0.9, x1: fdx + 0.9, z0: main.z0, z1: main.z0 + 1.4 });
  if (cfg.wing) {
    const sx = w - cfg.wing.w / 2 - w / 2;
    addZone({ x0: sx - 0.9, x1: sx + 0.9, z0: main.z1 - 1.4, z1: d / 2 + 1.4 });
    addZone({ x0: sx - 0.9, x1: sx + 0.9, z0: d / 2 + cfg.wing.d - T - 1.4, z1: d / 2 + cfg.wing.d });
  } else {
    const sx = -w / 2 + w * 0.75;
    addZone({ x0: sx - 0.85, x1: sx + 0.85, z0: main.z1 - 1.4, z1: main.z1 });
  }
  if (cfg.garage) addZone({ x0: main.x0, x1: main.x0 + 1.4, z0: -0.85, z1: 0.85 });

  // ---- window clearances ---------------------------------------------------------------------
  const wz = (r: R, tall: R) => windowZones.push({ r, tallR: tall });
  const HW = 0.8;
  const LOW = 0.6;
  const TALL = 1.0;
  const nOps = windowsAlong(w, 3, { ...GROUND_WINDOW, avoid: [[doorAt - 1, doorAt + 1]] });
  const sAvoidAt = cfg.wing ? w - cfg.wing.w / 2 : w * 0.75;
  const sOps = windowsAlong(w, 2, { ...GROUND_WINDOW, avoid: [[sAvoidAt - (cfg.wing ? 1.2 : 1), sAvoidAt + (cfg.wing ? 1.2 : 1)]] });
  const sideOps = windowsAlong(d - 2 * T, 2, GROUND_WINDOW);
  for (const o of nOps) {
    const x = -w / 2 + o.at;
    wz({ x0: x - HW, x1: x + HW, z0: main.z0, z1: main.z0 + LOW }, { x0: x - HW, x1: x + HW, z0: main.z0, z1: main.z0 + TALL });
  }
  for (const o of sOps) {
    const x = -w / 2 + o.at;
    wz({ x0: x - HW, x1: x + HW, z0: main.z1 - LOW, z1: main.z1 }, { x0: x - HW, x1: x + HW, z0: main.z1 - TALL, z1: main.z1 });
  }
  const sideSides: Side[] = cfg.garage ? ['e'] : ['w', 'e'];
  for (const sd of sideSides) {
    for (const o of sideOps) {
      const z = main.z0 + o.at;
      const xa = sd === 'w' ? main.x0 : main.x1 - LOW;
      const xb = sd === 'w' ? main.x0 + LOW : main.x1;
      const ta = sd === 'w' ? main.x0 : main.x1 - TALL;
      const tb = sd === 'w' ? main.x0 + TALL : main.x1;
      wz({ x0: xa, x1: xb, z0: z - HW, z1: z + HW }, { x0: ta, x1: tb, z0: z - HW, z1: z + HW });
    }
  }
  if (cfg.wing) {
    const gz = d / 2 + (cfg.wing.d - T) / 2;
    const gx0 = w / 2 - cfg.wing.w + T;
    const gx1 = w / 2 - T;
    wz({ x0: gx0, x1: gx0 + LOW, z0: gz - HW, z1: gz + HW }, { x0: gx0, x1: gx0 + TALL, z0: gz - HW, z1: gz + HW });
    wz({ x0: gx1 - LOW, x1: gx1, z0: gz - HW, z1: gz + HW }, { x0: gx1 - TALL, x1: gx1, z0: gz - HW, z1: gz + HW });
  }

  // ---- placement machinery -------------------------------------------------------------------
  const placed: PlacedProp[] = [];
  const hit = (a: R, b: R, gap = 0) => a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.z0 < b.z1 + gap && a.z1 > b.z0 - gap;

  const tryPut = (room: R, id: PropId, cx: number, cz: number, qt: number): boolean => {
    const [sw, sd, sh] = SIZE.get(id)!;
    const odd = qt % 2 !== 0;
    const hx = (odd ? sd : sw) / 2;
    const hz = (odd ? sw : sd) / 2;
    const box: R = { x0: cx - hx, x1: cx + hx, z0: cz - hz, z1: cz + hz };
    const M = 0.06;
    if (box.x0 < room.x0 + M || box.x1 > room.x1 - M || box.z0 < room.z0 + M || box.z1 > room.z1 - M) return false;
    for (const z of zones) if (hit(box, z.r)) return false;
    const tall = sh > 1.0;
    for (const z of windowZones) if (hit(box, tall ? z.tallR : z.r)) return false;
    for (const p of placed) if (hit(box, { x0: p.x - p.hx, x1: p.x + p.hx, z0: p.z - p.hz, z1: p.z + p.hz }, 0.12)) return false;
    placed.push({ id, x: cx, z: cz, quarterTurns: qt, hx, hz, h: sh });
    return true;
  };

  const NUDGE: number[] = [0];
  for (let k = 1; k <= 60; k++) NUDGE.push(k * 0.1, -k * 0.1);
  /** Back against wall `side` of `room`, centred at fraction `frac` (0..1) of the wall. */
  const wallPut = (room: R, id: PropId, side: Side, frac: number, gap = 0.08): boolean => {
    const [sw, sd] = SIZE.get(id)!;
    const qt = WALL_QT[side];
    const horiz = side === 'n' || side === 's';
    const depth = sd / 2;
    const lo = horiz ? room.x0 : room.z0;
    const hi = horiz ? room.x1 : room.z1;
    const base = lo + frac * (hi - lo);
    for (const n of NUDGE) {
      const a = base + n;
      let cx: number;
      let cz: number;
      if (side === 'n') [cx, cz] = [a, room.z0 + depth + gap];
      else if (side === 's') [cx, cz] = [a, room.z1 - depth - gap];
      else if (side === 'w') [cx, cz] = [room.x0 + depth + gap, a];
      else [cx, cz] = [room.x1 - depth - gap, a];
      if (tryPut(room, id, cx, cz, qt)) return true;
    }
    void sw;
    return false;
  };
  /** Like wallPut but at an explicit distance `dist` from the wall (to the prop centre). */
  const freePut = (room: R, id: PropId, side: Side, frac: number, dist: number, qt: number): boolean => {
    const horiz = side === 'n' || side === 's';
    const lo = horiz ? room.x0 : room.z0;
    const hi = horiz ? room.x1 : room.z1;
    const base = lo + frac * (hi - lo);
    for (const n of NUDGE) {
      const a = base + n;
      let cx: number;
      let cz: number;
      if (side === 'n') [cx, cz] = [a, room.z0 + dist];
      else if (side === 's') [cx, cz] = [a, room.z1 - dist];
      else if (side === 'w') [cx, cz] = [room.x0 + dist, a];
      else [cx, cz] = [room.x1 - dist, a];
      if (tryPut(room, id, cx, cz, qt)) return true;
    }
    return false;
  };
  const opposite: Record<Side, Side> = { n: 's', s: 'n', w: 'e', e: 'w' };
  const lenAlong = (room: R, side: Side) => (side === 'n' || side === 's' ? room.x1 - room.x0 : room.z1 - room.z0);
  const depthAcross = (room: R, side: Side) => (side === 'n' || side === 's' ? room.z1 - room.z0 : room.x1 - room.x0);
  const face = (side: Side) => (WALL_QT[side] + 2) % 4;

  // ---- recipes -------------------------------------------------------------------------------
  /** TV against `tvSide`, sofa facing it across the room (or against the opposite wall when the room is shallow). */
  const living = (r: R, tvSide: Side, frac = 0.5) => {
    wallPut(r, 'tv_stand', tvSide, frac);
    const across = depthAcross(r, tvSide);
    if (across >= 5.2) freePut(r, 'sofa', tvSide, frac, 3.0, WALL_QT[opposite[tvSide]]);
    else wallPut(r, 'sofa', opposite[tvSide], frac);
  };
  const decor = (r: R, sides: Side[], ids: PropId[]) => {
    ids.forEach((id, i) => {
      const s = sides[i % sides.length];
      wallPut(r, id, s, i % 2 === 0 ? 0.04 : 0.96);
    });
  };
  const bedroom = (r: R, side: Side, frac = 0.85) => {
    wallPut(r, 'bunk_bed', side, frac);
    wallPut(r, 'storage_shelf', opposite[side], 0.2);
  };
  /** Desk against `side` with its chair pulled up in front; returns true when the desk fitted. */
  const deskSet = (r: R, side: Side, frac: number): boolean => {
    if (!wallPut(r, 'office_desk', side, frac)) return false;
    const q = placed[placed.length - 1];
    const [ix, iz] = INWARD[side];
    const half = side === 'n' || side === 's' ? q.hz : q.hx;
    const off = half + 0.3 + 0.13;
    tryPut(r, 'office_chair', q.x + ix * off, q.z + iz * off, face(side));
    return true;
  };
  const study = (r: R, side: Side, frac = 0.5) => {
    deskSet(r, side, frac);
    wallPut(r, 'filing_cabinet', side, frac < 0.5 ? 0.92 : 0.08);
  };
  const storage = (r: R, side: Side) => {
    wallPut(r, 'storage_shelf', side, 0.2);
    wallPut(r, 'storage_shelf', side, 0.55);
    wallPut(r, 'supply_crate', side, 0.95);
    freePut(r, 'wooden_pallet', side, 0.5, 2.2, 0);
    freePut(r, 'cardboard_box', side, 0.2, 2.0, 0);
    wallPut(r, 'oil_drum', opposite[side], 0.1);
    wallPut(r, 'generator_box', opposite[side], 0.7);
  };
  const workshop = (r: R, side: Side) => {
    wallPut(r, 'storage_shelf', side, 0.15);
    wallPut(r, 'generator_box', side, 0.7);
    wallPut(r, 'tire_stack', side, 0.97);
    wallPut(r, 'oil_drum', opposite[side], 0.85);
    wallPut(r, 'toolbox', opposite[side], 0.5);
    wallPut(r, 'paint_bucket', opposite[side], 0.2);
    wallPut(r, 'gas_canister', side, 0.4);
  };
  void lenAlong;

  // ---- per-variant layouts -------------------------------------------------------------------
  switch (((variant % 10) + 10) % 10) {
    case 0: {
      // Cottage: living room with a sleeping corner
      const r = rooms.M;
      living(r, 'e');
      bedroom(r, 'w', 0.85);
      decor(r, ['s', 's', 'e'], ['potted_tree', 'trash_bin', 'flower_pot']);
      wallPut(r, 'cardboard_box', 'w', 0.4);
      wallPut(r, 'storage_shelf', 's', 0.5);
      wallPut(r, 'flower_pot', 'n', 0.96);
      break;
    }
    case 1: {
      // Ranch: bedroom wing west, living room east
      bedroom(rooms.W, 'w', 0.8);
      wallPut(rooms.W, 'storage_shelf', 's', 0.5);
      decor(rooms.W, ['n', 's'], ['flower_pot', 'trash_bin']);
      living(rooms.E, 'e');
      decor(rooms.E, ['s', 'n', 's'], ['potted_tree', 'flower_pot', 'trash_bin']);
      break;
    }
    case 2: {
      // Modern flat: study + bedroom west, open living east
      study(rooms.W, 'w', 0.3);
      wallPut(rooms.W, 'bunk_bed', 's', 0.5);
      wallPut(rooms.W, 'potted_tree', 'n', 0.05);
      living(rooms.E, 'e');
      decor(rooms.E, ['s', 's', 'n'], ['potted_tree', 'trash_bin', 'flower_pot']);
      wallPut(rooms.E, 'planter_box', 's', 0.5);
      break;
    }
    case 3: {
      // L-bungalow: living/bedroom main, study wing
      const r = rooms.M;
      living(r, 'w');
      bedroom(r, 'e', 0.75);
      decor(r, ['s', 'n'], ['potted_tree', 'trash_bin']);
      wallPut(r, 'cardboard_box', 'e', 0.25);
      wallPut(r, 'storage_shelf', 's', 0.4);
      const g = rooms.G;
      deskSet(g, 'w', 0.5);
      wallPut(g, 'filing_cabinet', 'e', 0.5);
      wallPut(g, 'flower_pot', 'e', 0.9);
      break;
    }
    case 4: {
      // Garage home: living east, tool bench zone south-west
      const r = rooms.M;
      living(r, 'e');
      wallPut(r, 'bunk_bed', 'n', 0.9);
      wallPut(r, 'storage_shelf', 's', 0.2);
      wallPut(r, 'tire_stack', 'w', 0.9);
      wallPut(r, 'toolbox', 'w', 0.2);
      wallPut(r, 'generator_box', 's', 0.5);
      wallPut(r, 'potted_tree', 'e', 0.04);
      wallPut(r, 'trash_bin', 's', 0.97);
      wallPut(r, 'paint_bucket', 'w', 0.5);
      wallPut(r, 'gas_canister', 'w', 0.6);
      break;
    }
    case 5: {
      // Shed-roof studio: office / drafting space with a lounge corner
      const r = rooms.M;
      study(r, 'e', 0.3);
      deskSet(r, 's', 0.3);
      wallPut(r, 'filing_cabinet', 's', 0.75);
      wallPut(r, 'storage_shelf', 'w', 0.3);
      wallPut(r, 'water_cooler', 'w', 0.8);
      wallPut(r, 'sofa', 'n', 0.75);
      wallPut(r, 'potted_tree', 'w', 0.04);
      wallPut(r, 'trash_bin', 'e', 0.97);
      break;
    }
    case 6: {
      // Brick cabin: bunks and a rough living area
      const r = rooms.M;
      wallPut(r, 'bunk_bed', 'w', 0.85);
      wallPut(r, 'bunk_bed', 'e', 0.85);
      living(r, 'e', 0.35);
      wallPut(r, 'storage_shelf', 'w', 0.3);
      wallPut(r, 'metal_locker', 's', 0.15);
      wallPut(r, 'ammo_chest', 's', 0.6);
      decor(r, ['w', 'e'], ['trash_bin', 'flower_pot']);
      wallPut(r, 'potted_tree', 'n', 0.04);
      wallPut(r, 'cardboard_box', 'n', 0.96);
      break;
    }
    case 7: {
      // Farmhouse: pantry / bedroom west, family room east
      const w = rooms.W;
      bedroom(w, 'w', 0.8);
      wallPut(w, 'supply_crate', 's', 0.3);
      wallPut(w, 'cardboard_box', 's', 0.8);
      decor(w, ['n', 'n'], ['flower_pot', 'trash_bin']);
      const e = rooms.E;
      living(e, 'e');
      wallPut(e, 'storage_shelf', 's', 0.3);
      decor(e, ['n', 's', 's'], ['potted_tree', 'trash_bin', 'flower_pot']);
      wallPut(e, 'planter_box', 'n', 0.9);
      break;
    }
    case 8: {
      // Desert adobe: living + sleeping main, storeroom wing
      const r = rooms.M;
      living(r, 'w');
      bedroom(r, 'e', 0.8);
      decor(r, ['n', 's', 'n'], ['potted_tree', 'trash_bin', 'flower_pot']);
      wallPut(r, 'water_cooler', 's', 0.3);
      const g = rooms.G;
      wallPut(g, 'storage_shelf', 'w', 0.5);
      wallPut(g, 'supply_crate', 'e', 0.35);
      wallPut(g, 'cardboard_box', 'e', 0.8);
      break;
    }
    case 9:
    default: {
      // Duplex: two mirrored flats
      living(rooms.W, 'w');
      wallPut(rooms.W, 'bunk_bed', 'n', 0.1);
      wallPut(rooms.W, 'storage_shelf', 's', 0.3);
      decor(rooms.W, ['s', 'n'], ['potted_tree', 'trash_bin']);
      living(rooms.E, 'e');
      wallPut(rooms.E, 'bunk_bed', 's', 0.9);
      wallPut(rooms.E, 'storage_shelf', 'n', 0.9);
      decor(rooms.E, ['n', 's'], ['potted_tree', 'flower_pot']);
      wallPut(rooms.E, 'cardboard_box', 's', 0.3);
      break;
    }
  }
  void storage;
  void workshop;
  return placed;
}

export function furnish(kit: Kit, f: Frame, info: StructureInfo, variant: number): void {
  void info;
  for (const p of layoutSingleHouse(variant)) placeDisguiseProp(kit, f, p.id, p.x, FLOOR_Y, p.z, p.quarterTurns);
}
