import * as THREE from 'three';
import { buildWeaponModel, WeaponId, disposeObject } from '../weapons';

/**
 * Articulated low-poly character models (4 male + 4 female operators) used for AI bots, remote
 * players and the avatar selector. Every rig has jointed limbs (hip → knee, shoulder → elbow),
 * a head with hair / headgear, gear layers and procedural walk / run / crouch / aim poses.
 *
 * Rig faces -Z. Meshes carry userData.hitZone = 'head' | 'body' for hit detection.
 */

export type CharacterId =
  | 'specops'
  | 'mercenary'
  | 'desert_sniper'
  | 'heavy_striker'
  | 'bodysuit_agent'
  | 'urban_scout'
  | 'crimson_operative'
  | 'cyber_valkyrie';

type Hair = 'buzz' | 'short' | 'none' | 'ponytail' | 'bob' | 'braid' | 'long' | 'undercut';
type Headgear = 'helmet' | 'cap' | 'boonie' | 'heavy' | 'none' | 'visor' | 'beret';

interface CharacterStyle {
  id: CharacterId;
  name: string;
  gender: 'male' | 'female';
  tagline: string;
  skin: number;
  hair: number;
  hairStyle: Hair;
  headgear: Headgear;
  top: number;
  pants: number;
  vest: number | null;
  boots: number;
  gloves: number;
  accent: number;
  /** Extra gear flags */
  beard?: boolean;
  mask?: boolean;
  goggles?: boolean;
  ghillie?: boolean;
  armor?: boolean;
  jacket?: boolean;
  cropTop?: boolean;
  bodysuit?: boolean;
  cyber?: boolean;
  scarf?: boolean;
  belt?: number;
  /** Proportions */
  scale: number;
  shoulder: number;
  hipW: number;
  limb: number;
}

export const CHARACTERS: CharacterStyle[] = [
  {
    id: 'specops', name: 'Spec-Ops Operator', gender: 'male', tagline: 'Night-black tactical kit, NVG mount',
    skin: 0xc89f7c, hair: 0x2b2118, hairStyle: 'buzz', headgear: 'helmet', top: 0x2a2f36, pants: 0x30363e, vest: 0x1d2228,
    boots: 0x111214, gloves: 0x1c1c1c, accent: 0x22d3ee, goggles: true, scale: 1.0, shoulder: 0.25, hipW: 0.12, limb: 1.0,
  },
  {
    id: 'mercenary', name: 'Urban Mercenary', gender: 'male', tagline: 'Leather jacket, cap & beard',
    skin: 0xb7835f, hair: 0x1f1a17, hairStyle: 'short', headgear: 'cap', top: 0x4b3a2e, pants: 0x3d4a5c, vest: null,
    boots: 0x3a2a1e, gloves: 0x2a1f18, accent: 0xf97316, beard: true, jacket: true, belt: 0x2a1f18, scale: 1.0, shoulder: 0.25, hipW: 0.12, limb: 1.0,
  },
  {
    id: 'desert_sniper', name: 'Desert Recon Sniper', gender: 'male', tagline: 'Ghillie drapes, boonie hat, shemagh',
    skin: 0xa8754f, hair: 0x3b2a1a, hairStyle: 'short', headgear: 'boonie', top: 0xa58e66, pants: 0x8c7650, vest: 0x6f5f3f,
    boots: 0x5c4630, gloves: 0x7a6847, accent: 0xfacc15, ghillie: true, scarf: true, scale: 1.0, shoulder: 0.24, hipW: 0.12, limb: 1.0,
  },
  {
    id: 'heavy_striker', name: 'Heavy Armored Striker', gender: 'male', tagline: 'Plated juggernaut, full-face helmet',
    skin: 0x8d5b3c, hair: 0x111111, hairStyle: 'none', headgear: 'heavy', top: 0x3f3f46, pants: 0x27272a, vest: 0x52525b,
    boots: 0x18181b, gloves: 0x27272a, accent: 0xef4444, armor: true, scale: 1.04, shoulder: 0.29, hipW: 0.135, limb: 1.15,
  },
  {
    id: 'bodysuit_agent', name: 'Tactical Bodysuit Agent', gender: 'female', tagline: 'Sleek bodysuit, high ponytail',
    skin: 0xe0b090, hair: 0x1b1b1f, hairStyle: 'ponytail', headgear: 'none', top: 0x1e2433, pants: 0x1e2433, vest: 0x2e3a52,
    boots: 0x0f1115, gloves: 0x111318, accent: 0x60a5fa, bodysuit: true, belt: 0x0f172a, scale: 0.96, shoulder: 0.2, hipW: 0.12, limb: 0.86,
  },
  {
    id: 'urban_scout', name: 'Urban Crop-Top Scout', gender: 'female', tagline: 'Crop top, cargo pants, chest rig',
    skin: 0xc68e66, hair: 0x6b3f22, hairStyle: 'bob', headgear: 'none', top: 0x84a98c, pants: 0x5b6b4a, vest: 0x3f4a35,
    boots: 0x3b3027, gloves: 0x3b3027, accent: 0xa3e635, cropTop: true, belt: 0x3b3027, scale: 0.95, shoulder: 0.2, hipW: 0.12, limb: 0.86,
  },
  {
    id: 'crimson_operative', name: 'Crimson Leather Operative', gender: 'female', tagline: 'Red leather jacket, long braid',
    skin: 0xf0c4a4, hair: 0x7f1d1d, hairStyle: 'braid', headgear: 'beret', top: 0x991b1b, pants: 0x1c1917, vest: null,
    boots: 0x1c1917, gloves: 0x450a0a, accent: 0xf87171, jacket: true, belt: 0x1c1917, scale: 0.96, shoulder: 0.205, hipW: 0.12, limb: 0.86,
  },
  {
    id: 'cyber_valkyrie', name: 'Cyber-Valkyrie Recon', gender: 'female', tagline: 'Neon visor, undercut, light armor',
    skin: 0xd9a37f, hair: 0xe2e8f0, hairStyle: 'undercut', headgear: 'visor', top: 0x312e81, pants: 0x1e1b4b, vest: 0x4338ca,
    boots: 0x111827, gloves: 0x1e1b4b, accent: 0xe879f9, cyber: true, belt: 0x0f172a, scale: 0.97, shoulder: 0.21, hipW: 0.12, limb: 0.9,
  },
];

export const CHARACTER_IDS = CHARACTERS.map((c) => c.id);

export function characterStyle(id: CharacterId) {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}

export function randomCharacterId(): CharacterId {
  return CHARACTER_IDS[Math.floor(Math.random() * CHARACTER_IDS.length)];
}

/** First-person arm colours (glove, sleeve) for the viewmodel. */
export function characterArmColors(id: CharacterId): { glove: number; sleeve: number } {
  const s = characterStyle(id);
  return { glove: s.gloves, sleeve: s.cropTop ? s.skin : s.jacket ? s.top : s.top };
}

export interface CharacterRig {
  id: CharacterId;
  root: THREE.Group;
  /** Whole-body group (crouch offset / death fall). */
  body: THREE.Group;
  torso: THREE.Group;
  neck: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  gun: THREE.Group;
  head: THREE.Mesh;
  muzzle: THREE.Object3D;
  hitMeshes: THREE.Mesh[];
  nameTag?: THREE.Sprite;
  weapon: WeaponId;
  setWeapon(id: WeaponId): void;
  dispose(): void;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function cached(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key);
  if (!g) geoCache.set(key, (g = make()));
  return g;
}
const boxGeo = (w: number, h: number, d: number) => cached(`b${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d));
/** Capsule-ish limb segment (rounded cylinder) hanging downwards from y=0 to y=-len. */
const limbGeo = (rTop: number, rBot: number, len: number) =>
  cached(`l${rTop}|${rBot}|${len}`, () => {
    const g = new THREE.CylinderGeometry(rTop, rBot, len, 10);
    g.translate(0, -len / 2, 0);
    return g;
  });
const sphereGeo = (r: number) => cached(`s${r}`, () => new THREE.SphereGeometry(r, 14, 10));

type Zone = 'head' | 'body' | undefined;

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D, zone?: Zone) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  if (zone) m.userData.hitZone = zone;
  parent.add(m);
  return m;
}

function makeNameTag(text: string, color: string) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(2,6,23,0.7)';
  ctx.beginPath();
  ctx.roundRect(4, 8, 248, 48, 14);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  s.scale.set(1.4, 0.35, 1);
  s.position.y = 2.25;
  return s;
}

export function createCharacter(id: CharacterId, opts: { name?: string; tagColor?: string; weapon?: WeaponId } = {}): CharacterRig {
  const st = characterStyle(id);
  const female = st.gender === 'female';
  const mats: THREE.Material[] = [];
  const M = (color: number, roughness = 0.85, metalness = 0.05) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    mats.push(m);
    return m;
  };
  const skin = M(st.skin, 0.7);
  const hair = M(st.hair, 0.8);
  const top = M(st.top, st.jacket ? 0.55 : st.bodysuit ? 0.4 : 0.9, st.bodysuit || st.jacket ? 0.15 : 0.02);
  const pants = M(st.pants, st.bodysuit ? 0.4 : 0.9, st.bodysuit ? 0.15 : 0.02);
  const vest = M(st.vest ?? st.top, 0.75, st.armor ? 0.45 : 0.08);
  const boots = M(st.boots, 0.6, 0.1);
  const gloves = M(st.gloves, 0.7);
  const belt = M(st.belt ?? 0x1f1f1f, 0.6, 0.2);
  const black = M(0x141618, 0.5, 0.4);
  const accent = new THREE.MeshBasicMaterial({ color: st.accent, toneMapped: false });
  mats.push(accent);

  const L = st.limb; // limb thickness factor
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(st.scale);
  root.add(body);

  // ---------------- Legs (hip pivot → knee pivot)
  const hipY = 0.93;
  const mkLeg = (side: -1 | 1) => {
    const leg = new THREE.Group();
    leg.position.set(side * st.hipW, hipY, 0);
    mesh(limbGeo(0.085 * L, 0.065 * L, 0.46), pants, 0, 0, 0, leg, 'body');
    if (st.ghillie) {
      const drape = mesh(boxGeo(0.2, 0.3, 0.2), M(0x6b6b3a, 1), 0, -0.2, 0.02, leg);
      drape.rotation.y = side * 0.3;
    }
    // Cargo pocket
    if (!st.bodysuit) mesh(boxGeo(0.05, 0.12, 0.1), pants, side * 0.08 * L, -0.22, 0, leg);
    if (st.armor) mesh(boxGeo(0.17, 0.22, 0.17), vest, 0, -0.15, -0.02, leg);
    const knee = new THREE.Group();
    knee.position.set(0, -0.46, 0);
    leg.add(knee);
    mesh(limbGeo(0.064 * L, 0.05 * L, 0.42), pants, 0, 0, 0, knee, 'body');
    mesh(boxGeo(0.13 * L, 0.11, 0.06), st.armor ? vest : black, 0, -0.04, -0.06 * L, knee); // knee pad
    // Boot
    mesh(boxGeo(0.12 * L, 0.11, 0.26), boots, 0, -0.45, -0.045, knee);
    mesh(boxGeo(0.11 * L, 0.12, 0.13), boots, 0, -0.36, 0, knee);
    body.add(leg);
    return { leg, knee };
  };
  const { leg: legL, knee: kneeL } = mkLeg(-1);
  const { leg: legR, knee: kneeR } = mkLeg(1);

  // ---------------- Pelvis + torso (spine pivot at hips)
  mesh(boxGeo(st.hipW * 2 + 0.12, 0.17, 0.22), pants, 0, hipY - 0.01, 0, body, 'body');
  mesh(boxGeo(st.hipW * 2 + 0.14, 0.05, 0.24), belt, 0, hipY + 0.06, 0, body);
  mesh(boxGeo(0.05, 0.04, 0.02), accent, 0, hipY + 0.06, -0.125, body); // buckle
  const torso = new THREE.Group();
  torso.position.set(0, hipY + 0.06, 0);
  body.add(torso);
  const sh = st.shoulder;
  if (female) {
    // Tapered waist + chest
    mesh(boxGeo(0.25, 0.22, 0.18), st.cropTop ? skin : top, 0, 0.11, 0, torso, 'body');
    mesh(boxGeo(sh * 2 + 0.02, 0.28, 0.21), top, 0, 0.36, 0, torso, 'body');
    if (st.cropTop) mesh(boxGeo(0.27, 0.03, 0.19), top, 0, 0.2, 0, torso);
  } else {
    mesh(boxGeo(sh * 2 - 0.04, 0.26, 0.22), top, 0, 0.13, 0, torso, 'body');
    mesh(boxGeo(sh * 2 + 0.02, 0.28, 0.25), top, 0, 0.38, 0, torso, 'body');
  }
  if (st.vest !== null) {
    if (st.armor) {
      mesh(boxGeo(sh * 2 + 0.08, 0.42, 0.32), vest, 0, 0.3, 0, torso, 'body');
      // Shoulder pauldrons
      for (const s of [-1, 1]) {
        const p = mesh(boxGeo(0.17, 0.08, 0.22), vest, s * (sh + 0.04), 0.52, 0, torso, 'body');
        p.rotation.z = -s * 0.35;
      }
      mesh(boxGeo(0.2, 0.15, 0.05), black, 0, 0.36, -0.17, torso);
      mesh(boxGeo(0.24, 0.12, 0.05), vest, 0, 0.12, -0.15, torso);
    } else if (st.cyber) {
      mesh(boxGeo(sh * 2 - 0.02, 0.16, 0.24), vest, 0, 0.42, 0, torso, 'body');
      mesh(boxGeo(0.02, 0.3, 0.005), accent, -0.06, 0.28, -0.11, torso);
      mesh(boxGeo(0.02, 0.3, 0.005), accent, 0.06, 0.28, -0.11, torso);
    } else if (st.cropTop) {
      // Chest rig over the crop top
      mesh(boxGeo(sh * 2 - 0.02, 0.14, 0.24), vest, 0, 0.4, 0, torso, 'body');
      for (const x of [-0.08, 0, 0.08]) mesh(boxGeo(0.06, 0.08, 0.04), vest, x, 0.33, -0.13, torso);
      mesh(boxGeo(0.03, 0.3, 0.02), vest, -0.1, 0.5, -0.11, torso);
      mesh(boxGeo(0.03, 0.3, 0.02), vest, 0.1, 0.5, -0.11, torso);
    } else {
      mesh(boxGeo(sh * 2 + 0.04, 0.36, 0.3), vest, 0, 0.32, 0, torso, 'body');
      for (const x of [-0.11, 0, 0.11]) mesh(boxGeo(0.08, 0.1, 0.05), vest, x, 0.2, -0.165, torso);
      mesh(boxGeo(0.06, 0.04, 0.02), accent, 0.14, 0.44, -0.16, torso);
    }
  }
  if (st.jacket) {
    // Open jacket collar + lapels
    mesh(boxGeo(sh * 2 + 0.05, 0.08, 0.27), top, 0, 0.53, 0.0, torso);
    mesh(boxGeo(0.06, 0.32, 0.02), M(new THREE.Color(st.top).multiplyScalar(0.75).getHex(), 0.5, 0.15), -0.07, 0.36, -0.13, torso);
    mesh(boxGeo(0.06, 0.32, 0.02), M(new THREE.Color(st.top).multiplyScalar(0.75).getHex(), 0.5, 0.15), 0.07, 0.36, -0.13, torso);
    mesh(boxGeo(0.08, 0.3, 0.01), female ? M(0x111111, 0.8) : M(0x9ca3af, 0.9), 0, 0.36, -0.13, torso); // inner shirt
  }
  if (st.bodysuit) {
    mesh(boxGeo(0.015, 0.5, 0.005), accent, -sh + 0.04, 0.3, -0.105, torso);
    mesh(boxGeo(0.015, 0.5, 0.005), accent, sh - 0.04, 0.3, -0.105, torso);
    mesh(boxGeo(0.18, 0.12, 0.04), vest, 0, 0.44, -0.1, torso); // chest harness
  }
  if (st.ghillie) {
    const drape = M(0x6b6b3a, 1);
    mats.push(drape);
    mesh(boxGeo(sh * 2 + 0.14, 0.5, 0.36), drape, 0, 0.32, 0.03, torso, 'body');
    for (let i = 0; i < 6; i++) {
      const strip = mesh(boxGeo(0.06, 0.3, 0.03), i % 2 ? drape : vest, -0.2 + i * 0.08, 0.05, 0.17, torso);
      strip.rotation.x = 0.2;
    }
  }
  // Backpack / radio
  if (!st.bodysuit && !st.cropTop) mesh(boxGeo(0.3, 0.32, 0.13), st.armor ? black : vest, 0, 0.32, 0.19, torso, 'body');
  else mesh(boxGeo(0.18, 0.2, 0.08), black, 0, 0.32, 0.14, torso);
  if (st.scarf) mesh(boxGeo(0.26, 0.08, 0.24), M(0xd6c7a1, 1), 0, 0.57, 0, torso);

  // ---------------- Neck + head
  const neck = new THREE.Group();
  neck.position.set(0, 0.58, 0);
  torso.add(neck);
  mesh(limbGeo(0.055, 0.06, 0.08), skin, 0, 0.08, 0, neck);
  const headR = female ? 0.115 : 0.122;
  const head = mesh(sphereGeo(headR), skin, 0, 0.17, -0.005, neck, 'head');
  head.scale.set(0.92, 1.08, 1.0);
  // Face details
  mesh(boxGeo(0.035, 0.05, 0.03), skin, 0, 0.15, -headR + 0.005, neck, 'head'); // nose
  mesh(boxGeo(0.12, 0.08, 0.1), skin, 0, 0.08, -0.04, neck, 'head'); // jaw
  for (const s of [-1, 1]) mesh(boxGeo(0.025, 0.012, 0.01), black, s * 0.04, 0.185, -headR + 0.01, neck); // eyes
  if (st.beard) mesh(boxGeo(0.13, 0.07, 0.07), hair, 0, 0.075, -0.07, neck, 'head');
  // Hair styles
  const hairTop = (h: number, extraBack = 0) => {
    const cap = mesh(sphereGeo(headR + 0.012), hair, 0, 0.19, 0.005 + extraBack, neck, 'head');
    cap.scale.set(0.95, h, 1.03);
    return cap;
  };
  switch (st.hairStyle) {
    case 'buzz':
      hairTop(0.85);
      break;
    case 'short':
      hairTop(0.95);
      break;
    case 'ponytail': {
      hairTop(1.0);
      const tie = new THREE.Group();
      tie.position.set(0, 0.28, 0.1);
      neck.add(tie);
      mesh(sphereGeo(0.035), hair, 0, 0, 0, tie);
      const tail = mesh(limbGeo(0.04, 0.02, 0.3), hair, 0, -0.01, 0.03, tie);
      tail.rotation.x = 0.35;
      break;
    }
    case 'bob': {
      hairTop(1.02);
      const bob = mesh(boxGeo(0.27, 0.16, 0.24), hair, 0, 0.13, 0.03, neck, 'head');
      bob.scale.set(1, 1, 1);
      mesh(boxGeo(0.2, 0.05, 0.05), hair, 0, 0.27, -0.09, neck); // fringe
      break;
    }
    case 'braid': {
      hairTop(1.02);
      for (let i = 0; i < 6; i++) mesh(sphereGeo(0.038 - i * 0.003), hair, 0, 0.14 - i * 0.07, 0.13 + i * 0.012, neck);
      break;
    }
    case 'long': {
      hairTop(1.02);
      mesh(boxGeo(0.24, 0.36, 0.08), hair, 0, 0.05, 0.1, neck);
      break;
    }
    case 'undercut': {
      const cap = mesh(sphereGeo(headR + 0.005), M(0x52525b, 0.9), 0, 0.17, 0, neck, 'head');
      cap.scale.set(0.97, 1.0, 1.02);
      const swoop = mesh(boxGeo(0.12, 0.08, 0.28), hair, 0.03, 0.3, -0.01, neck, 'head');
      swoop.rotation.z = -0.25;
      const side = mesh(boxGeo(0.05, 0.12, 0.18), hair, -0.08, 0.24, -0.05, neck);
      side.rotation.z = 0.3;
      break;
    }
    default:
      break;
  }
  // Headgear
  switch (st.headgear) {
    case 'helmet': {
      const h = mesh(sphereGeo(headR + 0.035), vest, 0, 0.22, 0.005, neck, 'head');
      h.scale.set(1.02, 0.8, 1.06);
      mesh(boxGeo(0.08, 0.05, 0.04), black, 0, 0.3, -0.13, neck); // NVG mount
      if (st.goggles) {
        mesh(boxGeo(0.2, 0.055, 0.04), black, 0, 0.2, -0.115, neck, 'head');
        mesh(boxGeo(0.17, 0.03, 0.01), accent, 0, 0.2, -0.137, neck);
      }
      break;
    }
    case 'cap': {
      const c = mesh(sphereGeo(headR + 0.02), M(0x1f2937, 0.9), 0, 0.22, 0.0, neck, 'head');
      c.scale.set(1, 0.6, 1.05);
      mesh(boxGeo(0.2, 0.015, 0.12), M(0x1f2937, 0.9), 0, 0.235, -0.15, neck);
      break;
    }
    case 'boonie': {
      const c = mesh(sphereGeo(headR + 0.022), vest, 0, 0.22, 0, neck, 'head');
      c.scale.set(1, 0.65, 1);
      const brim = mesh(cached('brim', () => new THREE.CylinderGeometry(0.22, 0.22, 0.015, 16)), vest, 0, 0.21, 0, neck);
      brim.castShadow = true;
      break;
    }
    case 'heavy': {
      const h = mesh(sphereGeo(headR + 0.045), vest, 0, 0.18, 0, neck, 'head');
      h.scale.set(1.02, 1.05, 1.08);
      mesh(boxGeo(0.21, 0.07, 0.04), black, 0, 0.19, -0.14, neck, 'head'); // visor slit
      mesh(boxGeo(0.18, 0.02, 0.01), accent, 0, 0.19, -0.162, neck);
      mesh(boxGeo(0.2, 0.08, 0.06), vest, 0, 0.07, -0.12, neck, 'head'); // jaw guard
      break;
    }
    case 'visor': {
      const v = mesh(boxGeo(0.24, 0.05, 0.05), accent, 0, 0.19, -0.11, neck, 'head');
      v.rotation.x = -0.05;
      mesh(boxGeo(0.04, 0.06, 0.12), black, -0.12, 0.18, -0.04, neck);
      mesh(boxGeo(0.04, 0.06, 0.12), black, 0.12, 0.18, -0.04, neck);
      break;
    }
    case 'beret': {
      const b = mesh(sphereGeo(headR + 0.02), M(0x18181b, 0.95), 0.025, 0.27, 0.01, neck, 'head');
      b.scale.set(1.05, 0.4, 1.05);
      b.rotation.z = -0.2;
      break;
    }
    default:
      break;
  }
  if (st.mask) mesh(boxGeo(0.16, 0.07, 0.05), black, 0, 0.09, -0.1, neck, 'head');

  // ---------------- Arms (shoulder pivot → elbow pivot)
  const mkArm = (side: -1 | 1) => {
    const arm = new THREE.Group();
    arm.position.set(side * (sh + 0.035), 0.5, 0);
    torso.add(arm);
    const sleeveMat = st.cropTop ? skin : top;
    mesh(limbGeo(0.058 * L, 0.05 * L, 0.29), sleeveMat, 0, 0, 0, arm, 'body');
    if (st.armor) mesh(boxGeo(0.13, 0.14, 0.13), vest, 0, -0.08, 0, arm);
    if (st.cyber) mesh(boxGeo(0.11, 0.03, 0.11), accent, 0, -0.2, 0, arm);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.29, 0);
    arm.add(elbow);
    mesh(limbGeo(0.05 * L, 0.042 * L, 0.26), st.jacket || st.bodysuit ? top : st.cropTop ? skin : top, 0, 0, 0, elbow, 'body');
    // Glove
    mesh(boxGeo(0.075, 0.1, 0.085), gloves, 0, -0.3, 0, elbow);
    if (st.ghillie) mesh(boxGeo(0.12, 0.12, 0.12), M(0x6b6b3a, 1), 0, -0.05, 0, elbow);
    return { arm, elbow };
  };
  const { arm: armL, elbow: elbowL } = mkArm(-1);
  const { arm: armR, elbow: elbowR } = mkArm(1);

  // ---------------- Weapon (held in front of the chest)
  const gun = new THREE.Group();
  gun.position.set(0.06, 0.32, -0.3);
  torso.add(gun);
  const muzzle = new THREE.Object3D();
  gun.add(muzzle);
  let gunModel: THREE.Group | null = null;
  let weapon: WeaponId = opts.weapon ?? 'm16';
  const setWeapon = (w: WeaponId) => {
    weapon = w;
    if (gunModel) {
      gun.remove(gunModel);
      disposeObject(gunModel);
    }
    const m = buildWeaponModel(w);
    m.group.scale.setScalar(w === 'pistol' ? 0.95 : 0.78);
    m.group.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    gunModel = m.group;
    gun.add(m.group);
    muzzle.position.set(0, m.muzzle.position.y * m.group.scale.x, m.muzzleZ * m.group.scale.x);
    rig.weapon = w;
  };

  let nameTag: THREE.Sprite | undefined;
  if (opts.name) {
    nameTag = makeNameTag(opts.name, opts.tagColor ?? '#fca5a5');
    root.add(nameTag);
  }

  const hitMeshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.userData.hitZone) hitMeshes.push(m);
  });

  const rig: CharacterRig = {
    id,
    root,
    body,
    torso,
    neck,
    legL,
    legR,
    kneeL,
    kneeR,
    armL,
    armR,
    elbowL,
    elbowR,
    gun,
    head,
    muzzle,
    hitMeshes,
    nameTag,
    weapon,
    setWeapon,
    dispose() {
      mats.forEach((m) => m.dispose());
      if (gunModel) disposeObject(gunModel);
      if (nameTag) {
        (nameTag.material as THREE.SpriteMaterial).map?.dispose();
        nameTag.material.dispose();
      }
    },
  };
  setWeapon(weapon);
  // Initial aim pose
  animateCharacter(rig, 0, 0, false, 0, 1);
  return rig;
}

const lerp = THREE.MathUtils.lerp;

/**
 * Procedural animation: walk/run cycle with knee bend, crouch (hips drop, knees fold), aim pose
 * (rifle shouldered, both hands on the weapon) and low-ready while moving fast.
 * `blend` = per-call smoothing factor (0..1).
 */
/**
 * Pose a character. `crouch` (0..1) folds the legs; `prone` (0..1) lays the whole body flat on
 * its belly (feet behind the player position, head forward) with the rifle held out in front.
 */
export function animateCharacter(rig: CharacterRig, t: number, speed: number, aiming: boolean, crouch = 0, blend = 0.2, prone = 0) {
  if (prone > 0.5) {
    animateProne(rig, t, speed, blend);
    return;
  }
  rig.body.rotation.x = lerp(rig.body.rotation.x, 0, 0.3);
  rig.body.position.z = lerp(rig.body.position.z, 0, 0.3);
  const run = Math.min(1, speed / 5.5);
  const walk = Math.min(1, speed / 2.5);
  const swing = walk * (0.45 + run * 0.35);
  const ph = t * (4.2 + speed * 1.35);
  const s = Math.sin(ph);
  const c = Math.cos(ph);
  const cr = crouch;

  // Legs: thigh swing + knee bend on the back-swing; crouch folds both
  const thighBase = cr * 0.95;
  rig.legL.rotation.x = lerp(rig.legL.rotation.x, thighBase + s * swing * (1 - cr * 0.5), 0.5);
  rig.legR.rotation.x = lerp(rig.legR.rotation.x, thighBase - s * swing * (1 - cr * 0.5), 0.5);
  rig.kneeL.rotation.x = lerp(rig.kneeL.rotation.x, -cr * 1.9 - Math.max(0, -c) * swing * 1.3, 0.5);
  rig.kneeR.rotation.x = lerp(rig.kneeR.rotation.x, -cr * 1.9 - Math.max(0, c) * swing * 1.3, 0.5);

  // Body: crouch drop + bob, forward lean when running
  rig.body.position.y = lerp(rig.body.position.y, -cr * 0.38 + Math.abs(s) * 0.035 * swing, 0.5);
  rig.torso.rotation.x = lerp(rig.torso.rotation.x, -(run * 0.18 + cr * 0.25), blend);
  rig.torso.rotation.y = lerp(rig.torso.rotation.y, s * swing * 0.12, blend);
  rig.neck.rotation.x = lerp(rig.neck.rotation.x, run * 0.12 + cr * 0.2, blend);

  // Arms: aim = shouldered; otherwise low-ready, swinging slightly while running
  const pistol = rig.weapon === 'pistol';
  const aimAmt = aiming ? 1 : 0;
  const ready = 1 - aimAmt;
  const rShoulderX = aimAmt * (pistol ? 1.45 : 1.25) + ready * (pistol ? 0.9 : 0.75) + ready * s * run * 0.12;
  const lShoulderX = aimAmt * (pistol ? 1.45 : 1.45) + ready * (pistol ? 0.9 : 1.05) - ready * s * run * 0.12;
  rig.armR.rotation.x = lerp(rig.armR.rotation.x, rShoulderX, blend);
  rig.armL.rotation.x = lerp(rig.armL.rotation.x, lShoulderX, blend);
  // Positive z swings the left arm inward (towards the weapon), negative z the right arm.
  rig.armR.rotation.z = lerp(rig.armR.rotation.z, pistol ? -0.3 : -0.12, blend);
  rig.armL.rotation.z = lerp(rig.armL.rotation.z, pistol ? 0.45 : 0.5, blend);
  rig.armR.rotation.y = lerp(rig.armR.rotation.y, 0, blend);
  rig.armL.rotation.y = lerp(rig.armL.rotation.y, 0, blend);
  rig.elbowR.rotation.x = lerp(rig.elbowR.rotation.x, pistol ? 0.15 : aimAmt * 0.7 + ready * 0.9, blend);
  rig.elbowL.rotation.x = lerp(rig.elbowL.rotation.x, pistol ? 0.15 : aimAmt * 0.25 + ready * 0.5, blend);

  // Weapon: shouldered at eye line when aiming, angled down at low-ready
  const gy = pistol ? (aiming ? 0.5 : 0.36) : aiming ? 0.47 : 0.3;
  const gz = pistol ? -0.48 : aiming ? -0.3 : -0.28;
  rig.gun.position.y = lerp(rig.gun.position.y, gy, blend);
  rig.gun.position.z = lerp(rig.gun.position.z, gz, blend);
  rig.gun.position.x = lerp(rig.gun.position.x, pistol ? 0.0 : 0.07, blend);
  rig.gun.rotation.x = lerp(rig.gun.rotation.x, aiming ? 0 : 0.35 + run * 0.1, blend);
  rig.gun.rotation.y = lerp(rig.gun.rotation.y, aiming ? 0 : -0.15, blend);
}

/** Lying flat: body rotated -90° about x around the feet, then slid back so the chest sits on the player. */
function animateProne(rig: CharacterRig, t: number, speed: number, blend: number) {
  const crawl = Math.min(1, speed / 1.1);
  const ph = t * 5.5;
  const s = Math.sin(ph) * crawl;
  rig.body.rotation.x = lerp(rig.body.rotation.x, -Math.PI / 2, 0.3);
  rig.body.position.z = lerp(rig.body.position.z, 1.0, 0.3);
  rig.body.position.y = lerp(rig.body.position.y, 0.16, 0.3);
  // Legs straight back, alternating knee drag while crawling
  rig.legL.rotation.x = lerp(rig.legL.rotation.x, 0.08 + s * 0.35, 0.5);
  rig.legR.rotation.x = lerp(rig.legR.rotation.x, 0.08 - s * 0.35, 0.5);
  rig.kneeL.rotation.x = lerp(rig.kneeL.rotation.x, -0.15 - Math.max(0, s) * 0.9, 0.5);
  rig.kneeR.rotation.x = lerp(rig.kneeR.rotation.x, -0.15 - Math.max(0, -s) * 0.9, 0.5);
  rig.torso.rotation.x = lerp(rig.torso.rotation.x, 0, blend);
  rig.torso.rotation.y = lerp(rig.torso.rotation.y, s * 0.08, blend);
  // Head tilted back so the face looks forward along the ground
  rig.neck.rotation.x = lerp(rig.neck.rotation.x, 1.1, blend);
  // Arms reach forward past the head, holding the weapon out in front
  rig.armR.rotation.x = lerp(rig.armR.rotation.x, 2.85 + s * 0.15, blend);
  rig.armL.rotation.x = lerp(rig.armL.rotation.x, 2.9 - s * 0.15, blend);
  rig.armR.rotation.z = lerp(rig.armR.rotation.z, -0.18, blend);
  rig.armL.rotation.z = lerp(rig.armL.rotation.z, 0.35, blend);
  rig.armR.rotation.y = lerp(rig.armR.rotation.y, 0, blend);
  rig.armL.rotation.y = lerp(rig.armL.rotation.y, 0, blend);
  rig.elbowR.rotation.x = lerp(rig.elbowR.rotation.x, 0.25, blend);
  rig.elbowL.rotation.x = lerp(rig.elbowL.rotation.x, 0.2, blend);
  // Weapon (torso space): beside the head, barrel along the body's +y axis (= world forward)
  rig.gun.position.y = lerp(rig.gun.position.y, 0.72, blend);
  rig.gun.position.z = lerp(rig.gun.position.z, -0.14, blend);
  rig.gun.position.x = lerp(rig.gun.position.x, 0.06, blend);
  rig.gun.rotation.x = lerp(rig.gun.rotation.x, Math.PI / 2, blend);
  rig.gun.rotation.y = lerp(rig.gun.rotation.y, 0, blend);
}

/** Renders each character to a transparent PNG data URL for the avatar selector. */
export function renderCharacterPortraits(width = 180, height = 240): Record<CharacterId, string> {
  const out = {} as Record<CharacterId, string>;
  let renderer: THREE.WebGLRenderer | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xf0f6ff, 0x3a3428, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-1.5, 2.5, -2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x93c5fd, 1.2);
    rim.position.set(2, 1.5, 2);
    scene.add(rim);
    const cam = new THREE.PerspectiveCamera(30, width / height, 0.1, 20);
    cam.position.set(-1.4, 1.35, -3.6);
    cam.lookAt(0, 0.98, 0);
    for (const c of CHARACTERS) {
      const rig = createCharacter(c.id);
      animateCharacter(rig, 0, 0, false, 0, 1);
      rig.root.rotation.y = 0.35;
      scene.add(rig.root);
      renderer.clear();
      renderer.render(scene, cam);
      out[c.id] = renderer.domElement.toDataURL('image/png');
      scene.remove(rig.root);
      rig.dispose();
    }
  } catch {
    /* WebGL unavailable: selector falls back to colour swatches */
  } finally {
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
  return out;
}
