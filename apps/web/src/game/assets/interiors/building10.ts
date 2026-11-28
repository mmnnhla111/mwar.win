import type { Frame, Kit } from '../kit';
import type { StructureInfo } from '../structure';
import { STORY } from '../structure';
import { PROPS, type PropId } from '../disguiseProps';
import { placeDisguiseProp } from '../propPlacement';

/**
 * Interior furnishing of Building10 — Courtyard Complex (assets/buildings.ts). Called once per placed instance
 * right after the building factory, in the building's own local frame `f`, so every copy on every map gets the
 * same interior. Every object is a Prop-Hunt disguise prop placed with placeDisguiseProp.
 *
 * Geometry recap (local frame): outer shell +-9.5 (wall t 0.3, inner face +-9.2), courtyard block +-4.5 whose
 * walls occupy 4.2..4.5, so the ring of wings is 4.7 m deep (+-4.5 .. +-9.2). Ground floor y = 0, upper floor
 * walking surface y = STORY (slab top). West stair (x -8.9..-7.5, z -2.5..2.5) climbs to floor 1, east stair
 * (same z span, x 7.5..8.9) climbs from floor 1 to the roof; both keep 1.2 m clear around them.
 * Layout is fully deterministic (no randomness).
 */

export interface Building10Placement {
  id: PropId;
  x: number;
  y: number;
  z: number;
  qt: number;
}

const IN = 9.2; // inner face of the outer walls
const CORE = 4.5; // face of the courtyard walls on the ring side
const G = 0.08; // gap kept to wall faces

const F0 = 0;
const F1 = STORY; // slab top = WALL_H + SLAB_T

/** Footprint extents (x, z) of a prop after `qt` quarter turns. */
function ext(id: PropId, qt: number): [number, number] {
  const [w, d] = PROPS.find((p) => p.id === id)!.size;
  return qt % 2 === 0 ? [w, d] : [d, w];
}

function build(): Building10Placement[] {
  const out: Building10Placement[] = [];
  const put = (id: PropId, x: number, y: number, z: number, qt: number) => out.push({ id, x, y, z, qt });
  /** Against the outer north (-z) wall, back to the wall, facing +z. */
  const nWall = (id: PropId, y: number, x: number, qt = 0) => put(id, x, y, -IN + G + ext(id, qt)[1] / 2, qt);
  /** Against the outer south wall, facing -z. */
  const sWall = (id: PropId, y: number, x: number, qt = 2) => put(id, x, y, IN - G - ext(id, qt)[1] / 2, qt);
  /** Against the outer west wall, facing +x. */
  const wWall = (id: PropId, y: number, z: number, qt = 1) => put(id, -IN + G + ext(id, qt)[0] / 2, y, z, qt);
  /** Against the outer east wall, facing -x. */
  const eWall = (id: PropId, y: number, z: number, qt = 3) => put(id, IN - G - ext(id, qt)[0] / 2, y, z, qt);
  /** Against the courtyard wall, ring side. */
  const inN = (id: PropId, y: number, x: number, qt = 2) => put(id, x, y, -CORE - G - ext(id, qt)[1] / 2, qt);
  const inS = (id: PropId, y: number, x: number, qt = 0) => put(id, x, y, CORE + G + ext(id, qt)[1] / 2, qt);
  const inW = (id: PropId, y: number, z: number, qt = 3) => put(id, -CORE - G - ext(id, qt)[0] / 2, y, z, qt);
  const inE = (id: PropId, y: number, z: number, qt = 1) => put(id, CORE + G + ext(id, qt)[0] / 2, y, z, qt);

  // ---------------------------------------------------------------- ground floor
  // North-west: administration office
  nWall('filing_cabinet', F0, -8.88);
  nWall('office_desk', F0, -6.3);
  put('office_chair', -6.3, F0, -8.07, 2);
  nWall('office_desk', F0, -3.1);
  put('office_chair', -3.1, F0, -8.07, 2);
  inN('metal_locker', F0, -4.0);
  inN('metal_locker', F0, -3.4);
  wWall('storage_shelf', F0, -5.4);

  // North-east: briefing / radio room
  nWall('sofa', F0, 2.95);
  nWall('tv_stand', F0, 6.33);
  put('office_desk', 5.6, F0, -7.2, 0);
  put('office_chair', 5.6, F0, -7.9, 0);
  put('generator_box', 2.9, F0, -5.3, 0);
  put('ammo_chest', 8.3, F0, -5.6, 0);

  // East wing: supply store
  eWall('storage_shelf', F0, -2.05);
  eWall('storage_shelf', F0, 2.05);
  inE('supply_crate', F0, -3.4);
  inE('supply_crate', F0, 3.4);
  put('oil_drum', 6.6, F0, -3.9, 0);
  put('wooden_pallet', 7.0, F0, 3.6, 0);
  put('cardboard_box', 8.3, F0, 4.0, 0);

  // South wing: barracks + break corner
  inS('bunk_bed', F0, -3.0);
  sWall('bunk_bed', F0, -2.7);
  sWall('metal_locker', F0, -6.6);
  sWall('metal_locker', F0, -6.0);
  sWall('sofa', F0, 3.0);
  inS('tv_stand', F0, 3.0);
  sWall('water_cooler', F0, 5.9);
  sWall('flower_pot', F0, 8.9);

  // West wing (stair hall): locker bank + shelf
  inW('metal_locker', F0, -3.4);
  inW('metal_locker', F0, -2.8);
  inW('metal_locker', F0, 2.8);
  inW('metal_locker', F0, 3.4);
  wWall('storage_shelf', F0, 5.6);

  // Courtyard planting
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put('potted_tree', sx * 3.3, F0, sz * 3.3, 0);

  // ---------------------------------------------------------------- first floor
  // North wing: operations room
  for (const x of [-6.33, -3.17, 3.17, 6.33]) {
    nWall('office_desk', F1, x);
    put('office_chair', x, F1, -8.07, 2);
  }
  nWall('tv_stand', F1, 0);

  // West / east wings: ammo caches along the courtyard wall (stairs keep their own clearance)
  inW('ammo_chest', F1, -3.3);
  inW('ammo_chest', F1, 3.3);
  inE('ammo_chest', F1, -3.3);
  inE('ammo_chest', F1, 3.3);

  // South wing: dormitory (bunks head-to-wall between the windows) + lockers
  for (const x of [-6.33, -3.17, 3.17, 6.33]) sWall('bunk_bed', F1, x, 1);
  sWall('metal_locker', F1, -8.84);
  sWall('metal_locker', F1, 8.84);

  return out;
}

export const BUILDING10_LAYOUT: readonly Building10Placement[] = build();

export function furnish(kit: Kit, f: Frame, info: StructureInfo): void {
  void info;
  for (const p of BUILDING10_LAYOUT) placeDisguiseProp(kit, f, p.id, p.x, p.y, p.z, p.qt);
}
