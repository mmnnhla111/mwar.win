import * as THREE from 'three';
import { Tile, tileRect } from './textures';

/**
 * Sculpted primitive builders + a "kit" that bakes many small parts (with vertex colour, atlas-tile UVs and a
 * cheap baked ambient-occlusion term) into ONE merged BufferGeometry per (bone, material kind). The merged
 * geometries are built once per operator id and shared by every instance of that operator.
 */

// ------------------------------------------------------------------ primitives

export type Profile = Array<[number, number]>; // [radius, y]

/** Lathe (revolved profile) with elliptical cross-section. Phi 0 = +Z (back), PI = -Z (front). */
export function lathe(profile: Profile, segs = 14, sx = 1, sz = 1, phiStart = 0, phiLength = Math.PI * 2) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0001, r), y));
  const g = new THREE.LatheGeometry(pts, segs, phiStart, phiLength);
  if (sx !== 1 || sz !== 1) g.scale(sx, 1, sz);
  return g;
}

/** Radius of a profile at height y (linear interpolation; profile may run up or down). */
export function profileAt(p: Profile, y: number) {
  for (let i = 0; i < p.length - 1; i++) {
    const [r0, y0] = p[i];
    const [r1, y1] = p[i + 1];
    if ((y >= y0 && y <= y1) || (y <= y0 && y >= y1)) {
      const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
      return r0 + (r1 - r0) * t;
    }
  }
  const first = p[0];
  const last = p[p.length - 1];
  return Math.abs(y - first[1]) < Math.abs(y - last[1]) ? first[0] : last[0];
}

/** A conforming shell over part of a profile (jacket, cummerbund, sleeve, boot shaft…). */
export function shell(p: Profile, y0: number, y1: number, dr: number, opts: { segs?: number; steps?: number; sx?: number; sz?: number; phiStart?: number; phiLength?: number; flare?: number } = {}) {
  const steps = opts.steps ?? 6;
  const prof: Profile = [];
  for (let i = 0; i <= steps; i++) {
    const y = y0 + ((y1 - y0) * i) / steps;
    const flare = (opts.flare ?? 0) * (i / steps);
    prof.push([profileAt(p, y) + dr + flare, y]);
  }
  return lathe(prof, opts.segs ?? 16, opts.sx ?? 1, opts.sz ?? 1, opts.phiStart ?? 0, opts.phiLength ?? Math.PI * 2);
}

/** Rounded box (seg = subdivisions per side; corners are true radius-r fillets). */
export function rbox(w: number, h: number, d: number, r: number, seg = 2) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const rr = Math.min(r, hx, hy, hz) * 0.999;
  const v = new THREE.Vector3();
  const inner = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    inner.set(THREE.MathUtils.clamp(v.x, -hx + rr, hx - rr), THREE.MathUtils.clamp(v.y, -hy + rr, hy - rr), THREE.MathUtils.clamp(v.z, -hz + rr, hz - rr));
    v.sub(inner);
    const len = v.length();
    if (len > 1e-6) {
      v.multiplyScalar(1 / len);
      nor.setXYZ(i, v.x, v.y, v.z);
      v.multiplyScalar(rr).add(inner);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
  }
  return g;
}

export function ellipsoid(rx: number, ry: number, rz: number, ws = 12, hs = 8) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  return g;
}

/** Tapered tube along a smooth curve through `pts` (radius r0 at the start → r1 at the end). */
export function tube(pts: THREE.Vector3[], r0: number, r1 = r0, radial = 6, tubular = 10, closed = false) {
  const curve = new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
  const g = new THREE.TubeGeometry(curve, tubular, 1, radial, closed);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const c = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    curve.getPointAt(t, c);
    const r = r0 + (r1 - r0) * t;
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(r).add(c);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
  }
  return g;
}

/** Closed ring hugging a profile at height y (piping, belts, collars). */
export function ring(p: Profile, y: number, dr: number, radius: number, sx = 1, sz = 1, n = 16, phiStart = 0, phiLength = Math.PI * 2) {
  const r = profileAt(p, y) + dr;
  const closed = phiLength >= Math.PI * 2 - 1e-3;
  const pts: THREE.Vector3[] = [];
  const cnt = closed ? n : n + 1;
  for (let i = 0; i < cnt; i++) {
    const a = phiStart + (phiLength * i) / n;
    pts.push(new THREE.Vector3(Math.sin(a) * r * sx, y, Math.cos(a) * r * sz));
  }
  return tube(pts, radius, radius, 5, closed ? n * 2 : n * 2, closed);
}

/** Line running down the surface of a profile at angle phi (seam piping, zips, straps). */
export function stripe(p: Profile, phi: number, y0: number, y1: number, dr: number, radius: number, sx = 1, sz = 1, n = 6) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n;
    const r = profileAt(p, y) + dr;
    pts.push(new THREE.Vector3(Math.sin(phi) * r * sx, y, Math.cos(phi) * r * sz));
  }
  return tube(pts, radius, radius, 4, n * 2);
}

/** Curved panel: a patch of a sphere (helmet shells, visors, pauldron plates). Angles in radians. */
export function spherePatch(r: number, phiStart: number, phiLength: number, thetaStart: number, thetaLength: number, ws = 16, hs = 8) {
  return new THREE.SphereGeometry(r, ws, hs, phiStart, phiLength, thetaStart, thetaLength);
}

// ------------------------------------------------------------------ kit (bake + merge)

export type Bone = 'body' | 'torso' | 'neck' | 'legL' | 'legR' | 'kneeL' | 'kneeR' | 'armL' | 'armR' | 'elbowL' | 'elbowR';
/** gear = textured standard material (hit-testable); loose = same material, not hit-testable (hair below the
 *  head zone, dangling straps); glow = unlit neon; visor = translucent neon glass. */
export type Kind = 'gear' | 'loose' | 'glow' | 'visor';

export interface PartOpts {
  p?: [number, number, number];
  r?: [number, number, number];
  s?: [number, number, number];
  kind?: Kind;
  /** Baked AO strength (0 = none). Default 0.22. */
  ao?: number;
  /** Mirror on X (for building the right side from a left-side description). */
  mirror?: boolean;
}

interface Baked {
  pos: Float32Array;
  nor: Float32Array;
  uv: Float32Array;
  col: Float32Array;
  idx: number[];
  count: number;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();

export class Kit {
  private parts = new Map<string, Baked[]>();

  add(bone: Bone, geo: THREE.BufferGeometry, color: number | THREE.Color, tile: Tile, o: PartOpts = {}) {
    const g = geo;
    const kind = o.kind ?? 'gear';
    tmpE.set(o.r?.[0] ?? 0, o.r?.[1] ?? 0, o.r?.[2] ?? 0);
    tmpQ.setFromEuler(tmpE);
    tmpS.set(o.s?.[0] ?? 1, o.s?.[1] ?? 1, o.s?.[2] ?? 1);
    tmpP.set(o.p?.[0] ?? 0, o.p?.[1] ?? 0, o.p?.[2] ?? 0);
    if (o.mirror) {
      tmpS.x *= -1;
      tmpP.x *= -1;
      tmpQ.y *= -1;
      tmpQ.z *= -1;
    }
    tmpM.compose(tmpP, tmpQ, tmpS);
    g.applyMatrix4(tmpM);
    if (o.mirror) flipWinding(g);
    if (!g.attributes.normal) g.computeVertexNormals();
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute;
    const uvA = g.attributes.uv as THREE.BufferAttribute | undefined;
    const n = pos.count;
    const out: Baked = { pos: new Float32Array(n * 3), nor: new Float32Array(n * 3), uv: new Float32Array(n * 2), col: new Float32Array(n * 3), idx: [], count: n };
    const col = color instanceof THREE.Color ? color : new THREE.Color(color);
    const rect = tileRect(tile);
    // normalise UVs to 0..1 (extrudes etc. use world-space UVs)
    let umin = 0;
    let umax = 1;
    let vmin = 0;
    let vmax = 1;
    if (uvA) {
      umin = Infinity;
      umax = -Infinity;
      vmin = Infinity;
      vmax = -Infinity;
      for (let i = 0; i < n; i++) {
        const u = uvA.getX(i);
        const v = uvA.getY(i);
        if (u < umin) umin = u;
        if (u > umax) umax = u;
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      }
      if (umin >= 0 && umax <= 1) {
        umin = 0;
        umax = 1;
      }
      if (vmin >= 0 && vmax <= 1) {
        vmin = 0;
        vmax = 1;
      }
    }
    const ao = o.ao ?? 0.22;
    for (let i = 0; i < n; i++) {
      out.pos[i * 3] = pos.getX(i);
      out.pos[i * 3 + 1] = pos.getY(i);
      out.pos[i * 3 + 2] = pos.getZ(i);
      const nx = nor.getX(i);
      const ny = nor.getY(i);
      const nz = nor.getZ(i);
      out.nor[i * 3] = nx;
      out.nor[i * 3 + 1] = ny;
      out.nor[i * 3 + 2] = nz;
      let u = 0.5;
      let v = 0.5;
      if (uvA) {
        u = (uvA.getX(i) - umin) / Math.max(1e-6, umax - umin);
        v = (uvA.getY(i) - vmin) / Math.max(1e-6, vmax - vmin);
      }
      out.uv[i * 2] = rect.u0 + (rect.u1 - rect.u0) * u;
      out.uv[i * 2 + 1] = rect.v0 + (rect.v1 - rect.v0) * v;
      // cheap baked occlusion: downward-facing surfaces a little darker
      const k = kind === 'glow' || kind === 'visor' ? 1 : 1 - ao * (0.5 - 0.5 * ny);
      out.col[i * 3] = col.r * k;
      out.col[i * 3 + 1] = col.g * k;
      out.col[i * 3 + 2] = col.b * k;
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) out.idx.push(g.index.getX(i));
    else for (let i = 0; i < n; i++) out.idx.push(i);
    const key = `${bone}|${kind}`;
    let list = this.parts.get(key);
    if (!list) this.parts.set(key, (list = []));
    list.push(out);
    g.dispose();
  }

  /** Merge everything: bone → kind → geometry. */
  build(): Map<Bone, Map<Kind, THREE.BufferGeometry>> {
    const res = new Map<Bone, Map<Kind, THREE.BufferGeometry>>();
    this.parts.forEach((list, key) => {
      const [bone, kind] = key.split('|') as [Bone, Kind];
      let total = 0;
      let totalIdx = 0;
      for (const b of list) {
        total += b.count;
        totalIdx += b.idx.length;
      }
      const pos = new Float32Array(total * 3);
      const nor = new Float32Array(total * 3);
      const uv = new Float32Array(total * 2);
      const col = new Float32Array(total * 3);
      const idx = total > 65535 ? new Uint32Array(totalIdx) : new Uint16Array(totalIdx);
      let vo = 0;
      let io = 0;
      for (const b of list) {
        pos.set(b.pos, vo * 3);
        nor.set(b.nor, vo * 3);
        uv.set(b.uv, vo * 2);
        col.set(b.col, vo * 3);
        for (let i = 0; i < b.idx.length; i++) idx[io + i] = b.idx[i] + vo;
        vo += b.count;
        io += b.idx.length;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      let m = res.get(bone);
      if (!m) res.set(bone, (m = new Map()));
      m.set(kind, g);
    });
    return res;
  }
}

function flipWinding(g: THREE.BufferGeometry) {
  if (g.index) {
    const a = g.index.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
    g.index.needsUpdate = true;
  } else {
    const attrs = Object.values(g.attributes) as THREE.BufferAttribute[];
    for (const at of attrs) {
      const s = at.itemSize;
      const arr = at.array as Float32Array;
      for (let i = 0; i < at.count; i += 3) {
        for (let k = 0; k < s; k++) {
          const t = arr[(i + 1) * s + k];
          arr[(i + 1) * s + k] = arr[(i + 2) * s + k];
          arr[(i + 2) * s + k] = t;
        }
      }
      at.needsUpdate = true;
    }
  }
}

/** Merge a set of (already transformed) geometries sharing one material: keeps position / normal / uv. */
export function mergeSimple(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  let totalIdx = 0;
  for (const g of list) {
    total += g.attributes.position.count;
    totalIdx += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const idx = total > 65535 ? new Uint32Array(totalIdx) : new Uint16Array(totalIdx);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.attributes.position as THREE.BufferAttribute;
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.normal as THREE.BufferAttribute;
    const t = g.attributes.uv as THREE.BufferAttribute | undefined;
    for (let i = 0; i < p.count; i++) {
      pos[(vo + i) * 3] = p.getX(i);
      pos[(vo + i) * 3 + 1] = p.getY(i);
      pos[(vo + i) * 3 + 2] = p.getZ(i);
      nor[(vo + i) * 3] = n.getX(i);
      nor[(vo + i) * 3 + 1] = n.getY(i);
      nor[(vo + i) * 3 + 2] = n.getZ(i);
      if (t) {
        uv[(vo + i) * 2] = t.getX(i);
        uv[(vo + i) * 2 + 1] = t.getY(i);
      }
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
    else for (let i = 0; i < p.count; i++) idx[io + i] = i + vo;
    io += g.index ? g.index.count : p.count;
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
