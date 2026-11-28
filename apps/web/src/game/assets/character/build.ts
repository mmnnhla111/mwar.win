import * as THREE from 'three';
import { Bone, Kind, Kit, Profile, ellipsoid, lathe, profileAt, rbox, ring, shell, stripe, tube } from './geometry';
import { FACE_U_POW, FaceSpec, Tile, characterAtlas, faceTexture } from './textures';

/**
 * Operator construction: anatomical base body (~7.5 heads, 1.76 m skull top, root at the feet, facing -Z)
 * plus per-operator gear, baked into merged geometries (one per bone and material kind), built ONCE per
 * operator id and shared by every instance.
 */

// ------------------------------------------------------------------ skeleton (metres)
export const SKEL = {
  hipY: 0.93,
  thigh: 0.44,
  shin: 0.41,
  torsoY: 0.99,
  shoulderY: 0.425,
  neckY: 0.5,
  upper: 0.31,
  /** Elbow → grip centre of the fist (forearm + half hand). */
  grip: 0.345,
};

export type CharacterId =
  | 'specops'
  | 'mercenary'
  | 'desert_sniper'
  | 'heavy_striker'
  | 'bodysuit_agent'
  | 'urban_scout'
  | 'crimson_operative'
  | 'cyber_valkyrie';

export interface CharacterStyle {
  id: CharacterId;
  name: string;
  gender: 'male' | 'female';
  tagline: string;
  /** Signature neon / trim colour (card glow, accent lights). */
  accent: number;
  /** Main torso colour (selector fallback swatch). */
  top: number;
  skin: number;
  hair: number;
  eyes: number;
  /** First-person arms (viewmodel). */
  glove: number;
  sleeve: number;
  /** Girth factor (heavy = bulkier). */
  build: number;
}

export const CHARACTERS: CharacterStyle[] = [
  {
    id: 'specops', name: 'Spec-Ops Operator', gender: 'male', tagline: 'Matte-black plate carrier, headset & NVG',
    accent: 0x22d3ee, top: 0x2f353d, skin: 0xc89f7c, hair: 0x2b2118, eyes: 0x4b3621, glove: 0x1c1c1c, sleeve: 0x3a4048, build: 1.0,
  },
  {
    id: 'mercenary', name: 'Urban Mercenary', gender: 'male', tagline: 'Distressed leather, tactical cap, thigh rig',
    accent: 0xf97316, top: 0x5a3a24, skin: 0xb7835f, hair: 0x1f1a17, eyes: 0x3b2a1e, glove: 0x2a1f18, sleeve: 0x5a3a24, build: 1.02,
  },
  {
    id: 'desert_sniper', name: 'Desert Recon Sniper', gender: 'male', tagline: 'Boonie, ghillie mantle, rangefinder',
    accent: 0xfacc15, top: 0xc2a878, skin: 0xa8754f, hair: 0x3b2a1a, eyes: 0x5b4a2e, glove: 0x7a6847, sleeve: 0xc2a878, build: 0.98,
  },
  {
    id: 'heavy_striker', name: 'Heavy Armored Striker', gender: 'male', tagline: 'Segmented plates, visor helm, exo-rig',
    accent: 0xef4444, top: 0x4b5058, skin: 0x8d5b3c, hair: 0x111111, eyes: 0x2a1a10, glove: 0x27272a, sleeve: 0x2b2d31, build: 1.1,
  },
  {
    id: 'bodysuit_agent', name: 'Tactical Bodysuit Agent', gender: 'female', tagline: 'Stealth suit, cyan-gold piping, ponytail',
    accent: 0x22d3ee, top: 0x1a2030, skin: 0xe0b090, hair: 0x1b1b1f, eyes: 0x3f5a6e, glove: 0x111318, sleeve: 0x1a2030, build: 0.92,
  },
  {
    id: 'urban_scout', name: 'Urban Crop-Top Scout', gender: 'female', tagline: 'Cropped street jacket, headband, high-tops',
    accent: 0xfacc15, top: 0xfacc15, skin: 0xc68e66, hair: 0x6b3f22, eyes: 0x4a3020, glove: 0x18181b, sleeve: 0xfacc15, build: 0.92,
  },
  {
    id: 'crimson_operative', name: 'Crimson Leather Operative', gender: 'female', tagline: 'Crimson moto leather, long flowing hair',
    accent: 0xf87171, top: 0xb91c1c, skin: 0xf0c4a4, hair: 0x4a1c17, eyes: 0x355e3b, glove: 0x1f1414, sleeve: 0xb91c1c, build: 0.92,
  },
  {
    id: 'cyber_valkyrie', name: 'Cyber-Valkyrie Recon', gender: 'female', tagline: 'Neon visor, undercut, shoulder guard',
    accent: 0xe879f9, top: 0x312e81, skin: 0xd9a37f, hair: 0xe2e8f0, eyes: 0x6d28d9, glove: 0x1e1b4b, sleeve: 0x312e81, build: 0.93,
  },
];

// ------------------------------------------------------------------ dimensions

interface Dims {
  female: boolean;
  sh: number;
  hipW: number;
  torso: Profile;
  tsx: number;
  tsz: number;
  pelvis: Profile;
  psx: number;
  psz: number;
  thigh: Profile;
  shin: Profile;
  upper: Profile;
  fore: Profile;
  neck: Profile;
  head: { rx: number; ry: number; rz: number; cy: number; cz: number };
}

const scaleR = (p: Profile, k: number): Profile => p.map(([r, y]) => [r * k, y]);

function dims(st: CharacterStyle): Dims {
  const f = st.gender === 'female';
  const g = st.build;
  const torsoM: Profile = [[0.14, -0.06], [0.138, 0.02], [0.134, 0.1], [0.14, 0.18], [0.152, 0.26], [0.162, 0.33], [0.165, 0.38], [0.158, 0.43], [0.132, 0.47], [0.09, 0.5], [0.05, 0.515]];
  const torsoF: Profile = [[0.135, -0.06], [0.128, 0.02], [0.116, 0.1], [0.12, 0.18], [0.136, 0.26], [0.145, 0.32], [0.145, 0.37], [0.138, 0.42], [0.116, 0.46], [0.078, 0.495], [0.045, 0.51]];
  const pelvisM: Profile = [[0.06, 0.79], [0.12, 0.81], [0.15, 0.85], [0.163, 0.9], [0.162, 0.96], [0.15, 1.0], [0.142, 1.04]];
  const pelvisF: Profile = [[0.06, 0.79], [0.12, 0.81], [0.156, 0.85], [0.17, 0.9], [0.166, 0.96], [0.146, 1.0], [0.134, 1.04]];
  const thigh: Profile = [[0.07, 0.06], [0.088, 0.0], [0.09, -0.07], [0.083, -0.2], [0.07, -0.33], [0.058, -0.42], [0.055, -0.46]];
  const shin: Profile = [[0.056, 0.03], [0.057, -0.03], [0.06, -0.1], [0.055, -0.17], [0.045, -0.28], [0.037, -0.36], [0.036, -0.41]];
  const upper: Profile = [[0.056, 0.02], [0.06, -0.05], [0.056, -0.13], [0.05, -0.22], [0.044, -0.3], [0.042, -0.33]];
  const fore: Profile = [[0.044, 0.03], [0.048, -0.05], [0.043, -0.14], [0.035, -0.24], [0.031, -0.28]];
  return {
    female: f,
    sh: (f ? 0.165 : 0.185) * (1 + (g - 1) * 0.6),
    hipW: f ? 0.095 : 0.092,
    torso: scaleR(f ? torsoF : torsoM, g),
    tsx: f ? 1.15 : 1.22,
    tsz: f ? 0.72 : 0.68,
    pelvis: scaleR(f ? pelvisF : pelvisM, Math.min(1.04, g)),
    psx: f ? 1.06 : 1.08,
    psz: f ? 0.76 : 0.74,
    thigh: scaleR(thigh, g * (f ? 0.97 : 1)),
    shin: scaleR(shin, g * (f ? 0.93 : 1)),
    upper: scaleR(upper, g * (f ? 0.86 : 1)),
    fore: scaleR(fore, g * (f ? 0.86 : 1)),
    neck: f ? [[0.05, 0.44], [0.046, 0.5], [0.044, 0.55], [0.047, 0.6]] : [[0.058, 0.44], [0.054, 0.5], [0.052, 0.55], [0.054, 0.6]],
    head: f ? { rx: 0.075, ry: 0.112, rz: 0.096, cy: 0.152, cz: -0.01 } : { rx: 0.079, ry: 0.118, rz: 0.1, cy: 0.155, cz: -0.012 },
  };
}

// ------------------------------------------------------------------ head sculpt

const gauss = (x: number) => Math.exp(-x * x);
const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Sculpted head: unit direction → offset from the head centre (metres). Face is -Z. */
function headShape(d: THREE.Vector3, D: Dims, out = new THREE.Vector3()) {
  let { x, y, z } = d;
  const front = Math.max(0, -z);
  const low = sstep(0.1, -0.95, y);
  x *= 1 - (D.female ? 0.34 : 0.28) * low; // jaw taper
  if (z > 0) {
    z *= 1.06 + 0.06 * sstep(-0.2, 0.5, y); // occiput
    z *= 1 - 0.38 * sstep(-0.2, -0.85, y); // nape tuck into the neck
  }
  z -= (D.female ? 0.07 : 0.11) * gauss(x / 0.26) * gauss((y + 0.84) / 0.16) * front; // chin
  z -= 0.05 * gauss((y - 0.27) / 0.07) * sstep(0.8, 0.2, Math.abs(x)) * front; // brow ridge
  z += 0.035 * gauss((y - 0.11) / 0.08) * gauss((Math.abs(x) - 0.36) / 0.14) * front; // eye sockets
  const nx = gauss(x / 0.13);
  z -= front * nx * ((D.female ? 0.16 : 0.2) * gauss((y + 0.12) / 0.11) + 0.08 * gauss((y - 0.07) / 0.13)); // nose tip + bridge
  x *= 1 + 0.05 * gauss((y + 0.02) / 0.16) * front; // cheekbones
  z -= 0.03 * front * gauss(x / 0.2) * gauss((y + 0.43) / 0.07); // lips
  return out.set(x * D.head.rx, y * D.head.ry, z * D.head.rz);
}

/** Grid over a sphere region (az: 0 = back/+Z, PI = front/-Z; th: 0 = top). */
function dome(ws: number, hs: number, azStart: number, azLen: number, thMin: (az: number) => number, thMax: (az: number) => number, map: (d: THREE.Vector3, t: number, az: number) => THREE.Vector3) {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const d = new THREE.Vector3();
  for (let i = 0; i <= ws; i++) {
    const az = azStart + (azLen * i) / ws;
    const t0 = thMin(az);
    const t1 = thMax(az);
    for (let j = 0; j <= hs; j++) {
      const t = j / hs;
      const th = t0 + (t1 - t0) * t;
      d.set(Math.sin(az) * Math.sin(th), Math.cos(th), Math.cos(az) * Math.sin(th));
      const p = map(d, t, az);
      pos.push(p.x, p.y, p.z);
      uv.push(i / ws, 1 - t);
    }
  }
  for (let i = 0; i < ws; i++)
    for (let j = 0; j < hs; j++) {
      const a = i * (hs + 1) + j;
      const b = (i + 1) * (hs + 1) + j;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const frontness = (az: number) => (1 - Math.cos(az)) / 2; // 1 at the face, 0 at the back

function faceGeometry(D: Dims, ws: number, hs: number) {
  const tmp = new THREE.Vector3();
  const g = dome(ws, hs, 0, Math.PI * 2, () => 0, () => Math.PI, (d) => headShape(d, D, tmp).add(new THREE.Vector3(0, D.head.cy, D.head.cz)));
  // face UVs (expanded cylindrical, see textures.faceUV)
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i <= ws; i++) {
    const az = (Math.PI * 2 * i) / ws;
    const th = Math.PI - az; // angle from the front, + toward +X
    const u = 0.5 + 0.5 * Math.sign(th) * Math.pow(Math.abs(th) / Math.PI, FACE_U_POW);
    for (let j = 0; j <= hs; j++) {
      const v = 0.5 + 0.5 * Math.cos((Math.PI * j) / hs);
      uv.setXY(i * (hs + 1) + j, u, v);
    }
  }
  return g;
}

// ------------------------------------------------------------------ helpers

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Point on the front (-Z) or back of a lathe surface at lateral offset x. */
function surf(p: Profile, sx: number, sz: number, x: number, y: number, dr: number, back = false) {
  const r = profileAt(p, y) + dr;
  const a = Math.asin(Math.max(-0.97, Math.min(0.97, x / (r * sx))));
  const z = r * sz * Math.cos(a);
  return V(x, y, back ? z : -z);
}

type Sides = Array<{ s: -1 | 1; leg: Bone; knee: Bone; arm: Bone; elbow: Bone }>;
const SIDES: Sides = [
  { s: -1, leg: 'legL', knee: 'kneeL', arm: 'armL', elbow: 'elbowL' },
  { s: 1, leg: 'legR', knee: 'kneeR', arm: 'armR', elbow: 'elbowR' },
];

interface Ctx {
  k: Kit;
  st: CharacterStyle;
  D: Dims;
}

interface Cloth {
  color: number;
  tile: Tile;
}

interface BaseLook {
  shirt: Cloth;
  pants: Cloth;
  sleeve: Cloth;
  fore: Cloth;
  glove: Cloth & { fingerless?: boolean };
  boots: { type: 'combat' | 'sneaker' | 'thigh' | 'heavy'; color: number; tile: Tile; sole: number; accent?: number };
  belt?: { color: number; buckle: number; w?: number };
}

// ------------------------------------------------------------------ base body

function baseBody(c: Ctx, L: BaseLook) {
  const { k, D, st } = c;
  // Pelvis + torso + neck
  k.add('body', lathe(D.pelvis, 16, D.psx, D.psz), L.pants.color, L.pants.tile);
  k.add('torso', lathe(D.torso, 18, D.tsx, D.tsz), L.shirt.color, L.shirt.tile);
  k.add('torso', lathe(D.neck, 12, 1, 1.05), st.skin, Tile.Skin, { ao: 0.35 });
  // trapezius slope (clothing)
  for (const s of [-1, 1]) k.add('torso', ellipsoid(0.075, 0.032, 0.055, 10, 6), L.shirt.color, L.shirt.tile, { p: [s * 0.085, 0.462, 0.01], r: [0, 0, s * -0.35] });
  if (L.belt) {
    const bw = L.belt.w ?? 0.045;
    k.add('body', shell(D.pelvis, 1.0 - bw / 2, 1.0 + bw / 2, 0.008, { steps: 1, segs: 18, sx: D.psx, sz: D.psz }), L.belt.color, Tile.Nylon);
    const fz = -(profileAt(D.pelvis, 1.0) * D.psz + 0.012);
    k.add('body', rbox(0.06, bw + 0.008, 0.012, 0.004), L.belt.buckle, Tile.Metal, { p: [0, 1.0, fz] });
  }
  // Legs
  for (const S of SIDES) {
    k.add(S.leg, lathe(D.thigh, 12, 1, 1.05), L.pants.color, L.pants.tile);
    k.add(S.knee, lathe(D.shin, 12, 1, 1.08), L.pants.color, L.pants.tile);
    // calf mass (back)
    k.add(S.knee, ellipsoid(0.046 * st.build, 0.09, 0.045 * st.build, 10, 6), L.pants.color, L.pants.tile, { p: [0, -0.12, 0.014] });
    boots(c, S, L);
  }
  // Arms
  for (const S of SIDES) {
    k.add(S.arm, ellipsoid(0.066 * st.build * (D.female ? 0.88 : 1), 0.078, 0.07 * st.build * (D.female ? 0.88 : 1), 12, 8), L.sleeve.color, L.sleeve.tile, { p: [S.s * 0.01, -0.025, 0] });
    k.add(S.arm, lathe(D.upper, 12, 1, 1.0), L.sleeve.color, L.sleeve.tile);
    k.add(S.elbow, lathe(D.fore, 12, 1, 0.92), L.fore.color, L.fore.tile);
    hand(c, S, L);
  }
}

function hand(c: Ctx, S: Sides[number], L: BaseLook) {
  const { k, st, D } = c;
  const g = L.glove;
  const f = D.female ? 0.9 : 1;
  const y = -SKEL.grip;
  k.add(S.elbow, rbox(0.05 * f, 0.09 * f, 0.085 * f, 0.022, 2), g.color, g.tile, { p: [0, y + 0.012, 0.004] });
  // curled fingers (front of the fist)
  for (let i = 0; i < 4; i++) {
    const fy = y + 0.04 * f - i * 0.024 * f;
    k.add(S.elbow, ellipsoid(0.022 * f, 0.012 * f, 0.016 * f, 6, 4), g.fingerless ? st.skin : g.color, g.fingerless ? Tile.Skin : g.tile, { p: [0, fy, -0.042 * f] });
  }
  // thumb (medial side)
  k.add(S.elbow, ellipsoid(0.013 * f, 0.03 * f, 0.013 * f, 6, 4), g.fingerless ? st.skin : g.color, g.fingerless ? Tile.Skin : g.tile, { p: [-S.s * 0.024 * f, y + 0.03, -0.03 * f], r: [0.5, 0, -S.s * 0.4] });
  // wrist cuff
  k.add(S.elbow, ring(D.fore, -0.275, 0.006, 0.007, 1, 0.92, 12), g.color, g.tile);
}

function boots(c: Ctx, S: Sides[number], L: BaseLook) {
  const { k, D } = c;
  const b = L.boots;
  const sole = b.sole;
  if (b.type === 'sneaker') {
    k.add(S.knee, shell(D.shin, -0.29, -0.41, 0.014, { steps: 3, segs: 12, sz: 1.08 }), b.color, b.tile);
    k.add(S.knee, ring(D.shin, -0.29, 0.016, 0.01, 1, 1.08, 12), b.accent ?? b.color, Tile.Knit);
    k.add(S.knee, rbox(0.106, 0.075, 0.25, 0.034, 3), b.color, b.tile, { p: [0, -0.432, -0.045] });
    k.add(S.knee, ellipsoid(0.053, 0.035, 0.06, 10, 6), b.color, b.tile, { p: [0, -0.44, -0.145] });
    k.add(S.knee, rbox(0.116, 0.04, 0.275, 0.016, 2), sole, Tile.Rubber, { p: [0, -0.47, -0.048] });
    if (b.accent) for (const s of [-1, 1]) k.add(S.knee, rbox(0.004, 0.025, 0.12, 0.002, 1), b.accent, Tile.Flat, { p: [s * 0.055, -0.43, -0.04], r: [0.25, 0, 0] });
    for (let i = 0; i < 4; i++) k.add(S.knee, rbox(0.05, 0.008, 0.01, 0.003, 1), 0xf8fafc, Tile.Nylon, { p: [0, -0.33 - i * 0.025, -(profileAt(D.shin, -0.33 - i * 0.025) * 1.08 + 0.016)] });
    return;
  }
  if (b.type === 'thigh') {
    k.add(S.leg, shell(D.thigh, -0.2, -0.46, 0.008, { steps: 4, segs: 12, sz: 1.05 }), b.color, b.tile);
    k.add(S.knee, shell(D.shin, 0.03, -0.41, 0.008, { steps: 6, segs: 12, sz: 1.08 }), b.color, b.tile);
    k.add(S.knee, rbox(0.098, 0.075, 0.24, 0.033, 3), b.color, b.tile, { p: [0, -0.437, -0.05] });
    k.add(S.knee, ellipsoid(0.048, 0.034, 0.06, 10, 6), b.color, b.tile, { p: [0, -0.445, -0.145] });
    k.add(S.knee, rbox(0.104, 0.026, 0.26, 0.01, 2), sole, Tile.Rubber, { p: [0, -0.477, -0.05] });
    k.add(S.knee, rbox(0.06, 0.05, 0.05, 0.01, 1), sole, Tile.Rubber, { p: [0, -0.465, 0.06] }); // block heel
    return;
  }
  const heavy = b.type === 'heavy';
  const w = heavy ? 1.15 : 1;
  k.add(S.knee, shell(D.shin, -0.24, -0.41, 0.01 * w, { steps: 3, segs: 12, sz: 1.08 }), b.color, b.tile);
  k.add(S.knee, ring(D.shin, -0.24, 0.012 * w, 0.008, 1, 1.08, 12), b.color, b.tile);
  k.add(S.knee, rbox(0.105 * w, 0.085, 0.245, 0.035, 3), b.color, b.tile, { p: [0, -0.442, -0.045] });
  k.add(S.knee, ellipsoid(0.053 * w, 0.04, 0.062, 10, 6), b.color, b.tile, { p: [0, -0.452, -0.14] });
  k.add(S.knee, rbox(0.114 * w, 0.03, 0.272, 0.012, 2), sole, Tile.Rubber, { p: [0, -0.475, -0.046] });
  // laces / straps
  for (let i = 0; i < 4; i++) {
    const yy = -0.29 - i * 0.03;
    k.add(S.knee, rbox(0.05, 0.007, 0.008, 0.003, 1), heavy ? 0x52525b : 0x2a2a2a, heavy ? Tile.Metal : Tile.Nylon, { p: [0, yy, -(profileAt(D.shin, yy) * 1.08 + 0.014 * w)] });
  }
  if (b.accent) k.add(S.knee, rbox(0.03, 0.012, 0.012, 0.004, 1), b.accent, Tile.Metal, { p: [S.s * 0.05, -0.3, -0.02] });
}

// ------------------------------------------------------------------ hair / headgear helpers

function headCenter(D: Dims) {
  return V(0, D.head.cy, D.head.cz);
}

/** Hair cap following the skull with a shaped hairline. */
function hairCap(c: Ctx, color: number, thMax: (az: number) => number, thick = 0.035, base = 1.012, ws = 28, hs = 10, kind: Kind = 'gear') {
  const { k, D } = c;
  const tmp = new THREE.Vector3();
  const cen = headCenter(D);
  const g = dome(ws, hs, 0, Math.PI * 2, () => 0, thMax, (d, t) => headShape(d, D, tmp).multiplyScalar(base + thick * (1 - t * t)).add(cen));
  k.add('neck', g, color, Tile.Hair, { kind, ao: 0.3 });
}

/** Point on the scalp (unit direction (az, th)) scaled by s, in neck space. */
function scalp(D: Dims, az: number, th: number, s = 1.04) {
  const d = V(Math.sin(az) * Math.sin(th), Math.cos(th), Math.cos(az) * Math.sin(th));
  return headShape(d, D).multiplyScalar(s).add(headCenter(D));
}

function ellipDome(c: Ctx, scale: number, thMin: (az: number) => number, thMax: (az: number) => number, color: number, tile: Tile, o: { ws?: number; hs?: number; azStart?: number; azLen?: number; kind?: Kind; sy?: number; dz?: number } = {}) {
  const { k, D } = c;
  const cen = headCenter(D);
  const sy = o.sy ?? 1;
  const g = dome(o.ws ?? 24, o.hs ?? 8, o.azStart ?? 0, o.azLen ?? Math.PI * 2, thMin, thMax, (d) =>
    V(d.x * D.head.rx * scale, d.y * D.head.ry * scale * sy, d.z * D.head.rz * scale + (o.dz ?? 0)).add(cen),
  );
  k.add('neck', g, color, tile, { kind: o.kind ?? 'gear' });
  return g;
}

function ears(c: Ctx) {
  const { k, D, st } = c;
  for (const s of [-1, 1]) {
    const p = headShape(V(s, 0.02, 0.12).normalize(), D).add(headCenter(D));
    k.add('neck', ellipsoid(0.011, 0.03, 0.02, 8, 6), st.skin, Tile.Skin, { p: [p.x + s * 0.004, p.y, p.z], r: [0, s * 0.35, 0] });
  }
}

const shortHairline = (az: number) => {
  const f = frontness(az);
  return 2.15 - 1.05 * Math.pow(f, 1.4) - 0.35 * gauss((f - 0.52) / 0.12);
};

// ------------------------------------------------------------------ operators

function buildSpecOps(c: Ctx) {
  const { k, D } = c;
  const black = 0x1b1e22;
  baseBody(c, {
    shirt: { color: 0x2f353d, tile: Tile.Knit },
    pants: { color: 0x343a42, tile: Tile.Cargo },
    sleeve: { color: 0x3a4048, tile: Tile.Nylon },
    fore: { color: 0x3a4048, tile: Tile.Nylon },
    glove: { color: 0x1c1c1c, tile: Tile.Leather, fingerless: true },
    boots: { type: 'combat', color: 0x16171a, tile: Tile.Leather, sole: 0x0b0b0c },
    belt: { color: 0x22262b, buckle: 0x6b7280, w: 0.05 },
  });
  plateCarrier(c, black, true);
  // knee pads
  for (const S of SIDES) {
    k.add(S.knee, rbox(0.105, 0.11, 0.05, 0.024, 2), 0x15171a, Tile.Plate, { p: [0, -0.02, -0.06], r: [0.12, 0, 0] });
    k.add(S.knee, ring(D.shin, -0.06, 0.004, 0.006, 1, 1.08, 10), 0x111111, Tile.Nylon);
    // thigh cargo pocket
    k.add(S.leg, rbox(0.05, 0.12, 0.1, 0.014, 1), 0x30363e, Tile.Cargo, { p: [S.s * 0.085, -0.2, 0] });
  }
  // pistol holster on the right hip
  k.add('body', rbox(0.05, 0.15, 0.11, 0.015, 1), black, Tile.Nylon, { p: [0.185, 0.88, 0.02] });
  k.add('body', rbox(0.03, 0.06, 0.04, 0.008, 1), 0x111111, Tile.Rubber, { p: [0.185, 0.97, 0.05], r: [-0.3, 0, 0] });
  // hair + helmet + headset
  hairCap(c, 0x2b2118, shortHairline, 0.012, 1.008, 24, 8);
  ears(c);
  const fastLine = (az: number) => {
    const f = frontness(az);
    return 1.95 - 1.0 * Math.pow(f, 1.2) - 0.42 * gauss((f - 0.5) / 0.16);
  };
  ellipDome(c, 1.17, () => 0, fastLine, 0x2a2e33, Tile.Plate, { ws: 28, hs: 9, sy: 1.02 });
  // helmet rim
  const rim: THREE.Vector3[] = [];
  const cen = headCenter(D);
  for (let i = 0; i < 28; i++) {
    const az = (Math.PI * 2 * i) / 28;
    const th = fastLine(az);
    rim.push(V(Math.sin(az) * Math.sin(th) * D.head.rx * 1.18, Math.cos(th) * D.head.ry * 1.19, Math.cos(az) * Math.sin(th) * D.head.rz * 1.18).add(cen));
  }
  k.add('neck', tube(rim, 0.006, 0.006, 4, 56, true), 0x1a1c1f, Tile.Rubber);
  for (const s of [-1, 1]) {
    // rails
    k.add('neck', rbox(0.014, 0.022, 0.1, 0.005, 1), 0x3a3f45, Tile.Metal, { p: [s * D.head.rx * 1.16, cen.y + 0.045, cen.z + 0.0], r: [0, 0, s * 0.15] });
    // ear cups + mic
    k.add('neck', lathe([[0.001, 0.0], [0.036, 0.0], [0.038, 0.018], [0.03, 0.032], [0.001, 0.034]], 12), 0x1a1a1a, Tile.Rubber, { p: [s * (D.head.rx * 0.95), cen.y - 0.005, cen.z + 0.01], r: [0, 0, -s * Math.PI / 2] });
  }
  const mic = [V(-D.head.rx - 0.02, cen.y - 0.02, cen.z), V(-D.head.rx + 0.0, cen.y - 0.06, cen.z - 0.06), V(-0.03, cen.y - 0.075, cen.z - D.head.rz - 0.01)];
  k.add('neck', tube(mic, 0.004, 0.0035, 4, 10), 0x111111, Tile.Rubber);
  k.add('neck', ellipsoid(0.01, 0.009, 0.012, 6, 4), 0x111111, Tile.Rubber, { p: [mic[2].x, mic[2].y, mic[2].z] });
  // NVG shroud + strobe
  k.add('neck', rbox(0.06, 0.04, 0.03, 0.01, 1), 0x2e3238, Tile.Metal, { p: [0, cen.y + 0.085, cen.z - D.head.rz * 1.12] });
  k.add('neck', rbox(0.02, 0.012, 0.02, 0.004, 1), 0x22d3ee, Tile.Flat, { p: [0, cen.y + D.head.ry * 1.16, cen.z + 0.04], kind: 'glow' });
  k.add('neck', rbox(0.06, 0.045, 0.01, 0.006, 1), 0x4b5563, Tile.Nylon, { p: [0, cen.y + 0.1, cen.z + D.head.rz * 0.95], r: [-0.7, 0, 0] }); // velcro patch
}

/** Matte plate carrier with mag pouches, cummerbund, radio, back panel. */
function plateCarrier(c: Ctx, color: number, withRadio: boolean) {
  const { k, D } = c;
  const T = D.torso;
  const fz = (y: number, x = 0) => surf(T, D.tsx, D.tsz, x, y, 0).z;
  k.add('torso', shell(T, 0.12, 0.28, 0.016, { steps: 3, segs: 18, sx: D.tsx, sz: D.tsz }), color, Tile.Nylon);
  k.add('torso', rbox(0.29, 0.3, 0.055, 0.022, 2), color, Tile.Nylon, { p: [0, 0.3, fz(0.3) - 0.012] });
  k.add('torso', rbox(0.28, 0.3, 0.05, 0.022, 2), color, Tile.Nylon, { p: [0, 0.3, -fz(0.3) + 0.012] });
  for (const s of [-1, 1]) {
    const pts = [V(s * 0.095, 0.44, fz(0.44, 0.095) + 0.005), V(s * 0.1, 0.5, -0.01), V(s * 0.095, 0.44, -fz(0.44, 0.095) - 0.005)];
    k.add('torso', tube(pts, 0.018, 0.018, 5, 8), color, Tile.Nylon, { s: [1, 1, 1] });
  }
  for (const x of [-0.085, 0, 0.085]) {
    k.add('torso', rbox(0.07, 0.11, 0.045, 0.012, 1), 0x24282d, Tile.Nylon, { p: [x, 0.2, fz(0.2) - 0.055] });
    k.add('torso', rbox(0.05, 0.03, 0.03, 0.006, 1), 0x3a3f45, Tile.Rubber, { p: [x, 0.265, fz(0.2) - 0.055] });
  }
  k.add('torso', rbox(0.16, 0.07, 0.03, 0.01, 1), 0x24282d, Tile.Nylon, { p: [0, 0.39, fz(0.39) - 0.05] });
  k.add('torso', rbox(0.035, 0.02, 0.004, 0.002, 1), 0x22d3ee, Tile.Flat, { p: [0.09, 0.42, fz(0.42, 0.09) - 0.032], kind: 'glow' });
  if (withRadio) {
    k.add('torso', rbox(0.06, 0.12, 0.05, 0.01, 1), 0x24282d, Tile.Nylon, { p: [-0.19, 0.24, 0.02] });
    k.add('torso', tube([V(-0.19, 0.3, 0.06), V(-0.2, 0.48, 0.09), V(-0.22, 0.62, 0.1)], 0.004, 0.003, 4, 8), 0x111111, Tile.Rubber);
  }
  // hydration / back panel
  k.add('torso', rbox(0.24, 0.3, 0.07, 0.03, 2), 0x23272c, Tile.Nylon, { p: [0, 0.27, -fz(0.27) + 0.06] });
}

function buildMercenary(c: Ctx) {
  const { k, D, st } = c;
  const leather = 0x5a3a24;
  baseBody(c, {
    shirt: { color: 0xd6d3d1, tile: Tile.Graphic },
    pants: { color: 0x3f4a3a, tile: Tile.Cargo },
    sleeve: { color: leather, tile: Tile.Leather },
    fore: { color: leather, tile: Tile.Leather },
    glove: { color: 0x2a1f18, tile: Tile.Leather },
    boots: { type: 'combat', color: 0x3a2a1e, tile: Tile.Leather, sole: 0x1a1410 },
    belt: { color: 0x2a1f18, buckle: 0xb0a48f },
  });
  const T = D.torso;
  const open = 0.42;
  // open leather jacket over the graphic tee
  k.add('torso', shell(T, -0.05, 0.47, 0.014, { steps: 8, segs: 20, sx: D.tsx, sz: D.tsz, phiStart: Math.PI + open, phiLength: Math.PI * 2 - open * 2, flare: -0.004 }), leather, Tile.Leather);
  k.add('torso', shell(T, 0.43, 0.53, 0.03, { steps: 2, segs: 16, sx: D.tsx, sz: D.tsz, phiStart: Math.PI + 0.5, phiLength: Math.PI * 2 - 1.0, flare: 0.018 }), 0x4a2f1c, Tile.Leather);
  for (const s of [-1, 1]) {
    const phi = Math.PI + s * open;
    k.add('torso', stripe(T, phi, -0.05, 0.45, 0.018, 0.009, D.tsx, D.tsz, 6), 0x3e2716, Tile.Leather);
    k.add('torso', stripe(T, phi, -0.04, 0.44, 0.024, 0.0035, D.tsx, D.tsz, 6), 0x9ca3af, Tile.Metal);
  }
  // diagonal chest strap (sling) with a buckle
  const strap: THREE.Vector3[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const x = 0.15 - 0.3 * t;
    const y = 0.45 - 0.4 * t;
    strap.push(surf(T, D.tsx, D.tsz, x, y, 0.024));
  }
  k.add('torso', tube(strap, 0.011, 0.011, 5, 14), 0x2a1f18, Tile.Nylon, { s: [1, 1, 1] });
  const mid = strap[3];
  k.add('torso', rbox(0.04, 0.03, 0.012, 0.004, 1), 0x9ca3af, Tile.Metal, { p: [mid.x, mid.y, mid.z - 0.008] });
  // sleeve cuffs
  for (const S of SIDES) k.add(S.elbow, ring(D.fore, -0.24, 0.006, 0.008, 1, 0.92, 12), 0x3e2716, Tile.Leather);
  // cargo pockets + thigh holster (right)
  for (const S of SIDES) {
    k.add(S.leg, rbox(0.05, 0.12, 0.1, 0.014, 1), 0x37412f, Tile.Cargo, { p: [S.s * 0.086, -0.22, 0] });
  }
  k.add('legR', rbox(0.035, 0.17, 0.11, 0.012, 1), 0x161616, Tile.Nylon, { p: [0.098, -0.12, 0.0] });
  k.add('legR', rbox(0.03, 0.07, 0.04, 0.008, 1), 0x0f0f10, Tile.Rubber, { p: [0.1, -0.01, 0.03], r: [-0.35, 0, 0] });
  k.add('legR', ring(D.thigh, -0.08, 0.004, 0.006, 1, 1.05, 12), 0x161616, Tile.Nylon);
  k.add('legR', ring(D.thigh, -0.22, 0.004, 0.006, 1, 1.05, 12), 0x161616, Tile.Nylon);
  // head: short hair, cap, ears
  hairCap(c, st.hair, shortHairline, 0.018, 1.01, 24, 8);
  ears(c);
  const cen = headCenter(D);
  const capLine = (az: number) => 1.32 + 0.22 * (1 - frontness(az));
  ellipDome(c, 1.13, () => 0, capLine, 0x1f2937, Tile.Denim, { ws: 24, hs: 7, sy: 1.0 });
  k.add('neck', ring([[0.0, 0], [0.0, 1]], 0, 0, 0.004), 0x1f2937, Tile.Flat, { p: [0, -10, 0], s: [0, 0, 0] }); // (no-op placeholder keeps arrays aligned)
  // brim: curved half-disc
  const brimShape = new THREE.Shape();
  brimShape.absellipse(0, 0, 0.095, 0.085, Math.PI, Math.PI * 2, false, 0);
  const brim = new THREE.ExtrudeGeometry(brimShape, { depth: 0.008, bevelEnabled: false, curveSegments: 12 });
  brim.rotateX(Math.PI / 2);
  const bp = brim.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i);
    const z = bp.getZ(i);
    bp.setY(i, bp.getY(i) - 0.9 * x * x - 0.25 * z * z);
  }
  brim.computeVertexNormals();
  k.add('neck', brim, 0x1a2230, Tile.Denim, { p: [0, cen.y + D.head.ry * 0.3, cen.z - D.head.rz * 1.0], r: [0.12, 0, 0] });
  k.add('neck', rbox(0.045, 0.028, 0.006, 0.003, 1), st.accent, Tile.Flat, { p: [0, cen.y + D.head.ry * 0.62, cen.z - D.head.rz * 0.98], r: [-0.45, 0, 0] });
}

function buildDesertSniper(c: Ctx) {
  const { k, D, st } = c;
  const camo = 0xc2a878;
  baseBody(c, {
    shirt: { color: camo, tile: Tile.Camo },
    pants: { color: 0xb39a6b, tile: Tile.Camo },
    sleeve: { color: camo, tile: Tile.Camo },
    fore: { color: camo, tile: Tile.Camo },
    glove: { color: 0x7a6847, tile: Tile.Nylon },
    boots: { type: 'combat', color: 0x8b6f47, tile: Tile.Leather, sole: 0x3b2f22 },
    belt: { color: 0x6f5f3f, buckle: 0x8a8170 },
  });
  const T = D.torso;
  const fz = (y: number, x = 0) => surf(T, D.tsx, D.tsz, x, y, 0).z;
  // light chest rig
  k.add('torso', rbox(0.26, 0.13, 0.04, 0.015, 2), 0x8a7650, Tile.Nylon, { p: [0, 0.22, fz(0.22) - 0.012] });
  for (const x of [-0.08, 0, 0.08]) k.add('torso', rbox(0.065, 0.09, 0.04, 0.01, 1), 0x7d6a46, Tile.Nylon, { p: [x, 0.21, fz(0.21) - 0.045] });
  for (const s of [-1, 1]) k.add('torso', stripe(T, Math.PI + s * 0.55, 0.26, 0.47, 0.012, 0.009, D.tsx, D.tsz, 5), 0x6f5f3f, Tile.Nylon);
  // rangefinder on the chest (lanyard)
  const rp = surf(T, D.tsx, D.tsz, -0.075, 0.36, 0.04);
  k.add('torso', rbox(0.09, 0.05, 0.06, 0.014, 2), 0x3a3a35, Tile.Rubber, { p: [rp.x, rp.y, rp.z], r: [0, 0.2, 0] });
  for (const s of [-1, 1]) k.add('torso', lathe([[0.001, 0], [0.016, 0], [0.017, 0.02], [0.012, 0.024], [0.001, 0.024]], 10), 0x1f1f1c, Tile.Metal, { p: [rp.x + s * 0.022, rp.y + 0.008, rp.z - 0.028], r: [Math.PI / 2, 0, 0] });
  k.add('torso', rbox(0.012, 0.008, 0.004, 0.002, 1), st.accent, Tile.Flat, { p: [rp.x + 0.03, rp.y + 0.02, rp.z - 0.031], kind: 'glow' });
  // shemagh around the neck + front drape
  k.add('torso', shell(D.neck, 0.44, 0.56, 0.022, { steps: 3, segs: 14, flare: -0.006 }), 0xd6c7a1, Tile.Knit, { ao: 0.35 });
  k.add('torso', ellipsoid(0.08, 0.06, 0.03, 10, 6), 0xcbb98f, Tile.Knit, { p: [0, 0.43, fz(0.43) - 0.012], r: [0.3, 0, 0] });
  // ghillie mantle: shaggy cape over shoulders + hanging strips
  k.add('torso', shell(T, 0.33, 0.5, 0.03, { steps: 3, segs: 18, sx: D.tsx, sz: D.tsz, phiStart: -2.1, phiLength: 4.2, flare: -0.01 }), 0x7b7448, Tile.Ghillie, { ao: 0.4 });
  const cols = [0x6b6b3a, 0x8a7f52, 0x5d5a36, 0x9a8c5c];
  for (let i = 0; i < 18; i++) {
    const phi = -2.0 + (4.0 * i) / 17;
    const y0 = 0.48 - 0.04 * Math.abs(Math.sin(i * 1.7));
    const len = 0.18 + 0.1 * Math.abs(Math.sin(i * 2.3));
    const r0 = profileAt(T, y0) + 0.04;
    const r1 = profileAt(T, y0 - len) + 0.05;
    const p0 = V(Math.sin(phi) * r0 * D.tsx, y0, Math.cos(phi) * r0 * D.tsz);
    const p2 = V(Math.sin(phi + 0.05 * Math.sin(i)) * r1 * D.tsx, y0 - len, Math.cos(phi) * r1 * D.tsz);
    const p1 = p0.clone().lerp(p2, 0.5).multiply(V(1.04, 1, 1.04));
    k.add('torso', tube([p0, p1, p2], 0.014, 0.004, 4, 5), cols[i % cols.length], Tile.Ghillie, { ao: 0.3 });
  }
  for (const S of SIDES) {
    k.add(S.leg, rbox(0.05, 0.12, 0.1, 0.014, 1), 0xa38d60, Tile.Camo, { p: [S.s * 0.086, -0.22, 0] });
    k.add(S.knee, rbox(0.1, 0.1, 0.045, 0.022, 2), 0x8a7650, Tile.Nylon, { p: [0, -0.02, -0.058], r: [0.12, 0, 0] });
    for (let i = 0; i < 2; i++) k.add(S.arm, tube([V(S.s * 0.05, -0.0, 0.02 * (i ? 1 : -1)), V(S.s * 0.075, -0.08, 0.03 * (i ? 1 : -1)), V(S.s * 0.07, -0.16, 0.025 * (i ? 1 : -1))], 0.012, 0.004, 4, 5), cols[i + 1], Tile.Ghillie);
  }
  // rolled ghillie bag on the back
  k.add('torso', lathe([[0.001, -0.13], [0.05, -0.12], [0.055, 0], [0.05, 0.12], [0.001, 0.13]], 12), 0x6b6b3a, Tile.Ghillie, { p: [0, 0.4, -fz(0.4) + 0.06], r: [0, 0, Math.PI / 2] });
  // head: short hair under a boonie
  hairCap(c, st.hair, shortHairline, 0.015, 1.01, 24, 8);
  ears(c);
  const cen = headCenter(D);
  const crown: [number, number][] = [[0.001, 0.13], [0.06, 0.128], [0.086, 0.108], [0.094, 0.06], [0.096, 0.02]];
  k.add('neck', lathe(crown, 18, 1, 1.18), 0xa38b62, Tile.Camo, { p: [0, cen.y - 0.005, cen.z] });
  k.add('neck', lathe([[0.096, 0.02], [0.098, 0.04]], 18, 1, 1.18), 0x6f5f3f, Tile.Nylon, { p: [0, cen.y - 0.005, cen.z] });
  const brimTop: [number, number][] = [[0.095, 0.02], [0.14, 0.008], [0.18, -0.012], [0.195, -0.026]];
  k.add('neck', lathe(brimTop, 22, 1, 1.12), 0xa38b62, Tile.Camo, { p: [0, cen.y - 0.005, cen.z] });
  k.add('neck', lathe(brimTop.slice().reverse().map(([r, y]) => [r, y - 0.004] as [number, number]), 22, 1, 1.12), 0x8a7550, Tile.Camo, { p: [0, cen.y - 0.005, cen.z] });
}

function buildHeavy(c: Ctx) {
  const { k, D, st } = c;
  const plate = 0x4b5058;
  const dark = 0x2b2d31;
  const red = st.accent;
  baseBody(c, {
    shirt: { color: dark, tile: Tile.Nylon },
    pants: { color: 0x27272a, tile: Tile.Nylon },
    sleeve: { color: dark, tile: Tile.Nylon },
    fore: { color: dark, tile: Tile.Nylon },
    glove: { color: 0x27272a, tile: Tile.Rubber },
    boots: { type: 'heavy', color: 0x1c1d20, tile: Tile.Plate, sole: 0x0b0b0c, accent: 0x6b7280 },
    belt: { color: 0x18181b, buckle: 0x71717a, w: 0.06 },
  });
  const T = D.torso;
  const fz = (y: number, x = 0) => surf(T, D.tsx, D.tsz, x, y, 0).z;
  // chest plates (two pec plates) + carbon centre + segmented abdomen
  for (const s of [-1, 1]) k.add('torso', rbox(0.17, 0.17, 0.05, 0.022, 2), plate, Tile.Plate, { p: [s * 0.085, 0.35, fz(0.35, s * 0.085) - 0.01], r: [0.05, s * 0.28, 0] });
  k.add('torso', rbox(0.08, 0.14, 0.03, 0.01, 1), 0x9ca3af, Tile.Carbon, { p: [0, 0.34, fz(0.34) - 0.035] });
  k.add('torso', rbox(0.05, 0.012, 0.006, 0.003, 1), red, Tile.Flat, { p: [0, 0.4, fz(0.4) - 0.052], kind: 'glow' });
  for (let i = 0; i < 3; i++) k.add('torso', rbox(0.22 - i * 0.01, 0.065, 0.045, 0.016, 2), plate, Tile.Plate, { p: [0, 0.23 - i * 0.068, fz(0.23 - i * 0.068) - 0.01], r: [0.08, 0, 0] });
  // gorget
  k.add('torso', shell(T, 0.44, 0.52, 0.035, { steps: 2, segs: 18, sx: D.tsx, sz: D.tsz, flare: 0.012 }), plate, Tile.Plate);
  // back plate + exo spine + power core
  k.add('torso', rbox(0.3, 0.34, 0.05, 0.025, 2), plate, Tile.Plate, { p: [0, 0.28, -fz(0.28) + 0.012] });
  k.add('torso', tube([V(0, -0.02, -fz(0.0) + 0.04), V(0, 0.2, -fz(0.2) + 0.05), V(0, 0.48, -fz(0.48) + 0.04)], 0.02, 0.018, 6, 10), 0x6b7280, Tile.Metal);
  for (let i = 0; i < 4; i++) k.add('torso', rbox(0.07, 0.03, 0.035, 0.008, 1), 0x3f3f46, Tile.Metal, { p: [0, 0.04 + i * 0.1, -fz(0.04 + i * 0.1) + 0.06] });
  k.add('torso', lathe([[0.001, 0], [0.035, 0], [0.035, 0.03], [0.001, 0.03]], 12), red, Tile.Flat, { p: [0, 0.3, -fz(0.3) + 0.04], r: [Math.PI / 2, 0, 0], kind: 'glow' });
  // segmented pauldrons (on the torso so they ride over the IK-driven arms)
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const g = new THREE.SphereGeometry(0.105 - i * 0.008, 12, 6, 0, Math.PI * 2, 0, 1.15);
      g.scale(1, 0.75, 1.05);
      k.add('torso', g, i === 0 ? plate : 0x3f444b, Tile.Plate, { p: [s * (D.sh + 0.02 + i * 0.012), 0.47 - i * 0.05, 0], r: [0, 0, -s * (0.45 + i * 0.12)] });
    }
    k.add('torso', rbox(0.03, 0.008, 0.004, 0.002, 1), red, Tile.Flat, { p: [s * (D.sh + 0.06), 0.47, -0.08], kind: 'glow' });
  }
  for (const S of SIDES) {
    // arm plates + vambraces + pistons
    k.add(S.arm, shell(D.upper, -0.08, -0.26, 0.012, { steps: 3, segs: 12 }), 0x3f444b, Tile.Plate);
    k.add(S.elbow, ellipsoid(0.05, 0.04, 0.05, 10, 6), 0x52525b, Tile.Metal, { p: [0, 0.0, 0.012] });
    k.add(S.elbow, shell(D.fore, -0.04, -0.24, 0.012, { steps: 3, segs: 12, sz: 0.92 }), plate, Tile.Plate);
    k.add(S.elbow, ring(D.fore, -0.14, 0.015, 0.004, 1, 0.92, 12), red, Tile.Flat, { kind: 'glow' });
    k.add(S.elbow, rbox(0.05, 0.015, 0.06, 0.006, 1), 0x52525b, Tile.Metal, { p: [0, -SKEL.grip + 0.012, -0.045] }); // knuckle plate
    k.add(S.arm, tube([V(S.s * 0.06, -0.02, 0), V(S.s * 0.065, -0.15, 0), V(S.s * 0.055, -0.29, 0)], 0.01, 0.008, 5, 6), 0x71717a, Tile.Metal);
    // thigh plates + knee cops + shin guards + exo struts
    k.add(S.leg, shell(D.thigh, -0.03, -0.32, 0.014, { steps: 4, segs: 10, sz: 1.05, phiStart: Math.PI - 1.1, phiLength: 2.2 }), plate, Tile.Plate);
    k.add(S.leg, tube([V(S.s * 0.1, 0.04, 0), V(S.s * 0.1, -0.2, 0), V(S.s * 0.075, -0.43, 0)], 0.012, 0.01, 5, 8), 0x71717a, Tile.Metal);
    k.add(S.knee, rbox(0.11, 0.11, 0.06, 0.026, 2), 0x3f444b, Tile.Plate, { p: [0, -0.02, -0.06], r: [0.12, 0, 0] });
    k.add(S.knee, shell(D.shin, -0.06, -0.26, 0.014, { steps: 3, segs: 10, sz: 1.08, phiStart: Math.PI - 1.0, phiLength: 2.0 }), plate, Tile.Plate);
    k.add(S.knee, rbox(0.004, 0.08, 0.004, 0.002, 1), red, Tile.Flat, { p: [0, -0.15, -(profileAt(D.shin, -0.15) * 1.08 + 0.016)], kind: 'glow' });
  }
  // helmet: full armoured shell, visor, jaw guard, crest, ear modules
  ears(c);
  const cen = headCenter(D);
  ellipDome(c, 1.26, () => 0, (az) => 2.55 - 0.15 * frontness(az), 0x3f4349, Tile.Plate, { ws: 26, hs: 10, sy: 1.02 });
  ellipDome(c, 1.29, () => 1.28, () => 1.78, 0x220707, Tile.Flat, { ws: 14, hs: 4, azStart: Math.PI - 0.95, azLen: 1.9, kind: 'visor' });
  ellipDome(c, 1.3, () => 1.47, () => 1.53, red, Tile.Flat, { ws: 14, hs: 1, azStart: Math.PI - 0.8, azLen: 1.6, kind: 'glow' });
  k.add('neck', rbox(0.13, 0.05, 0.06, 0.02, 2), plate, Tile.Plate, { p: [0, cen.y - D.head.ry * 0.8, cen.z - D.head.rz * 0.95], r: [-0.2, 0, 0] });
  k.add('neck', rbox(0.025, 0.04, 0.16, 0.01, 1), 0x52525b, Tile.Metal, { p: [0, cen.y + D.head.ry * 1.25, cen.z + 0.01] });
  for (const s of [-1, 1]) {
    k.add('neck', lathe([[0.001, 0], [0.034, 0], [0.034, 0.025], [0.022, 0.035], [0.001, 0.035]], 12), 0x27272a, Tile.Metal, { p: [s * D.head.rx * 1.18, cen.y - 0.01, cen.z + 0.01], r: [0, 0, -s * Math.PI / 2] });
    k.add('neck', ring([[0.028, 0], [0.028, 1]], 0, 0, 0.003, 1, 1, 12), red, Tile.Flat, { p: [s * (D.head.rx * 1.18 + 0.036), cen.y - 0.01, cen.z + 0.01], r: [0, 0, Math.PI / 2], kind: 'glow' });
  }
}

function buildBodysuitAgent(c: Ctx) {
  const { k, D, st } = c;
  const suit = 0x1a2030;
  const cyan = st.accent;
  const gold = 0xfbbf24;
  baseBody(c, {
    shirt: { color: suit, tile: Tile.Suit },
    pants: { color: suit, tile: Tile.Suit },
    sleeve: { color: suit, tile: Tile.Suit },
    fore: { color: suit, tile: Tile.Suit },
    glove: { color: 0x111318, tile: Tile.Leather },
    boots: { type: 'thigh', color: 0x0f1115, tile: Tile.Leather, sole: 0x050506 },
    belt: { color: 0x0f172a, buckle: 0xd4a62a, w: 0.03 },
  });
  const T = D.torso;
  const fz = (y: number, x = 0) => surf(T, D.tsx, D.tsz, x, y, 0).z;
  // glowing seam piping
  for (const s of [-1, 1]) {
    k.add('torso', stripe(T, s * Math.PI / 2, -0.04, 0.44, 0.003, 0.0035, D.tsx, D.tsz, 8), cyan, Tile.Flat, { kind: 'glow' });
    k.add('torso', stripe(T, Math.PI + s * 0.55, 0.0, 0.42, 0.003, 0.0025, D.tsx, D.tsz, 8), gold, Tile.Flat, { kind: 'glow' });
  }
  k.add('torso', ring(T, 0.255, 0.004, 0.003, D.tsx, D.tsz, 12, Math.PI - 1.0, 2.0), cyan, Tile.Flat, { kind: 'glow' });
  k.add('torso', ring(D.neck, 0.47, 0.005, 0.0035, 1, 1.05, 14), gold, Tile.Flat, { kind: 'glow' });
  k.add('body', ring(D.pelvis, 1.022, 0.01, 0.0025, D.psx, D.psz, 16), cyan, Tile.Flat, { kind: 'glow' });
  // slim chest harness
  k.add('torso', rbox(0.12, 0.06, 0.022, 0.01, 1), 0x0f1115, Tile.Leather, { p: [0, 0.34, fz(0.34) - 0.01] });
  for (const s of [-1, 1]) k.add('torso', tube([surf(T, D.tsx, D.tsz, s * 0.05, 0.34, 0.012), surf(T, D.tsx, D.tsz, s * 0.08, 0.44, 0.01), V(s * 0.085, 0.49, 0.0), surf(T, D.tsx, D.tsz, s * 0.07, 0.38, 0.01, true)], 0.006, 0.006, 4, 10), 0x0f1115, Tile.Leather);
  for (const S of SIDES) {
    k.add(S.leg, stripe(D.thigh, S.s * Math.PI / 2, 0.0, -0.2, 0.003, 0.003, 1, 1.05, 5), cyan, Tile.Flat, { kind: 'glow' });
    k.add(S.leg, ring(D.thigh, -0.2, 0.012, 0.004, 1, 1.05, 14), gold, Tile.Flat, { kind: 'glow' });
    k.add(S.arm, stripe(D.upper, S.s * Math.PI / 2, 0.0, -0.3, 0.003, 0.003, 1, 1, 5), cyan, Tile.Flat, { kind: 'glow' });
    k.add(S.elbow, stripe(D.fore, S.s * Math.PI / 2, 0.0, -0.25, 0.003, 0.0025, 1, 0.92, 5), cyan, Tile.Flat, { kind: 'glow' });
    // dual hip holsters with pistols (upper thigh)
    k.add(S.leg, rbox(0.035, 0.15, 0.1, 0.012, 1), 0x111318, Tile.Leather, { p: [S.s * 0.095, -0.1, 0.005] });
    k.add(S.leg, rbox(0.028, 0.065, 0.038, 0.008, 1), 0x0a0a0c, Tile.Rubber, { p: [S.s * 0.097, 0.0, 0.03], r: [-0.35, 0, 0] });
    k.add(S.leg, ring(D.thigh, -0.12, 0.004, 0.005, 1, 1.05, 12), 0x111318, Tile.Leather);
    k.add(S.leg, rbox(0.004, 0.03, 0.004, 0.002, 1), gold, Tile.Flat, { p: [S.s * 0.114, -0.1, -0.03], kind: 'glow' });
  }
  // sleek hair + high ponytail
  const line = (az: number) => {
    const f = frontness(az);
    return 2.3 - 1.12 * Math.pow(f, 1.3) - 0.3 * gauss((f - 0.52) / 0.12);
  };
  hairCap(c, st.hair, line, 0.022, 1.012, 28, 10);
  ears(c);
  const tie = scalp(D, 0, 0.55, 1.06);
  k.add('neck', ring([[0.022, 0], [0.022, 1]], 0, 0, 0.006, 1, 1, 10), gold, Tile.Metal, { p: [tie.x, tie.y, tie.z + 0.005], r: [-1.0, 0, 0] });
  const pony = [V(0, tie.y, tie.z + 0.01), V(0, tie.y - 0.02, tie.z + 0.06), V(0, tie.y - 0.11, tie.z + 0.085), V(0.01, tie.y - 0.22, tie.z + 0.07), V(0.015, tie.y - 0.31, tie.z + 0.05)];
  k.add('neck', tube(pony, 0.03, 0.006, 8, 14), st.hair, Tile.Hair, { kind: 'loose', ao: 0.25 });
}

function buildUrbanScout(c: Ctx) {
  const { k, D, st } = c;
  const yellow = 0xfacc15;
  const black = 0x111111;
  baseBody(c, {
    shirt: { color: 0x1c1c1f, tile: Tile.Knit },
    pants: { color: 0x2f3437, tile: Tile.Cargo },
    sleeve: { color: yellow, tile: Tile.Nylon },
    fore: { color: yellow, tile: Tile.Nylon },
    glove: { color: 0x18181b, tile: Tile.Leather, fingerless: true },
    boots: { type: 'sneaker', color: 0xf1f5f9, tile: Tile.Knit, sole: 0xe5e7eb, accent: yellow },
  });
  const T = D.torso;
  // cropped athletic jacket (ends at the ribs; fitted black top underneath)
  const open = 0.3;
  k.add('torso', shell(T, 0.22, 0.47, 0.016, { steps: 5, segs: 20, sx: D.tsx, sz: D.tsz, phiStart: Math.PI + open, phiLength: Math.PI * 2 - open * 2 }), yellow, Tile.Nylon);
  k.add('torso', shell(T, 0.2, 0.25, 0.02, { steps: 1, segs: 20, sx: D.tsx, sz: D.tsz, phiStart: Math.PI + open, phiLength: Math.PI * 2 - open * 2 }), black, Tile.Knit);
  for (const s of [-1, 1]) {
    k.add('torso', shell(T, 0.27, 0.44, 0.02, { steps: 3, segs: 6, sx: D.tsx, sz: D.tsz, phiStart: s * Math.PI / 2 - 0.3, phiLength: 0.6 }), black, Tile.Nylon);
    k.add('torso', stripe(T, Math.PI + s * open, 0.2, 0.46, 0.02, 0.006, D.tsx, D.tsz, 5), black, Tile.Rubber);
  }
  k.add('torso', shell(T, 0.44, 0.53, 0.028, { steps: 2, segs: 16, sx: D.tsx, sz: D.tsz, phiStart: Math.PI + 0.45, phiLength: Math.PI * 2 - 0.9, flare: 0.01 }), yellow, Tile.Nylon);
  for (const S of SIDES) {
    k.add(S.arm, ring(D.upper, -0.2, 0.004, 0.012, 1, 1, 12), black, Tile.Nylon);
    k.add(S.elbow, ring(D.fore, -0.25, 0.004, 0.011, 1, 0.92, 12), black, Tile.Knit);
    k.add(S.leg, rbox(0.045, 0.11, 0.09, 0.012, 1), 0x2a2e31, Tile.Cargo, { p: [S.s * 0.084, -0.2, 0] });
  }
  // tactical belt + pouches
  k.add('body', shell(D.pelvis, 0.975, 1.03, 0.01, { steps: 1, segs: 18, sx: D.psx, sz: D.psz }), 0x2b2b2b, Tile.Nylon);
  const pz = (x: number) => surf(D.pelvis, D.psx, D.psz, x, 1.0, 0.02).z;
  k.add('body', rbox(0.055, 0.04, 0.012, 0.005, 1), 0x9ca3af, Tile.Metal, { p: [0, 1.0, pz(0) - 0.004] });
  for (const x of [-0.12, 0.12]) k.add('body', rbox(0.05, 0.065, 0.035, 0.01, 1), 0x262626, Tile.Nylon, { p: [x, 0.985, pz(x) - 0.01], r: [0, -Math.sign(x) * 0.6, 0] });
  k.add('body', rbox(0.1, 0.07, 0.04, 0.012, 1), 0x262626, Tile.Nylon, { p: [0, 0.985, -pz(0) + 0.012] });
  // layered hair + headband
  const line = (az: number) => {
    const f = frontness(az);
    return 2.25 - 1.15 * Math.pow(f, 1.3) - 0.2 * gauss((f - 0.5) / 0.12);
  };
  hairCap(c, st.hair, line, 0.03, 1.012, 28, 10);
  ears(c);
  const cen = headCenter(D);
  // layered side / back strands (end at chin level → stay in the head zone)
  for (let i = 0; i < 12; i++) {
    const az = 0.55 + (i / 11) * (Math.PI * 2 - 1.1);
    const f = frontness(az);
    const start = scalp(D, az, 0.85, 1.06);
    const endTh = 1.95 + 0.25 * (1 - f);
    const end = scalp(D, az + 0.05, endTh, 1.12 + 0.06 * (1 - f));
    if (end.y < cen.y - D.head.ry * 0.85) end.y = cen.y - D.head.ry * 0.85;
    const mid = scalp(D, az, (0.85 + endTh) / 2, 1.13);
    k.add('neck', tube([start, mid, end], 0.022, 0.006, 6, 6), st.hair, Tile.Hair, { ao: 0.25 });
  }
  // fringe (stops above the brows)
  for (let i = 0; i < 4; i++) {
    const az = Math.PI - 0.45 + i * 0.3;
    k.add('neck', tube([scalp(D, Math.PI + (az - Math.PI) * 0.4, 0.25, 1.08), scalp(D, az, 0.8, 1.1), scalp(D, az + 0.12, 1.08, 1.08)], 0.018, 0.005, 5, 6), st.hair, Tile.Hair, { ao: 0.2 });
  }
  // headband
  const hb = (az: number) => 0.98 + 0.12 * (1 - frontness(az));
  const tmp = new THREE.Vector3();
  const band = dome(28, 1, 0, Math.PI * 2, (az) => hb(az), (az) => hb(az) + 0.17, (d) => headShape(d, D, tmp).multiplyScalar(1.075).add(cen));
  k.add('neck', band, yellow, Tile.Knit);
}

function buildCrimson(c: Ctx) {
  const { k, D, st } = c;
  const crimson = 0xb91c1c;
  const metal = 0xd1d5db;
  baseBody(c, {
    shirt: { color: 0x18181b, tile: Tile.Knit },
    pants: { color: 0x1c1917, tile: Tile.Suit },
    sleeve: { color: crimson, tile: Tile.Leather },
    fore: { color: crimson, tile: Tile.Leather },
    glove: { color: 0x1f1414, tile: Tile.Leather },
    boots: { type: 'combat', color: 0x1c1917, tile: Tile.Leather, sole: 0x0a0a0a, accent: metal },
  });
  const T = D.torso;
  // closed moto jacket + asymmetric front flap + diagonal zip
  k.add('torso', shell(T, -0.04, 0.47, 0.014, { steps: 8, segs: 20, sx: D.tsx, sz: D.tsz }), crimson, Tile.Leather);
  k.add('torso', shell(T, 0.02, 0.45, 0.02, { steps: 6, segs: 8, sx: D.tsx, sz: D.tsz, phiStart: Math.PI - 0.15, phiLength: 0.75 }), 0xa51717, Tile.Leather);
  const zip: THREE.Vector3[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    zip.push(surf(T, D.tsx, D.tsz, -0.02 + 0.12 * t * t, -0.02 + 0.46 * t, 0.024));
  }
  k.add('torso', tube(zip, 0.0045, 0.0045, 4, 12), metal, Tile.Metal);
  k.add('torso', rbox(0.012, 0.022, 0.006, 0.003, 1), metal, Tile.Metal, { p: [zip[4].x, zip[4].y, zip[4].z - 0.006] });
  for (const s of [-1, 1]) {
    // chest pocket zips
    const a = surf(T, D.tsx, D.tsz, s * 0.1, 0.34, 0.022);
    const b = surf(T, D.tsx, D.tsz, s * 0.04, 0.38, 0.022);
    k.add('torso', tube([a, a.clone().lerp(b, 0.5), b], 0.003, 0.003, 4, 4), metal, Tile.Metal);
    // epaulettes
    k.add('torso', rbox(0.04, 0.012, 0.1, 0.005, 1), 0x991b1b, Tile.Leather, { p: [s * (D.sh - 0.03), 0.475, 0], r: [0, 0, -s * 0.35] });
  }
  k.add('torso', shell(T, 0.42, 0.52, 0.03, { steps: 2, segs: 18, sx: D.tsx, sz: D.tsz, phiStart: Math.PI + 0.4, phiLength: Math.PI * 2 - 0.8, flare: 0.03 }), 0x991b1b, Tile.Leather);
  for (const s of [-1, 1]) k.add('torso', ellipsoid(0.007, 0.007, 0.004, 6, 4), metal, Tile.Metal, { p: [surf(T, D.tsx, D.tsz, s * 0.1, 0.44, 0.04).x, 0.44, surf(T, D.tsx, D.tsz, s * 0.1, 0.44, 0.04).z] });
  k.add('torso', shell(T, -0.04, 0.0, 0.02, { steps: 1, segs: 20, sx: D.tsx, sz: D.tsz }), 0x7f1d1d, Tile.Leather); // hem belt
  k.add('torso', rbox(0.04, 0.035, 0.01, 0.004, 1), metal, Tile.Metal, { p: [0.06, -0.02, surf(T, D.tsx, D.tsz, 0.06, -0.02, 0.026).z] });
  for (const S of SIDES) {
    k.add(S.elbow, stripe(D.fore, S.s * Math.PI / 2, -0.12, -0.25, 0.004, 0.003, 1, 0.92, 4), metal, Tile.Metal);
    k.add(S.knee, ring(D.shin, -0.3, 0.016, 0.005, 1, 1.08, 12), metal, Tile.Metal);
  }
  // long flowing hair: cap (head zone) + strands down the back and over the shoulders (not hit-tested)
  const line = (az: number) => {
    const f = frontness(az);
    return 2.3 - 1.1 * Math.pow(f, 1.3) - 0.15 * gauss((f - 0.5) / 0.12);
  };
  hairCap(c, st.hair, line, 0.028, 1.012, 28, 10);
  ears(c);
  const cen = headCenter(D);
  for (let i = 0; i < 9; i++) {
    const az = -1.5 + (3.0 * i) / 8;
    const start = scalp(D, az, 1.15, 1.04);
    const p1 = scalp(D, az, 2.0, 1.22);
    const back = 0.11 + 0.04 * Math.cos(az);
    const p2 = V(Math.sin(az) * 0.1, cen.y - 0.2, back + 0.02);
    const p3 = V(Math.sin(az) * 0.11 + 0.01 * Math.sin(i * 2.1), cen.y - 0.36 - 0.03 * Math.cos(i * 1.3), back + 0.0);
    k.add('neck', tube([start, p1, p2, p3], 0.032, 0.012, 6, 10), st.hair, Tile.Hair, { kind: 'loose', ao: 0.25 });
  }
  for (const s of [-1, 1]) {
    const az = Math.PI - s * 1.25;
    const start = scalp(D, az, 0.95, 1.05);
    const p1 = scalp(D, az, 1.7, 1.18);
    const p2 = V(s * 0.1, cen.y - 0.15, -0.01);
    const p3 = V(s * 0.11, cen.y - 0.27, -0.045);
    k.add('neck', tube([start, p1, p2, p3], 0.026, 0.008, 6, 10), st.hair, Tile.Hair, { kind: 'loose', ao: 0.2 });
  }
}

function buildValkyrie(c: Ctx) {
  const { k, D, st } = c;
  const suit = 0x312e81;
  const pink = st.accent;
  const cyan = 0x22d3ee;
  const armor = 0x4338ca;
  baseBody(c, {
    shirt: { color: suit, tile: Tile.Suit },
    pants: { color: 0x1e1b4b, tile: Tile.Suit },
    sleeve: { color: suit, tile: Tile.Suit },
    fore: { color: suit, tile: Tile.Suit },
    glove: { color: 0x1e1b4b, tile: Tile.Suit },
    boots: { type: 'combat', color: 0x111827, tile: Tile.Plate, sole: 0x05060a },
    belt: { color: 0x0f172a, buckle: 0xa5b4fc, w: 0.035 },
  });
  const T = D.torso;
  const fz = (y: number, x = 0) => surf(T, D.tsx, D.tsz, x, y, 0).z;
  // neon trims
  for (const s of [-1, 1]) {
    k.add('torso', stripe(T, s * Math.PI / 2, -0.04, 0.44, 0.003, 0.0035, D.tsx, D.tsz, 8), pink, Tile.Flat, { kind: 'glow' });
    const a = surf(T, D.tsx, D.tsz, s * 0.12, 0.42, 0.004);
    const b = surf(T, D.tsx, D.tsz, 0, 0.2, 0.004);
    k.add('torso', tube([a, a.clone().lerp(b, 0.5).add(V(0, 0, -0.008)), b], 0.003, 0.003, 4, 6), cyan, Tile.Flat, { kind: 'glow' });
  }
  k.add('body', ring(D.pelvis, 1.022, 0.01, 0.003, D.psx, D.psz, 16), pink, Tile.Flat, { kind: 'glow' });
  // light chest armour
  k.add('torso', rbox(0.22, 0.13, 0.035, 0.018, 2), armor, Tile.Plate, { p: [0, 0.35, fz(0.35) - 0.01] });
  k.add('torso', rbox(0.1, 0.008, 0.004, 0.003, 1), pink, Tile.Flat, { p: [0, 0.33, fz(0.33) - 0.03], kind: 'glow' });
  for (let i = 0; i < 2; i++) k.add('torso', rbox(0.15, 0.05, 0.03, 0.012, 1), 0x3730a3, Tile.Plate, { p: [0, 0.2 - i * 0.06, fz(0.2 - i * 0.06) - 0.008] });
  // asymmetric armoured shoulder guard (left) + collar plate
  for (let i = 0; i < 3; i++) {
    const g = new THREE.SphereGeometry(0.115 - i * 0.01, 14, 6, 0, Math.PI * 2, 0, 1.2);
    g.scale(1, 0.7, 1.1);
    k.add('torso', g, i === 0 ? armor : 0x3730a3, Tile.Plate, { p: [-(D.sh + 0.025 + i * 0.012), 0.47 - i * 0.055, 0], r: [0, 0, 0.5 + i * 0.15] });
  }
  k.add('torso', ring([[0.112, 0], [0.112, 1]], 0, 0, 0.004, 1, 1.1, 18), pink, Tile.Flat, { p: [-(D.sh + 0.025) - 0.04, 0.47 - 0.07, 0], r: [0, 0, 0.5], kind: 'glow' });
  k.add('torso', rbox(0.1, 0.03, 0.12, 0.012, 1), armor, Tile.Plate, { p: [-0.1, 0.5, 0], r: [0, 0, 0.3] });
  for (const S of SIDES) {
    k.add(S.leg, stripe(D.thigh, S.s * Math.PI / 2, 0.02, -0.4, 0.003, 0.003, 1, 1.05, 6), pink, Tile.Flat, { kind: 'glow' });
    k.add(S.knee, stripe(D.shin, S.s * Math.PI / 2, -0.02, -0.24, 0.003, 0.003, 1, 1.08, 5), cyan, Tile.Flat, { kind: 'glow' });
    k.add(S.knee, rbox(0.1, 0.1, 0.045, 0.022, 2), armor, Tile.Plate, { p: [0, -0.02, -0.058], r: [0.12, 0, 0] });
    k.add(S.arm, stripe(D.upper, S.s * Math.PI / 2, 0.0, -0.3, 0.003, 0.003, 1, 1, 5), pink, Tile.Flat, { kind: 'glow' });
    k.add(S.elbow, shell(D.fore, -0.08, -0.24, 0.01, { steps: 2, segs: 12, sz: 0.92 }), armor, Tile.Plate);
    k.add(S.elbow, ring(D.fore, -0.1, 0.012, 0.003, 1, 0.92, 12), cyan, Tile.Flat, { kind: 'glow' });
    k.add(S.knee, ring(D.shin, -0.25, 0.016, 0.003, 1, 1.08, 12), pink, Tile.Flat, { kind: 'glow' });
  }
  // undercut: shaved sides + swept top + neon visor + ear modules
  hairCap(c, 0x4b5060, (az) => 2.15 - 1.0 * Math.pow(frontness(az), 1.4) - 0.3 * gauss((frontness(az) - 0.52) / 0.12), 0.006, 1.006, 24, 8);
  ears(c);
  const cen = headCenter(D);
  const top = (az: number) => 0.95 + 0.2 * gauss((frontness(az) - 0.5) / 0.4);
  hairCap(c, st.hair, top, 0.06, 1.03, 24, 8);
  for (let i = 0; i < 5; i++) {
    const az = Math.PI - 0.5 + i * 0.25;
    const a = scalp(D, az, 0.15, 1.1);
    const b = scalp(D, az + 0.7, 0.75, 1.2);
    const e = scalp(D, az + 1.0, 1.15, 1.12);
    k.add('neck', tube([a, b, e], 0.026, 0.006, 6, 7), st.hair, Tile.Hair, { ao: 0.15 });
  }
  ellipDome(c, 1.16, () => 1.36, () => 1.66, pink, Tile.Flat, { ws: 18, hs: 3, azStart: Math.PI - 1.15, azLen: 2.3, kind: 'visor' });
  ellipDome(c, 1.17, () => 1.35, () => 1.37, pink, Tile.Flat, { ws: 18, hs: 1, azStart: Math.PI - 1.15, azLen: 2.3, kind: 'glow' });
  for (const s of [-1, 1]) {
    k.add('neck', lathe([[0.001, 0], [0.026, 0], [0.026, 0.02], [0.016, 0.028], [0.001, 0.028]], 12), 0x111827, Tile.Plate, { p: [s * D.head.rx * 1.0, cen.y + 0.0, cen.z + 0.01], r: [0, 0, -s * Math.PI / 2] });
    k.add('neck', ring([[0.02, 0], [0.02, 1]], 0, 0, 0.003, 1, 1, 12), cyan, Tile.Flat, { p: [s * (D.head.rx + 0.03), cen.y, cen.z + 0.01], r: [0, 0, Math.PI / 2], kind: 'glow' });
  }
}

// ------------------------------------------------------------------ public build cache

export interface BuiltCharacter {
  parts: Map<Bone, Map<Kind, THREE.BufferGeometry>>;
  head: THREE.BufferGeometry;
  faceMat: THREE.MeshStandardMaterial;
  sh: number;
  hipW: number;
}

const FACES: Record<CharacterId, Omit<FaceSpec, 'skin' | 'eyes' | 'female'>> = {
  specops: { brow: 0x2b2118, lips: 0xa0685a, stubble: 0.7 },
  mercenary: { brow: 0x1f1a17, lips: 0x8f5a48, beard: true },
  desert_sniper: { brow: 0x3b2a1a, lips: 0x8c5a44, stubble: 0.5, paint: 'eyeblack', paintColor: 0x2a2418 },
  heavy_striker: { brow: 0x111111, lips: 0x6b4030, stubble: 0.8 },
  bodysuit_agent: { brow: 0x1b1b1f, lips: 0xb5615a },
  urban_scout: { brow: 0x4a2a16, lips: 0xb06a5a },
  crimson_operative: { brow: 0x3a1512, lips: 0xb04848 },
  cyber_valkyrie: { brow: 0x9ca3af, lips: 0xa65a6a, paint: 'cyber', paintColor: 0xe879f9 },
};

const built = new Map<CharacterId, BuiltCharacter>();

export function characterStyleOf(id: CharacterId) {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}

export function buildCharacter(id: CharacterId): BuiltCharacter {
  const hit = built.get(id);
  if (hit) return hit;
  const st = characterStyleOf(id);
  const D = dims(st);
  const k = new Kit();
  const c: Ctx = { k, st, D };
  switch (st.id) {
    case 'specops':
      buildSpecOps(c);
      break;
    case 'mercenary':
      buildMercenary(c);
      break;
    case 'desert_sniper':
      buildDesertSniper(c);
      break;
    case 'heavy_striker':
      buildHeavy(c);
      break;
    case 'bodysuit_agent':
      buildBodysuitAgent(c);
      break;
    case 'urban_scout':
      buildUrbanScout(c);
      break;
    case 'crimson_operative':
      buildCrimson(c);
      break;
    case 'cyber_valkyrie':
      buildValkyrie(c);
      break;
  }
  const hidden = st.id === 'heavy_striker';
  const head = faceGeometry(D, hidden ? 16 : 40, hidden ? 10 : 28);
  head.computeBoundingBox();
  head.computeBoundingSphere();
  const face = FACES[st.id];
  const faceMat = new THREE.MeshStandardMaterial({
    map: faceTexture(st.id, { ...face, skin: st.skin, eyes: st.eyes, female: st.gender === 'female' }),
    roughness: 0.62,
    metalness: 0,
    bumpMap: characterAtlas().data,
    bumpScale: 0.0,
  });
  faceMat.name = `face:${st.id}`;
  const res: BuiltCharacter = { parts: k.build(), head, faceMat, sh: D.sh, hipW: D.hipW };
  built.set(id, res);
  return res;
}

// ------------------------------------------------------------------ shared materials

let shared: { gear: THREE.MeshStandardMaterial; glow: THREE.MeshBasicMaterial; visor: THREE.MeshBasicMaterial } | null = null;
export function characterMaterials() {
  if (shared) return shared;
  const a = characterAtlas();
  const gear = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: a.color,
    roughnessMap: a.data,
    metalnessMap: a.data,
    bumpMap: a.data,
    bumpScale: 1.2,
    roughness: 1,
    metalness: 1,
  });
  gear.name = 'character:gear';
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  glow.name = 'character:glow';
  const visor = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  visor.name = 'character:visor';
  shared = { gear, glow, visor };
  return shared;
}
