import * as THREE from 'three';
import { Frame, Kit, Opening, Rect, door, win } from './kit';
import { MaterialKey } from './materials';

/** Height of one storey (floor to floor) and of its walls. */
export const STORY = 3.2;
export const WALL_H = 3.0;
export const SLAB_T = STORY - WALL_H;

export type Vec3 = [number, number, number];

export interface StructureInfo {
  name: string;
  /** World-space standing points on walkable rooftops (AI overwatch posts). */
  rooftops: Vec3[];
  /** World-space standing points inside the structure (any floor). */
  interior: Vec3[];
  /** World-space point just outside the main entrance. */
  entrance: Vec3;
  /** World-space footprint (for layout / nav). */
  footprint: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export function worldPoint(f: Frame, lx: number, y: number, lz: number): Vec3 {
  const [x, z] = f.toWorld(lx, lz);
  return [x, f.baseY + y, z];
}

/** Evenly spaced window openings along a wall of length `len`, skipping keep-out spans. */
export function windowsAlong(len: number, count: number, opts: { width?: number; sill?: number; top?: number; avoid?: [number, number][]; glass?: boolean } = {}): Opening[] {
  const out: Opening[] = [];
  const width = opts.width ?? 1.2;
  for (let i = 0; i < count; i++) {
    const at = ((i + 0.5) / count) * len;
    if ((opts.avoid ?? []).some(([a, b]) => at + width / 2 > a && at - width / 2 < b)) continue;
    out.push({ ...win(at, width, opts.sill ?? 1.0, opts.top ?? 2.2), glass: opts.glass });
  }
  return out;
}

export interface StoriesOptions {
  stories: number;
  wallKey?: MaterialKey;
  wallColor: THREE.ColorRepresentation;
  trim?: THREE.ColorRepresentation;
  floorColor?: THREE.ColorRepresentation;
  /** Windows per side per storey. */
  windows?: { n?: number; s?: number; w?: number; e?: number };
  /** Ground floor doors: offsets along each side (centre). */
  doors?: { n?: number[]; s?: number[]; w?: number[]; e?: number[] };
  doorWidth?: number;
  /** Extra openings on upper floors (e.g. balcony doors) keyed by storey index. */
  upperDoors?: Record<number, { n?: number[]; s?: number[]; w?: number[]; e?: number[] }>;
  stairWidth?: number;
  stairRun?: number;
  /** Add a final flight to a walkable roof with parapets. */
  roofAccess?: boolean;
  parapetH?: number;
  wallT?: number;
  glassWindows?: boolean;
  /** Which side the first flight hugs. */
  firstStairSide?: 'e' | 'w';
  /** Front margin before stairs start (local z). */
  stairStartInset?: number;
}

/**
 * Generic multi-storey shell: exterior walls with doors/windows per storey, floor slabs with
 * stairwell holes, alternating stair flights hugging the east/west walls and an optional
 * accessible rooftop with parapet cover. Local footprint is `r`; front (main door) is the -z side.
 */
export function buildStories(kit: Kit, f: Frame, r: Rect, o: StoriesOptions) {
  const t = o.wallT ?? 0.3;
  const w = r.x1 - r.x0;
  const d = r.z1 - r.z0;
  const sw = o.stairWidth ?? 1.3;
  const run = o.stairRun ?? Math.min(5.0, d - 2 * t - 2.2);
  const flights = o.stories - 1 + (o.roofAccess ? 1 : 0);
  const holes: Rect[][] = Array.from({ length: o.stories + 1 }, () => []);
  const doorW = o.doorWidth ?? 1.5;
  let side: 'e' | 'w' = o.firstStairSide ?? 'e';
  const z0 = r.z0 + t + (o.stairStartInset ?? 1.2);
  const stairSpans: Record<'e' | 'w', [number, number]> = { e: [z0 - 0.2, z0 + run + 0.2], w: [z0 - 0.2, z0 + run + 0.2] };

  for (let k = 0; k < flights; k++) {
    const y0 = k * STORY;
    const y1 = (k + 1) * STORY;
    const x = side === 'e' ? r.x1 - t - sw / 2 - 0.02 : r.x0 + t + sw / 2 + 0.02;
    kit.stairs(f, x, z0, '+z', sw, run, y0, y1, {
      rails: [side === 'e' ? 'right' : 'left'],
      topGuard: true,
      color: 0x9ca3af,
    });
    holes[k + 1].push({ x0: x - sw / 2 - 0.05, x1: x + sw / 2 + 0.05, z0: z0 - 0.05, z1: z0 + run });
    side = side === 'e' ? 'w' : 'e';
  }

  for (let k = 0; k < o.stories; k++) {
    const y = k * STORY;
    const ground = k === 0;
    const ops = (sideKey: 'n' | 's' | 'w' | 'e', len: number) => {
      const list: Opening[] = [];
      const doors = ground ? o.doors?.[sideKey] ?? [] : o.upperDoors?.[k]?.[sideKey] ?? [];
      for (const at of doors) list.push(door(at, doorW, 2.4));
      const avoid: [number, number][] = doors.map((at) => [at - doorW / 2 - 0.3, at + doorW / 2 + 0.3]);
      const n = o.windows?.[sideKey] ?? Math.max(1, Math.floor(len / 3.2));
      list.push(...windowsAlong(len, n, { avoid, glass: o.glassWindows }));
      return list;
    };
    kit.room(f, r, y, WALL_H, {
      t,
      key: o.wallKey ?? 'plaster',
      color: o.wallColor,
      trim: o.trim,
      n: ops('n', w),
      s: ops('s', w),
      w: ops('w', d - 2 * t),
      e: ops('e', d - 2 * t),
    });
    // Slab above this storey (floor of next / roof)
    kit.slab(f, r, y + WALL_H, SLAB_T, { color: o.floorColor ?? 0xa3a3a3, holes: holes[k + 1] });
    // Interior floor finish (visual)
    kit.deco(f, 'wood', 0xc8a27a, (r.x0 + r.x1) / 2, y + (ground ? 0.005 : 0), (r.z0 + r.z1) / 2, w - 2 * t, 0.01, d - 2 * t, false);
  }

  const roofY = o.stories * STORY;
  if (o.roofAccess) {
    kit.parapet(f, r, roofY, { h: o.parapetH ?? 1.1, color: new THREE.Color(o.wallColor).multiplyScalar(0.85) });
  } else {
    kit.deco(f, 'trim', o.trim ?? 0x52525b, (r.x0 + r.x1) / 2, roofY, (r.z0 + r.z1) / 2, w + 0.2, 0.3, d + 0.2);
  }
  return { roofY, stairSpans };
}

/** Collect standard interior & rooftop points for a rectangular multi-storey shell. */
export function standardPoints(f: Frame, r: Rect, stories: number, roof: boolean) {
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const interior: Vec3[] = [];
  for (let k = 0; k < stories; k++) interior.push(worldPoint(f, cx, k * STORY + 0.05, cz + 1.5));
  const rooftops: Vec3[] = roof
    ? [
        worldPoint(f, r.x0 + 1.4, stories * STORY + 0.05, r.z0 + 1.4),
        worldPoint(f, r.x1 - 1.4, stories * STORY + 0.05, r.z1 - 1.4),
        worldPoint(f, cx, stories * STORY + 0.05, r.z0 + 1.4),
      ]
    : [];
  return { interior, rooftops };
}
