import * as THREE from 'three';

/**
 * Prop disguise catalogue for the radial C-menu: 8 small props (inner ring, pass-through) and
 * 12 medium / large props (outer ring, solid colliders other players and bots cannot walk through).
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
  | 'ammo_chest';

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

const B = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const C = (rt: number, rb: number, h: number, seg = 16) => new THREE.CylinderGeometry(rt, rb, h, seg);

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
  }
  return g;
}
