/**
 * Static bullet-blocking obstacles (audit H1 — server-authoritative ballistics).
 *
 * Every solid box the client map builders register as bullet-blocking (buildings, walls, cover boxes,
 * stairs, props…) is exported once by `pnpm --filter @mwar/web gen:obstacles` into the game server as a
 * flat number list [minX, minY, minZ, maxX, maxY, maxZ, …]. The server indexes them in a 2D grid and
 * tests shooter-eye → target segments against them, exactly like the client's own world raycast, so a
 * bullet can never pass through a wall the player sees.
 */
import { segmentBoxEntry, type StairBox } from './stairs';

const CELL = 8;
const cellKey = (cx: number, cz: number) => (cx + 8192) * 16384 + (cz + 8192);

export class AabbIndex {
  private readonly boxes: StairBox[] = [];
  private readonly grid = new Map<number, number[]>();
  private stamp = 0;
  private readonly seen: number[];

  /** `flat` = [minX, minY, minZ, maxX, maxY, maxZ] per box. */
  constructor(flat: readonly number[]) {
    for (let i = 0; i + 5 < flat.length; i += 6) {
      this.boxes.push({ minX: flat[i], minY: flat[i + 1], minZ: flat[i + 2], maxX: flat[i + 3], maxY: flat[i + 4], maxZ: flat[i + 5] });
    }
    this.seen = new Array(this.boxes.length).fill(0);
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

  /**
   * True when a box lies on the segment a → b. `endMargin` (m) ignores contacts within that distance of either
   * end (the shooter's own floor / window sill, the floor the target stands on). A segment that STARTS inside
   * a box (entry t = 0) is not blocked by that box.
   */
  blocksSegment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, endMargin = 0): boolean {
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    if (len < 1e-6) return false;
    const margin = endMargin / len;
    const stamp = ++this.stamp;
    // Walk the xz path every <= 2 m and test the cells within 1 m of each sample (every box the segment
    // touches has its contact within 1 m of a sample, so none is missed).
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
    let lastKey = NaN;
    for (let i = 0; i <= n; i++) {
      const px = ax + ((bx - ax) * i) / n;
      const pz = az + ((bz - az) * i) / n;
      for (let cx = Math.floor((px - 1) / CELL); cx <= Math.floor((px + 1) / CELL); cx++) {
        for (let cz = Math.floor((pz - 1) / CELL); cz <= Math.floor((pz + 1) / CELL); cz++) {
          const k = cellKey(cx, cz);
          if (k === lastKey) continue;
          const l = this.grid.get(k);
          if (!l) continue;
          for (const idx of l) {
            if (this.seen[idx] === stamp) continue;
            this.seen[idx] = stamp;
            const t = segmentBoxEntry(ax, ay, az, bx, by, bz, this.boxes[idx]);
            if (t !== null && t > margin && t < 1 - margin) return true;
          }
        }
      }
    }
    return false;
  }
}

/** Terrain occlusion: true when the segment dips below a height field (mountains) between its ends. */
export function segmentBelowTerrain(
  height: (x: number, z: number) => number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  endMargin = 0.5
): boolean {
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  if (len <= endMargin * 2) return false;
  const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (t * len < endMargin || (1 - t) * len < endMargin) continue;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const z = az + (bz - az) * t;
    if (y < height(x, z) - 0.15) return true;
  }
  return false;
}

/** Round a collision box list into the flat list stored for the server (cm precision). */
export function obstaclesToFlat(boxes: readonly StairBox[]): number[] {
  const r = (v: number) => Math.round(v * 100) / 100;
  const out: number[] = [];
  for (const b of boxes) out.push(r(b.minX), r(b.minY), r(b.minZ), r(b.maxX), r(b.maxY), r(b.maxZ));
  return out;
}
