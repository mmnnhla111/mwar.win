/**
 * Solid staircase geometry shared by the web client (collision world) and the game server
 * (bullet line-of-sight check). V1.1 round 4.
 *
 * A staircase is stored as ONE world-space record: its footprint, the axis it climbs along, which end
 * is the low end, the foot height and the total rise. Every step is a full-height block from the foot
 * level up to its tread, so the flight is completely solid (no cavity under, behind or beside it).
 * `stairStepBoxes` turns a record into those AABBs; the client registers them as walkable / solid /
 * bullet-blocking boxes and the server uses the very same boxes for its ray test.
 *
 * The per-map record lists (stairData.ts) are generated from the client map builders by
 * `pnpm --filter @mwar/web gen:stairs`; a test fails if they drift from the builders.
 */

export interface StairVolume {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** World axis the flight climbs along. */
  axis: 'x' | 'z';
  /** True when the low (bottom step) end is at the min side of `axis`. */
  lowIsMin: boolean;
  /** World height of the bottom of every step block (the floor the flight starts on). */
  baseY: number;
  /** Total rise from `baseY` to the top tread. */
  rise: number;
  steps: number;
}

export interface StairBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Compact tuple form used by the generated data: [minX, minZ, maxX, maxZ, axis(0=x,1=z), lowIsMin(0/1), baseY, rise, steps]. */
export type StairTuple = readonly [number, number, number, number, 0 | 1, 0 | 1, number, number, number];

export function stairFromTuple(t: StairTuple): StairVolume {
  return { minX: t[0], minZ: t[1], maxX: t[2], maxZ: t[3], axis: t[4] === 0 ? 'x' : 'z', lowIsMin: t[5] === 1, baseY: t[6], rise: t[7], steps: t[8] };
}

export function stairToTuple(s: StairVolume): StairTuple {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return [r(s.minX), r(s.minZ), r(s.maxX), r(s.maxZ), s.axis === 'x' ? 0 : 1, s.lowIsMin ? 1 : 0, r(s.baseY), r(s.rise), s.steps];
}

/** One solid block per step, foot level to tread. */
export function stairStepBoxes(s: StairVolume): StairBox[] {
  const out: StairBox[] = [];
  const lo = s.axis === 'x' ? s.minX : s.minZ;
  const hi = s.axis === 'x' ? s.maxX : s.maxZ;
  const run = (hi - lo) / s.steps;
  for (let i = 0; i < s.steps; i++) {
    const a = s.lowIsMin ? lo + i * run : hi - (i + 1) * run;
    const b = a + run;
    const top = s.baseY + (s.rise * (i + 1)) / s.steps;
    out.push(
      s.axis === 'x'
        ? { minX: a, maxX: b, minY: s.baseY, maxY: top, minZ: s.minZ, maxZ: s.maxZ }
        : { minX: s.minX, maxX: s.maxX, minY: s.baseY, maxY: top, minZ: a, maxZ: b }
    );
  }
  return out;
}

/** Slab test: parametric entry (0..1 along the segment) of a segment into a box, or null when it misses. */
export function segmentBoxEntry(ax: number, ay: number, az: number, bx: number, by: number, bz: number, box: StairBox): number | null {
  let t0 = 0;
  let t1 = 1;
  const d = [bx - ax, by - ay, bz - az];
  const o = [ax, ay, az];
  const mn = [box.minX, box.minY, box.minZ];
  const mx = [box.maxX, box.maxY, box.maxZ];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < mn[i] || o[i] > mx[i]) return null;
    } else {
      let ta = (mn[i] - o[i]) / d[i];
      let tb = (mx[i] - o[i]) / d[i];
      if (ta > tb) [ta, tb] = [tb, ta];
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return null;
    }
  }
  return t0;
}

const CELL = 16;
const cellKey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);

/** Cell-indexed set of stair step boxes: cheap per-shot queries even on the 960 m map. */
export class StairIndex {
  private readonly boxes: StairBox[] = [];
  private readonly grid = new Map<number, number[]>();

  constructor(stairs: readonly StairVolume[]) {
    for (const s of stairs) for (const b of stairStepBoxes(s)) this.boxes.push(b);
    this.boxes.forEach((b, idx) => {
      for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++) {
        for (let cz = Math.floor(b.minZ / CELL); cz <= Math.floor(b.maxZ / CELL); cz++) {
          const k = cellKey(cx, cz);
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          l.push(idx);
        }
      }
    });
  }

  get boxCount() {
    return this.boxes.length;
  }

  /** True when a solid stair block lies on the segment a to b. `endMargin` (metres) ignores contacts right at either end. */
  blocksSegment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, endMargin = 0): boolean {
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    if (len < 1e-6) return false;
    const margin = endMargin / len;
    const seen = new Set<number>();
    // Sample the xz path every <= 2 m and look at the cells within 1 m of each sample: any box the
    // segment touches has its contact point within 1 m of a sample, so it is always found.
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
    for (let i = 0; i <= n; i++) {
      const px = ax + ((bx - ax) * i) / n;
      const pz = az + ((bz - az) * i) / n;
      for (let cx = Math.floor((px - 1) / CELL); cx <= Math.floor((px + 1) / CELL); cx++) {
        for (let cz = Math.floor((pz - 1) / CELL); cz <= Math.floor((pz + 1) / CELL); cz++) {
          const l = this.grid.get(cellKey(cx, cz));
          if (!l) continue;
          for (const idx of l) {
            if (seen.has(idx)) continue;
            seen.add(idx);
            const t = segmentBoxEntry(ax, ay, az, bx, by, bz, this.boxes[idx]);
            if (t !== null && t > margin && t < 1 - margin) return true;
          }
        }
      }
    }
    return false;
  }
}
