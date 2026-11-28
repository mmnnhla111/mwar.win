import type { Frame, Kit } from '../kit';
import type { StructureInfo } from '../structure';
import { STORY } from '../structure';
import type { PropId } from '../disguiseProps';
import { placeDisguiseProp } from '../propPlacement';

/**
 * Interior furnishing of Building03 — Sniper Watchtower (slim 4-storey tower, 7.2 m square, 0.3 m walls,
 * alternating east/west stair flights along the side walls, wide windows on the top deck).
 * Called once per placed instance right after the building factory, in the building's own local frame `f`,
 * so every copy on every map gets the same interior. Every object is a Prop-Hunt disguise prop.
 *
 * Floor plan (local x/z, inner room x,z in [-3.3, 3.3], entrance door on the -z wall of the ground floor):
 *   ground : guard post  - lockers, ammo chest, desk + chair, generator, water cooler, shelf
 *   1      : radio room  - desk + chair, filing cabinet, shelf, ammo chest
 *   2      : barracks    - bunk bed, lockers, shelf, ammo chest
 *   3      : firing deck - sandbags, map desk, ammo chest (all low: the wide windows start at 1.0 m)
 * The stair flights hug the east wall (floors 0, 2) / west wall (floors 1, 3); a clear corridor |x| < 0.8 runs
 * the full depth of every floor and the stair feet / landings / ground door are kept free.
 */
export interface B03Placement {
  id: PropId;
  floor: number;
  lx: number;
  lz: number;
  q: number;
}

const P = (floor: number, id: PropId, lx: number, lz: number, q = 0): B03Placement => ({ id, floor, lx, lz, q });

export const BUILDING03_PLACEMENTS: readonly B03Placement[] = [
  // ---- ground floor: guard post (door on -z wall at x = 0; flight 0 on the east wall) ----
  P(0, 'office_desk', -2.5, -2.9),
  P(0, 'office_chair', -2.5, -2.0),
  P(0, 'metal_locker', -3.0, 2.0, 1),
  P(0, 'metal_locker', -3.0, 2.65, 1),
  P(0, 'ammo_chest', -2.925, 0.2, 1),
  P(0, 'storage_shelf', -1.8, 3.025),
  P(0, 'water_cooler', -1.0, 3.0),
  P(0, 'generator_box', 1.7, 2.7),
  // ---- floor 1: radio room (arrival hole east, flight 1 on the west wall) ----
  P(1, 'office_desk', -2.5, 2.9),
  P(1, 'office_chair', -2.5, 2.1),
  P(1, 'filing_cabinet', -1.4, 2.95),
  P(1, 'storage_shelf', -1.7, 0.3, 1),
  P(1, 'ammo_chest', 1.4, -2.925),
  // ---- floor 2: barracks (arrival hole west, flight 2 on the east wall) ----
  P(2, 'bunk_bed', 2.25, 2.775),
  P(2, 'metal_locker', -1.72, -3.0),
  P(2, 'metal_locker', -1.1, -3.0),
  P(2, 'storage_shelf', 1.7, 0.75, 1),
  P(2, 'ammo_chest', 1.5, -0.7, 1),
  // ---- floor 3: firing deck (arrival hole east, flight 3 on the west wall); every prop <= 0.9 m high ----
  P(3, 'sandbag_barrier', -2.0, 2.85),
  P(3, 'ammo_chest', 1.4, -2.925),
  P(3, 'sandbag_barrier', 1.55, -0.3, 1),
  P(3, 'office_desk', -1.7, 0.3, 1),
];

export function furnish(kit: Kit, f: Frame, info: StructureInfo): void {
  void info;
  for (const p of BUILDING03_PLACEMENTS) placeDisguiseProp(kit, f, p.id, p.lx, p.floor * STORY, p.lz, p.q);
}
