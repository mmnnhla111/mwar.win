import type { Frame, Kit } from '../kit';
import type { StructureInfo } from '../structure';
import { STORY } from '../structure';
import type { PropId } from '../disguiseProps';
import { placeDisguiseProp } from '../propPlacement';

/**
 * Interior furnishing of Building06 — Apartment Complex (4 storeys, balconies). Called once per placed instance
 * right after the building factory, in the building's own local frame `f`, so every copy on every map gets the
 * same interior. Every object is a Prop-Hunt disguise prop placed with placeDisguiseProp.
 *
 * Shell (local frame): interior x -6.7..6.7, z -7.7..7.7 (front / entrance on -z). Stair flights hug the east and
 * west walls for z -6.1..-1.1, so the whole x>4.1 / x<-4.1, z<0.15 strip is kept clear, as is the 1.5 m deep
 * strip behind the doors on the north wall (x = 0 on the ground floor, x = ±3.5 balcony doors above). Tall props
 * only stand in the wall gaps between windows. Floor walking surface of storey k = k × STORY. Fully deterministic.
 */
type Item = [id: PropId, x: number, z: number, quarterTurns: number];

// Ground floor: lobby, mailboxes, bike/storage room at the back.
const FLOOR0: Item[] = [
  ['mailbox', -3.7, -7.3, 0],
  ['mailbox', -3.1, -7.3, 0],
  ['potted_tree', 3.5, -7.2, 0],
  ['park_bench', -6.25, 3.0, 1],
  ['park_bench', 6.25, 1.6, 1],
  ['generator_box', 6.15, 3.85, 1],
  ['storage_shelf', 0, 7.375, 0],
  ['storage_shelf', -3.5, 7.375, 0],
  ['storage_shelf', 3.5, 7.375, 0],
  ['wooden_pallet', -5.3, 6.9, 0],
  ['oil_drum', 5.6, 6.9, 0],
  ['cardboard_box', 2.0, 2.0, 0],
  ['cardboard_box', -2.2, 2.4, 1],
  ['trash_bin', -6.2, 0.6, 0],
];

// Floor 1: family flat — living room west, dining middle, bedroom east.
const FLOOR1: Item[] = [
  ['tv_stand', -6.375, 3.85, 1],
  ['sofa', -3.8, 3.85, 3],
  ['flower_pot', -6.2, 6.9, 0],
  ['office_desk', 0.9, 5.6, 0],
  ['office_chair', 0.3, 6.4, 2],
  ['office_chair', 1.5, 6.4, 2],
  ['office_chair', 0.3, 4.8, 0],
  ['office_chair', 1.5, 4.8, 0],
  ['bunk_bed', 6.125, 3.85, 1],
  ['metal_locker', 3.0, 7.35, 0],
  ['metal_locker', 3.7, 7.35, 0],
  ['trash_bin', -3.5, 7.25, 0],
  ['utility_box', 0, 7.375, 0],
];

// Floor 2: shared flat — living room east, bunk room west, study corner.
const FLOOR2: Item[] = [
  ['tv_stand', 6.375, 3.85, 3],
  ['sofa', 3.8, 3.85, 1],
  ['bunk_bed', -6.125, 3.85, 1],
  ['planter_box', -5.0, 7.3, 0],
  ['filing_cabinet', -3.7, 7.3, 0],
  ['filing_cabinet', -3.2, 7.3, 0],
  ['office_desk', -1.0, 5.8, 0],
  ['office_chair', -1.0, 6.7, 2],
  ['office_chair', -1.0, 4.9, 0],
  ['water_cooler', 0, 7.4, 0],
  ['potted_tree', 3.5, 7.2, 0],
  ['flower_pot', -6.2, 7.2, 0],
  ['flower_pot', 6.2, 7.2, 0],
  ['cardboard_box', -2.0, 1.0, 0],
];

// Floor 3: penthouse — lounge, workspace, storage nook.
const FLOOR3: Item[] = [
  ['tv_stand', -6.375, 3.85, 1],
  ['sofa', -3.8, 3.85, 3],
  ['planter_box', 1.0, 7.3, 0],
  ['flower_pot', -6.2, 7.2, 0],
  ['flower_pot', 6.2, 7.2, 0],
  ['bunk_bed', 6.125, 3.85, 1],
  ['office_desk', 2.5, 5.6, 0],
  ['office_chair', 2.5, 6.4, 2],
  ['office_chair', 2.5, 4.8, 0],
  ['metal_locker', -3.7, 7.35, 0],
  ['metal_locker', -3.1, 7.35, 0],
  ['ammo_chest', -2.0, 1.2, 0],
  ['flower_pot', -1.0, 7.3, 0],
  ['trash_bin', 3.5, 7.25, 0],
  ['water_cooler', 0, 7.4, 0],
];

const FLOORS: Item[][] = [FLOOR0, FLOOR1, FLOOR2, FLOOR3];

export function furnish(kit: Kit, f: Frame, info: StructureInfo): void {
  void info;
  for (let k = 0; k < FLOORS.length; k++) {
    const y = k * STORY;
    for (const [id, x, z, q] of FLOORS[k]) placeDisguiseProp(kit, f, id, x, y, z, q);
  }
}
