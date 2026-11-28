import type { Frame, Kit } from '../kit';
import type { StructureInfo } from '../structure';
import { STORY } from '../structure';
import type { PropId } from '../disguiseProps';
import { placeDisguiseProp } from '../propPlacement';

/**
 * Interior furnishing of Building01 (Tactical Command Center) (assets/buildings.ts). Called once per placed instance right after the
 * building factory, in the building's own local frame `f`, so every copy on every map gets the same interior.
 * Every object must be a Prop-Hunt disguise prop placed with placeDisguiseProp (assets/propPlacement.ts).
 *
 * Shell (Building01): footprint x -9..9, z -8..8, walls 0.3 m thick, 3 storeys of STORY m. Doors only on the ground floor
 * (n & s, x -1.1..1.1). Stairs: flight 0 east (ground to 2F), flight 1 west (2F to 3F), flight 2 east (3F to roof), all
 * running +z from z=-6.5 to z=-1.5. Layout is fully static (no randomness) so every client renders the same thing.
 */

/** [id, local x, local z, quarterTurns] — y is the storey's floor height. */
export type Placement = readonly [PropId, number, number, number];

/** Storey 0: lobby / duty desk, armoury (west wing) and operations side (east wing). Central x -1.5..1.5 is the clear hallway. */
export const GROUND_FLOOR: readonly Placement[] = [
  // west wing: duty desk, armoury lockers, storage rows, supply
  ['office_desk', -3.2, -5.6, 0],
  ['office_chair', -3.2, -4.8, 0],
  ['metal_locker', -8.38, -4.4, 1],
  ['metal_locker', -8.38, -3.75, 1],
  ['metal_locker', -8.38, -0.35, 1],
  ['metal_locker', -8.38, 0.3, 1],
  ['ammo_chest', -8.3, 3.85, 1],
  ['storage_shelf', -5.2, -1.3, 1],
  ['storage_shelf', -5.2, 0.0, 1],
  ['storage_shelf', -5.2, 1.3, 1],
  ['supply_crate', -3.2, 3.2, 0],
  ['supply_crate', -3.2, 4.6, 0],
  ['oil_drum', -5.6, 4.6, 0],
  ['oil_drum', -5.6, 5.5, 0],
  // east wing: watch desk, records, briefing table, power, lounge
  ['office_desk', 3.6, -5.2, 0],
  ['office_chair', 3.6, -4.4, 0],
  ['filing_cabinet', 2.0, -2.0, 0],
  ['filing_cabinet', 2.0, -1.35, 0],
  ['office_desk', 4.2, 0.9, 0],
  ['office_desk', 5.8, 0.9, 0],
  ['office_chair', 4.2, 1.65, 0],
  ['office_chair', 5.8, 1.65, 0],
  ['generator_box', 8.15, 3.85, 1],
  ['water_cooler', 8.45, 0.0, 0],
  ['sofa', 4.0, 5.7, 0],
  ['tv_stand', 4.0, 3.9, 2],
  ['potted_tree', 6.5, 5.6, 0],
];

/** Storey 1: operations floor — two rows of workstations facing the wall displays, records, lounge. */
export const SECOND_FLOOR: readonly Placement[] = [
  ['tv_stand', -2.5, -6.2, 0],
  ['tv_stand', 0.0, -6.2, 0],
  ['tv_stand', 2.5, -6.2, 0],
  ['office_desk', -2.5, -4.0, 0],
  ['office_desk', 0.0, -4.0, 0],
  ['office_desk', 2.5, -4.0, 0],
  ['office_chair', -2.5, -3.15, 0],
  ['office_chair', 0.0, -3.15, 0],
  ['office_chair', 2.5, -3.15, 0],
  ['office_desk', -2.5, 0.8, 0],
  ['office_desk', 0.0, 0.8, 0],
  ['office_desk', 2.5, 0.8, 0],
  ['office_chair', -2.5, 1.65, 0],
  ['office_chair', 0.0, 1.65, 0],
  ['office_chair', 2.5, 1.65, 0],
  ['filing_cabinet', -8.35, 3.55, 1],
  ['filing_cabinet', -8.35, 4.15, 1],
  ['water_cooler', -8.45, 0.2, 0],
  ['storage_shelf', 8.4, 3.85, 1],
  ['sofa', -4.2, 5.7, 0],
  ['tv_stand', -4.2, 3.9, 2],
  ['potted_tree', 6.6, 5.6, 0],
  ['radio_case', 0.0, 3.6, 0],
];

/** Storey 2: commander's suite, briefing lounges and crew quarters. */
export const THIRD_FLOOR: readonly Placement[] = [
  ['office_desk', 0.0, -5.2, 0],
  ['office_chair', 0.0, -4.4, 0],
  ['filing_cabinet', -2.2, -6.0, 0],
  ['filing_cabinet', 2.2, -6.0, 0],
  ['tv_stand', -3.8, -6.0, 0],
  ['tv_stand', 3.8, -6.0, 0],
  ['sofa', -3.6, 0.2, 0],
  ['tv_stand', -3.6, -1.6, 0],
  ['sofa', 3.6, 0.2, 0],
  ['tv_stand', 3.6, -1.6, 0],
  ['bunk_bed', -4.4, 5.5, 0],
  ['bunk_bed', -2.1, 5.5, 0],
  ['bunk_bed', 2.1, 5.5, 0],
  ['bunk_bed', 4.4, 5.5, 0],
  ['metal_locker', -8.38, 3.55, 1],
  ['metal_locker', -8.38, 4.15, 1],
  ['metal_locker', 8.38, 3.55, 3],
  ['metal_locker', 8.38, 4.15, 3],
  ['water_cooler', 8.45, 0.2, 0],
  ['flower_pot', 6.9, 2.2, 0],
];

/** Furniture per storey index (0 = ground). */
export const FLOORS: readonly (readonly Placement[])[] = [GROUND_FLOOR, SECOND_FLOOR, THIRD_FLOOR];

export function furnish(kit: Kit, f: Frame, info: StructureInfo): void {
  void info;
  for (let k = 0; k < FLOORS.length; k++) {
    const y = k * STORY;
    for (const [id, x, z, turns] of FLOORS[k]) placeDisguiseProp(kit, f, id, x, y, z, turns);
  }
}
