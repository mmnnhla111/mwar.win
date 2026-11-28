import type { Frame, Kit } from '../kit';
import type { StructureInfo } from '../structure';
import type { PropId } from '../disguiseProps';
import { placeDisguiseProp } from '../propPlacement';

/**
 * Interior furnishing of Building07 — Fortified Bunker (assets/buildings.ts). Called once per placed instance
 * right after the building factory, in the building's own local frame `f`, so every copy on every map gets the
 * same interior. Every object is a Prop-Hunt disguise prop placed with placeDisguiseProp.
 *
 * Single ground-floor room, inner clear area x -6.3..6.3, z -5.3..5.3 (0.7 m walls), floor surface y = 0.
 * Doors: north (x 0), south (x -4). Firing slits (sill 1.35 m): n x ±1.75/±5.25, s x -1.75/1.75/5.25,
 * w/e z -3.53/0/3.53 — tall props (> 1.3 m) are kept out of those spans.
 *
 * Layout: barracks (bunk beds + lockers) west/north, armoury (shelves, ammo, generator) east,
 * command desks south, supply stacks in the middle; the centre lane between the doors stays clear.
 */
export interface BunkerProp {
  id: PropId;
  x: number;
  z: number;
  q: number;
}

export const BUNKER_FLOOR_Y = 0;

export const BUNKER_LAYOUT: readonly BunkerProp[] = [
  // Barracks: bunk beds along the north wall between the slits (flanking the door lane)
  { id: 'bunk_bed', x: -3.5, z: -4.775, q: 0 },
  { id: 'bunk_bed', x: 3.5, z: -4.775, q: 0 },
  // Lockers along the west wall, in the gaps between slits
  { id: 'metal_locker', x: -6.0, z: -2.4, q: 1 },
  { id: 'metal_locker', x: -6.0, z: -1.75, q: 1 },
  { id: 'metal_locker', x: -6.0, z: 1.75, q: 1 },
  { id: 'metal_locker', x: -6.0, z: 2.4, q: 1 },
  { id: 'trash_bin', x: -5.7, z: -4.7, q: 0 },
  { id: 'water_cooler', x: -5.4, z: 4.6, q: 0 },
  // Armoury along the east wall
  { id: 'storage_shelf', x: 6.025, z: -1.77, q: 1 },
  { id: 'storage_shelf', x: 6.025, z: 1.77, q: 1 },
  { id: 'ammo_chest', x: 5.925, z: -3.53, q: 1 },
  { id: 'ammo_chest', x: 5.925, z: 3.53, q: 1 },
  { id: 'generator_box', x: 5.8, z: 0, q: 1 },
  { id: 'toolbox', x: 5.0, z: -4.8, q: 0 },
  { id: 'radio_case', x: 5.7, z: -4.8, q: 0 },
  // Command desks along the south wall
  { id: 'office_desk', x: 1.3, z: 4.9, q: 2 },
  { id: 'office_chair', x: 1.3, z: 4.0, q: 0 },
  { id: 'office_desk', x: 3.5, z: 4.9, q: 2 },
  { id: 'office_chair', x: 3.5, z: 4.0, q: 0 },
  { id: 'tv_stand', x: 5.4, z: 4.95, q: 2 },
  { id: 'filing_cabinet', x: -1.8, z: 4.95, q: 2 },
  // Supply stacks in the middle
  { id: 'wooden_pallet', x: 3.2, z: -1.2, q: 0 },
  { id: 'supply_crate', x: 4.6, z: -1.3, q: 0 },
  { id: 'oil_drum', x: 3.0, z: 1.2, q: 0 },
  { id: 'oil_drum', x: 3.85, z: 1.2, q: 0 },
  { id: 'sandbag_barrier', x: -3.2, z: 1.0, q: 0 },
];

export function furnish(kit: Kit, f: Frame, info: StructureInfo): void {
  void info;
  for (const p of BUNKER_LAYOUT) placeDisguiseProp(kit, f, p.id, p.x, BUNKER_FLOOR_Y, p.z, p.q);
}
