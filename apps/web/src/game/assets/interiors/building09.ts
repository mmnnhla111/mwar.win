import type { Frame, Kit } from '../kit';
import { STORY } from '../structure';
import type { StructureInfo } from '../structure';
import type { PropId } from '../disguiseProps';
import { placeDisguiseProp } from '../propPlacement';

/**
 * Interior furnishing of Building09 — Plaza Tower (5 storeys, 13 x 13 m, walls 0.3 m, doors N/S on the ground
 * floor only, stair flights hugging the east/west walls on z -5.3..-0.3). Called once per placed instance right
 * after the building factory, in the building's own local frame `f`, so every copy on every map gets the same
 * interior. Every object is a Prop-Hunt disguise prop placed with placeDisguiseProp.
 *
 * Reserved (kept clear on every floor): stair columns x +-[3.6, 6.2] for z < 1.0, a 2.4 m wide north-south
 * spine x in [-1.2, 1.2], and the ground-floor door lobbies (|x| < 1.5 within 1.4 m of both doors). Tall props
 * only stand against solid wall segments, never in front of window openings.
 *
 * Floors: 0 reception lobby, 1 open-plan office, 2 server / utility floor, 3 executive suites, 4 command deck.
 */
export interface Building09Placement {
  floor: number;
  id: PropId;
  x: number;
  z: number;
  qt: number;
}

type P = [PropId, number, number, number];

const FLOORS: P[][] = [
  // 0 - reception lobby
  [
    ['office_desk', -2.6, -3.6, 0],
    ['office_chair', -2.6, -2.75, 0],
    ['tv_stand', 2.6, -4.0, 0],
    ['water_cooler', 3.1, -5.8, 0],
    ['filing_cabinet', -3.2, -5.82, 0],
    ['sofa', -2.9, 2.0, 0],
    ['sofa', 2.9, 2.0, 0],
    ['planter_box', -3.0, 3.4, 0],
    ['planter_box', 3.0, 3.4, 0],
    ['potted_tree', -3.3, 5.65, 0],
    ['potted_tree', 3.3, 5.65, 0],
    ['trash_bin', -5.65, 3.1, 0],
    ['trash_bin', 5.65, 3.1, 0],
  ],
  // 1 - open-plan office
  [
    ['office_desk', -2.5, -4.95, 0],
    ['office_chair', -2.5, -4.15, 0],
    ['office_desk', -2.5, -2.4, 0],
    ['office_chair', -2.5, -1.6, 0],
    ['office_desk', 2.5, -4.95, 0],
    ['office_chair', 2.5, -4.15, 0],
    ['office_desk', 2.5, -2.4, 0],
    ['office_chair', 2.5, -1.6, 0],
    ['office_desk', -2.5, 2.2, 0],
    ['office_chair', -2.5, 3.0, 0],
    ['office_desk', 2.5, 2.2, 0],
    ['office_chair', 2.5, 3.0, 0],
    ['filing_cabinet', -5.85, 2.7, 1],
    ['filing_cabinet', 5.85, 2.7, 3],
    ['water_cooler', -5.8, 5.7, 0],
  ],
  // 2 - server / utility floor
  [
    ['storage_shelf', -3.25, 5.9, 0],
    ['storage_shelf', 3.25, 5.9, 0],
    ['generator_box', -2.6, -2.5, 0],
    ['generator_box', 2.6, -2.5, 0],
    ['utility_box', -5.9, 3.1, 1],
    ['utility_box', 5.9, 3.1, 3],
    ['metal_locker', -3.4, 2.0, 0],
    ['metal_locker', -2.7, 2.0, 0],
    ['metal_locker', 2.7, 2.0, 0],
    ['metal_locker', 3.4, 2.0, 0],
    ['office_desk', -2.5, 4.0, 0],
    ['office_chair', -2.5, 4.8, 0],
    ['office_desk', 2.5, 4.0, 0],
    ['office_chair', 2.5, 4.8, 0],
  ],
  // 3 - executive suites
  [
    ['office_desk', -2.5, -4.6, 0],
    ['office_chair', -2.5, -3.8, 0],
    ['office_desk', 2.5, -4.6, 0],
    ['office_chair', 2.5, -3.8, 0],
    ['sofa', -3.0, -1.5, 1],
    ['sofa', 3.0, -1.5, 3],
    ['potted_tree', -3.0, 0.2, 0],
    ['potted_tree', 3.0, 0.2, 0],
    ['sofa', -3.0, 4.5, 0],
    ['sofa', 3.0, 4.5, 0],
    ['tv_stand', -3.3, 5.9, 0],
    ['tv_stand', 3.3, 5.9, 0],
    ['water_cooler', -5.8, 3.1, 0],
    ['trash_bin', 5.65, 3.1, 0],
  ],
  // 4 - command deck
  [
    ['bunk_bed', -3.25, 5.65, 0],
    ['bunk_bed', 3.25, 5.65, 0],
    ['metal_locker', -5.85, 2.55, 1],
    ['metal_locker', -5.85, 3.2, 1],
    ['metal_locker', 5.85, 2.55, 3],
    ['metal_locker', 5.85, 3.2, 3],
    ['tv_stand', -2.9, -5.8, 0],
    ['tv_stand', 2.9, -5.8, 0],
    ['office_desk', -2.5, -3.4, 0],
    ['office_chair', -2.5, -2.6, 0],
    ['office_desk', 2.5, -3.4, 0],
    ['office_chair', 2.5, -2.6, 0],
    ['ammo_chest', -2.8, 1.8, 0],
    ['supply_crate', -2.9, 3.2, 0],
    ['ammo_chest', 2.8, 1.8, 0],
    ['supply_crate', 2.9, 3.2, 0],
  ],
];

/** Flat, deterministic list of every placement (floor index, prop id, local x/z, quarter turns). */
export const BUILDING09_LAYOUT: readonly Building09Placement[] = FLOORS.flatMap((list, floor) =>
  list.map(([id, x, z, qt]) => ({ floor, id, x, z, qt }))
);

export function furnish(kit: Kit, f: Frame, info: StructureInfo): void {
  void info;
  for (const p of BUILDING09_LAYOUT) {
    placeDisguiseProp(kit, f, p.id, p.x, p.floor * STORY, p.z, p.qt);
  }
}
