import type { Frame, Kit } from '../kit';
import type { StructureInfo } from '../structure';
import type { PropId } from '../disguiseProps';
import { placeDisguiseProp } from '../propPlacement';

/**
 * Interior furnishing of Building08 — Garage Hangar (assets/buildings.ts). Called once per placed instance right
 * after the building factory, in the building's own local frame `f`, so every copy on every map gets the same
 * interior. Every object is a Prop-Hunt disguise prop placed with placeDisguiseProp (assets/propPlacement.ts).
 *
 * Factory geometry (local): room x -9.5..9.5, z -8..8 (walls 0.3 thick), ground floor y = 0, catwalk slab top
 * y = 3.4 over x -9.2..9.2, z 5.2..7.7 (rail at z 5.25), stairs x -9.1..-7.7, z -0.8..5.2. Front opening (north,
 * x -4.5..4.5), south door x 4.8..6.2, east door z -5.4..-4.0. Existing cover: car x 1.4..3.6 z -3.3..1.3,
 * bench x 5.2..8.4 z 2.5..3.5, red cabinet x -3.5..-2.5 z 2.6..3.4.
 * Deterministic: a fixed table, no randomness.
 */

export const GROUND_Y = 0;
export const CATWALK_Y = 3.4;

/** [id, lx, y, lz, quarterTurns] */
export type Building08Placement = readonly [PropId, number, number, number, number];

export const LAYOUT: readonly Building08Placement[] = [
  // ---- Ground floor: workshop + parts store ----
  // west wall shelving (depth along x -> 1 quarter turn), clear of the stair foot landing (z > -2.0)
  ['storage_shelf', -9.07, GROUND_Y, -6.6, 1],
  ['storage_shelf', -9.07, GROUND_Y, -5.35, 1],
  ['storage_shelf', -9.07, GROUND_Y, -4.1, 1],
  ['supply_crate', -6.9, GROUND_Y, -6.9, 0],
  ['wooden_pallet', -7.0, GROUND_Y, -5.2, 0],
  // east wall: generator + drums (clear of the east door zone z -6.0..-3.4)
  ['generator_box', 8.8, GROUND_Y, -1.5, 1],
  ['oil_drum', 8.8, GROUND_Y, 0.4, 0],
  ['tire_stack', 8.5, GROUND_Y, 5.2, 0],
  // south wall: lockers + shelving (door zone x 4.4..6.6 kept open)
  ['metal_locker', 7.3, GROUND_Y, 7.55, 0],
  ['metal_locker', 7.95, GROUND_Y, 7.55, 0],
  ['storage_shelf', 3.0, GROUND_Y, 7.575, 0],
  ['storage_shelf', 1.75, GROUND_Y, 7.575, 0],
  // site office corner
  ['office_desk', -4.7, GROUND_Y, 7.45, 0],
  ['office_chair', -4.7, GROUND_Y, 6.3, 0],
  ['filing_cabinet', -3.4, GROUND_Y, 7.5, 0],
  // north-east corner
  ['dumpster', 7.5, GROUND_Y, -6.8, 0],
  ['toolbox', 6.9, GROUND_Y, 1.5, 0],
  // ---- Catwalk (y = 3.4): storage mezzanine ----
  ['storage_shelf', -4.5, CATWALK_Y, 7.45, 0],
  ['storage_shelf', -3.25, CATWALK_Y, 7.45, 0],
  ['oil_drum', 0.0, CATWALK_Y, 7.2, 0],
  ['ammo_chest', 2.0, CATWALK_Y, 7.2, 0],
  ['ammo_chest', 3.8, CATWALK_Y, 7.2, 0],
  ['metal_locker', 5.5, CATWALK_Y, 7.4, 0],
  ['metal_locker', 6.2, CATWALK_Y, 7.4, 0],
  ['toolbox', 7.2, CATWALK_Y, 6.5, 0],
];

export function furnish(kit: Kit, f: Frame, info: StructureInfo): void {
  void info;
  for (const [id, lx, y, lz, q] of LAYOUT) placeDisguiseProp(kit, f, id, lx, y, lz, q);
}
