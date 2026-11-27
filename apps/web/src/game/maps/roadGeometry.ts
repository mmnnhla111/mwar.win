/**
 * Non-overlapping road tiling for the 960 m map (V1.1 round 4).
 *
 * The map is described as a list of axis-aligned road rectangles (highways, city streets, side roads)
 * that cross and overlap each other. Drawing each one as its own quad puts several coplanar triangles
 * on top of each other at every intersection, which z-fights (flickers) with distance. Here the union
 * of all rectangles is cut into DISJOINT tiles:
 *   - strip tiles: stretches of a single road, textured along its direction with world-aligned UVs
 *     (lane markings stay continuous across tile borders);
 *   - plain tiles: intersection / junction areas covered by roads of different directions, plain asphalt.
 * No two tiles share any area, so no two triangles are ever coplanar-overlapping.
 */

export interface RoadRect {
  /** Min / max corners (world metres). */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** True when the road runs along the X axis. */
  alongX: boolean;
}

export interface RoadTile {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  kind: 'strip' | 'plain';
  /** Strip only: direction of travel and the road's centre line on the cross axis. */
  alongX: boolean;
  centre: number;
}

const EPS = 1e-6;

export function unionRoadTiles(rects: readonly RoadRect[]): RoadTile[] {
  const zs = Array.from(new Set(rects.flatMap((r) => [r.z0, r.z1]))).sort((a, b) => a - b);
  type Seg = { x0: number; x1: number; z0: number; z1: number; kind: 'strip' | 'plain'; alongX: boolean; centre: number; id: number };
  let open: Seg[] = [];
  const out: RoadTile[] = [];
  const flush = (list: Seg[]) => {
    for (const s of list) out.push({ x0: s.x0, z0: s.z0, x1: s.x1, z1: s.z1, kind: s.kind, alongX: s.alongX, centre: s.centre });
  };
  for (let j = 0; j < zs.length - 1; j++) {
    const za = zs[j];
    const zb = zs[j + 1];
    if (zb - za < EPS) continue;
    const zm = (za + zb) / 2;
    const cover = rects.map((r, i) => ({ r, i })).filter(({ r }) => zm > r.z0 && zm < r.z1);
    const xs = Array.from(new Set(cover.flatMap(({ r }) => [r.x0, r.x1]))).sort((a, b) => a - b);
    const band: Seg[] = [];
    for (let i = 0; i < xs.length - 1; i++) {
      const xa = xs[i];
      const xb = xs[i + 1];
      if (xb - xa < EPS) continue;
      const xm = (xa + xb) / 2;
      const here = cover.filter(({ r }) => xm > r.x0 && xm < r.x1);
      if (!here.length) continue;
      const hasX = here.some(({ r }) => r.alongX);
      const hasZ = here.some(({ r }) => !r.alongX);
      let seg: Seg;
      if (hasX && hasZ) {
        seg = { x0: xa, x1: xb, z0: za, z1: zb, kind: 'plain', alongX: true, centre: 0, id: -1 };
      } else {
        // Single direction: the widest road in that direction owns the tile (lane markings + centre line).
        const owner = here.reduce((a, b) => {
          const wa = a.r.alongX ? a.r.z1 - a.r.z0 : a.r.x1 - a.r.x0;
          const wb = b.r.alongX ? b.r.z1 - b.r.z0 : b.r.x1 - b.r.x0;
          return wb > wa ? b : a;
        });
        const o = owner.r;
        seg = { x0: xa, x1: xb, z0: za, z1: zb, kind: 'strip', alongX: o.alongX, centre: o.alongX ? (o.z0 + o.z1) / 2 : (o.x0 + o.x1) / 2, id: owner.i };
      }
      // Merge with the horizontally adjacent segment of the same road (same owner / same kind)
      const prev = band[band.length - 1];
      if (prev && Math.abs(prev.x1 - seg.x0) < EPS && prev.kind === seg.kind && prev.id === seg.id && prev.alongX === seg.alongX && prev.centre === seg.centre) prev.x1 = seg.x1;
      else band.push(seg);
    }
    // Merge with the previous band when a segment has identical x-extent (long vertical roads)
    const stillOpen: Seg[] = [];
    for (const s of band) {
      const prev = open.find((p) => Math.abs(p.z1 - s.z0) < EPS && Math.abs(p.x0 - s.x0) < EPS && Math.abs(p.x1 - s.x1) < EPS && p.kind === s.kind && p.id === s.id && p.alongX === s.alongX && p.centre === s.centre);
      if (prev) {
        prev.z1 = s.z1;
        stillOpen.push(prev);
        open.splice(open.indexOf(prev), 1);
      } else stillOpen.push(s);
    }
    flush(open);
    open = stillOpen;
  }
  flush(open);
  return out;
}

/** Split a tile into pieces no longer than `maxLen` along its long axis (so it chunks cleanly). */
export function splitTile(t: RoadTile, maxLen = 60): RoadTile[] {
  const alongX = t.x1 - t.x0 >= t.z1 - t.z0;
  const a = alongX ? t.x0 : t.z0;
  const b = alongX ? t.x1 : t.z1;
  const n = Math.max(1, Math.ceil((b - a) / maxLen - 1e-9));
  const out: RoadTile[] = [];
  for (let i = 0; i < n; i++) {
    const s = a + ((b - a) * i) / n;
    const e = a + ((b - a) * (i + 1)) / n;
    out.push(alongX ? { ...t, x0: s, x1: e } : { ...t, z0: s, z1: e });
  }
  return out;
}
