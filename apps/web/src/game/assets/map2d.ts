/**
 * 2D top-down footprint registry for the tactical minimap.
 *
 * Filled while the 3D arena is built (buildArena → addTree / placeVehicle / structures), so the
 * minimap always draws the real map geometry instead of a hand-drawn picture.
 */
export interface Map2DRect {
  x: number; // centre
  z: number;
  w: number; // size along world x (after rotation)
  d: number; // size along world z
  kind: 'building' | 'house' | 'vehicle';
  color?: string;
}

export interface Map2DTree {
  x: number;
  z: number;
  r: number;
}

export interface Map2DRoad {
  x: number;
  z: number;
  w: number;
  d: number;
  dirt?: boolean;
}

/** A window opening the player can vault through (world space). n = unit wall normal. */
export interface WindowSpot {
  x: number;
  z: number;
  sill: number;
  top: number;
  nx: number;
  nz: number;
  halfW: number;
  t: number;
}

export const MAP2D = {
  /** Vaultable window openings, collected while walls are built. */
  windows: [] as WindowSpot[],
  rects: [] as Map2DRect[],
  trees: [] as Map2DTree[],
  /** Explicit road rectangles (large map). Empty → the minimap draws the small map's 3×3 grid. */
  roads: [] as Map2DRoad[],
  hills: [] as { x: number; z: number; r: number; peak: number }[],
  /** Playable / full half-size overrides (large map); 0 = small map defaults. */
  playHalf: 0,
  mapHalf: 0,
  reset() {
    this.rects.length = 0;
    this.windows.length = 0;
    this.trees.length = 0;
    this.roads.length = 0;
    this.hills.length = 0;
    this.playHalf = 0;
    this.mapHalf = 0;
  },
};

export function map2dTree(x: number, z: number, r: number) {
  MAP2D.trees.push({ x, z, r });
}

/** Axis-aligned vehicle footprint; quarterTurns 1/3 swap length onto the x axis. */
export function map2dVehicle(x: number, z: number, quarterTurns: number, width: number, length: number, color?: string) {
  const swap = Math.abs(quarterTurns) % 2 === 1;
  MAP2D.rects.push({ x, z, w: swap ? length : width, d: swap ? width : length, kind: 'vehicle', color });
}
