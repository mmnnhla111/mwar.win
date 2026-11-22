import * as THREE from 'three';

/**
 * Weapon definitions + procedural models shared by the first-person viewmodel, world drops and
 * the third-person character rigs (bots / remote players).
 *
 * Loadout rules: one Primary (Sniper / AK-47 / M16 / Uzi) chosen before deploy, a universal
 * Pistol sidearm and 2 Frag Grenades. Ammo is strictly limited (magazine + reserve).
 */

export type PrimaryId = 'sniper' | 'ak47' | 'm16' | 'uzi';
export type WeaponId = PrimaryId | 'pistol';
export type FireMode = 'auto' | 'semi' | 'bolt';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** Short HUD / loadout description. */
  blurb: string;
  slot: 'primary' | 'secondary';
  /** Body-shot damage (player HP = 100). */
  damage: number;
  headMult: number;
  /** Seconds between shots. */
  fireInterval: number;
  mode: FireMode;
  magSize: number;
  reserve: number;
  /** Cone half-size in NDC units: hip, aimed, extra when moving. */
  hipSpread: number;
  adsSpread: number;
  moveSpread: number;
  /** Camera kick per shot (radians). */
  recoilPitch: number;
  recoilYaw: number;
  /** Recoil recovery rate (higher = snappier). */
  recoilRecover: number;
  adsFov: number;
  reloadTime: number;
  /** Movement speed multiplier while holding it. */
  moveMult: number;
  /** Damage falloff start / minimum multiplier at 3x that range. */
  range: number;
  scope?: boolean;
  /** Stat bars for the loadout screen (0..1). */
  stats: { damage: number; rate: number; control: number; mobility: number };
  tag: string;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  sniper: {
    id: 'sniper',
    name: 'Sniper Rifle',
    blurb: 'Bolt-action. One-shot headshots, 25° scope.',
    slot: 'primary',
    damage: 92,
    headMult: 2.5,
    fireInterval: 1.25,
    mode: 'bolt',
    magSize: 5,
    reserve: 20,
    hipSpread: 0.07,
    adsSpread: 0,
    moveSpread: 0.05,
    recoilPitch: 0.07,
    recoilYaw: 0.01,
    recoilRecover: 4,
    adsFov: 25,
    reloadTime: 3.0,
    moveMult: 0.88,
    range: 200,
    scope: true,
    stats: { damage: 1, rate: 0.12, control: 0.55, mobility: 0.45 },
    tag: 'SNIPER',
  },
  ak47: {
    id: 'ak47',
    name: 'AK-47',
    blurb: 'Hard-hitting 7.62 auto. Strong, wild recoil.',
    slot: 'primary',
    damage: 34,
    headMult: 2,
    fireInterval: 0.1,
    mode: 'auto',
    magSize: 30,
    reserve: 90,
    hipSpread: 0.032,
    adsSpread: 0.006,
    moveSpread: 0.03,
    recoilPitch: 0.024,
    recoilYaw: 0.014,
    recoilRecover: 6,
    adsFov: 50,
    reloadTime: 2.5,
    moveMult: 0.95,
    range: 45,
    stats: { damage: 0.75, rate: 0.6, control: 0.35, mobility: 0.6 },
    tag: 'AK-47',
  },
  m16: {
    id: 'm16',
    name: 'M16',
    blurb: 'Accurate, fast and controllable auto rifle.',
    slot: 'primary',
    damage: 27,
    headMult: 2,
    fireInterval: 0.075,
    mode: 'auto',
    magSize: 30,
    reserve: 90,
    hipSpread: 0.022,
    adsSpread: 0.0025,
    moveSpread: 0.02,
    recoilPitch: 0.011,
    recoilYaw: 0.004,
    recoilRecover: 8,
    adsFov: 46,
    reloadTime: 2.2,
    moveMult: 0.97,
    range: 55,
    stats: { damage: 0.6, rate: 0.78, control: 0.85, mobility: 0.65 },
    tag: 'M16',
  },
  uzi: {
    id: 'uzi',
    name: 'Uzi',
    blurb: 'Bullet hose SMG. Fast movement, close range.',
    slot: 'primary',
    damage: 17,
    headMult: 1.6,
    fireInterval: 0.05,
    mode: 'auto',
    magSize: 32,
    reserve: 128,
    hipSpread: 0.045,
    adsSpread: 0.024,
    moveSpread: 0.012,
    recoilPitch: 0.008,
    recoilYaw: 0.009,
    recoilRecover: 10,
    adsFov: 62,
    reloadTime: 1.8,
    moveMult: 1.1,
    range: 18,
    stats: { damage: 0.35, rate: 1, control: 0.55, mobility: 1 },
    tag: 'UZI',
  },
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    blurb: 'Semi-auto sidearm. Everyone carries one.',
    slot: 'secondary',
    damage: 24,
    headMult: 2,
    fireInterval: 0.16,
    mode: 'semi',
    magSize: 15,
    reserve: 45,
    hipSpread: 0.026,
    adsSpread: 0.008,
    moveSpread: 0.015,
    recoilPitch: 0.02,
    recoilYaw: 0.006,
    recoilRecover: 9,
    adsFov: 60,
    reloadTime: 1.5,
    moveMult: 1.05,
    range: 25,
    stats: { damage: 0.45, rate: 0.5, control: 0.7, mobility: 0.9 },
    tag: 'PISTOL',
  },
};

export const PRIMARY_IDS: PrimaryId[] = ['sniper', 'ak47', 'm16', 'uzi'];

export const GRENADE = {
  start: 2,
  max: 3,
  fuse: 3.0,
  radius: 7.5,
  maxDamage: 130,
  throwSpeed: 17,
  name: 'Frag Grenade',
};

/** Damage multiplier for range falloff. */
export function falloff(def: WeaponDef, dist: number) {
  if (dist <= def.range) return 1;
  const t = Math.min(1, (dist - def.range) / (def.range * 2));
  return 1 - t * 0.45;
}

// =============================================================================================
// Procedural models
// =============================================================================================

export interface WeaponModel {
  group: THREE.Group;
  muzzle: THREE.Object3D;
  mag: THREE.Object3D | null;
  /** Bolt handle (sniper) for cycling animation. */
  bolt: THREE.Object3D | null;
  /** Height of the sight line above the model origin (for ADS alignment). */
  sightY: number;
  /** Local z of the sight (eye relief reference). */
  sightZ: number;
  /** Local z of the muzzle tip. */
  muzzleZ: number;
  materials: THREE.Material[];
  /** Viewmodel hand poses (model-local). */
  hands: { right: HandPose; left: HandPose | null };
}

export interface HandPose {
  pos: [number, number, number];
  rot: [number, number, number];
}

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function cyl(rt: number, rb: number, len: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D, seg = 12) {
  const g = new THREE.CylinderGeometry(rt, rb, len, seg);
  g.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function std(color: number, roughness: number, metalness: number) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

/** Rear iron sight: low base with two ears and a clear notch on the sight line (y). */
function rearNotch(parent: THREE.Object3D, mat: THREE.Material, y: number, z: number, gap = 0.012) {
  box(0.036, 0.012, 0.03, mat, 0, y - 0.016, z, parent);
  box(0.008, 0.02, 0.012, mat, -(gap / 2 + 0.004), y - 0.004, z, parent);
  box(0.008, 0.02, 0.012, mat, gap / 2 + 0.004, y - 0.004, z, parent);
}

function redDot(parent: THREE.Object3D, metal: THREE.Material, y: number, z: number, mats: THREE.Material[]) {
  box(0.036, 0.016, 0.09, metal, 0, y - 0.021, z, parent);
  const tube = new THREE.CylinderGeometry(0.024, 0.024, 0.07, 18, 1, true);
  tube.rotateX(Math.PI / 2);
  const tubeMat = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide });
  const tubeMesh = new THREE.Mesh(tube, tubeMat);
  tubeMesh.position.set(0, y, z);
  parent.add(tubeMesh);
  const lensMat = new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.16, depthWrite: false });
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.022, 20), lensMat);
  lens.position.set(0, y, z - 0.03);
  parent.add(lens);
  const dotMat = new THREE.SpriteMaterial({ color: 0xff2a2a, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
  const dot = new THREE.Sprite(dotMat);
  dot.scale.setScalar(0.0045);
  dot.position.set(0, y, z - 0.035);
  dot.renderOrder = 10;
  parent.add(dot);
  mats.push(tubeMat, lensMat, dotMat);
}

function buildM16(): WeaponModel {
  const g = new THREE.Group();
  const metal = std(0x3f444b, 0.45, 0.6);
  const polymer = std(0x23262b, 0.7, 0.1);
  const steel = std(0x55595e, 0.3, 0.9);
  const mats: THREE.Material[] = [metal, polymer, steel];
  box(0.066, 0.07, 0.36, metal, 0, 0.035, -0.04, g);
  box(0.06, 0.05, 0.26, metal, 0, -0.022, 0.0, g);
  box(0.044, 0.012, 0.42, steel, 0, 0.077, -0.1, g);
  // Round ribbed handguard
  cyl(0.04, 0.04, 0.36, polymer, 0, 0.03, -0.4, g, 14);
  for (let i = 0; i < 6; i++) cyl(0.042, 0.042, 0.012, metal, 0, 0.03, -0.26 - i * 0.05, g, 14);
  cyl(0.011, 0.011, 0.34, steel, 0, 0.03, -0.74, g);
  // Triangular front sight post
  box(0.014, 0.07, 0.02, metal, 0, 0.09, -0.6, g);
  const muzzle = cyl(0.017, 0.017, 0.07, metal, 0, 0.03, -0.92, g);
  const mag = new THREE.Group();
  box(0.04, 0.12, 0.072, polymer, 0, -0.06, 0, mag);
  const low = box(0.04, 0.1, 0.072, polymer, 0, -0.155, 0.014, mag);
  low.rotation.x = 0.2;
  mag.position.set(0, -0.045, -0.12);
  mag.rotation.x = 0.08;
  g.add(mag);
  box(0.05, 0.03, 0.09, metal, 0, -0.05, -0.12, g);
  box(0.012, 0.012, 0.07, metal, 0, -0.08, -0.02, g);
  const grip = box(0.042, 0.12, 0.055, polymer, 0, -0.1, 0.06, g);
  grip.rotation.x = -0.32;
  // Fixed stock
  box(0.05, 0.08, 0.3, polymer, 0, 0.0, 0.33, g);
  box(0.056, 0.13, 0.03, polymer, 0, -0.015, 0.49, g);
  box(0.07, 0.015, 0.03, steel, 0, 0.065, 0.12, g);
  redDot(g, metal, 0.112, -0.06, mats);
  return {
    group: g,
    muzzle,
    mag,
    bolt: null,
    sightY: 0.112,
    sightZ: -0.06,
    muzzleZ: -0.96,
    materials: mats,
    hands: {
      right: { pos: [0.012, -0.095, 0.075], rot: [-0.55, 0.12, -0.25] },
      left: { pos: [-0.03, -0.01, -0.42], rot: [0.25, 0.55, 0.35] },
    },
  };
}

function buildAK(): WeaponModel {
  const g = new THREE.Group();
  const steel = std(0x2b2d31, 0.4, 0.75);
  const wood = std(0x8a4b22, 0.6, 0.05);
  const dark = std(0x1a1b1e, 0.6, 0.3);
  const mats: THREE.Material[] = [steel, wood, dark];
  // Receiver with dust cover
  box(0.064, 0.08, 0.4, steel, 0, 0.02, -0.02, g);
  box(0.058, 0.02, 0.36, dark, 0, 0.07, 0.0, g);
  // Wooden handguard (upper + lower)
  box(0.07, 0.05, 0.26, wood, 0, 0.005, -0.36, g);
  box(0.05, 0.035, 0.22, wood, 0, 0.055, -0.34, g);
  // Gas tube + barrel
  cyl(0.013, 0.013, 0.3, steel, 0, 0.055, -0.6, g);
  cyl(0.012, 0.012, 0.44, steel, 0, 0.012, -0.66, g);
  box(0.03, 0.05, 0.03, steel, 0, 0.04, -0.66, g);
  // Front sight hood
  box(0.024, 0.03, 0.03, steel, 0, 0.05, -0.82, g);
  // Rear sight (iron notch) + front post on the same sight line
  rearNotch(g, steel, 0.095, -0.18);
  box(0.006, 0.03, 0.006, steel, 0, 0.083, -0.82, g);
  const muzzle = cyl(0.016, 0.02, 0.06, steel, 0, 0.012, -0.9, g);
  // Banana magazine (3 angled segments)
  const mag = new THREE.Group();
  const segs = [0, 0.2, 0.42];
  segs.forEach((r, i) => {
    const s = box(0.038, 0.09, 0.08, dark, 0, -0.045 - i * 0.082, 0.02 * i * i - 0.02 * i, mag);
    s.rotation.x = -r;
  });
  mag.position.set(0, -0.02, -0.15);
  g.add(mag);
  // Grip + trigger guard
  const grip = box(0.04, 0.11, 0.05, wood, 0, -0.085, 0.07, g);
  grip.rotation.x = -0.35;
  box(0.012, 0.012, 0.07, steel, 0, -0.06, -0.02, g);
  // Wooden stock dropping slightly
  const stock = box(0.05, 0.08, 0.34, wood, 0, -0.025, 0.36, g);
  stock.rotation.x = 0.1;
  box(0.054, 0.12, 0.03, dark, 0, -0.055, 0.53, g);
  // Charging handle (right side)
  box(0.03, 0.015, 0.02, steel, 0.045, 0.03, 0.05, g);
  return {
    group: g,
    muzzle,
    mag,
    bolt: null,
    sightY: 0.095,
    sightZ: -0.18,
    muzzleZ: -0.93,
    materials: mats,
    hands: {
      right: { pos: [0.012, -0.085, 0.085], rot: [-0.55, 0.12, -0.25] },
      left: { pos: [-0.03, -0.035, -0.37], rot: [0.25, 0.55, 0.35] },
    },
  };
}

function buildSniper(): WeaponModel {
  const g = new THREE.Group();
  const body = std(0x3d4a36, 0.75, 0.15);
  const steel = std(0x222428, 0.35, 0.85);
  const glassMat = new THREE.MeshBasicMaterial({ color: 0x0ea5e9, transparent: true, opacity: 0.35 });
  const mats: THREE.Material[] = [body, steel, glassMat];
  // Chassis / stock (thumbhole style)
  box(0.07, 0.08, 0.5, body, 0, 0.0, -0.08, g);
  box(0.06, 0.12, 0.36, body, 0, -0.03, 0.36, g);
  box(0.064, 0.15, 0.03, steel, 0, -0.03, 0.55, g);
  box(0.04, 0.03, 0.18, body, 0, 0.065, 0.36, g); // cheek rest
  // Receiver + long fluted barrel
  cyl(0.026, 0.026, 0.3, steel, 0, 0.045, -0.06, g, 14);
  cyl(0.015, 0.013, 0.78, steel, 0, 0.045, -0.6, g, 12);
  const muzzle = cyl(0.022, 0.022, 0.09, steel, 0, 0.045, -1.03, g, 10);
  // Bipod folded
  box(0.012, 0.012, 0.22, steel, 0.02, -0.03, -0.48, g);
  box(0.012, 0.012, 0.22, steel, -0.02, -0.03, -0.48, g);
  // Bolt handle
  const bolt = new THREE.Group();
  box(0.07, 0.012, 0.012, steel, 0.05, 0, 0, bolt);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), steel);
  knob.position.set(0.085, 0, 0);
  bolt.add(knob);
  bolt.position.set(0, 0.04, 0.06);
  g.add(bolt);
  // Magazine
  const mag = new THREE.Group();
  box(0.04, 0.07, 0.09, steel, 0, -0.035, 0, mag);
  mag.position.set(0, -0.04, -0.05);
  g.add(mag);
  const grip = box(0.04, 0.11, 0.05, body, 0, -0.095, 0.14, g);
  grip.rotation.x = -0.25;
  box(0.012, 0.012, 0.07, steel, 0, -0.06, 0.05, g);
  // Scope: rings + tube + bells + lens
  const sightY = 0.125;
  box(0.03, 0.05, 0.02, steel, 0, 0.09, -0.15, g);
  box(0.03, 0.05, 0.02, steel, 0, 0.09, 0.05, g);
  cyl(0.026, 0.026, 0.3, steel, 0, sightY, -0.05, g, 16);
  cyl(0.038, 0.026, 0.08, steel, 0, sightY, -0.24, g, 16);
  cyl(0.026, 0.034, 0.07, steel, 0, sightY, 0.13, g, 16);
  box(0.018, 0.03, 0.03, steel, 0, sightY + 0.035, -0.05, g); // turret
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.036, 20), glassMat);
  lens.position.set(0, sightY, -0.285);
  lens.rotation.y = Math.PI;
  g.add(lens);
  return {
    group: g,
    muzzle,
    mag,
    bolt,
    sightY,
    sightZ: 0.13,
    muzzleZ: -1.08,
    materials: mats,
    hands: {
      right: { pos: [0.012, -0.095, 0.16], rot: [-0.5, 0.12, -0.25] },
      left: { pos: [-0.03, -0.02, -0.32], rot: [0.25, 0.55, 0.35] },
    },
  };
}

function buildUzi(): WeaponModel {
  const g = new THREE.Group();
  const steel = std(0x2f3237, 0.45, 0.7);
  const dark = std(0x16171a, 0.65, 0.3);
  const mats: THREE.Material[] = [steel, dark];
  box(0.06, 0.08, 0.3, steel, 0, 0.02, -0.06, g);
  box(0.05, 0.015, 0.26, dark, 0, 0.068, -0.06, g);
  cyl(0.012, 0.012, 0.08, steel, 0, 0.02, -0.25, g);
  const muzzle = cyl(0.016, 0.016, 0.03, steel, 0, 0.02, -0.3, g);
  box(0.006, 0.03, 0.006, steel, 0, 0.078, -0.19, g);
  rearNotch(g, steel, 0.088, 0.07);
  // Grip with magazine inside
  const grip = box(0.044, 0.13, 0.06, dark, 0, -0.08, 0.02, g);
  grip.rotation.x = -0.12;
  const mag = new THREE.Group();
  box(0.034, 0.12, 0.045, steel, 0, -0.06, 0, mag);
  mag.position.set(0, -0.13, 0.03);
  g.add(mag);
  box(0.012, 0.012, 0.06, steel, 0, -0.035, -0.06, g);
  // Folded wire stock
  box(0.05, 0.012, 0.16, steel, 0, -0.03, 0.17, g);
  box(0.05, 0.05, 0.012, steel, 0, -0.01, 0.25, g);
  return {
    group: g,
    muzzle,
    mag,
    bolt: null,
    sightY: 0.088,
    sightZ: 0.07,
    muzzleZ: -0.32,
    materials: mats,
    hands: {
      right: { pos: [0.01, -0.1, 0.035], rot: [-0.3, 0.12, -0.2] },
      left: { pos: [-0.03, -0.04, -0.17], rot: [0.25, 0.55, 0.35] },
    },
  };
}

function buildPistol(): WeaponModel {
  const g = new THREE.Group();
  const slide = std(0x2c2f34, 0.35, 0.8);
  const frame = std(0x1a1b1f, 0.7, 0.15);
  const mats: THREE.Material[] = [slide, frame];
  box(0.034, 0.036, 0.2, slide, 0, 0.03, -0.03, g);
  box(0.03, 0.02, 0.17, frame, 0, 0.0, -0.035, g);
  box(0.005, 0.012, 0.006, slide, 0, 0.052, -0.12, g);
  rearNotch(g, slide, 0.058, 0.06, 0.01);
  const muzzle = cyl(0.008, 0.008, 0.01, slide, 0, 0.028, -0.135, g);
  const grip = box(0.032, 0.11, 0.045, frame, 0, -0.055, 0.045, g);
  grip.rotation.x = -0.25;
  box(0.01, 0.01, 0.04, frame, 0, -0.022, -0.01, g);
  const mag = new THREE.Group();
  box(0.026, 0.02, 0.04, frame, 0, -0.01, 0, mag);
  mag.position.set(0, -0.105, 0.06);
  g.add(mag);
  return {
    group: g,
    muzzle,
    mag,
    bolt: null,
    sightY: 0.058,
    sightZ: 0.06,
    muzzleZ: -0.14,
    materials: mats,
    hands: {
      right: { pos: [0.005, -0.075, 0.07], rot: [-0.35, 0.05, -0.1] },
      left: { pos: [-0.035, -0.08, 0.05], rot: [-0.25, -0.5, 0.6] },
    },
  };
}

export function buildGrenadeModel(): { group: THREE.Group; materials: THREE.Material[] } {
  const g = new THREE.Group();
  const body = std(0x4d5a2c, 0.7, 0.2);
  const metal = std(0x9ca3af, 0.4, 0.8);
  const mats = [body, metal];
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), body);
  sphere.scale.set(1, 1.15, 1);
  g.add(sphere);
  // Segment grooves
  for (let i = -1; i <= 1; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.046 * Math.cos(i * 0.5), 0.003, 6, 18), body);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = i * 0.022;
    g.add(ring);
  }
  const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.03, 10), metal);
  fuse.position.y = 0.062;
  g.add(fuse);
  const lever = box(0.012, 0.006, 0.07, metal, 0.014, 0.06, 0.025, g);
  lever.rotation.x = 0.5;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.0025, 6, 14), metal);
  ring.position.set(-0.02, 0.07, 0);
  ring.rotation.y = Math.PI / 2;
  g.add(ring);
  return { group: g, materials: mats };
}

export function buildWeaponModel(id: WeaponId): WeaponModel {
  switch (id) {
    case 'sniper':
      return buildSniper();
    case 'ak47':
      return buildAK();
    case 'uzi':
      return buildUzi();
    case 'pistol':
      return buildPistol();
    case 'm16':
    default:
      return buildM16();
  }
}

export function disposeObject(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) mat.dispose();
  });
}

// =============================================================================================
// World pickups (dropped weapons)
// =============================================================================================

export const WEAPON_DROP_LIFETIME = 300; // seconds (5 minutes)

export function makeLabelSprite(text: string, color = '#fde68a', bg = 'rgba(2,6,23,0.75)') {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(4, 8, 248, 48, 14);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  s.scale.set(1.2, 0.3, 1);
  return s;
}

export interface WorldWeapon {
  uid: number;
  id: PrimaryId | 'pistol';
  mag: number;
  reserve: number;
  group: THREE.Group;
  /** Seconds left before despawn. */
  ttl: number;
  vel: THREE.Vector3;
  resting: boolean;
}

let dropUid = 1;

/** Creates the glowing pickup group (weapon model, glow ring, floating name tag). */
export function createWorldWeapon(id: WorldWeapon['id'], mag: number, reserve: number): WorldWeapon {
  const group = new THREE.Group();
  const model = buildWeaponModel(id);
  model.group.scale.setScalar(0.85);
  model.group.rotation.set(0, Math.PI / 2, Math.PI / 2 - 0.15);
  model.group.position.y = 0.12;
  model.group.name = 'model';
  group.add(model.group);
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.62, 28), glowMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  ring.name = 'glow';
  group.add(ring);
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xfde68a, transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.25, 1.4, 12, 1, true), beamMat);
  beam.position.y = 0.7;
  group.add(beam);
  const label = makeLabelSprite(`${WEAPONS[id].name} • ${mag}/${reserve}`);
  label.position.y = 1.0;
  label.name = 'label';
  group.add(label);
  return { uid: dropUid++, id, mag, reserve, group, ttl: WEAPON_DROP_LIFETIME, vel: new THREE.Vector3(), resting: true };
}

export function animateWorldWeapon(w: WorldWeapon, t: number) {
  const model = w.group.getObjectByName('model');
  if (model && w.resting) {
    model.position.y = 0.16 + Math.sin(t * 2.4 + w.uid) * 0.05;
    model.rotation.y = Math.PI / 2 + t * 0.9;
  }
  const glow = w.group.getObjectByName('glow') as THREE.Mesh | undefined;
  if (glow) {
    const mat = glow.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.35 + Math.sin(t * 4 + w.uid) * 0.15;
    // Blink during the last 20 seconds before despawn
    if (w.ttl < 20) w.group.visible = Math.sin(t * 12) > -0.3;
  }
}
