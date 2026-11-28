import * as THREE from 'three';

/**
 * Procedural, process-wide cached textures for the operator characters.
 *
 *  - One 512 px material ATLAS (4 x 4 tiles of 128 px) shared by every character: skin, hair strands,
 *    woven nylon, distressed leather, cargo twill + seams, carbon fibre, brushed metal, rubber lugs,
 *    knit cotton, desert camo, ghillie, painted armour plate, stealth bodysuit, graphic tee, flat, denim.
 *    Colour comes from vertex colours, so the colour atlas is a near-white detail layer.
 *  - A matching DATA atlas (linear): R = bump height, G = roughness, B = metalness. It is used as
 *    bumpMap + roughnessMap + metalnessMap at once (three.js reads .r / .g / .b respectively).
 *  - One 256 px FACE texture per operator (skin tone, eyes, brows, lips, jaw shadow / stubble).
 *
 * Everything is drawn once per process. Headless-safe: with a fake DOM canvas (scripts/headlessMaps.ts)
 * getContext returns a proxy whose calls are no-ops, so all drawing is guarded and never throws.
 */

export const ATLAS_SIZE = 512;
const TILE_PX = 128;
const GRID = 4;

export enum Tile {
  Skin = 0,
  Hair,
  Nylon,
  Leather,
  Cargo,
  Carbon,
  Metal,
  Rubber,
  Knit,
  Camo,
  Ghillie,
  Plate,
  Suit,
  Graphic,
  Flat,
  Denim,
}

export interface TileRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const INSET = 4;
export function tileRect(t: Tile): TileRect {
  const col = t % GRID;
  const row = Math.floor(t / GRID);
  const x0 = col * TILE_PX + INSET;
  const x1 = (col + 1) * TILE_PX - INSET;
  const y0 = row * TILE_PX + INSET;
  const y1 = (row + 1) * TILE_PX - INSET;
  // CanvasTexture.flipY = true: canvas row 0 is v = 1
  return { u0: x0 / ATLAS_SIZE, u1: x1 / ATLAS_SIZE, v0: 1 - y1 / ATLAS_SIZE, v1: 1 - y0 / ATLAS_SIZE };
}

// ------------------------------------------------------------------ noise helpers (deterministic)
function hash(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const fade = (t: number) => t * t * (3 - 2 * t);
function vnoise(x: number, y: number, s = 1) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
function fbm(x: number, y: number, s = 1, oct = 4) {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    v += amp * vnoise(x * f, y * f, s + i * 17);
    f *= 2;
    amp *= 0.5;
  }
  return v / (1 - Math.pow(0.5, oct));
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** [r, g, b] colour multiplier, bump height, roughness, metalness (all 0..1). */
type Px = [number, number, number, number, number, number];

function seamLine(d: number, w: number) {
  return 1 - smooth(0, w, Math.abs(d));
}

function tilePixel(t: Tile, u: number, v: number): Px {
  switch (t) {
    case Tile.Skin: {
      const n = fbm(u * 6, v * 6, 3);
      const pores = vnoise(u * 90, v * 90, 5);
      const c = 0.9 + 0.08 * n;
      return [c + 0.02 * (n - 0.5), c - 0.01, c - 0.02, 0.5 + 0.12 * (pores - 0.5), 0.55 + 0.1 * n, 0];
    }
    case Tile.Hair: {
      const warp = fbm(u * 3, v * 2, 7) * 0.15;
      const strand = vnoise((u + warp) * 70, v * 4, 9);
      const fine = vnoise((u + warp) * 160, v * 8, 11);
      const sheen = Math.exp(-Math.pow((v - 0.62 - 0.08 * Math.sin(u * 12)) / 0.07, 2));
      const c = 0.62 + 0.3 * strand + 0.1 * fine + 0.22 * sheen;
      return [c, c, c, 0.3 + 0.5 * strand, 0.42 - 0.12 * sheen, 0];
    }
    case Tile.Nylon: {
      const f = 26;
      const cx = Math.floor(u * f);
      const cy = Math.floor(v * f);
      const fu = u * f - cx;
      const fv = v * f - cy;
      const warpWeft = (cx + cy) % 2 === 0 ? Math.sin(fu * Math.PI) : Math.sin(fv * Math.PI);
      const n = fbm(u * 5, v * 5, 13);
      const c = 0.8 + 0.1 * warpWeft + 0.08 * (n - 0.5);
      // PALS webbing rows
      const pals = seamLine(((v * 7) % 1) - 0.5, 0.06) * 0.12;
      return [c - pals, c - pals, c - pals, 0.35 + 0.4 * warpWeft - pals, 0.86, 0];
    }
    case Tile.Leather: {
      const n = fbm(u * 5, v * 5, 21);
      const grain = vnoise(u * 70, v * 70, 23);
      const crackN = fbm(u * 14, v * 14, 25);
      const crack = seamLine(crackN - 0.5, 0.025);
      const scratch = seamLine(((u * 3 + v * 9 + fbm(u * 2, v * 2, 27)) % 1) - 0.5, 0.01) * (vnoise(u * 4, v * 4, 29) > 0.6 ? 1 : 0);
      const worn = smooth(0.55, 0.8, fbm(u * 3, v * 3, 31));
      const c = 0.76 + 0.12 * n + 0.04 * grain - 0.16 * crack + 0.2 * worn + 0.15 * scratch;
      return [c, c * 0.98, c * 0.96, 0.5 + 0.15 * grain - 0.3 * crack, 0.42 + 0.3 * worn + 0.1 * crack, 0];
    }
    case Tile.Cargo: {
      const twill = 0.5 + 0.5 * Math.sin((u + v) * Math.PI * 2 * 48);
      const n = fbm(u * 4, v * 4, 33);
      const seamU = seamLine(u - 0.5, 0.012);
      const seamV = seamLine(v - 0.32, 0.012);
      const stitch = (Math.sin(v * 220) > 0.2 ? 1 : 0) * seamLine(u - 0.475, 0.006) + (Math.sin(u * 220) > 0.2 ? 1 : 0) * seamLine(v - 0.345, 0.006);
      const c = 0.84 + 0.06 * twill + 0.08 * (n - 0.5) - 0.25 * Math.max(seamU, seamV) + 0.12 * stitch;
      return [c, c, c, 0.45 + 0.2 * twill - 0.35 * Math.max(seamU, seamV), 0.9, 0];
    }
    case Tile.Carbon: {
      const f = 20;
      const cx = Math.floor(u * f);
      const cy = Math.floor(v * f);
      const fu = u * f - cx;
      const fv = v * f - cy;
      const tw = Math.floor((cx + cy) / 2) % 2 === 0;
      const ridge = tw ? Math.sin(fu * Math.PI) : Math.sin(fv * Math.PI);
      const c = 0.32 + 0.22 * ridge;
      return [c, c, c * 1.04, 0.4 + 0.4 * ridge, 0.32, 0.25];
    }
    case Tile.Metal: {
      const brush = vnoise(u * 3, v * 140, 41) * 0.6 + vnoise(u * 8, v * 300, 43) * 0.4;
      const c = 0.82 + 0.16 * brush;
      return [c, c, c, 0.5 + 0.1 * brush, 0.25 + 0.15 * brush, 1];
    }
    case Tile.Rubber: {
      const lug = (Math.sin(u * Math.PI * 2 * 7) > 0.2 ? 1 : 0) * (Math.sin(v * Math.PI * 2 * 11) > -0.3 ? 1 : 0);
      const n = vnoise(u * 50, v * 50, 47);
      const c = 0.72 + 0.12 * lug + 0.06 * n;
      return [c, c, c, 0.25 + 0.6 * lug, 0.92, 0];
    }
    case Tile.Knit: {
      const k = vnoise(u * 110, v * 110, 51);
      const rib = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 60);
      const n = fbm(u * 3, v * 3, 53);
      const c = 0.88 + 0.05 * k + 0.03 * rib + 0.05 * (n - 0.5);
      return [c, c, c, 0.4 + 0.2 * rib + 0.1 * k, 0.94, 0];
    }
    case Tile.Camo: {
      const a = fbm(u * 3.2, v * 3.2, 61);
      const b = fbm(u * 5.5 + 9, v * 5.5, 63);
      let c = 1.0;
      if (a > 0.58) c = 0.72;
      if (b > 0.62) c = 0.86;
      if (a > 0.58 && b > 0.62) c = 0.6;
      const twill = 0.5 + 0.5 * Math.sin((u - v) * Math.PI * 2 * 44);
      c += 0.04 * twill;
      const seam = seamLine(u - 0.5, 0.01);
      return [c * 1.02 - 0.2 * seam, c - 0.2 * seam, c * 0.94 - 0.2 * seam, 0.45 + 0.2 * twill - 0.3 * seam, 0.92, 0];
    }
    case Tile.Ghillie: {
      const strands = vnoise(u * 40, v * 6, 71);
      const clump = fbm(u * 6, v * 6, 73);
      const c = 0.5 + 0.45 * strands * (0.6 + 0.4 * clump);
      return [c * 0.96, c, c * 0.84, 0.2 + 0.7 * strands, 1, 0];
    }
    case Tile.Plate: {
      const panel = Math.max(seamLine(v - 0.34, 0.01), seamLine(v - 0.68, 0.01), seamLine(u - 0.5, 0.008) * (v < 0.34 ? 1 : 0));
      const edge = 1 - Math.min(smooth(0, 0.08, u), smooth(1, 0.92, u), smooth(0, 0.08, v), smooth(1, 0.92, v));
      const wear = edge * smooth(0.45, 0.7, fbm(u * 10, v * 10, 81));
      const scratch = seamLine(((u * 5 - v * 2 + fbm(u, v, 83) * 2) % 1) - 0.5, 0.006) * (vnoise(u * 3, v * 3, 85) > 0.55 ? 1 : 0);
      const n = fbm(u * 4, v * 4, 87);
      const c = 0.86 + 0.06 * n - 0.35 * panel + 0.25 * wear + 0.2 * scratch;
      return [c, c, c, 0.55 - 0.4 * panel, 0.42 + 0.1 * n - 0.15 * wear, 0.3 + 0.6 * wear];
    }
    case Tile.Suit: {
      // fine diamond / hex micro-mesh with satin sheen
      const a = Math.abs(Math.sin((u + v * 0.58) * Math.PI * 34));
      const b = Math.abs(Math.sin((u - v * 0.58) * Math.PI * 34));
      const cell = Math.min(a, b);
      const n = fbm(u * 3, v * 3, 91);
      const c = 0.84 + 0.1 * cell + 0.05 * (n - 0.5);
      const panel = seamLine(u - 0.25, 0.008) + seamLine(u - 0.75, 0.008);
      return [c - 0.25 * panel, c - 0.25 * panel, c - 0.2 * panel, 0.45 + 0.25 * cell - 0.3 * panel, 0.32 + 0.1 * n, 0.12];
    }
    case Tile.Graphic: {
      const knit = vnoise(u * 110, v * 110, 95);
      let r = 0.92 + 0.04 * knit;
      let g = r;
      let b = r;
      // Front print centred at u = 0.5, v ~ 0.62: ring + chevrons + bar (tee graphic)
      const dx = (u - 0.5) * 3.2;
      const dy = (v - 0.62) * 2.2;
      const d = Math.hypot(dx, dy);
      const ring = seamLine(d - 0.22, 0.03);
      const chev = Math.abs(dx) < 0.16 && dy > -0.12 && dy < 0.12 && Math.abs(Math.abs(dx) - (0.12 - Math.abs(dy))) < 0.05 ? 1 : 0;
      const bar = Math.abs(dy + 0.36) < 0.04 && Math.abs(dx) < 0.3 ? 1 : 0;
      const ink = Math.max(ring, chev, bar) * (vnoise(u * 60, v * 60, 97) > 0.25 ? 1 : 0.6); // distressed print
      if (ink > 0) {
        r = r * (1 - ink) + 0.95 * ink;
        g = g * (1 - ink) + 0.45 * ink;
        b = b * (1 - ink) + 0.12 * ink;
      }
      return [r, g, b, 0.4 + 0.1 * knit + 0.1 * ink, 0.92 - 0.2 * ink, 0];
    }
    case Tile.Denim: {
      const twill = 0.5 + 0.5 * Math.sin((u * 1.0 - v * 1.0) * Math.PI * 2 * 56);
      const slub = vnoise(u * 8, v * 90, 101);
      const fade2 = fbm(u * 2, v * 3, 103);
      const c = 0.74 + 0.12 * twill + 0.08 * slub + 0.12 * fade2;
      const seam = seamLine(u - 0.5, 0.012);
      return [c - 0.2 * seam, c - 0.2 * seam, c - 0.15 * seam, 0.4 + 0.3 * twill - 0.3 * seam, 0.88, 0];
    }
    case Tile.Flat:
    default:
      return [1, 1, 1, 0.5, 0.5, 0];
  }
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas') as HTMLCanvasElement;
  c.width = w;
  c.height = h;
  return c;
}

function getImage(ctx: CanvasRenderingContext2D | null, w: number, h: number): ImageData | null {
  try {
    const img = ctx?.getImageData?.(0, 0, w, h);
    return img && img.data && img.data.length >= w * h * 4 ? img : null;
  } catch {
    return null;
  }
}

interface AtlasSet {
  color: THREE.CanvasTexture;
  data: THREE.CanvasTexture;
}
let atlas: AtlasSet | null = null;

/** The shared colour + data atlas (built on first use). */
export function characterAtlas(): AtlasSet {
  if (atlas) return atlas;
  const S = ATLAS_SIZE;
  const cc = makeCanvas(S, S);
  const dc = makeCanvas(S, S);
  const cctx = cc.getContext('2d') as CanvasRenderingContext2D | null;
  const dctx = dc.getContext('2d') as CanvasRenderingContext2D | null;
  try {
    if (cctx) {
      cctx.fillStyle = '#ffffff';
      cctx.fillRect(0, 0, S, S);
    }
    if (dctx) {
      dctx.fillStyle = '#808000';
      dctx.fillRect(0, 0, S, S);
    }
  } catch {
    /* fake canvas */
  }
  const ci = getImage(cctx, S, S);
  const di = getImage(dctx, S, S);
  if (ci && di) {
    for (let y = 0; y < S; y++) {
      const row = Math.floor(y / TILE_PX);
      const v = 1 - (y - row * TILE_PX) / TILE_PX; // v up inside the tile
      for (let x = 0; x < S; x++) {
        const col = Math.floor(x / TILE_PX);
        const u = (x - col * TILE_PX) / TILE_PX;
        const px = tilePixel((row * GRID + col) as Tile, u, v);
        const i = (y * S + x) * 4;
        ci.data[i] = clamp01(px[0]) * 255;
        ci.data[i + 1] = clamp01(px[1]) * 255;
        ci.data[i + 2] = clamp01(px[2]) * 255;
        ci.data[i + 3] = 255;
        di.data[i] = clamp01(px[3]) * 255;
        di.data[i + 1] = clamp01(px[4]) * 255;
        di.data[i + 2] = clamp01(px[5]) * 255;
        di.data[i + 3] = 255;
      }
    }
    try {
      cctx?.putImageData(ci, 0, 0);
      dctx?.putImageData(di, 0, 0);
    } catch {
      /* ignore */
    }
  }
  const color = new THREE.CanvasTexture(cc);
  color.colorSpace = THREE.SRGBColorSpace;
  color.anisotropy = 4;
  const data = new THREE.CanvasTexture(dc);
  data.colorSpace = THREE.NoColorSpace;
  atlas = { color, data };
  return atlas;
}

// ------------------------------------------------------------------ faces

/** Head UV mapping shared with the head geometry: expanded cylindrical projection (face gets ~40 % of u). */
export const FACE_U_POW = 0.6;
export function faceUV(x: number, y: number, z: number): [number, number] {
  const th = Math.atan2(x, -z); // 0 = front (-Z)
  const u = 0.5 + 0.5 * Math.sign(th) * Math.pow(Math.abs(th) / Math.PI, FACE_U_POW);
  const v = 0.5 + 0.5 * Math.max(-1, Math.min(1, y));
  return [u, v];
}

export interface FaceSpec {
  skin: number;
  brow: number;
  eyes: number;
  lips: number;
  female: boolean;
  stubble?: number; // 0..1 jaw stubble / beard shadow
  beard?: boolean;
  /** Face paint / eye black stripe (desert sniper), cyber tattoo line (valkyrie) */
  paint?: 'eyeblack' | 'cyber' | null;
  paintColor?: number;
}

const FACE_PX = 256;
const faceCache = new Map<string, THREE.CanvasTexture>();

const hex = (c: number, a = 1) => {
  const col = new THREE.Color(c);
  return `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${a})`;
};
function shade(c: number, k: number) {
  const col = new THREE.Color(c);
  col.multiplyScalar(k);
  return col.getHex();
}

/** Canvas pixel position of a direction on the head sphere (θ around from the front, y up). */
function fp(th: number, y: number): [number, number] {
  const u = 0.5 + 0.5 * Math.sign(th) * Math.pow(Math.abs(th) / Math.PI, FACE_U_POW);
  const v = 0.5 + 0.5 * y;
  return [u * FACE_PX, (1 - v) * FACE_PX];
}

export function faceTexture(key: string, f: FaceSpec): THREE.CanvasTexture {
  const hit = faceCache.get(key);
  if (hit) return hit;
  const c = makeCanvas(FACE_PX, FACE_PX);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D | null;
  if (ctx) {
    try {
      drawFace(ctx, f);
    } catch {
      /* fake canvas */
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  faceCache.set(key, tex);
  return tex;
}

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2);
}

function drawFace(ctx: CanvasRenderingContext2D, f: FaceSpec) {
  const W = FACE_PX;
  ctx.fillStyle = hex(f.skin);
  ctx.fillRect(0, 0, W, W);
  // Skin mottling
  const img = getImage(ctx, W, W);
  if (img) {
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const n = fbm(x / 40, y / 40, 201) - 0.5;
        const p = vnoise(x / 2.2, y / 2.2, 203) - 0.5;
        const k = 1 + n * 0.06 + p * 0.03;
        img.data[i] = Math.min(255, img.data[i] * (k + 0.01));
        img.data[i + 1] = Math.min(255, img.data[i + 1] * k);
        img.data[i + 2] = Math.min(255, img.data[i + 2] * (k - 0.01));
      }
    ctx.putImageData(img, 0, 0);
  }
  const [cx] = fp(0, 0);
  // Under-jaw / neck shadow and top-of-head shading
  let g = ctx.createLinearGradient(0, W * 0.62, 0, W);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(40,18,10,0.35)');
  ctx.fillStyle = g;
  ctx.fillRect(0, W * 0.62, W, W * 0.38);
  // Side shading (face planes turn away)
  g = ctx.createLinearGradient(cx - W * 0.32, 0, cx + W * 0.32, 0);
  g.addColorStop(0, 'rgba(50,25,15,0.22)');
  g.addColorStop(0.3, 'rgba(0,0,0,0)');
  g.addColorStop(0.7, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(50,25,15,0.22)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, W);
  // Cheek warmth
  for (const s of [-1, 1]) {
    const [x, y] = fp(s * 0.55, -0.15);
    const rg = ctx.createRadialGradient(x, y, 1, x, y, 18);
    rg.addColorStop(0, f.female ? 'rgba(210,90,80,0.16)' : 'rgba(190,90,70,0.1)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(x - 20, y - 20, 40, 40);
  }
  // Stubble / beard
  if (f.stubble || f.beard) {
    const a = f.beard ? 0.62 : (f.stubble ?? 0) * 0.35;
    const beard = hex(shade(f.brow, 0.9), a);
    ctx.fillStyle = beard;
    ctx.beginPath();
    const [lx, ly] = fp(-0.95, -0.15);
    const [rx2] = fp(0.95, -0.15);
    const [, jy] = fp(0, -1);
    const [, my] = fp(0, -0.36);
    ctx.moveTo(lx, ly);
    ctx.quadraticCurveTo(lx + 6, jy, cx, jy + 2);
    ctx.quadraticCurveTo(rx2 - 6, jy, rx2, ly);
    ctx.lineTo(rx2 - 10, ly + 4);
    ctx.quadraticCurveTo(cx + 26, my + 2, cx, my - 2);
    ctx.quadraticCurveTo(cx - 26, my + 2, lx + 10, ly + 4);
    ctx.closePath();
    ctx.fill();
    // moustache
    if (f.beard) {
      ellipse(ctx, cx, my - 5, 17, 3.5);
      ctx.fill();
    }
    // stubble speckle
    const im2 = getImage(ctx, W, W);
    if (im2) {
      for (let y = Math.floor(my - 10); y < W; y++)
        for (let x = 0; x < W; x++) {
          if (vnoise(x * 1.7, y * 1.7, 211) > 0.72) {
            const i = (y * W + x) * 4;
            im2.data[i] *= 0.9;
            im2.data[i + 1] *= 0.9;
            im2.data[i + 2] *= 0.9;
          }
        }
      ctx.putImageData(im2, 0, 0);
    }
  }
  // Nose: bridge highlight, nostril shadow
  {
    const [nx, ny] = fp(0, -0.12);
    const [, by] = fp(0, 0.12);
    ctx.fillStyle = 'rgba(255,240,225,0.18)';
    ellipse(ctx, nx, (ny + by) / 2, 2.5, (ny - by) / 2 + 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(70,30,20,0.35)';
    for (const s of [-1, 1]) {
      ellipse(ctx, nx + s * 4, ny + 3, 2.2, 1.3);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(70,30,20,0.12)';
    ellipse(ctx, nx, ny + 6, 7, 2);
    ctx.fill();
  }
  // Eyes
  for (const s of [-1, 1]) {
    const [ex, ey] = fp(s * 0.36, 0.1);
    // socket shadow
    const rg = ctx.createRadialGradient(ex, ey, 2, ex, ey, 14);
    rg.addColorStop(0, 'rgba(60,30,25,0.28)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(ex - 15, ey - 15, 30, 30);
    // sclera (almond)
    ctx.fillStyle = '#f1ece6';
    ctx.beginPath();
    ctx.moveTo(ex - 8, ey + 0.5);
    ctx.quadraticCurveTo(ex, ey - 5.5, ex + 8, ey - 0.5);
    ctx.quadraticCurveTo(ex, ey + 4.5, ex - 8, ey + 0.5);
    ctx.fill();
    // iris + pupil + catch-light
    ctx.fillStyle = hex(f.eyes);
    ellipse(ctx, ex + s * 0.6, ey, 3.6, 3.8);
    ctx.fill();
    ctx.fillStyle = '#0b0b0d';
    ellipse(ctx, ex + s * 0.6, ey, 1.7, 1.8);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ellipse(ctx, ex + s * 0.6 - 1.2, ey - 1.4, 0.9, 0.9);
    ctx.fill();
    // upper lid line / lashes
    ctx.strokeStyle = f.female ? 'rgba(20,12,10,0.95)' : 'rgba(40,22,16,0.8)';
    ctx.lineWidth = f.female ? 1.8 : 1.3;
    ctx.beginPath();
    ctx.moveTo(ex - 8.5, ey + 0.8);
    ctx.quadraticCurveTo(ex, ey - 6.2, ex + 8.5, ey - 0.6);
    if (f.female) ctx.lineTo(ex + s * 10.5, ey - 2.6);
    ctx.stroke();
    // lower lid hint
    ctx.strokeStyle = 'rgba(90,45,35,0.35)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(ex - 7, ey + 1.6);
    ctx.quadraticCurveTo(ex, ey + 5, ex + 7, ey + 0.6);
    ctx.stroke();
    // brow
    const [bx, byy] = fp(s * 0.36, 0.25);
    ctx.strokeStyle = hex(f.brow, 0.95);
    ctx.lineCap = 'round';
    ctx.lineWidth = f.female ? 2.2 : 3.4;
    ctx.beginPath();
    ctx.moveTo(bx - s * 10, byy + 2);
    ctx.quadraticCurveTo(bx - s * 1, byy - 3.5, bx + s * 10, byy + (f.female ? -0.5 : 1));
    ctx.stroke();
  }
  // Mouth
  {
    const [mx, my] = fp(0, -0.43);
    ctx.fillStyle = hex(f.lips, f.female ? 0.85 : 0.6);
    ctx.beginPath();
    ctx.moveTo(mx - 15, my);
    ctx.quadraticCurveTo(mx - 6, my - 4.5, mx, my - 2.5);
    ctx.quadraticCurveTo(mx + 6, my - 4.5, mx + 15, my);
    ctx.quadraticCurveTo(mx, my + 6, mx - 15, my);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,20,18,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx - 15, my);
    ctx.quadraticCurveTo(mx, my + 1.4, mx + 15, my);
    ctx.stroke();
    // chin shadow
    const [, chy] = fp(0, -0.72);
    ctx.fillStyle = 'rgba(60,30,20,0.1)';
    ellipse(ctx, mx, chy, 12, 4);
    ctx.fill();
  }
  // Face paint
  if (f.paint === 'eyeblack') {
    ctx.fillStyle = hex(f.paintColor ?? 0x1a1a1a, 0.75);
    for (const s of [-1, 1]) {
      const [x, y] = fp(s * 0.4, -0.06);
      ctx.fillRect(x - 9, y - 2.5, 18, 5);
    }
  } else if (f.paint === 'cyber') {
    ctx.strokeStyle = hex(f.paintColor ?? 0xe879f9, 0.9);
    ctx.lineWidth = 1.4;
    const [x, y] = fp(0.5, -0.05);
    ctx.beginPath();
    ctx.moveTo(x - 4, y - 14);
    ctx.lineTo(x + 2, y - 4);
    ctx.lineTo(x + 2, y + 12);
    ctx.stroke();
    ellipse(ctx, x + 2, y + 13, 1.4, 1.4);
    ctx.fillStyle = hex(f.paintColor ?? 0xe879f9, 0.9);
    ctx.fill();
  }
}
