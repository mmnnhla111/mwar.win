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

export const MAP2D = {
  rects: [] as Map2DRect[],
  trees: [] as Map2DTree[],
  reset() {
    this.rects.length = 0;
    this.trees.length = 0;
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
