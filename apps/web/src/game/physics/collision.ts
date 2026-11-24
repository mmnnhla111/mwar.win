/**
 * Lightweight AABB collision world for the mwar.win FPS client.
 *
 * - Solid boxes block horizontal movement (sliding collision, per axis).
 * - The tops of solid boxes and ramps are walkable surfaces (floors, roofs, stairs).
 * - A hard rectangular map boundary keeps players inside the playable area.
 * - Ray casts against solid boxes give bullet / line-of-sight obstruction.
 *
 * Everything is axis-aligned so the queries stay cheap enough to run every frame
 * for the player and a dozen AI bots. A uniform spatial hash keeps candidate
 * lists short.
 */

export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface SolidBox extends AABB {
  id: number;
  /** When false the box only blocks bullets/LOS, never the player (e.g. glass, foliage). */
  blocksMovement: boolean;
  /** When false the box never stops bullets (e.g. thin railings). */
  blocksBullets: boolean;
  /** Whether the top face can be stood on. */
  walkable: boolean;
}

/** A ramp / staircase surface: height rises linearly along one axis over its footprint. */
export interface Ramp {
  id: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Axis along which height changes. */
  axis: 'x' | 'z';
  /** Height at the min end of the axis. */
  y0: number;
  /** Height at the max end of the axis. */
  y1: number;
}

export interface MoveBody {
  /** Feet position. */
  x: number;
  y: number;
  z: number;
  velY: number;
  onGround: boolean;
  radius: number;
  height: number;
  /** Owner id: dynamic boxes with the same owner (e.g. your own prop disguise) are ignored. */
  owner?: string;
}

export interface RayHit {
  distance: number;
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  boxId: number;
}

export interface CollisionWorldOptions {
  /** Half-size of the square playable area (metres). */
  halfSize: number;
  /** Max height a body can step up onto without jumping. */
  stepHeight?: number;
  gravity?: number;
  cellSize?: number;
  /** Optional height-field terrain (mountains). Flat y = 0 everywhere outside `bounds`. */
  terrain?: TerrainField;
}

export interface TerrainField {
  height(x: number, z: number): number;
  /** XZ rectangles where the terrain is not flat (terrain checks are skipped elsewhere). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }[];
}

const EPS = 1e-4;

export class CollisionWorld {
  readonly halfSize: number;
  readonly stepHeight: number;
  readonly gravity: number;
  private readonly cellSize: number;
  private boxes: SolidBox[] = [];
  private ramps: Ramp[] = [];
  private boxGrid = new Map<number, number[]>();
  private rampGrid = new Map<number, number[]>();
  private nextId = 1;
  private queryStamp = 0;
  private boxStamps: number[] = [];
  /** Dynamic movable boxes (prop disguises) keyed by owner. */
  private dynamic = new Map<string, SolidBox>();
  private ignoreOwner: string | undefined;
  readonly terrain: TerrainField | undefined;

  constructor(opts: CollisionWorldOptions) {
    this.halfSize = opts.halfSize;
    this.terrain = opts.terrain;
    this.stepHeight = opts.stepHeight ?? 0.45;
    this.gravity = opts.gravity ?? -22;
    this.cellSize = opts.cellSize ?? 8;
  }

  get boxCount() {
    return this.boxes.length;
  }

  /** Terrain height (0 when the world has no terrain). */
  terrainHeight(x: number, z: number): number {
    return this.terrain ? this.terrain.height(x, z) : 0;
  }

  private segmentTouchesTerrain(ax: number, az: number, bx: number, bz: number) {
    if (!this.terrain) return false;
    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minZ = Math.min(az, bz);
    const maxZ = Math.max(az, bz);
    return this.terrain.bounds.some((r) => !(maxX < r.minX || minX > r.maxX || maxZ < r.minZ || minZ > r.maxZ));
  }

  /** First terrain hit along a ray (marching + bisection), or null. */
  private terrainRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number | null {
    if (!this.terrain || !this.segmentTouchesTerrain(ox, oz, ox + dx * maxDist, oz + dz * maxDist)) return null;
    const h = (t: number) => oy + dy * t - this.terrain!.height(ox + dx * t, oz + dz * t);
    if (h(0) < 0) return 0;
    const step = 1.25;
    let prev = 0;
    for (let t = step; ; t += step) {
      const tt = Math.min(t, maxDist);
      if (h(tt) < 0) {
        let lo = prev;
        let hi = tt;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          if (h(mid) < 0) hi = mid;
          else lo = mid;
        }
        return hi;
      }
      prev = tt;
      if (tt >= maxDist) return null;
    }
  }

  private key(cx: number, cz: number) {
    return (cx + 1024) * 4096 + (cz + 1024);
  }

  private cellsFor(minX: number, minZ: number, maxX: number, maxZ: number, cb: (k: number) => void) {
    const c = this.cellSize;
    const x0 = Math.floor(minX / c);
    const x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c);
    const z1 = Math.floor(maxZ / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) cb(this.key(cx, cz));
    }
  }

  addBox(
    box: AABB,
    opts: Partial<Pick<SolidBox, 'blocksMovement' | 'blocksBullets' | 'walkable'>> = {}
  ): number {
    const b: SolidBox = {
      id: this.nextId++,
      minX: Math.min(box.minX, box.maxX),
      maxX: Math.max(box.minX, box.maxX),
      minY: Math.min(box.minY, box.maxY),
      maxY: Math.max(box.minY, box.maxY),
      minZ: Math.min(box.minZ, box.maxZ),
      maxZ: Math.max(box.minZ, box.maxZ),
      blocksMovement: opts.blocksMovement ?? true,
      blocksBullets: opts.blocksBullets ?? true,
      walkable: opts.walkable ?? true,
    };
    const idx = this.boxes.length;
    this.boxes.push(b);
    this.boxStamps.push(0);
    this.cellsFor(b.minX, b.minZ, b.maxX, b.maxZ, (k) => {
      let list = this.boxGrid.get(k);
      if (!list) this.boxGrid.set(k, (list = []));
      list.push(idx);
    });
    return b.id;
  }

  /** Convenience: box from centre + full size. */
  addBoxCentered(cx: number, cy: number, cz: number, w: number, h: number, d: number, opts?: Parameters<CollisionWorld['addBox']>[1]) {
    return this.addBox(
      { minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2, minZ: cz - d / 2, maxZ: cz + d / 2 },
      opts
    );
  }

  addRamp(r: Omit<Ramp, 'id'>): number {
    const ramp: Ramp = {
      ...r,
      id: this.nextId++,
      minX: Math.min(r.minX, r.maxX),
      maxX: Math.max(r.minX, r.maxX),
      minZ: Math.min(r.minZ, r.maxZ),
      maxZ: Math.max(r.minZ, r.maxZ),
    };
    const idx = this.ramps.length;
    this.ramps.push(ramp);
    this.cellsFor(ramp.minX, ramp.minZ, ramp.maxX, ramp.maxZ, (k) => {
      let list = this.rampGrid.get(k);
      if (!list) this.rampGrid.set(k, (list = []));
      list.push(idx);
    });
    return ramp.id;
  }

  /**
   * Set / move / clear (null) a dynamic solid box owned by `owner` (e.g. a solid prop disguise).
   * Dynamic boxes block movement of every body except their owner; they never stop bullets.
   */
  setDynamicBox(owner: string, box: AABB | null, opts: { walkable?: boolean } = {}) {
    if (!box) {
      this.dynamic.delete(owner);
      return;
    }
    const prev = this.dynamic.get(owner);
    const b: SolidBox = prev ?? { id: this.nextId++, minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0, blocksMovement: true, blocksBullets: false, walkable: true };
    b.minX = box.minX;
    b.maxX = box.maxX;
    b.minY = box.minY;
    b.maxY = box.maxY;
    b.minZ = box.minZ;
    b.maxZ = box.maxZ;
    b.walkable = opts.walkable ?? true;
    this.dynamic.set(owner, b);
  }

  private forBoxesNear(minX: number, minZ: number, maxX: number, maxZ: number, cb: (b: SolidBox) => void) {
    if (this.dynamic.size) {
      this.dynamic.forEach((b, owner) => {
        if (owner === this.ignoreOwner) return;
        if (maxX < b.minX || minX > b.maxX || maxZ < b.minZ || minZ > b.maxZ) return;
        cb(b);
      });
    }
    const stamp = ++this.queryStamp;
    this.cellsFor(minX, minZ, maxX, maxZ, (k) => {
      const list = this.boxGrid.get(k);
      if (!list) return;
      for (const idx of list) {
        if (this.boxStamps[idx] === stamp) continue;
        this.boxStamps[idx] = stamp;
        cb(this.boxes[idx]);
      }
    });
  }

  private rampHeightAt(r: Ramp, x: number, z: number): number {
    const t =
      r.axis === 'x' ? (x - r.minX) / Math.max(EPS, r.maxX - r.minX) : (z - r.minZ) / Math.max(EPS, r.maxZ - r.minZ);
    const tc = Math.min(1, Math.max(0, t));
    return r.y0 + (r.y1 - r.y0) * tc;
  }

  /**
   * Height of the highest walkable surface under the circle (x,z,radius) whose height
   * is at most `maxY` (the body can reach it by stepping). Terrain is y = 0.
   */
  groundHeightAt(x: number, z: number, radius: number, maxY: number): number {
    // Terrain is solid ground under everything (slopes are always walkable / climbable)
    let best = this.terrain ? this.terrain.height(x, z) : 0;
    const r = radius * 0.7; // feet footprint slightly smaller than body
    this.forBoxesNear(x - r, z - r, x + r, z + r, (b) => {
      if (!b.walkable || !b.blocksMovement) return;
      if (x + r <= b.minX || x - r >= b.maxX || z + r <= b.minZ || z - r >= b.maxZ) return;
      if (b.maxY <= maxY + EPS && b.maxY > best) best = b.maxY;
    });
    const c = this.cellSize;
    const k = this.key(Math.floor(x / c), Math.floor(z / c));
    const list = this.rampGrid.get(k);
    if (list) {
      for (const idx of list) {
        const ramp = this.ramps[idx];
        if (x < ramp.minX || x > ramp.maxX || z < ramp.minZ || z > ramp.maxZ) continue;
        const h = this.rampHeightAt(ramp, x, z);
        if (h <= maxY + EPS && h > best) best = h;
      }
    }
    return best;
  }

  /** True if a body at (x, feetY, z) overlaps any movement-blocking box (ignoring step-up-able tops). */
  private overlapsSolid(x: number, feetY: number, z: number, radius: number, height: number, stepAllowance: number): boolean {
    let hit = false;
    const lowY = feetY + stepAllowance;
    const highY = feetY + height;
    this.forBoxesNear(x - radius, z - radius, x + radius, z + radius, (b) => {
      if (hit || !b.blocksMovement) return;
      if (b.maxY <= lowY || b.minY >= highY) return;
      // Circle vs AABB (xz)
      const cx = Math.max(b.minX, Math.min(x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < radius * radius - EPS) hit = true;
    });
    return hit;
  }

  /**
   * Total xz penetration depth of the body into movement-blocking solids (0 = free). Used to let a
   * body that got wedged (e.g. jumped into a window opening it cannot fit through) slide back out.
   */
  private overlapDepth(x: number, feetY: number, z: number, radius: number, height: number, stepAllowance: number): number {
    let depth = 0;
    const lowY = feetY + stepAllowance;
    const highY = feetY + height;
    this.forBoxesNear(x - radius, z - radius, x + radius, z + radius, (b) => {
      if (!b.blocksMovement) return;
      if (b.maxY <= lowY || b.minY >= highY) return;
      const inside = x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ;
      if (inside) {
        depth += radius + Math.min(x - b.minX, b.maxX - x, z - b.minZ, b.maxZ - z);
        return;
      }
      const cx = Math.max(b.minX, Math.min(x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
      const d = Math.hypot(x - cx, z - cz);
      if (d < radius) depth += radius - d;
    });
    return depth;
  }

  /** Lowest ceiling (box bottom) above `feetY` that overlaps the body footprint. */
  private ceilingAbove(x: number, z: number, radius: number, feetY: number): number {
    let best = Infinity;
    const r = radius * 0.7;
    this.forBoxesNear(x - r, z - r, x + r, z + r, (b) => {
      if (!b.blocksMovement) return;
      if (x + r <= b.minX || x - r >= b.maxX || z + r <= b.minZ || z - r >= b.maxZ) return;
      if (b.minY >= feetY + 0.1 && b.minY < best) best = b.minY;
    });
    return best;
  }

  /** True if the body could grow to `height` at its current position (used before standing up from crouch / prone). */
  hasHeadroom(body: MoveBody, height: number): boolean {
    return this.ceilingAbove(body.x, body.z, body.radius, body.y) >= body.y + height - 0.02;
  }

  clampToBounds(p: { x: number; z: number }, margin = 0.5) {
    const lim = this.halfSize - margin;
    if (p.x > lim) p.x = lim;
    if (p.x < -lim) p.x = -lim;
    if (p.z > lim) p.z = lim;
    if (p.z < -lim) p.z = -lim;
  }

  /**
   * Move a body by (dx, dz) horizontally and integrate gravity. Uses sub-stepping and
   * per-axis resolution so the body slides along walls. Returns the body (mutated).
   */
  moveBody(body: MoveBody, dx: number, dz: number, dt: number): MoveBody {
    this.ignoreOwner = body.owner;
    try {
      return this.moveBodyInner(body, dx, dz, dt);
    } finally {
      this.ignoreOwner = undefined;
    }
  }

  private moveBodyInner(body: MoveBody, dx: number, dz: number, dt: number): MoveBody {
    const maxStep = body.radius * 0.5;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / maxStep));
    const sx = dx / steps;
    const sz = dz / steps;
    const stepAllow = body.onGround ? this.stepHeight : 0.12;

    for (let i = 0; i < steps; i++) {
      // X axis (on contact, bisect to slide flush against the wall)
      if (sx !== 0) body.x = this.sweepAxis(body, 'x', sx, stepAllow);
      // Z axis
      if (sz !== 0) body.z = this.sweepAxis(body, 'z', sz, stepAllow);
      this.clampToBounds(body, body.radius + 0.2);
      // Step up onto low surfaces / ramps while walking.
      if (body.onGround) {
        const g = this.groundHeightAt(body.x, body.z, body.radius, body.y + this.stepHeight);
        if (g > body.y) body.y = g;
      }
    }

    // Vertical integration
    const ground = this.groundHeightAt(body.x, body.z, body.radius, body.y + (body.onGround ? this.stepHeight : 0.05));
    if (body.onGround && body.velY <= 0) {
      if (body.y - ground > this.stepHeight + 0.05) {
        // Walked off a ledge
        body.onGround = false;
      } else {
        body.y = ground;
        body.velY = 0;
      }
    }

    if (!body.onGround) {
      body.velY += this.gravity * dt;
      let ny = body.y + body.velY * dt;
      if (body.velY > 0) {
        const ceil = this.ceilingAbove(body.x, body.z, body.radius, body.y);
        if (ny + body.height > ceil) {
          ny = Math.max(body.y, ceil - body.height - 0.01);
          body.velY = 0;
        }
      }
      const landOn = this.groundHeightAt(body.x, body.z, body.radius, Math.max(body.y, ny) + 0.05);
      if (ny <= landOn && body.velY <= 0) {
        ny = landOn;
        body.velY = 0;
        body.onGround = true;
      }
      body.y = ny;
    }

    // Safety: never sink inside a solid (e.g. spawned overlapping) — push up onto its top.
    const floor = this.terrain ? this.terrain.height(body.x, body.z) : 0;
    if (body.y < floor) {
      body.y = floor;
      body.velY = 0;
      body.onGround = true;
    }
    return body;
  }

  /** Largest fraction of `delta` along one axis that keeps the body out of solids. */
  private sweepAxis(body: MoveBody, axis: 'x' | 'z', delta: number, stepAllow: number): number {
    const start = axis === 'x' ? body.x : body.z;
    const test = (v: number) =>
      axis === 'x'
        ? this.overlapsSolid(v, body.y, body.z, body.radius, body.height, stepAllow)
        : this.overlapsSolid(body.x, body.y, v, body.radius, body.height, stepAllow);
    if (!test(start + delta)) return start + delta;
    if (test(start)) {
      // Already wedged: allow any move that reduces the penetration (slide back out of the frame)
      const depthAt = (v: number) =>
        axis === 'x'
          ? this.overlapDepth(v, body.y, body.z, body.radius, body.height, stepAllow)
          : this.overlapDepth(body.x, body.y, v, body.radius, body.height, stepAllow);
      return depthAt(start + delta) < depthAt(start) - 1e-5 ? start + delta : start;
    }
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 4; i++) {
      const mid = (lo + hi) / 2;
      if (test(start + delta * mid)) hi = mid;
      else lo = mid;
    }
    return start + delta * lo;
  }

  jump(body: MoveBody, speed = 7.6) {
    if (body.onGround) {
      body.velY = speed;
      body.onGround = false;
    }
  }

  /**
   * Ray cast against bullet-blocking boxes and the ground plane.
   * `dir` must be normalised.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    filter: 'bullets' | 'movement' = 'bullets'
  ): RayHit | null {
    let best = maxDist;
    let bestBox: SolidBox | null = null;
    let bestAxis = -1;

    const ex = ox + dx * maxDist;
    const ez = oz + dz * maxDist;
    const inv = (v: number) => (Math.abs(v) < 1e-9 ? 1e9 : 1 / v);
    const ix = inv(dx);
    const iy = inv(dy);
    const iz = inv(dz);

    const testBox = (b: SolidBox) => {
      if (filter === 'bullets' ? !b.blocksBullets : !b.blocksMovement) return;
      let t1 = (b.minX - ox) * ix;
      let t2 = (b.maxX - ox) * ix;
      let tmin = Math.min(t1, t2);
      let tmax = Math.max(t1, t2);
      let axis = 0;
      t1 = (b.minY - oy) * iy;
      t2 = (b.maxY - oy) * iy;
      const tyMin = Math.min(t1, t2);
      if (tyMin > tmin) {
        tmin = tyMin;
        axis = 1;
      }
      tmax = Math.min(tmax, Math.max(t1, t2));
      t1 = (b.minZ - oz) * iz;
      t2 = (b.maxZ - oz) * iz;
      const tzMin = Math.min(t1, t2);
      if (tzMin > tmin) {
        tmin = tzMin;
        axis = 2;
      }
      tmax = Math.min(tmax, Math.max(t1, t2));
      if (tmax < Math.max(tmin, 0)) return;
      const t = tmin >= 0 ? tmin : 0; // origin inside → hit at 0
      if (t < best) {
        best = t;
        bestBox = b;
        bestAxis = tmin >= 0 ? axis : -1;
      }
    };

    // Spatial hash: short rays scan their bounding rectangle; long rays walk only the grid cells the
    // ray actually crosses (2D DDA), stopping once the next cell starts beyond the best hit.
    if (maxDist <= 24) {
      this.forBoxesNear(Math.min(ox, ex), Math.min(oz, ez), Math.max(ox, ex), Math.max(oz, ez), testBox);
    } else {
      this.dynamic.forEach((b, owner) => {
        if (owner !== this.ignoreOwner) testBox(b);
      });
      const c = this.cellSize;
      const stamp = ++this.queryStamp;
      let cx = Math.floor(ox / c);
      let cz = Math.floor(oz / c);
      const stepX = dx > 0 ? 1 : -1;
      const stepZ = dz > 0 ? 1 : -1;
      const tDeltaX = Math.abs(ix) * c;
      const tDeltaZ = Math.abs(iz) * c;
      let tMaxX = Math.abs(dx) < 1e-9 ? Infinity : ((dx > 0 ? (cx + 1) * c : cx * c) - ox) * ix;
      let tMaxZ = Math.abs(dz) < 1e-9 ? Infinity : ((dz > 0 ? (cz + 1) * c : cz * c) - oz) * iz;
      let tEnter = 0;
      for (let guard = 0; guard < 4096; guard++) {
        if (tEnter > best || tEnter > maxDist) break;
        const list = this.boxGrid.get(this.key(cx, cz));
        if (list) {
          for (const idx of list) {
            if (this.boxStamps[idx] === stamp) continue;
            this.boxStamps[idx] = stamp;
            testBox(this.boxes[idx]);
          }
        }
        if (tMaxX < tMaxZ) {
          tEnter = tMaxX;
          tMaxX += tDeltaX;
          cx += stepX;
        } else {
          tEnter = tMaxZ;
          tMaxZ += tDeltaZ;
          cz += stepZ;
        }
      }
    }

    // Height-field terrain (mountains)
    const tt = this.terrainRay(ox, oy, oz, dx, dy, dz, Math.min(best, maxDist));
    if (tt !== null && tt < best) {
      const px = ox + dx * tt;
      const pz = oz + dz * tt;
      const e = 0.5;
      const nx = this.terrainHeight(px - e, pz) - this.terrainHeight(px + e, pz);
      const nz = this.terrainHeight(px, pz - e) - this.terrainHeight(px, pz + e);
      const nl = Math.hypot(nx, 2 * e, nz) || 1;
      return { distance: tt, point: { x: px, y: oy + dy * tt, z: pz }, normal: { x: nx / nl, y: (2 * e) / nl, z: nz / nl }, boxId: 0 };
    }

    // Ground plane
    if (dy < -1e-6) {
      const tg = -oy / dy;
      if (tg >= 0 && tg < best) {
        return {
          distance: tg,
          point: { x: ox + dx * tg, y: 0, z: oz + dz * tg },
          normal: { x: 0, y: 1, z: 0 },
          boxId: 0,
        };
      }
    }

    if (!bestBox) return null;
    const b = bestBox as SolidBox;
    const p = { x: ox + dx * best, y: oy + dy * best, z: oz + dz * best };
    const n = { x: 0, y: 0, z: 0 };
    if (bestAxis === 0) n.x = dx > 0 ? -1 : 1;
    else if (bestAxis === 1) n.y = dy > 0 ? -1 : 1;
    else if (bestAxis === 2) n.z = dz > 0 ? -1 : 1;
    else {
      n.x = -dx;
      n.y = -dy;
      n.z = -dz;
    }
    return { distance: best, point: p, normal: n, boxId: b.id };
  }

  /** True when nothing solid blocks the segment a→b. */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return true;
    const hit = this.raycast(ax, ay, az, dx / len, dy / len, dz / len, len);
    return !hit || hit.distance >= len - 0.05;
  }

  /** Is a point inside any movement-blocking solid? */
  pointInSolid(x: number, y: number, z: number): boolean {
    if (this.terrain && y < this.terrain.height(x, z) - 0.05) return true;
    let inside = false;
    this.forBoxesNear(x, z, x, z, (b) => {
      if (inside || !b.blocksMovement) return;
      if (x > b.minX && x < b.maxX && y > b.minY && y < b.maxY && z > b.minZ && z < b.maxZ) inside = true;
    });
    return inside;
  }
}
