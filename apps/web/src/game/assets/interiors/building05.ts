import type { Frame, Kit } from '../kit';
import { STORY } from '../structure';
import type { StructureInfo } from '../structure';
import type { PropId } from '../disguiseProps';
import { placeDisguiseProp } from '../propPlacement';

/**
 * Interior furnishing of Building05 — Tech Research Lab (assets/buildings.ts). Called once per placed instance
 * right after the building factory, in the building's own local frame `f`, so every copy on every map gets the
 * same interior. Every object is a Prop-Hunt disguise prop placed with placeDisguiseProp.
 *
 * Shell (local frame): footprint x -9..9, z -7..7, walls 0.3 m thick, 2 storeys (STORY 3.2). Main door in the
 * north wall (x 0, z -7), side door in the east wall (z +0.3). Stair flight 0 hugs the east wall (z -5.5 → -0.5,
 * ground → floor 1), flight 1 hugs the west wall (z -5.5 → -0.5, floor 1 → roof). The walking surface of
 * storey k is k × STORY.
 *
 * Layout intent:
 *  - Ground floor: research bay (work desks + lockers + filing) in the west half, power / equipment bay
 *    (generators, utility box, ammo chest, desks) in the east half, shelving by the entrance, clear centre aisle.
 *  - First floor: office + lounge — lockers along the north wall, two workstations, a sofa + TV corner,
 *    water cooler, planters, shelves on the side walls.
 */
export interface Building05Placement {
  id: PropId;
  /** Local frame x / z of the prop's base centre. */
  x: number;
  z: number;
  /** Storey index: 0 = ground floor, 1 = first floor. */
  floor: 0 | 1;
  quarterTurns: number;
}

const P = (floor: 0 | 1, id: PropId, x: number, z: number, quarterTurns = 0): Building05Placement => ({ id, x, z, floor, quarterTurns });

/** Static, deterministic layout (no randomness — identical on every map and client). */
export const BUILDING05_PLACEMENTS: readonly Building05Placement[] = [
  // ---- Ground floor ----
  // Entrance shelving (either side of the north door aisle, between windows)
  P(0, 'storage_shelf', -2.4, -6.4),
  P(0, 'storage_shelf', 2.4, -6.4),
  // West research bay
  P(0, 'office_desk', -6.0, -3.0),
  P(0, 'office_chair', -6.0, -2.05, 2),
  P(0, 'office_desk', -3.2, -3.0),
  P(0, 'office_chair', -3.2, -2.05, 2),
  P(0, 'metal_locker', -8.35, -3.4, 1),
  P(0, 'metal_locker', -8.35, 0.0, 1),
  P(0, 'filing_cabinet', -8.35, 3.4, 1),
  // East equipment bay
  P(0, 'generator_box', 3.0, -3.2),
  P(0, 'generator_box', 5.2, -3.2),
  P(0, 'utility_box', 3.0, -0.8),
  P(0, 'ammo_chest', 5.2, -0.8),
  P(0, 'office_desk', 4.0, 2.6),
  P(0, 'office_chair', 4.0, 3.55, 2),
  // Back of the hall
  P(0, 'water_cooler', 0.0, 6.3),

  // ---- First floor ----
  // Lockers along the north wall (between window pairs)
  P(1, 'metal_locker', -3.0, -6.4),
  P(1, 'metal_locker', 0.0, -6.4),
  P(1, 'metal_locker', 3.0, -6.4),
  // Two workstations
  P(1, 'office_desk', -3.6, -3.2),
  P(1, 'office_chair', -3.6, -2.25, 2),
  P(1, 'office_desk', 3.6, -3.2),
  P(1, 'office_chair', 3.6, -2.25, 2),
  // Lounge corner (sofa faces the TV)
  P(1, 'tv_stand', -3.0, 3.0),
  P(1, 'sofa', -3.0, 5.2, 2),
  P(1, 'water_cooler', 0.0, 5.9),
  P(1, 'planter_box', 2.8, 5.9),
  P(1, 'potted_tree', 6.0, 6.0),
  // Side-wall shelving
  P(1, 'storage_shelf', 8.4, 3.35, 1),
  P(1, 'storage_shelf', -8.4, 3.35, 1),
  P(1, 'ammo_chest', 4.6, 0.6),
];

export function furnish(kit: Kit, f: Frame, info: StructureInfo): void {
  void info;
  for (const p of BUILDING05_PLACEMENTS) {
    placeDisguiseProp(kit, f, p.id, p.x, p.floor * STORY, p.z, p.quarterTurns);
  }
}
