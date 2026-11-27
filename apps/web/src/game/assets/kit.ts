import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CollisionWorld } from '../physics/collision';
import { stairStepBoxes, type StairVolume } from '@mwar/shared';
import { MaterialKey, MaterialLibrary, TEXTURE_SCALE } from './materials';
import { MAP2D } from './map2d';

/**
 * Modular building kit.
 *
 * Every static environment piece goes through a StaticBatcher (merged into one mesh per
 * material → a handful of draw calls for the whole city) and, when solid, registers an
 * axis-aligned collider in the CollisionWorld so visuals and physics can never drift apart.
 */

export interface BatchItem {
  geometry: THREE.BufferGeometry;
  castShadow: boolean;
}

const tmpColor = new THREE.Color();

/** Assigns world-space box-projected UVs + a flat vertex colour to a (world-space) geometry. */
function prepareGeometry(geo: THREE.BufferGeometry, key: MaterialKey, color: THREE.ColorRepresentation, worldUv: boolean, keepColors = false) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const count = pos.count;
  if (worldUv || !g.getAttribute('uv')) {
    const scale = 1 / TEXTURE_SCALE[key];
    const uv = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const nx = Math.abs(nor.getX(i));
      const ny = Math.abs(nor.getY(i));
      const nz = Math.abs(nor.getZ(i));
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (ny >= nx && ny >= nz) {
        uv[i * 2] = x * scale;
        uv[i * 2 + 1] = z * scale;
      } else if (nx >= nz) {
        uv[i * 2] = z * scale;
        uv[i * 2 + 1] = y * scale;
      } else {
        uv[i * 2] = x * scale;
        uv[i * 2 + 1] = y * scale;
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  if (!(keepColors && g.getAttribute('color'))) {
    tmpColor.set(color);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      col[i * 3] = tmpColor.r;
      col[i * 3 + 1] = tmpColor.g;
      col[i * 3 + 2] = tmpColor.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  // Keep only the attributes every batch shares.
  for (const name of Object.keys(g.attributes)) {
    if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name);
  }
  return g;
}

export class StaticBatcher {
  private buckets = new Map<string, BatchItem[]>();

  /**
   * @param chunkSize When > 0, geometry is also bucketed by its XZ grid chunk (metres) so every
   *   merged mesh covers one chunk: frustum culling and distance culling then work per chunk
   *   (used by the 960 m large map).
   */
  constructor(private readonly chunkSize = 0) {}

  add(
    key: MaterialKey,
    color: THREE.ColorRepresentation,
    geometry: THREE.BufferGeometry,
    opts: { castShadow?: boolean; worldUv?: boolean; keepColors?: boolean } = {}
  ) {
    const castShadow = opts.castShadow ?? !(key === 'glass' || key === 'emissive' || key === 'asphalt' || key === 'grass' || key === 'sidewalk');
    const g = prepareGeometry(geometry, key, color, opts.worldUv ?? true, opts.keepColors);
    let chunk = '';
    if (this.chunkSize > 0) {
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      chunk = `|${Math.floor((bb.min.x + bb.max.x) / 2 / this.chunkSize)},${Math.floor((bb.min.z + bb.max.z) / 2 / this.chunkSize)}`;
    }
    const bucketKey = `${key}|${castShadow ? 1 : 0}${chunk}`;
    let list = this.buckets.get(bucketKey);
    if (!list) this.buckets.set(bucketKey, (list = []));
    list.push({ geometry: g, castShadow });
  }

  /** World-space axis-aligned box from min corner/size. */
  addBox(key: MaterialKey, color: THREE.ColorRepresentation, cx: number, cy: number, cz: number, w: number, h: number, d: number, castShadow?: boolean) {
    if (w <= 0.001 || h <= 0.001 || d <= 0.001) return;
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(cx, cy, cz);
    this.add(key, color, g, { castShadow });
  }

  build(lib: MaterialLibrary, parent: THREE.Object3D) {
    const meshes: THREE.Mesh[] = [];
    this.buckets.forEach((items, bucketKey) => {
      const [key, shadow] = bucketKey.split('|');
      // Chunk large buckets so frustum culling still helps and index sizes stay sane.
      const CHUNK = 1500;
      for (let i = 0; i < items.length; i += CHUNK) {
        const slice = items.slice(i, i + CHUNK).map((it) => it.geometry);
        const merged = mergeGeometries(slice, false);
        slice.forEach((g) => g.dispose());
        if (!merged) continue;
        merged.computeBoundingSphere();
        merged.computeBoundingBox();
        const mesh = new THREE.Mesh(merged, lib.get(key as MaterialKey));
        if (this.chunkSize > 0) mesh.userData.chunked = true;
        mesh.castShadow = shadow === '1';
        mesh.receiveShadow = key !== 'glass' && key !== 'emissive';
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        if (key === 'glass') mesh.renderOrder = 2;
        parent.add(mesh);
        meshes.push(mesh);
      }
    });
    this.buckets.clear();
    return meshes;
  }
}

/**
 * Local frame for a structure: origin on the ground + quarter-turn rotation. Keeps every
 * collider axis-aligned while letting designs face any street.
 */
export class Frame {
  readonly cos: number;
  readonly sin: number;
  constructor(public ox: number, public oz: number, public quarterTurns: number, public baseY = 0) {
    const q = ((quarterTurns % 4) + 4) % 4;
    this.quarterTurns = q;
    const a = (q * Math.PI) / 2;
    this.cos = Math.round(Math.cos(a));
    this.sin = Math.round(Math.sin(a));
  }

  get angle() {
    return (this.quarterTurns * Math.PI) / 2;
  }

  /** local (x,z) → world (x,z). Same convention as Object3D.rotation.y. */
  toWorld(lx: number, lz: number): [number, number] {
    return [this.ox + lx * this.cos + lz * this.sin, this.oz - lx * this.sin + lz * this.cos];
  }

  /** local rectangle → world AABB footprint. */
  rect(x0: number, z0: number, x1: number, z1: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const [ax, az] = this.toWorld(x0, z0);
    const [bx, bz] = this.toWorld(x1, z1);
    return { minX: Math.min(ax, bx), maxX: Math.max(ax, bx), minZ: Math.min(az, bz), maxZ: Math.max(az, bz) };
  }

  child(lx: number, lz: number, extraTurns = 0): Frame {
    const [wx, wz] = this.toWorld(lx, lz);
    return new Frame(wx, wz, this.quarterTurns + extraTurns, this.baseY);
  }
}

export interface Opening {
  /** Centre of the opening measured along the wall from its start point. */
  at: number;
  width: number;
  /** Bottom of the opening above the wall base (0 for doors). */
  sill: number;
  /** Top of the opening above the wall base. */
  top: number;
  /** Fill with glass (visual only, bullets pass). */
  glass?: boolean;
}

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Split rectangle r into non-overlapping rectangles that exclude every hole (rows merged). */
export function rectsMinusHoles(r: Rect, rawHoles: Rect[]): Rect[] {
  const holes = rawHoles.map((h) => ({
    x0: Math.max(r.x0, Math.min(h.x0, h.x1)),
    x1: Math.min(r.x1, Math.max(h.x0, h.x1)),
    z0: Math.max(r.z0, Math.min(h.z0, h.z1)),
    z1: Math.min(r.z1, Math.max(h.z0, h.z1)),
  })).filter((h) => h.x1 > h.x0 && h.z1 > h.z0);
  const xs = Array.from(new Set([r.x0, r.x1, ...holes.flatMap((h) => [h.x0, h.x1])])).sort((a, b) => a - b);
  const zs = Array.from(new Set([r.z0, r.z1, ...holes.flatMap((h) => [h.z0, h.z1])])).sort((a, b) => a - b);
  const out: Rect[] = [];
  for (let j = 0; j < zs.length - 1; j++) {
    let runStart: number | null = null;
    for (let i = 0; i <= xs.length - 1; i++) {
      let solidCell = false;
      if (i < xs.length - 1) {
        const cx = (xs[i] + xs[i + 1]) / 2;
        const cz = (zs[j] + zs[j + 1]) / 2;
        solidCell = !holes.some((h) => cx > h.x0 && cx < h.x1 && cz > h.z0 && cz < h.z1);
      }
      if (solidCell && runStart === null) runStart = xs[i];
      if (!solidCell && runStart !== null) {
        out.push({ x0: runStart, x1: xs[i], z0: zs[j], z1: zs[j + 1] });
        runStart = null;
      }
    }
  }
  return out;
}

export const door = (at: number, width = 1.4, top = 2.3): Opening => ({ at, width, sill: 0, top });
export const win = (at: number, width = 1.3, sill = 1.0, top = 2.1): Opening => ({ at, width, sill, top });

export class Kit {
  constructor(
    public batcher: StaticBatcher,
    public world: CollisionWorld
  ) {}

  /** Solid box in local coordinates: centre (cx, cz), bottom at y0. */
  solid(
    f: Frame,
    key: MaterialKey,
    color: THREE.ColorRepresentation,
    cx: number,
    y0: number,
    cz: number,
    w: number,
    h: number,
    d: number,
    opts: { walkable?: boolean; blocksBullets?: boolean; blocksMovement?: boolean; castShadow?: boolean; visual?: boolean } = {}
  ) {
    const r = f.rect(cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2);
    const y = f.baseY + y0;
    if (opts.visual !== false) {
      this.batcher.addBox(key, color, (r.minX + r.maxX) / 2, y + h / 2, (r.minZ + r.maxZ) / 2, r.maxX - r.minX, h, r.maxZ - r.minZ, opts.castShadow);
    }
    this.world.addBox(
      { minX: r.minX, maxX: r.maxX, minY: y, maxY: y + h, minZ: r.minZ, maxZ: r.maxZ },
      { walkable: opts.walkable ?? true, blocksBullets: opts.blocksBullets ?? true, blocksMovement: opts.blocksMovement ?? true }
    );
  }

  /** Visual-only box (no collider). */
  deco(f: Frame, key: MaterialKey, color: THREE.ColorRepresentation, cx: number, y0: number, cz: number, w: number, h: number, d: number, castShadow?: boolean) {
    const r = f.rect(cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2);
    this.batcher.addBox(key, color, (r.minX + r.maxX) / 2, f.baseY + y0 + h / 2, (r.minZ + r.maxZ) / 2, r.maxX - r.minX, h, r.maxZ - r.minZ, castShadow);
  }

  /** Arbitrary local geometry (already built around the local origin) → world, visual only. */
  geometry(f: Frame, key: MaterialKey, color: THREE.ColorRepresentation, geo: THREE.BufferGeometry, lx: number, ly: number, lz: number, rotY = 0, castShadow?: boolean) {
    const [wx, wz] = f.toWorld(lx, lz);
    const m = new THREE.Matrix4().makeRotationY(f.angle + rotY);
    m.setPosition(wx, f.baseY + ly, wz);
    geo.applyMatrix4(m);
    this.batcher.add(key, color, geo, { castShadow });
  }

  /**
   * Straight wall between (x0,z0) and (x1,z1) (must be axis-aligned in local space)
   * with door/window openings cut out. Openings are real gaps (you can walk/shoot through).
   */
  wall(
    f: Frame,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    y0: number,
    h: number,
    opts: { t?: number; key?: MaterialKey; color?: THREE.ColorRepresentation; openings?: Opening[]; trim?: THREE.ColorRepresentation } = {}
  ) {
    const t = opts.t ?? 0.3;
    const key = opts.key ?? 'plaster';
    const color = opts.color ?? 0xe5e1d8;
    const alongX = Math.abs(z1 - z0) < 1e-6;
    const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    const sx = alongX ? Math.sign(x1 - x0) || 1 : 0;
    const sz = alongX ? 0 : Math.sign(z1 - z0) || 1;
    const piece = (a: number, b: number, py0: number, py1: number) => {
      if (b - a < 0.02 || py1 - py0 < 0.02) return;
      const mid = (a + b) / 2;
      const cx = x0 + sx * mid;
      const cz = z0 + sz * mid;
      const w = alongX ? b - a : t;
      const d = alongX ? t : b - a;
      this.solid(f, key, color, cx, y0 + py0, cz, w, py1 - py0, d);
    };
    const ops = (opts.openings ?? []).slice().sort((a, b) => a.at - b.at);
    let cursor = 0;
    for (const o of ops) {
      const a = Math.max(0, o.at - o.width / 2);
      const b = Math.min(len, o.at + o.width / 2);
      piece(cursor, a, 0, h);
      piece(a, b, 0, o.sill);
      piece(a, b, Math.min(o.top, h), h);
      // Frame trim around openings (visual)
      const trimColor = opts.trim ?? 0x3f3f46;
      const midO = (a + b) / 2;
      const cx = x0 + sx * midO;
      const cz = z0 + sz * midO;
      const tw = alongX ? b - a + 0.16 : t + 0.08;
      const td = alongX ? t + 0.08 : b - a + 0.16;
      this.deco(f, 'trim', trimColor, cx, y0 + Math.min(o.top, h) - 0.02, cz, tw, 0.12, td, false);
      if (o.sill > 0) this.deco(f, 'trim', trimColor, cx, y0 + o.sill - 0.1, cz, tw, 0.12, td, false);
      // Register real (non-slit) windows for the vault action
      if (o.sill >= 0.4 && Math.min(o.top, h) - o.sill >= 0.9 && b - a >= 0.7) {
        const [wx, wz] = f.toWorld(cx, cz);
        const lnx = alongX ? 0 : 1;
        const lnz = alongX ? 1 : 0;
        MAP2D.windows.push({
          x: wx,
          z: wz,
          sill: f.baseY + y0 + o.sill,
          top: f.baseY + y0 + Math.min(o.top, h),
          nx: lnx * f.cos + lnz * f.sin,
          nz: -lnx * f.sin + lnz * f.cos,
          halfW: (b - a) / 2,
          t,
        });
      }
      if (o.glass) {
        const gw = alongX ? b - a : 0.05;
        const gd = alongX ? 0.05 : b - a;
        this.deco(f, 'glass', 0x9fd3f0, cx, y0 + o.sill, cz, gw, Math.min(o.top, h) - o.sill, gd, false);
      }
      cursor = b;
    }
    piece(cursor, len, 0, h);
  }

  /** Four walls of a rectangular room. Openings per side: n(-z), s(+z), w(-x), e(+x). */
  room(
    f: Frame,
    r: Rect,
    y0: number,
    h: number,
    opts: {
      t?: number;
      key?: MaterialKey;
      color?: THREE.ColorRepresentation;
      n?: Opening[];
      s?: Opening[];
      w?: Opening[];
      e?: Opening[];
      trim?: THREE.ColorRepresentation;
    } = {}
  ) {
    const t = opts.t ?? 0.3;
    const base = { t, key: opts.key, color: opts.color, trim: opts.trim };
    // North (z0) & south (z1) walls span full width; west/east walls fit between them.
    this.wall(f, r.x0, r.z0 + t / 2, r.x1, r.z0 + t / 2, y0, h, { ...base, openings: opts.n });
    this.wall(f, r.x0, r.z1 - t / 2, r.x1, r.z1 - t / 2, y0, h, { ...base, openings: opts.s });
    this.wall(f, r.x0 + t / 2, r.z0 + t, r.x0 + t / 2, r.z1 - t, y0, h, { ...base, openings: opts.w });
    this.wall(f, r.x1 - t / 2, r.z0 + t, r.x1 - t / 2, r.z1 - t, y0, h, { ...base, openings: opts.e });
  }

  /** Horizontal slab (floor / roof) with rectangular holes (stairwells). Top surface at y + t. */
  slab(f: Frame, r: Rect, y: number, t: number, opts: { key?: MaterialKey; color?: THREE.ColorRepresentation; holes?: Rect[] } = {}) {
    const key = opts.key ?? 'concrete';
    const color = opts.color ?? 0xbdbdbd;
    for (const c of rectsMinusHoles(r, opts.holes ?? [])) {
      this.solid(f, key, color, (c.x0 + c.x1) / 2, y, (c.z0 + c.z1) / 2, c.x1 - c.x0, t, c.z1 - c.z0);
    }
  }

  /** Thin visual floor finish that respects stairwell openings (never covers a hole). */
  floorFinish(f: Frame, r: Rect, y: number, holes: Rect[], key: MaterialKey = 'wood', color: THREE.ColorRepresentation = 0xc8a27a) {
    for (const c of rectsMinusHoles(r, holes)) {
      this.deco(f, key, color, (c.x0 + c.x1) / 2, y + 0.004, (c.z0 + c.z1) / 2, c.x1 - c.x0, 0.012, c.z1 - c.z0, false);
    }
  }

  /**
   * Walkable staircase. Starts at local (x, z) (centre of the bottom step's front edge) and climbs
   * `run` metres in direction `dir` from height y0 to y1. Visual steps + smooth ramp collider.
   */
  stairs(
    f: Frame,
    x: number,
    z: number,
    dir: '+x' | '-x' | '+z' | '-z',
    width: number,
    run: number,
    y0: number,
    y1: number,
    opts: { key?: MaterialKey; color?: THREE.ColorRepresentation; rails?: ('left' | 'right')[]; topGuard?: boolean } = {}
  ) {
    const key = opts.key ?? 'concrete';
    const color = opts.color ?? 0xa8a29e;
    const rise = y1 - y0;
    const nSteps = Math.max(2, Math.round(rise / 0.2));
    const stepRun = run / nSteps;
    const ax = dir === '+x' ? 1 : dir === '-x' ? -1 : 0;
    const az = dir === '+z' ? 1 : dir === '-z' ? -1 : 0;
    // Perpendicular (right-hand side when walking up)
    const px = -az;
    const pz = ax;
    for (let i = 0; i < nSteps; i++) {
      const along = stepRun * (i + 0.5);
      const cx = x + ax * along;
      const cz = z + az * along;
      const top = (rise * (i + 1)) / nSteps;
      const w = ax !== 0 ? stepRun : width;
      const d = ax !== 0 ? width : stepRun;
      // Each step is a block from y0 up to its tread (looks like solid masonry stairs).
      this.deco(f, key, i % 2 ? color : new THREE.Color(color).multiplyScalar(0.93), cx, y0, cz, w + 0.001, top, d + 0.001, true);
    }
    // Ramp collider in world space.
    const hw = width / 2;
    const r = f.rect(
      x - Math.abs(px) * hw + Math.min(0, ax * run),
      z - Math.abs(pz) * hw + Math.min(0, az * run),
      x + Math.abs(px) * hw + Math.max(0, ax * run),
      z + Math.abs(pz) * hw + Math.max(0, az * run)
    );
    const [lowX, lowZ] = f.toWorld(x, z);
    const [highX, highZ] = f.toWorld(x + ax * run, z + az * run);
    const worldAxis: 'x' | 'z' = Math.abs(highX - lowX) > Math.abs(highZ - lowZ) ? 'x' : 'z';
    const lowIsMin = worldAxis === 'x' ? lowX < highX : lowZ < highZ;
    this.world.addRamp({
      minX: r.minX,
      maxX: r.maxX,
      minZ: r.minZ,
      maxZ: r.maxZ,
      axis: worldAxis,
      y0: f.baseY + (lowIsMin ? y0 : y1),
      y1: f.baseY + (lowIsMin ? y1 : y0),
    });

    // SOLID stair body (V1.1 round 4): one full-height block per step, from the stair's foot level up to
    // its tread. There is no hollow space under / behind / beside the flight, the treads are walkable
    // (so a body dropping in from a window lands ON the steps) and every block stops bullets. The same
    // stair is recorded as data (world.addStair) so the game server can rebuild identical volumes.
    const stairRec: StairVolume = {
      minX: r.minX,
      minZ: r.minZ,
      maxX: r.maxX,
      maxZ: r.maxZ,
      axis: worldAxis,
      lowIsMin,
      baseY: f.baseY + y0,
      rise,
      steps: nSteps,
    };
    this.world.addStair(stairRec);
    for (const b of stairStepBoxes(stairRec)) {
      this.world.addBox(b, { walkable: true, blocksBullets: true, blocksMovement: true, pushOut: true });
    }

    // Side rails: a LOW rail (0.8 m) that follows the slope — it stops accidental falls but can be
    // jumped over (jump clears ~1.3 m) to drop down quickly. The upper floor gets a matching low
    // guard along the well, so the stairwell can be vaulted into from the side.
    const railH = 0.8;
    for (const side of opts.rails ?? []) {
      const s = side === 'right' ? 1 : -1;
      const ox = x + (px * s * width) / 2;
      const oz = z + (pz * s * width) / 2;
      const startAlong = Math.min(run * 0.25, 0.9);
      const a0x = ox + ax * startAlong;
      const a0z = oz + az * startAlong;
      const a1x = ox + ax * run;
      const a1z = oz + az * run;
      const cx = (a0x + a1x) / 2;
      const cz = (a0z + a1z) / 2;
      const len = run - startAlong;
      const w = ax !== 0 ? len : 0.08;
      const d = ax !== 0 ? 0.08 : len;
      // Collider follows the slope in 4 stepped pieces (never a full-height invisible wall)
      const pieces = 4;
      for (let k = 0; k < pieces; k++) {
        const s0 = startAlong + (len * k) / pieces;
        const s1 = startAlong + (len * (k + 1)) / pieces;
        const top = (rise * s1) / run + railH;
        const pcx = ox + ax * ((s0 + s1) / 2);
        const pcz = oz + az * ((s0 + s1) / 2);
        const pw = ax !== 0 ? s1 - s0 : 0.08;
        const pd = ax !== 0 ? 0.08 : s1 - s0;
        this.solid(f, 'metal', 0x52525b, pcx, y0, pcz, pw, top, pd, { visual: false, walkable: false, blocksBullets: false });
      }
      // Low guard on the upper floor along the well edge (vaultable)
      const gcx = ox + ax * (run / 2);
      const gcz = oz + az * (run / 2);
      const gw = ax !== 0 ? run : 0.08;
      const gd = ax !== 0 ? 0.08 : run;
      this.solid(f, 'metal', 0x52525b, gcx, y1, gcz, gw, railH, gd, { visual: false, walkable: false, blocksBullets: false });
      this.deco(f, 'metal', 0x27272a, gcx, y1 + railH - 0.05, gcz, ax !== 0 ? run : 0.07, 0.05, ax !== 0 ? 0.07 : run, false);
      const gPosts = Math.max(2, Math.round(run / 1.2));
      for (let i = 0; i <= gPosts; i++) {
        const along = (run * i) / gPosts;
        this.deco(f, 'metal', 0x3f3f46, ox + ax * along, y1, oz + az * along, 0.05, railH, 0.05, false);
      }
      // Visual: slanted handrail + posts
      const posts = Math.max(2, Math.round(len / 1.2));
      for (let i = 0; i <= posts; i++) {
        const t = i / posts;
        const along = startAlong + t * len;
        const h = (rise * along) / run;
        this.deco(f, 'metal', 0x3f3f46, ox + ax * along, y0 + h, oz + az * along, 0.06, railH, 0.06, false);
      }
      const railGeo = new THREE.BoxGeometry(Math.hypot(len, (rise * len) / run), 0.07, 0.07);
      railGeo.rotateZ(Math.atan2(rise, run));
      const yaw = dir === '+x' ? 0 : dir === '-x' ? Math.PI : dir === '+z' ? -Math.PI / 2 : Math.PI / 2;
      const midAlong = startAlong + len / 2;
      this.geometry(f, 'metal', 0x27272a, railGeo, ox + ax * midAlong, y0 + (rise * midAlong) / run + railH, oz + az * midAlong, yaw, false);
    }
    if (opts.topGuard) {
      // Guard across the low end at the upper floor level (prevents falling into the well).
      const w = ax !== 0 ? 0.08 : width;
      const d = ax !== 0 ? width : 0.08;
      this.solid(f, 'metal', 0x3f3f46, x - ax * 0.04, y1, z - az * 0.04, w, railH, d, { walkable: false, blocksBullets: false });
    }
  }

  /** Low cover walls around the edge of a rectangle (rooftop parapets / balconies). */
  parapet(
    f: Frame,
    r: Rect,
    y: number,
    opts: { h?: number; t?: number; key?: MaterialKey; color?: THREE.ColorRepresentation; gaps?: { side: 'n' | 's' | 'w' | 'e'; at: number; width: number }[] } = {}
  ) {
    const h = opts.h ?? 1.1;
    const t = opts.t ?? 0.25;
    const key = opts.key ?? 'concrete';
    const color = opts.color ?? 0x9ca3af;
    const gapFor = (side: 'n' | 's' | 'w' | 'e') =>
      (opts.gaps ?? []).filter((g) => g.side === side).map((g) => ({ at: g.at, width: g.width, sill: 0, top: h }));
    this.wall(f, r.x0, r.z0 + t / 2, r.x1, r.z0 + t / 2, y, h, { t, key, color, openings: gapFor('n') });
    this.wall(f, r.x0, r.z1 - t / 2, r.x1, r.z1 - t / 2, y, h, { t, key, color, openings: gapFor('s') });
    this.wall(f, r.x0 + t / 2, r.z0 + t, r.x0 + t / 2, r.z1 - t, y, h, { t, key, color, openings: gapFor('w') });
    this.wall(f, r.x1 - t / 2, r.z0 + t, r.x1 - t / 2, r.z1 - t, y, h, { t, key, color, openings: gapFor('e') });
    // Coping cap
    this.deco(f, 'trim', 0x71717a, (r.x0 + r.x1) / 2, y + h, r.z0 + t / 2, r.x1 - r.x0 + 0.06, 0.06, t + 0.06, false);
    this.deco(f, 'trim', 0x71717a, (r.x0 + r.x1) / 2, y + h, r.z1 - t / 2, r.x1 - r.x0 + 0.06, 0.06, t + 0.06, false);
  }

  /** Thin balcony railing along one edge (blocks movement, bullets pass through). */
  railing(f: Frame, x0: number, z0: number, x1: number, z1: number, y: number, h = 1.0) {
    const alongX = Math.abs(z1 - z0) < 1e-6;
    const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    this.solid(f, 'metal', 0x27272a, cx, y + h - 0.06, cz, alongX ? len : 0.07, 0.06, alongX ? 0.07 : len, { walkable: false, blocksBullets: false, visual: true, castShadow: false });
    this.solid(f, 'metal', 0x27272a, cx, y, cz, alongX ? len : 0.05, h, alongX ? 0.05 : len, { visual: false, walkable: false, blocksBullets: false });
    const posts = Math.max(2, Math.round(len / 0.5));
    for (let i = 0; i <= posts; i++) {
      const t = i / posts;
      const px = alongX ? Math.min(x0, x1) + t * len : x0;
      const pz = alongX ? z0 : Math.min(z0, z1) + t * len;
      this.deco(f, 'metal', 0x3f3f46, px, y, pz, 0.04, h, 0.04, false);
    }
  }

  /** Gabled pitched roof (visual). Ridge runs along `ridge` axis. A solid ceiling slab is added separately. */
  pitchedRoof(f: Frame, r: Rect, y: number, rise: number, ridge: 'x' | 'z', color: THREE.ColorRepresentation, overhang = 0.5, gableColor?: THREE.ColorRepresentation) {
    const x0 = r.x0 - overhang;
    const x1 = r.x1 + overhang;
    const z0 = r.z0 - overhang;
    const z1 = r.z1 + overhang;
    const verts: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => verts.push(...a, ...b, ...c, ...a, ...c, ...d);
    if (ridge === 'x') {
      const zm = (z0 + z1) / 2;
      quad([x0, 0, z0], [x0, rise, zm], [x1, rise, zm], [x1, 0, z0]);
      quad([x1, 0, z1], [x1, rise, zm], [x0, rise, zm], [x0, 0, z1]);
      // undersides
      quad([x0, 0, z0], [x1, 0, z0], [x1, -0.15, z0], [x0, -0.15, z0]);
      quad([x1, 0, z1], [x0, 0, z1], [x0, -0.15, z1], [x1, -0.15, z1]);
    } else {
      const xm = (x0 + x1) / 2;
      quad([x0, 0, z1], [xm, rise, z1], [xm, rise, z0], [x0, 0, z0]);
      quad([x1, 0, z0], [xm, rise, z0], [xm, rise, z1], [x1, 0, z1]);
      quad([x0, 0, z0], [x0, 0, z1], [x0, -0.15, z1], [x0, -0.15, z0]);
      quad([x1, 0, z1], [x1, 0, z0], [x1, -0.15, z0], [x1, -0.15, z1]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    this.geometry(f, 'roofTile', color, g, 0, y, 0);
    // Gable triangles (walls) closing the ends.
    const gv: number[] = [];
    if (ridge === 'x') {
      const zm = (r.z0 + r.z1) / 2;
      gv.push(r.x0, 0, r.z0, r.x0, 0, r.z1, r.x0, rise, zm);
      gv.push(r.x1, 0, r.z1, r.x1, 0, r.z0, r.x1, rise, zm);
    } else {
      const xm = (r.x0 + r.x1) / 2;
      gv.push(r.x1, 0, r.z0, r.x0, 0, r.z0, xm, rise, r.z0);
      gv.push(r.x0, 0, r.z1, r.x1, 0, r.z1, xm, rise, r.z1);
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gv, 3));
    gg.computeVertexNormals();
    // Double-sided look: add reversed copy
    const rev = gv.slice();
    for (let i = 0; i < rev.length; i += 9) {
      const tmp = rev.slice(i + 3, i + 6);
      rev.splice(i + 3, 3, ...rev.slice(i + 6, i + 9));
      rev.splice(i + 6, 3, ...tmp);
    }
    const gr = new THREE.BufferGeometry();
    gr.setAttribute('position', new THREE.Float32BufferAttribute(rev, 3));
    gr.computeVertexNormals();
    this.geometry(f, 'plaster', gableColor ?? 0xe7e5e4, gg, 0, y, 0);
    this.geometry(f, 'plaster', gableColor ?? 0xe7e5e4, gr, 0, y, 0);
  }

  /** Flat roof cap with a small overhang trim (solid + walkable). */
  flatRoof(f: Frame, r: Rect, y: number, color: THREE.ColorRepresentation = 0x6b7280, holes?: Rect[]) {
    this.slab(f, r, y, 0.25, { key: 'concrete', color, holes });
  }

  /** Porch: raised deck + posts + small roof. Deck is a walkable step. */
  porch(f: Frame, r: Rect, roofY: number, color: THREE.ColorRepresentation = 0x8b5a2b) {
    this.solid(f, 'wood', color, (r.x0 + r.x1) / 2, 0, (r.z0 + r.z1) / 2, r.x1 - r.x0, 0.22, r.z1 - r.z0);
    const posts: [number, number][] = [
      [r.x0 + 0.15, r.z0 + 0.15],
      [r.x1 - 0.15, r.z0 + 0.15],
    ];
    for (const [px, pz] of posts) this.solid(f, 'wood', 0xf5f5f4, px, 0.22, pz, 0.18, roofY - 0.22, 0.18, { walkable: false });
    this.solid(f, 'wood', 0x57534e, (r.x0 + r.x1) / 2, roofY, (r.z0 + r.z1) / 2, r.x1 - r.x0 + 0.3, 0.15, r.z1 - r.z0 + 0.3);
  }
}
