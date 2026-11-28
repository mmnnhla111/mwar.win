import * as THREE from 'three';

/**
 * Prop disguise catalogue for the radial C-menu: 8 small props (inner ring, pass-through) and
 * 25 medium / large props (outer ring: street, military / industrial and indoor furniture; solid colliders
 * other players and bots cannot walk through). Fronts of directional props face local -Z.
 */

export type PropId =
  // inner ring (small)
  | 'traffic_cone'
  | 'cardboard_box'
  | 'toolbox'
  | 'flower_pot'
  | 'gas_canister'
  | 'paint_bucket'
  | 'radio_case'
  | 'stone_bollard'
  // outer ring (medium / large)
  | 'supply_crate'
  | 'oil_drum'
  | 'sandbag_barrier'
  | 'tire_stack'
  | 'park_bench'
  | 'trash_bin'
  | 'fire_hydrant'
  | 'potted_tree'
  | 'wooden_pallet'
  | 'generator_box'
  | 'mailbox'
  | 'ammo_chest'
  // indoor furniture (outer ring, solid) — placed inside buildings via placeDisguiseProp
  | 'office_desk'
  | 'office_chair'
  | 'filing_cabinet'
  | 'metal_locker'
  | 'storage_shelf'
  | 'bunk_bed'
  | 'tv_stand'
  | 'water_cooler'
  | 'sofa'
  // street / roadside (outer ring, solid)
  | 'road_barrier'
  | 'dumpster'
  | 'utility_box'
  | 'planter_box';

export interface PropDef {
  id: PropId;
  name: string;
  icon: string;
  ring: 'inner' | 'outer';
  /** Solid collider (outer ring) vs pass-through (inner ring). */
  solid: boolean;
  /** Collider footprint (w × d) and height in metres. */
  size: [number, number, number];
}

export const PROPS: PropDef[] = [
  { id: 'traffic_cone', name: 'Traffic Cone', icon: '🚧', ring: 'inner', solid: false, size: [0.4, 0.4, 0.7] },
  { id: 'cardboard_box', name: 'Cardboard Box', icon: '📦', ring: 'inner', solid: false, size: [0.6, 0.5, 0.45] },
  { id: 'toolbox', name: 'Small Toolbox', icon: '🧰', ring: 'inner', solid: false, size: [0.55, 0.3, 0.35] },
  { id: 'flower_pot', name: 'Flower Pot', icon: '🪴', ring: 'inner', solid: false, size: [0.45, 0.45, 0.75] },
  { id: 'gas_canister', name: 'Gas Canister', icon: '⛽', ring: 'inner', solid: false, size: [0.35, 0.25, 0.5] },
  { id: 'paint_bucket', name: 'Paint Bucket', icon: '🪣', ring: 'inner', solid: false, size: [0.35, 0.35, 0.42] },
  { id: 'radio_case', name: 'Tactical Radio Case', icon: '📻', ring: 'inner', solid: false, size: [0.5, 0.35, 0.4] },
  { id: 'stone_bollard', name: 'Stone Bollard', icon: '🗿', ring: 'inner', solid: false, size: [0.4, 0.4, 0.85] },
  { id: 'supply_crate', name: 'Wooden Supply Crate', icon: '🟫', ring: 'outer', solid: true, size: [1.2, 1.2, 1.2] },
  { id: 'oil_drum', name: 'Steel Oil Drum', icon: '🛢️', ring: 'outer', solid: true, size: [0.75, 0.75, 1.0] },
  { id: 'sandbag_barrier', name: 'Sandbag Barrier', icon: '🧱', ring: 'outer', solid: true, size: [1.8, 0.8, 0.9] },
  { id: 'tire_stack', name: 'Tire Stack', icon: '🛞', ring: 'outer', solid: true, size: [0.9, 0.9, 1.0] },
  { id: 'park_bench', name: 'Park Bench', icon: '🪑', ring: 'outer', solid: true, size: [1.8, 0.7, 0.9] },
  { id: 'trash_bin', name: 'Trash Bin', icon: '🗑️', ring: 'outer', solid: true, size: [0.8, 0.8, 1.15] },
  { id: 'fire_hydrant', name: 'Fire Hydrant', icon: '🚒', ring: 'outer', solid: true, size: [0.55, 0.55, 0.9] },
  { id: 'potted_tree', name: 'Potted Tree', icon: '🌳', ring: 'outer', solid: true, size: [0.9, 0.9, 2.2] },
  { id: 'wooden_pallet', name: 'Wooden Pallet', icon: '🪵', ring: 'outer', solid: true, size: [1.2, 1.0, 0.75] },
  { id: 'generator_box', name: 'Power Generator Box', icon: '⚡', ring: 'outer', solid: true, size: [1.4, 0.9, 1.1] },
  { id: 'mailbox', name: 'Street Mailbox', icon: '📮', ring: 'outer', solid: true, size: [0.6, 0.55, 1.25] },
  { id: 'ammo_chest', name: 'Heavy Ammo Chest', icon: '🧳', ring: 'outer', solid: true, size: [1.1, 0.65, 0.7] },
  // Indoor furniture (sizes are the contract for interior layouts: footprint w × d, height h, origin at base centre)
  { id: 'office_desk', name: 'Office Desk', icon: '🗄️', ring: 'outer', solid: true, size: [1.4, 0.7, 0.76] },
  { id: 'office_chair', name: 'Office Chair', icon: '💺', ring: 'outer', solid: true, size: [0.6, 0.6, 1.0] },
  { id: 'filing_cabinet', name: 'Filing Cabinet', icon: '🗃️', ring: 'outer', solid: true, size: [0.5, 0.6, 1.3] },
  { id: 'metal_locker', name: 'Metal Locker', icon: '🚪', ring: 'outer', solid: true, size: [0.6, 0.5, 1.85] },
  { id: 'storage_shelf', name: 'Storage Shelf', icon: '📚', ring: 'outer', solid: true, size: [1.2, 0.45, 1.9] },
  { id: 'bunk_bed', name: 'Bunk Bed', icon: '🛏️', ring: 'outer', solid: true, size: [2.0, 0.95, 1.6] },
  { id: 'tv_stand', name: 'TV & Stand', icon: '📺', ring: 'outer', solid: true, size: [1.2, 0.45, 1.1] },
  { id: 'water_cooler', name: 'Water Cooler', icon: '🚰', ring: 'outer', solid: true, size: [0.4, 0.4, 1.25] },
  { id: 'sofa', name: 'Sofa', icon: '🛋️', ring: 'outer', solid: true, size: [1.9, 0.85, 0.85] },
  // Street / roadside
  { id: 'road_barrier', name: 'Road Barrier', icon: '🚧', ring: 'outer', solid: true, size: [1.6, 0.4, 1.0] },
  { id: 'dumpster', name: 'Dumpster', icon: '🗑️', ring: 'outer', solid: true, size: [1.9, 1.1, 1.35] },
  { id: 'utility_box', name: 'Electrical Utility Box', icon: '🔌', ring: 'outer', solid: true, size: [0.8, 0.45, 1.3] },
  { id: 'planter_box', name: 'Planter Box', icon: '🌿', ring: 'outer', solid: true, size: [1.4, 0.6, 0.7] },
];

export const INNER_PROPS = PROPS.filter((p) => p.ring === 'inner');
export const OUTER_PROPS = PROPS.filter((p) => p.ring === 'outer');

export function propDef(id: PropId) {
  return PROPS.find((p) => p.id === id) ?? PROPS[8];
}

function std(color: number, roughness = 0.8, metalness = 0.05) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function add(g: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

// Shared geometry cache: the same box / cylinder dimensions reuse one BufferGeometry across every prop model
// (never mutate a cached geometry; per-mesh position / rotation / scale live on the Mesh).
const geoCache = new Map<string, THREE.BufferGeometry>();
const B = (w: number, h: number, d: number) => {
  const k = `B${w}|${h}|${d}`;
  let g = geoCache.get(k);
  if (!g) geoCache.set(k, (g = new THREE.BoxGeometry(w, h, d)));
  return g;
};
const C = (rt: number, rb: number, h: number, seg = 16) => {
  const k = `C${rt}|${rb}|${h}|${seg}`;
  let g = geoCache.get(k);
  if (!g) geoCache.set(k, (g = new THREE.CylinderGeometry(rt, rb, h, seg)));
  return g;
};
const SPH = (r: number, ws = 10, hs = 8) => {
  const k = `S${r}|${ws}|${hs}`;
  let g = geoCache.get(k);
  if (!g) geoCache.set(k, (g = new THREE.SphereGeometry(r, ws, hs)));
  return g;
};
/** Box mesh shorthand: size (w,h,d), centre (x,y,z), optional Euler rotation. */
const box = (g: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
  add(g as THREE.Group, B(w, h, d), mat, x, y, z, rx, ry, rz);
/** Cylinder mesh shorthand (axis = Y unless rotated). */
const cyl = (g: THREE.Object3D, mat: THREE.Material, rt: number, rb: number, h: number, x: number, y: number, z: number, seg = 12, rx = 0, ry = 0, rz = 0) =>
  add(g as THREE.Group, C(rt, rb, h, seg), mat, x, y, z, rx, ry, rz);

/** Builds the 3D model for a disguise prop; origin at its base centre. */
export function createPropModel(id: PropId): THREE.Group {
  const g = new THREE.Group();
  switch (id) {
    case 'traffic_cone': {
      const orange = std(0xf97316, 0.6);
      const white = std(0xf8fafc, 0.5);
      add(g, B(0.42, 0.04, 0.42), std(0x1f2937, 0.8), 0, 0.02, 0);
      add(g, C(0.03, 0.17, 0.64), orange, 0, 0.36, 0);
      add(g, C(0.085, 0.12, 0.1), white, 0, 0.36, 0);
      add(g, C(0.05, 0.075, 0.07), white, 0, 0.54, 0);
      break;
    }
    case 'cardboard_box': {
      const card = std(0xb08455, 0.95);
      add(g, B(0.6, 0.45, 0.5), card, 0, 0.225, 0);
      add(g, B(0.61, 0.02, 0.08), std(0xd6c29c, 0.8), 0, 0.455, 0);
      add(g, B(0.2, 0.12, 0.005), std(0xf5f5f4, 0.9), 0.12, 0.25, -0.252);
      break;
    }
    case 'toolbox': {
      const red = std(0xdc2626, 0.45, 0.4);
      add(g, B(0.55, 0.26, 0.3), red, 0, 0.13, 0);
      add(g, B(0.56, 0.03, 0.31), std(0x111827, 0.5, 0.5), 0, 0.2, 0);
      add(g, B(0.3, 0.03, 0.04), std(0x9ca3af, 0.4, 0.8), 0, 0.33, 0);
      add(g, B(0.03, 0.07, 0.04), std(0x9ca3af, 0.4, 0.8), -0.14, 0.29, 0);
      add(g, B(0.03, 0.07, 0.04), std(0x9ca3af, 0.4, 0.8), 0.14, 0.29, 0);
      break;
    }
    case 'flower_pot': {
      add(g, C(0.22, 0.16, 0.38), std(0xb45309, 0.9), 0, 0.19, 0);
      add(g, C(0.2, 0.2, 0.03), std(0x3f2a1d, 1), 0, 0.37, 0);
      const leaf = std(0x16a34a, 0.9);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        add(g, new THREE.SphereGeometry(0.11, 8, 6), leaf, Math.cos(a) * 0.1, 0.5 + (i % 2) * 0.08, Math.sin(a) * 0.1);
      }
      add(g, new THREE.SphereGeometry(0.06, 8, 6), std(0xf472b6, 0.7), 0.05, 0.68, 0.02);
      break;
    }
    case 'gas_canister': {
      const red = std(0xb91c1c, 0.5, 0.3);
      add(g, B(0.32, 0.42, 0.2), red, 0, 0.21, 0);
      add(g, B(0.2, 0.05, 0.05), red, -0.04, 0.47, 0);
      add(g, C(0.03, 0.03, 0.1), std(0xfacc15, 0.5), 0.11, 0.47, 0, 0, 0, -0.5);
      break;
    }
    case 'paint_bucket': {
      add(g, C(0.17, 0.15, 0.38), std(0xe5e7eb, 0.5, 0.3), 0, 0.19, 0);
      add(g, C(0.172, 0.172, 0.1), std(0x2563eb, 0.6), 0, 0.22, 0);
      add(g, new THREE.TorusGeometry(0.15, 0.008, 6, 20, Math.PI), std(0x6b7280, 0.4, 0.8), 0, 0.38, 0);
      break;
    }
    case 'radio_case': {
      const od = std(0x4d5b3a, 0.8);
      add(g, B(0.5, 0.34, 0.32), od, 0, 0.17, 0);
      add(g, B(0.52, 0.04, 0.34), std(0x1f2937, 0.6), 0, 0.3, 0);
      add(g, C(0.008, 0.008, 0.6, 6), std(0x111111, 0.5), 0.18, 0.62, 0.08);
      add(g, B(0.12, 0.06, 0.005), std(0x22c55e, 0.3), -0.1, 0.18, -0.162);
      break;
    }
    case 'stone_bollard': {
      const stone = std(0x9ca3af, 0.95);
      add(g, C(0.16, 0.19, 0.75, 12), stone, 0, 0.375, 0);
      add(g, new THREE.SphereGeometry(0.16, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), stone, 0, 0.75, 0);
      add(g, C(0.195, 0.195, 0.06, 12), std(0x6b7280, 0.9), 0, 0.12, 0);
      break;
    }
    case 'supply_crate': {
      const wood = std(0x9a6b3f, 0.9);
      const dark = std(0x5b3d22, 0.9);
      add(g, B(1.2, 1.2, 1.2), wood, 0, 0.6, 0);
      for (const y of [0.05, 1.15]) {
        add(g, B(1.22, 0.1, 0.12), dark, 0, y, -0.55);
        add(g, B(1.22, 0.1, 0.12), dark, 0, y, 0.55);
        add(g, B(0.12, 0.1, 1.22), dark, -0.55, y, 0);
        add(g, B(0.12, 0.1, 1.22), dark, 0.55, y, 0);
      }
      add(g, B(1.22, 0.12, 0.08), dark, 0, 0.6, -0.6, 0, 0, 0.78);
      add(g, B(0.08, 0.12, 1.22), dark, 0.6, 0.6, 0, 0.78, 0, 0);
      break;
    }
    case 'oil_drum': {
      const blue = std(0x1d4ed8, 0.5, 0.45);
      add(g, C(0.36, 0.36, 0.98, 20), blue, 0, 0.49, 0);
      for (const y of [0.02, 0.33, 0.66, 0.96]) add(g, C(0.37, 0.37, 0.04, 20), std(0x1e3a8a, 0.4, 0.6), 0, y, 0);
      add(g, C(0.05, 0.05, 0.02, 10), std(0x9ca3af, 0.4, 0.8), 0.18, 0.99, 0);
      break;
    }
    case 'sandbag_barrier': {
      const bag = std(0xa89272, 1);
      for (let row = 0; row < 3; row++) {
        const n = 3 - (row === 2 ? 1 : 0);
        for (let i = 0; i < n; i++) {
          const x = (i - (n - 1) / 2) * 0.58;
          const m = add(g, new THREE.CapsuleGeometry(0.13, 0.34, 4, 10), bag, x, 0.14 + row * 0.27, row % 2 ? 0.05 : -0.05, 0, 0, Math.PI / 2);
          m.scale.set(1, 1, 1.8);
        }
      }
      break;
    }
    case 'tire_stack': {
      const rubber = std(0x18181b, 0.95);
      for (let i = 0; i < 4; i++) {
        const t = add(g, new THREE.TorusGeometry(0.32, 0.12, 10, 22), rubber, (i % 2) * 0.04, 0.12 + i * 0.24, 0, Math.PI / 2, 0, 0);
        t.castShadow = true;
      }
      break;
    }
    case 'park_bench': {
      const wood = std(0x92400e, 0.8);
      const iron = std(0x1f2937, 0.5, 0.6);
      for (let i = 0; i < 3; i++) add(g, B(1.8, 0.05, 0.12), wood, 0, 0.45, -0.18 + i * 0.15);
      for (let i = 0; i < 2; i++) add(g, B(1.8, 0.12, 0.04), wood, 0, 0.65 + i * 0.16, 0.26, -0.15, 0, 0);
      for (const x of [-0.78, 0.78]) {
        add(g, B(0.06, 0.45, 0.5), iron, x, 0.225, 0);
        add(g, B(0.06, 0.5, 0.05), iron, x, 0.7, 0.26);
      }
      break;
    }
    case 'trash_bin': {
      const green = std(0x166534, 0.6, 0.2);
      add(g, B(0.75, 1.0, 0.75), green, 0, 0.5, 0);
      add(g, B(0.8, 0.1, 0.8), std(0x14532d, 0.5, 0.2), 0, 1.05, 0);
      add(g, B(0.4, 0.04, 0.06), std(0x9ca3af, 0.4, 0.7), 0, 1.12, -0.25);
      for (const [x, z] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) add(g, C(0.06, 0.06, 0.05, 8), std(0x111111), x, 0.02, z, Math.PI / 2);
      break;
    }
    case 'fire_hydrant': {
      const red = std(0xdc2626, 0.45, 0.35);
      add(g, C(0.22, 0.24, 0.08), red, 0, 0.04, 0);
      add(g, C(0.15, 0.16, 0.58), red, 0, 0.37, 0);
      add(g, new THREE.SphereGeometry(0.16, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), red, 0, 0.66, 0);
      add(g, C(0.03, 0.04, 0.06), std(0xfacc15, 0.4, 0.5), 0, 0.84, 0);
      for (const s of [-1, 1]) add(g, C(0.06, 0.06, 0.12), std(0xfacc15, 0.4, 0.5), s * 0.2, 0.46, 0, 0, 0, Math.PI / 2);
      add(g, C(0.08, 0.08, 0.1), std(0xfacc15, 0.4, 0.5), 0, 0.42, -0.19, Math.PI / 2);
      break;
    }
    case 'potted_tree': {
      add(g, B(0.85, 0.55, 0.85), std(0x78716c, 0.9), 0, 0.275, 0);
      add(g, B(0.75, 0.04, 0.75), std(0x3f2a1d, 1), 0, 0.56, 0);
      add(g, C(0.05, 0.08, 1.0, 8), std(0x6b4423, 0.9), 0, 1.05, 0);
      const leaf = std(0x15803d, 0.9);
      add(g, new THREE.IcosahedronGeometry(0.45, 1), leaf, 0, 1.7, 0);
      add(g, new THREE.IcosahedronGeometry(0.32, 1), leaf, 0.22, 1.5, 0.12);
      add(g, new THREE.IcosahedronGeometry(0.3, 1), leaf, -0.2, 1.55, -0.15);
      break;
    }
    case 'wooden_pallet': {
      const wood = std(0xc29a6b, 0.9);
      // Two pallets stacked, one leaning
      for (let k = 0; k < 2; k++) {
        const y = k * 0.15;
        for (let i = 0; i < 5; i++) add(g, B(0.12, 0.025, 1.0), wood, -0.48 + i * 0.24, y + 0.135, 0);
        for (const z of [-0.42, 0, 0.42]) add(g, B(1.2, 0.1, 0.1), std(0xa77d4f, 0.9), 0, y + 0.07, z);
      }
      const lean = new THREE.Group();
      for (let i = 0; i < 5; i++) add(lean, B(0.12, 0.025, 1.0), wood, -0.48 + i * 0.24, 0, 0);
      lean.position.set(0, 0.6, 0.42);
      lean.rotation.x = -1.15;
      g.add(lean);
      break;
    }
    case 'generator_box': {
      const yellow = std(0xeab308, 0.5, 0.3);
      add(g, B(1.4, 0.9, 0.85), yellow, 0, 0.5, 0);
      add(g, B(1.45, 0.08, 0.9), std(0x1f2937, 0.6, 0.4), 0, 0.04, 0);
      for (let i = 0; i < 6; i++) add(g, B(0.5, 0.03, 0.005), std(0x111827), -0.3, 0.4 + i * 0.07, -0.428);
      add(g, B(0.25, 0.2, 0.005), std(0x111827), 0.4, 0.6, -0.428);
      add(g, B(0.08, 0.08, 0.005), std(0xef4444, 0.3), 0.4, 0.6, -0.432);
      add(g, C(0.05, 0.05, 0.25, 8), std(0x52525b, 0.5, 0.7), 0.55, 1.05, 0.2);
      break;
    }
    case 'mailbox': {
      const blue = std(0x1e40af, 0.5, 0.35);
      add(g, B(0.08, 0.35, 0.08), std(0x1f2937, 0.5, 0.5), -0.18, 0.17, 0);
      add(g, B(0.08, 0.35, 0.08), std(0x1f2937, 0.5, 0.5), 0.18, 0.17, 0);
      add(g, B(0.55, 0.65, 0.5), blue, 0, 0.67, 0);
      const top = add(g, C(0.25, 0.25, 0.55, 16, ), blue, 0, 1.0, 0, 0, 0, Math.PI / 2);
      top.scale.set(1, 1, 1);
      add(g, B(0.34, 0.04, 0.02), std(0x111827), 0, 0.92, -0.255);
      add(g, B(0.3, 0.12, 0.005), std(0xf8fafc, 0.8), 0, 0.65, -0.252);
      break;
    }
    case 'ammo_chest': {
      const od = std(0x4b5320, 0.75, 0.25);
      add(g, B(1.1, 0.6, 0.65), od, 0, 0.3, 0);
      add(g, B(1.12, 0.06, 0.67), std(0x3f4419, 0.7, 0.3), 0, 0.55, 0);
      for (const x of [-0.42, 0.42]) add(g, B(0.08, 0.12, 0.69), std(0x2d3112, 0.6, 0.4), x, 0.3, 0);
      add(g, B(0.4, 0.08, 0.005), std(0xfacc15, 0.6), 0, 0.33, -0.33);
      for (const x of [-0.56, 0.56]) add(g, B(0.03, 0.05, 0.2), std(0x111111, 0.4, 0.7), x, 0.4, 0);
      break;
    }
    // ---------------------------------------------------------------------------------------------
    // Indoor furniture. Extents match PROPS[id].size (w × d × h); the "front" faces local -Z.
    // ---------------------------------------------------------------------------------------------
    case 'office_desk': {
      const top = std(0xa8754a, 0.5, 0.05);
      const wood = std(0x8a5a33, 0.7);
      const front = std(0x9b6a40, 0.6);
      const chrome = std(0xb6bcc6, 0.3, 0.85);
      const dark = std(0x1f2937, 0.5, 0.3);
      box(g, top, 1.4, 0.04, 0.7, 0, 0.72, 0); // worktop 0.70–0.74
      // left drawer pedestal
      box(g, dark, 0.38, 0.04, 0.6, -0.5, 0.02, 0);
      box(g, wood, 0.4, 0.66, 0.62, -0.5, 0.37, 0);
      for (let i = 0; i < 3; i++) {
        const y = 0.15 + i * 0.205;
        box(g, front, 0.36, 0.185, 0.02, -0.5, y + 0.06, -0.32);
        box(g, chrome, 0.13, 0.02, 0.02, -0.5, y + 0.1, -0.34);
      }
      // right side panel + modesty panel
      box(g, wood, 0.04, 0.66, 0.62, 0.66, 0.37, 0);
      box(g, wood, 0.92, 0.4, 0.02, 0.17, 0.5, 0.29);
      box(g, dark, 0.04, 0.03, 0.62, 0.66, 0.015, 0);
      // desk pad, keyboard, mouse, loose papers
      box(g, std(0x1f3a2f, 0.9), 0.72, 0.004, 0.4, 0.2, 0.742, -0.05);
      box(g, dark, 0.42, 0.014, 0.14, 0.15, 0.751, -0.14);
      box(g, std(0x111827, 0.4, 0.2), 0.06, 0.02, 0.1, 0.5, 0.75, -0.1);
      box(g, std(0xf8fafc, 0.9), 0.22, 0.012, 0.3, -0.4, 0.746, 0.05, 0, 0.25, 0);
      box(g, std(0xfacc15, 0.7), 0.07, 0.014, 0.07, -0.3, 0.754, -0.22, 0, 0.3, 0);
      break;
    }
    case 'office_chair': {
      const fab = std(0x374151, 0.95);
      const blk = std(0x111827, 0.5, 0.4);
      const chrome = std(0xa1a1aa, 0.3, 0.85);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + Math.PI / 2;
        box(g, blk, 0.27, 0.035, 0.05, Math.cos(a) * 0.135, 0.076, -Math.sin(a) * 0.135, 0, a, 0);
        add(g, SPH(0.03, 8, 6), blk, Math.cos(a) * 0.25, 0.03, -Math.sin(a) * 0.25);
      }
      cyl(g, blk, 0.05, 0.06, 0.05, 0, 0.09, 0, 10);
      cyl(g, chrome, 0.025, 0.03, 0.33, 0, 0.27, 0, 10);
      box(g, blk, 0.22, 0.04, 0.2, 0, 0.45, 0);
      box(g, fab, 0.5, 0.08, 0.48, 0, 0.5, -0.01); // seat 0.46–0.54
      box(g, std(0x4b5563, 0.9), 0.46, 0.02, 0.1, 0, 0.545, -0.2); // front waterfall pad
      box(g, blk, 0.06, 0.3, 0.04, 0, 0.62, 0.2, 0.12);
      box(g, fab, 0.44, 0.46, 0.07, 0, 0.74, 0.23, 0.12); // backrest
      box(g, std(0x2563eb, 0.8), 0.36, 0.1, 0.012, 0, 0.74, 0.19, 0.12); // lumbar accent
      for (const s of [-1, 1]) {
        box(g, blk, 0.045, 0.025, 0.26, s * 0.265, 0.68, 0.02);
        box(g, blk, 0.03, 0.14, 0.03, s * 0.265, 0.6, 0.06);
      }
      break;
    }
    case 'filing_cabinet': {
      const body = std(0x8b95a1, 0.5, 0.45);
      const front = std(0x9aa4b0, 0.45, 0.5);
      const chrome = std(0xd1d5db, 0.3, 0.85);
      const dark = std(0x1f2937, 0.6, 0.3);
      box(g, dark, 0.46, 0.04, 0.54, 0, 0.02, 0);
      box(g, body, 0.48, 1.22, 0.56, 0, 0.65, 0);
      box(g, std(0x6b7280, 0.45, 0.5), 0.5, 0.02, 0.6, 0, 1.29, 0);
      for (let k = 0; k < 4; k++) {
        const y = 0.2125 + k * 0.3;
        box(g, front, 0.44, 0.285, 0.025, 0, y + 0.0, -0.29);
        box(g, chrome, 0.14, 0.03, 0.02, 0, y + 0.07, -0.31);
        box(g, std(0xf1f5f9, 0.8), 0.1, 0.045, 0.004, 0, y - 0.04, -0.304);
      }
      cyl(g, chrome, 0.012, 0.012, 0.01, 0.17, 1.1, -0.306, 8, Math.PI / 2);
      break;
    }
    case 'metal_locker': {
      const body = std(0x3f5f7f, 0.5, 0.5);
      const door = std(0x4b6f94, 0.45, 0.5);
      const dark = std(0x0f172a, 0.6, 0.3);
      const chrome = std(0xd1d5db, 0.3, 0.85);
      for (const x of [-0.25, 0.25]) for (const z of [-0.2, 0.2]) box(g, dark, 0.06, 0.04, 0.06, x, 0.02, z);
      box(g, body, 0.6, 1.77, 0.48, 0, 0.925, 0.01);
      box(g, std(0x5b7da0, 0.5, 0.5), 0.62, 0.04, 0.5, 0, 1.83, 0);
      for (const s of [-1, 1]) {
        const x = s * 0.1475;
        box(g, door, 0.285, 1.7, 0.025, x, 0.93, -0.2425);
        for (let i = 0; i < 4; i++) box(g, dark, 0.17, 0.015, 0.006, x, 1.62 + i * 0.045 - 0.05, -0.257);
        for (let i = 0; i < 3; i++) box(g, dark, 0.17, 0.015, 0.006, x, 0.18 + i * 0.045, -0.257);
        box(g, std(0xf1f5f9, 0.8), 0.07, 0.04, 0.005, x, 1.4, -0.257);
        box(g, chrome, 0.025, 0.14, 0.02, s * 0.04, 0.95, -0.265);
      }
      break;
    }
    case 'storage_shelf': {
      const post = std(0x1d4ed8, 0.5, 0.4);
      const board = std(0xb8c0cc, 0.5, 0.5);
      const card = std(0xb08455, 0.95);
      const tape = std(0xd6c29c, 0.8);
      const shelfY = [0.1, 0.52, 0.94, 1.36];
      for (const x of [-0.58, 0.58]) for (const z of [-0.2, 0.2]) box(g, post, 0.045, 1.9, 0.045, x, 0.95, z);
      for (const y of [...shelfY, 1.885]) box(g, board, 1.2, 0.03, 0.45, 0, y, 0);
      // diagonal back braces (top bay)
      const bl = Math.hypot(1.14, 0.45);
      box(g, post, bl, 0.012, 0.012, 0, 1.63, 0.215, 0, 0, 0.376);
      box(g, post, bl, 0.012, 0.012, 0, 1.63, 0.215, 0, 0, -0.376);
      // shelf 0: cardboard boxes
      box(g, card, 0.34, 0.3, 0.34, -0.38, 0.265, 0);
      box(g, tape, 0.35, 0.02, 0.07, -0.38, 0.42, 0);
      box(g, card, 0.4, 0.22, 0.3, 0.05, 0.225, 0.02);
      box(g, card, 0.3, 0.34, 0.3, 0.43, 0.285, -0.02);
      box(g, tape, 0.31, 0.02, 0.07, 0.43, 0.46, -0.02);
      // shelf 1: paint cans + toolbox
      const paint = [0xe5e7eb, 0x2563eb, 0xdc2626, 0xeab308];
      for (let i = 0; i < 4; i++) {
        cyl(g, std(paint[i], 0.5, 0.35), 0.075, 0.075, 0.17, -0.45 + (i % 2) * 0.17, 0.62, -0.1 + Math.floor(i / 2) * 0.2, 12);
        cyl(g, std(0x6b7280, 0.4, 0.8), 0.077, 0.077, 0.015, -0.45 + (i % 2) * 0.17, 0.71, -0.1 + Math.floor(i / 2) * 0.2, 12);
      }
      box(g, std(0xdc2626, 0.45, 0.4), 0.4, 0.2, 0.25, 0.25, 0.63, 0);
      box(g, std(0x111827, 0.5, 0.5), 0.41, 0.02, 0.26, 0.25, 0.69, 0);
      // shelf 2: binders
      const bind = [0x1d4ed8, 0xdc2626, 0x15803d, 0xeab308, 0x7c3aed, 0x0f172a, 0x1d4ed8, 0xea580c, 0x15803d, 0xdc2626, 0x0ea5e9, 0x0f172a];
      for (let i = 0; i < bind.length; i++) box(g, std(bind[i], 0.7), 0.05, 0.3, 0.26, -0.5 + i * 0.058, 1.105, 0.0);
      // shelf 3: plastic bins
      box(g, std(0x38bdf8, 0.3, 0.1), 0.45, 0.28, 0.34, -0.3, 1.525, 0);
      box(g, std(0x0284c7, 0.35, 0.1), 0.47, 0.04, 0.36, -0.3, 1.685, 0);
      box(g, std(0xf97316, 0.35, 0.1), 0.4, 0.22, 0.32, 0.22, 1.495, 0);
      box(g, std(0xea580c, 0.35, 0.1), 0.42, 0.04, 0.34, 0.22, 1.625, 0);
      break;
    }
    case 'bunk_bed': {
      const frame = std(0x8a5a2b, 0.75);
      const slat = std(0xa87a4a, 0.8);
      const mat = std(0x6b7280, 0.95);
      const blanket = std(0x4d5b3a, 0.95);
      const pillow = std(0xf1f5f9, 0.95);
      for (const x of [-0.965, 0.965]) for (const z of [-0.44, 0.44]) box(g, frame, 0.06, 1.6, 0.06, x, 0.8, z);
      for (const y of [0.22, 0.97]) {
        for (const z of [-0.44, 0.44]) box(g, frame, 1.94, 0.1, 0.03, 0, y, z);
        for (const x of [-0.965, 0.965]) box(g, frame, 0.03, 0.1, 0.84, x, y, 0);
        box(g, slat, 1.9, 0.025, 0.84, 0, y - 0.015, 0);
        box(g, mat, 1.88, 0.15, 0.82, 0, y + 0.075, 0);
        box(g, blanket, 1.0, 0.03, 0.83, 0.4, y + 0.165, 0);
        box(g, pillow, 0.4, 0.07, 0.55, -0.7, y + 0.185, 0);
      }
      // upper bunk guard rails (front has a ladder gap)
      for (const y of [1.25, 1.42]) {
        box(g, frame, 1.94, 0.04, 0.03, 0, y, 0.44);
        box(g, frame, 1.1, 0.04, 0.03, -0.42, y, -0.44);
        box(g, frame, 0.03, 0.04, 0.84, -0.965, y, 0);
        box(g, frame, 0.03, 0.04, 0.84, 0.965, y, 0);
      }
      // ladder on the front
      for (const x of [0.45, 0.85]) box(g, frame, 0.04, 1.06, 0.03, x, 0.58, -0.455);
      for (let i = 0; i < 5; i++) box(g, frame, 0.4, 0.03, 0.03, 0.65, 0.22 + i * 0.19, -0.455);
      break;
    }
    case 'tv_stand': {
      const wood = std(0x3f2a1d, 0.65, 0.05);
      const door = std(0x57402b, 0.6, 0.05);
      const chrome = std(0xd1d5db, 0.3, 0.85);
      const blackPl = std(0x0b0f14, 0.35, 0.3);
      for (const x of [-0.55, 0.55]) for (const z of [-0.17, 0.17]) box(g, blackPl, 0.05, 0.06, 0.05, x, 0.03, z);
      box(g, wood, 1.2, 0.44, 0.42, 0, 0.28, 0);
      for (const s of [-1, 1]) {
        box(g, door, 0.57, 0.38, 0.02, s * 0.295, 0.28, -0.215);
        box(g, chrome, 0.015, 0.1, 0.02, s * 0.03, 0.28, -0.235);
      }
      box(g, std(0x2a1c12, 0.7), 1.22, 0.02, 0.44, 0, 0.51, 0); // top board
      box(g, blackPl, 0.4, 0.02, 0.2, 0, 0.53, 0.02); // TV foot
      box(g, blackPl, 0.08, 0.06, 0.04, 0, 0.56, 0.03); // neck
      box(g, blackPl, 1.1, 0.54, 0.05, 0, 0.83, 0.03); // bezel 0.56–1.10
      box(g, std(0x0f172a, 0.12, 0.7), 1.05, 0.49, 0.01, 0, 0.83, 0.0); // screen glass
      box(g, std(0x1e3a8a, 0.2, 0.4), 0.36, 0.15, 0.004, -0.25, 0.9, -0.0065, 0, 0, 0.35);
      box(g, std(0xef4444, 0.3), 0.02, 0.01, 0.004, 0.45, 0.575, -0.0065);
      break;
    }
    case 'water_cooler': {
      const white = std(0xe5e7eb, 0.4, 0.15);
      const gray = std(0xcbd5e1, 0.45, 0.2);
      const dark = std(0x374151, 0.5, 0.4);
      box(g, dark, 0.34, 0.03, 0.34, 0, 0.015, 0);
      box(g, white, 0.34, 0.4, 0.34, 0, 0.23, 0); // lower cabinet
      box(g, gray, 0.38, 0.4, 0.36, 0, 0.63, 0); // dispenser housing 0.43–0.83
      box(g, dark, 0.26, 0.13, 0.01, 0, 0.66, -0.185); // tap recess
      box(g, std(0x3b82f6, 0.4), 0.04, 0.05, 0.03, -0.06, 0.68, -0.195);
      box(g, std(0xef4444, 0.4), 0.04, 0.05, 0.03, 0.06, 0.68, -0.195);
      box(g, std(0xf8fafc, 0.5), 0.1, 0.012, 0.01, 0, 0.78, -0.186); // label
      box(g, dark, 0.2, 0.018, 0.1, 0, 0.59, -0.15); // drip tray
      box(g, dark, 0.2, 0.012, 0.1, 0, 0.597, -0.15);
      cyl(g, std(0x60a5fa, 0.15, 0.1), 0.13, 0.13, 0.3, 0, 0.97, 0, 20); // bottle 0.82–1.12
      add(g, new THREE.SphereGeometry(0.13, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), std(0x60a5fa, 0.15, 0.1), 0, 1.12, 0).scale.y = 0.8;
      cyl(g, std(0x2563eb, 0.5), 0.045, 0.045, 0.03, 0, 1.235, 0, 10);
      box(g, std(0x93c5fd, 0.1), 0.006, 0.24, 0.006, 0.1, 0.97, -0.1);
      break;
    }
    case 'sofa': {
      const frame = std(0x2f4f55, 0.9);
      const seat = std(0x3d7580, 0.95);
      const back = std(0x4a8a96, 0.95);
      const leg = std(0x3f2a1d, 0.6);
      for (const x of [-0.88, 0.88]) for (const z of [-0.36, 0.36]) box(g, leg, 0.07, 0.07, 0.07, x, 0.035, z);
      box(g, frame, 1.9, 0.2, 0.85, 0, 0.17, 0); // base 0.07–0.27
      for (const s of [-1, 1]) {
        box(g, frame, 0.2, 0.42, 0.85, s * 0.85, 0.4, 0); // arm 0.19–0.61
        cyl(g, seat, 0.1, 0.1, 0.85, s * 0.85, 0.61, 0, 14, Math.PI / 2); // rolled arm top
      }
      box(g, frame, 1.5, 0.55, 0.22, 0, 0.545, 0.315); // backrest 0.27–0.82
      for (const s of [-1, 1]) {
        box(g, seat, 0.74, 0.15, 0.62, s * 0.38, 0.345, -0.08); // seat cushions
        box(g, back, 0.72, 0.4, 0.16, s * 0.38, 0.56, 0.17, 0.18); // back cushions lean back
      }
      box(g, std(0xf59e0b, 0.9), 0.3, 0.3, 0.1, -0.55, 0.5, 0.0, -0.3, 0.3, 0);
      break;
    }
    // ---------------------------------------------------------------------------------------------
    // Street / roadside
    // ---------------------------------------------------------------------------------------------
    case 'road_barrier': {
      const red = std(0xdc2626, 0.5, 0.05);
      const white = std(0xf8fafc, 0.45, 0.05);
      const leg = std(0x374151, 0.6, 0.4);
      for (const row of [0, 1]) {
        const y = row === 0 ? 0.62 : 0.88;
        for (let i = 0; i < 8; i++) box(g, (i + row) % 2 ? white : red, 0.2, 0.2, 0.03, -0.7 + i * 0.2, y, 0);
      }
      for (const x of [-0.72, 0.72]) {
        for (const s of [-1, 1]) box(g, leg, 0.05, 0.98, 0.04, x, 0.5, s * 0.085, -s * 0.175);
        box(g, leg, 0.06, 0.03, 0.4, x, 0.015, 0);
      }
      box(g, white, 1.6, 0.05, 0.035, 0, 0.14, 0); // kick board
      break;
    }
    case 'dumpster': {
      const green = std(0x1e4d2b, 0.55, 0.3);
      const rib = std(0x173d22, 0.6, 0.3);
      const lid = std(0x14281b, 0.6, 0.3);
      const dark = std(0x111827, 0.7, 0.3);
      box(g, green, 1.86, 0.9, 1.06, 0, 0.58, 0);
      box(g, dark, 1.8, 0.05, 1.0, 0, 0.12, 0);
      box(g, rib, 1.9, 0.05, 1.1, 0, 1.055, 0); // top rim
      for (let i = 0; i < 5; i++) {
        box(g, rib, 0.05, 0.8, 0.02, -0.8 + i * 0.4, 0.58, -0.545);
        box(g, rib, 0.05, 0.8, 0.02, -0.8 + i * 0.4, 0.58, 0.545);
      }
      for (const s of [-1, 1]) for (const z of [-0.3, 0.3]) box(g, rib, 0.02, 0.8, 0.05, s * 0.935, 0.58, z);
      box(g, std(0xf1f5f9, 0.7), 0.5, 0.18, 0.005, -0.3, 0.7, -0.542); // faded label plate
      box(g, std(0xeab308, 0.6), 0.5, 0.04, 0.005, -0.3, 0.57, -0.542);
      for (const x of [-0.8, 0.8]) for (const z of [-0.42, 0.42]) cyl(g, dark, 0.08, 0.08, 0.07, x, 0.07, z, 10, 0, 0, Math.PI / 2);
      // closed front lid
      box(g, lid, 1.86, 0.04, 0.55, 0, 1.1, -0.275);
      box(g, std(0xb6bcc6, 0.3, 0.8), 0.6, 0.03, 0.03, 0, 1.14, -0.5);
      // open rear lid, hinged at the back edge
      const lidPivot = new THREE.Group();
      lidPivot.position.set(0, 1.1, 0.54);
      lidPivot.rotation.x = 0.38;
      box(lidPivot, lid, 1.86, 0.04, 0.54, 0, 0.02, -0.27);
      g.add(lidPivot);
      break;
    }
    case 'utility_box': {
      const cab = std(0x5f7a66, 0.55, 0.3);
      const door = std(0x6a8872, 0.5, 0.3);
      const dark = std(0x111827, 0.6, 0.3);
      const chrome = std(0xd1d5db, 0.3, 0.85);
      box(g, std(0x9ca3af, 0.95), 0.8, 0.06, 0.45, 0, 0.03, 0); // concrete pad
      box(g, cab, 0.72, 1.18, 0.4, 0, 0.65, 0);
      box(g, std(0x3f5545, 0.5, 0.3), 0.8, 0.06, 0.45, 0, 1.27, 0); // overhanging cap
      for (const s of [-1, 1]) {
        box(g, door, 0.34, 1.08, 0.02, s * 0.175, 0.65, -0.21);
        for (let i = 0; i < 6; i++) box(g, dark, 0.24, 0.012, 0.006, s * 0.175, 0.25 + i * 0.03, -0.222);
        for (let i = 0; i < 6; i++) box(g, dark, 0.24, 0.012, 0.006, s * 0.175, 1.0 + i * 0.03 - 0.06, -0.222);
        box(g, chrome, 0.02, 0.12, 0.03, s * 0.04, 0.65, -0.225);
      }
      box(g, dark, 0.01, 1.08, 0.006, 0, 0.65, -0.222);
      box(g, std(0xfacc15, 0.5), 0.12, 0.12, 0.005, 0.18, 0.82, -0.222); // hazard sign
      box(g, dark, 0.03, 0.07, 0.006, 0.18, 0.82, -0.226, 0, 0, 0.4);
      cyl(g, chrome, 0.012, 0.012, 0.025, -0.04, 0.56, -0.236, 8, Math.PI / 2); // padlock
      cyl(g, std(0x6b7280, 0.6, 0.5), 0.025, 0.025, 1.18, 0.385, 0.65, 0.05, 8); // side conduit
      break;
    }
    case 'planter_box': {
      const wood = std(0xa0673a, 0.85);
      const post = std(0x7a4a24, 0.85);
      const soil = std(0x3f2a1d, 1);
      for (const x of [-0.66, 0.66]) for (const z of [-0.26, 0.26]) box(g, post, 0.08, 0.5, 0.08, x, 0.27, z);
      for (let i = 0; i < 3; i++) {
        const y = 0.1 + i * 0.15;
        box(g, wood, 1.3, 0.14, 0.03, 0, y + 0.02, -0.285);
        box(g, wood, 1.3, 0.14, 0.03, 0, y + 0.02, 0.285);
        box(g, wood, 0.03, 0.14, 0.54, -0.685, y + 0.02, 0);
        box(g, wood, 0.03, 0.14, 0.54, 0.685, y + 0.02, 0);
      }
      box(g, post, 1.4, 0.04, 0.6, 0, 0.5, 0); // top rim
      box(g, soil, 1.3, 0.03, 0.5, 0, 0.5, 0);
      const leaf = std(0x15803d, 0.9);
      const leaf2 = std(0x22a04a, 0.9);
      const shrubs: [number, number, number, number][] = [
        [-0.45, 0.0, 0.11, 0],
        [-0.1, 0.05, 0.13, 1],
        [0.28, -0.04, 0.125, 0],
        [0.55, 0.06, 0.1, 1],
        [-0.28, -0.12, 0.08, 1],
      ];
      for (const [x, z, r, v] of shrubs) {
        const m = add(g, new THREE.IcosahedronGeometry(r, 1), v ? leaf2 : leaf, x, 0.5 + r * 0.55, z);
        m.scale.set(1.5, 0.9, 1.3);
      }
      const bloom = [0xf472b6, 0xfacc15, 0xf8fafc, 0xef4444, 0xa78bfa];
      for (let i = 0; i < 9; i++) {
        const a = i * 2.4;
        add(g, SPH(0.035, 8, 6), std(bloom[i % bloom.length], 0.7), -0.55 + (i / 8) * 1.1, 0.62 + (i % 3) * 0.015, Math.sin(a) * 0.16);
      }
      break;
    }
  }
  return g;
}
