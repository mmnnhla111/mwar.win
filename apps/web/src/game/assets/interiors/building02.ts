import type { Frame, Kit } from '../kit';
import type { StructureInfo } from '../structure';
import { STORY } from '../structure';
import type { PropId } from '../disguiseProps';
import { placeDisguiseProp } from '../propPlacement';

/**
 * Interior furnishing of Building02 (Logistics Warehouse) (assets/buildings.ts). Called once per placed instance right after the
 * building factory, in the building's own local frame `f`, so every copy on every map gets the same interior.
 * Every object must be a Prop-Hunt disguise prop placed with placeDisguiseProp (assets/propPlacement.ts).
 *
 * Layout notes (local frame, interior faces x -8.7..6.7, z -6.7..6.7):
 *  - ground floor y = 0: loading bays along the north wall (keep the roll-up door x -3.75..1.75 and the
 *    side doors clear), racking in the centre, stock under the mezzanine, supervisor / storage corner on the mezzanine.
 *  - mezzanine y = STORY (slab z 2.2..6.7), reached by the stairs at x -8.65..-7.35, z -2.9..2.2.
 */
export interface Building02Placement {
  id: PropId;
  x: number;
  y: number;
  z: number;
  q: number;
}

const GROUND = 0;
const MEZZ = STORY;

const g = (id: PropId, x: number, z: number, q = 0): Building02Placement => ({ id, x, y: GROUND, z, q });
const m = (id: PropId, x: number, z: number, q = 0): Building02Placement => ({ id, x, y: MEZZ, z, q });

export const PLACEMENTS: readonly Building02Placement[] = [
  // --- Ground floor: the factory's own pallet row (z -3.6..-2.4) stays in the middle; stock in the north corners
  g('wooden_pallet', -4.6, -5.1),
  g('oil_drum', -4.7, -6.25),
  g('oil_drum', 2.4, -5.8),
  g('oil_drum', 3.3, -5.8),
  g('supply_crate', 3.4, -4.6),
  g('generator_box', 5.0, -6.0),
  // west wall bay (north of the stairs)
  g('storage_shelf', -8.4, -5.2, 1),
  g('oil_drum', -8.2, -6.25),
  // central racking (back-to-back double rows)
  g('storage_shelf', -4.2, -0.25),
  g('storage_shelf', -4.2, 0.25),
  g('storage_shelf', -3.0, -0.25),
  g('storage_shelf', -3.0, 0.25),
  g('storage_shelf', -1.8, -0.25),
  g('storage_shelf', -1.8, 0.25),
  g('storage_shelf', 2.6, -0.25),
  g('storage_shelf', 2.6, 0.25),
  // under the mezzanine: south wall racking, west wall racking, stock
  g('storage_shelf', -5.4, 6.425),
  g('storage_shelf', -4.2, 6.425),
  g('storage_shelf', -3.0, 6.425),
  g('storage_shelf', -1.8, 6.425),
  g('storage_shelf', 5.0, 6.425),
  g('storage_shelf', -8.4, 4.5, 1),
  g('storage_shelf', -8.4, 5.7, 1),
  g('supply_crate', -3.8, 3.6),
  g('supply_crate', -2.6, 3.6),
  g('cardboard_box', -1.3, 3.5),
  g('cardboard_box', -1.3, 4.3),
  g('wooden_pallet', 0.8, 4.4),
  g('ammo_chest', 5.5, 3.6),
  g('ammo_chest', 5.5, 4.5),

  // --- Mezzanine (y = STORY): shelving along the railing, dispatch office at the south-east, low stock by the windows
  m('storage_shelf', -4.4, 2.65),
  m('storage_shelf', -3.2, 2.65),
  m('storage_shelf', -0.2, 2.65),
  m('storage_shelf', 1.0, 2.65),
  m('storage_shelf', 3.4, 2.65),
  m('storage_shelf', 4.6, 2.65),
  m('wooden_pallet', -5.0, 6.15),
  m('wooden_pallet', -3.0, 6.15),
  m('cardboard_box', -1.6, 6.4),
  m('toolbox', -1.0, 6.4),
  m('wooden_pallet', -8.1, 4.5, 1),
  m('cardboard_box', -8.1, 5.9),
  m('supply_crate', -1.8, 4.4),
  m('supply_crate', -0.6, 4.4),
  m('ammo_chest', 0.6, 5.4),
  m('filing_cabinet', 2.0, 6.35),
  m('metal_locker', 3.0, 6.4),
  m('metal_locker', 3.7, 6.4),
  m('office_desk', 4.6, 4.6),
  m('office_chair', 4.6, 5.45),
];

export function furnish(kit: Kit, f: Frame, info: StructureInfo): void {
  void info;
  for (const p of PLACEMENTS) placeDisguiseProp(kit, f, p.id, p.x, p.y, p.z, p.q);
}
