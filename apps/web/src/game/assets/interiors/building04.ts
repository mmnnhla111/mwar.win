import type { Frame, Kit } from '../kit';
import type { StructureInfo } from '../structure';
import { STORY } from '../structure';
import type { PropId } from '../disguiseProps';
import { placeDisguiseProp } from '../propPlacement';

/**
 * Interior furnishing of Building04 — Corner Commercial Block (assets/buildings.ts). Called once per placed
 * instance right after the building factory, in the building's own local frame `f`, so every copy on every
 * map gets the same interior. Every object is a Prop-Hunt disguise prop placed with placeDisguiseProp.
 *
 * Shell (local frame): outer rect x,z in [-8, 8], wall t = 0.3 -> interior [-7.7, 7.7]. Doors on the ground
 * floor: north (x = 0) and west (z = 0), 2.0 m wide. Stairs: flight 0 hugs the east wall (x 6.38..7.68,
 * z -6.5..-1.5), flight 1 hugs the west wall (x -7.68..-6.38, z -6.5..-1.5). Windows: 4 per side per storey
 * (x = -6, -2, 2, 6 on N/S; z = -5.775, -1.925, 1.925, 5.775 on E/W; the ground west wall has none at 5.775/
 * 1.925 because of the door).
 *
 * Layout: ground floor = corner shop (shelf rows, counter with till chair, stock along the back wall);
 * first floor = offices + lounge. No tall prop stands in front of a window; door and stair landings are free.
 */

/** Visual floor finish is 1.6 cm thick; 8 mm keeps every base within 1 cm of both the collider and the finish. */
const FIN = 0.008;

export interface Placement {
  id: PropId;
  /** Floor index (0 ground, 1 first floor). */
  floor: 0 | 1;
  lx: number;
  lz: number;
  q: number;
}

const p = (floor: 0 | 1, id: PropId, lx: number, lz: number, q = 0): Placement => ({ id, floor, lx, lz, q });

export const BUILDING04_PLACEMENTS: readonly Placement[] = [
  // ---- Ground floor: general shop ----
  // Shelf row A (north aisle), west group + east group, leaving the central door lane free.
  p(0, 'storage_shelf', -4.4, -3.0),
  p(0, 'storage_shelf', -3.15, -3.0),
  p(0, 'storage_shelf', -1.9, -3.0),
  p(0, 'storage_shelf', 2.0, -3.0),
  p(0, 'storage_shelf', 3.25, -3.0),
  // Shelf row B (south aisle).
  p(0, 'storage_shelf', -3.8, 0.9),
  p(0, 'storage_shelf', -2.55, 0.9),
  p(0, 'storage_shelf', 2.0, 0.9),
  p(0, 'storage_shelf', 3.25, 0.9),
  // Checkout counter behind the door, with till chair and back-office cabinet.
  p(0, 'office_desk', 3.5, -5.0),
  p(0, 'office_chair', 3.5, -5.9),
  p(0, 'filing_cabinet', 4.0, -7.3),
  // North wall corner / segment between windows.
  p(0, 'metal_locker', -7.3, -7.3),
  p(0, 'water_cooler', -4.0, -7.3),
  // West wall (south of the door) and corner greenery.
  p(0, 'trash_bin', -7.1, 3.0),
  p(0, 'planter_box', -7.3, 4.5, 1),
  p(0, 'potted_tree', -7.15, 5.85),
  // South wall stock room shelves + east wall crate.
  p(0, 'storage_shelf', -4.0, 7.425),
  p(0, 'storage_shelf', 0.0, 7.425),
  p(0, 'storage_shelf', 4.0, 7.425),
  p(0, 'cardboard_box', -1.6, 6.6),
  p(0, 'supply_crate', 7.0, 3.85),

  // ---- First floor: offices + lounge ----
  // Front desk row (north wall).
  p(1, 'office_desk', -3.0, -6.8),
  p(1, 'office_chair', -3.0, -5.9),
  p(1, 'office_desk', 0.0, -6.8),
  p(1, 'office_chair', 0.0, -5.9),
  p(1, 'office_desk', 3.0, -6.8),
  p(1, 'office_chair', 3.0, -5.9),
  // Second desk row.
  p(1, 'office_desk', -1.5, -3.0),
  p(1, 'office_chair', -1.5, -2.1),
  p(1, 'office_desk', 1.5, -3.0),
  p(1, 'office_chair', 1.5, -2.1),
  // Lounge facing the TV (south wall).
  p(1, 'sofa', 0.0, 4.9, 2),
  p(1, 'tv_stand', 0.0, 7.4),
  // East wall utilities (between windows), west wall lockers.
  p(1, 'water_cooler', 7.3, 3.85),
  p(1, 'filing_cabinet', 7.3, 4.6, 1),
  p(1, 'metal_locker', -7.35, 3.2, 1),
  p(1, 'metal_locker', -7.35, 3.85, 1),
  // Greenery in the corners.
  p(1, 'flower_pot', 7.2, 7.2),
  p(1, 'flower_pot', -7.2, 7.2),
];

export function furnish(kit: Kit, f: Frame, info: StructureInfo): void {
  void info;
  for (const pl of BUILDING04_PLACEMENTS) {
    const y = (pl.floor === 0 ? 0 : STORY) + FIN;
    placeDisguiseProp(kit, f, pl.id, pl.lx, y, pl.lz, pl.q);
  }
}
