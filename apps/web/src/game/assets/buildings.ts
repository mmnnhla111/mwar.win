import * as THREE from 'three';
import { Frame, Kit, Rect, door, win } from './kit';
import { STORY, WALL_H, SLAB_T, StructureInfo, buildStories, standardPoints, worldPoint, windowsAlong } from './structure';

/**
 * 10 distinct multi-storey building architectures (Building01 … Building10).
 * Each design is built in local space around (0,0) with the main entrance on the -z side
 * and fits inside a 20 m × 20 m lot. Most have walkable stairs and parapet-lined rooftops.
 */

export type BuildingFactory = (kit: Kit, f: Frame) => StructureInfo;

function footprint(f: Frame, r: Rect) {
  return f.rect(r.x0, r.z0, r.x1, r.z1);
}

function sandbagRow(kit: Kit, f: Frame, x0: number, z0: number, x1: number, z1: number, y: number) {
  const alongX = Math.abs(z1 - z0) < 1e-6;
  const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  const n = Math.max(1, Math.round(len / 0.75));
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5 + (row % 2) * 0.25) / n;
      if (t > 1) continue;
      const cx = alongX ? Math.min(x0, x1) + t * len : x0;
      const cz = alongX ? z0 : Math.min(z0, z1) + t * len;
      kit.deco(f, 'fabric', 0xb8a97a, cx, y + row * 0.32, cz, alongX ? 0.72 : 0.45, 0.32, alongX ? 0.45 : 0.72);
    }
  }
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  kit.solid(f, 'fabric', 0xb8a97a, cx, y, cz, alongX ? len : 0.45, 0.64, alongX ? 0.45 : len, { visual: false });
}

/** Building01 — Tactical Command Center: 3 storeys, rooftop radar & sandbag nests. */
export const Building01: BuildingFactory = (kit, f) => {
  const r: Rect = { x0: -9, z0: -8, x1: 9, z1: 8 };
  const { roofY } = buildStories(kit, f, r, {
    stories: 3,
    wallKey: 'concrete',
    wallColor: 0x7c8a6e,
    trim: 0x2f3a2a,
    doors: { n: [9], s: [9] },
    doorWidth: 2.2,
    windows: { n: 5, s: 5, w: 4, e: 4 },
    roofAccess: true,
  });
  // Entrance canopy + blast walls
  kit.solid(f, 'concrete', 0x4b5543, 0, WALL_H - 0.2, -9.2, 5, 0.25, 2.4);
  kit.solid(f, 'concrete', 0x8b9479, -3.5, 0, -10.5, 2.4, 1.3, 0.5);
  kit.solid(f, 'concrete', 0x8b9479, 3.5, 0, -10.5, 2.4, 1.3, 0.5);
  // Radar mast + dish
  kit.solid(f, 'metal', 0x6b7280, 5.5, roofY, 4.5, 0.4, 4, 0.4, { walkable: false });
  const dish = new THREE.SphereGeometry(1.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.6);
  dish.rotateX(Math.PI / 2.4);
  kit.geometry(f, 'metal', 0xd4d4d8, dish, 5.5, roofY + 4.2, 4.5);
  kit.deco(f, 'emissive', 0xef4444, 5.5, roofY + 4, 4.5, 0.15, 0.15, 0.15, false);
  sandbagRow(kit, f, -6, -4, -2, -4, roofY);
  sandbagRow(kit, f, 2, 3, 2, 6, roofY);
  // Comms antennas
  kit.solid(f, 'metal', 0x9ca3af, -6.5, roofY, 5.5, 0.12, 5, 0.12, { walkable: false });
  kit.solid(f, 'metal', 0x9ca3af, -5.5, roofY, 6.2, 0.1, 3.5, 0.1, { walkable: false });
  const pts = standardPoints(f, r, 3, true);
  return { name: 'Tactical Command Center', ...pts, entrance: worldPoint(f, 0, 0, -11.5), footprint: footprint(f, { ...r, z0: -11 }) };
};

/** Building02 — Logistics Warehouse: tall hall, roll-up door, interior mezzanine, exterior fire stairs to roof. */
export const Building02: BuildingFactory = (kit, f) => {
  const r: Rect = { x0: -9, z0: -7, x1: 7, z1: 7 };
  const h = 6.4;
  const t = 0.3;
  kit.room(f, r, 0, h, {
    key: 'metal',
    color: 0x8aa1b1,
    trim: 0x1f2937,
    n: [door(8, 5.5, 4.6), door(2.5, 1.3, 2.3)],
    s: [door(12, 1.5, 2.4), ...windowsAlong(16, 4, { sill: 4.2, top: 5.6, avoid: [[10.5, 13.5]] })],
    w: windowsAlong(14 - 2 * t, 3, { sill: 4.2, top: 5.6 }),
    e: [door(4, 1.3, 2.4), ...windowsAlong(14 - 2 * t, 3, { sill: 4.2, top: 5.6, avoid: [[3, 5]] })],
  });
  // Mezzanine along the back wall + stairs up to it
  const mezz: Rect = { x0: r.x0 + t, z0: 2.2, x1: r.x1 - t, z1: r.z1 - t };
  kit.slab(f, mezz, STORY - SLAB_T, SLAB_T, { color: 0x6b7280 });
  kit.railing(f, mezz.x0 + 1.6, mezz.z0 + 0.05, mezz.x1, mezz.z0 + 0.05, STORY);
  kit.stairs(f, -8, -2.9, '+z', 1.3, 5.1, 0, STORY, { rails: ['left'], color: 0x71717a });
  // Roof (flat, low parapet) reached by exterior fire stairs on the east side
  kit.flatRoof(f, r, h, 0x52606d);
  kit.parapet(f, r, h + 0.25, { h: 1.0, color: 0x64748b, gaps: [{ side: 'e', at: 12.6, width: 1.4 }] });
  kit.stairs(f, 8.0, -6.5, '+z', 1.2, 5.6, 0, STORY, { rails: ['left'], key: 'metal', color: 0x475569 });
  kit.solid(f, 'metal', 0x475569, 8.0, STORY - 0.15, 0.15, 1.4, 0.15, 2.3); // landing
  kit.stairs(f, 8.0, 1.3, '+z', 1.2, 4.6, STORY, h + 0.25, { rails: ['left'], key: 'metal', color: 0x475569 });
  kit.solid(f, 'metal', 0x475569, 8.0, h + 0.1, 6.4, 1.4, 0.15, 1.4); // top landing
  kit.railing(f, 8.75, 5.7, 8.75, 7.1, h + 0.25, 1.0);
  kit.railing(f, 8.75, -0.9, 8.75, 1.3, STORY, 1.0);
  // Pallets & crates inside
  for (let i = 0; i < 4; i++) {
    kit.solid(f, 'wood', 0xa16207, -4 + i * 2.6, 0, -3, 1.6, 1.2, 1.2);
    if (i % 2 === 0) kit.solid(f, 'wood', 0xb45309, -4 + i * 2.6, 1.2, -3, 1.2, 0.9, 1.0);
  }
  kit.deco(f, 'emissive', 0xfde68a, -1, h - 0.4, 0, 6, 0.08, 0.3, false);
  kit.deco(f, 'trim', 0xfacc15, -1, 4.6, -7.05, 5.6, 0.25, 0.12, false);
  return {
    name: 'Logistics Warehouse',
    rooftops: [worldPoint(f, -6, h + 0.3, -4), worldPoint(f, 4, h + 0.3, 4), worldPoint(f, 0, h + 0.3, -5)],
    interior: [worldPoint(f, 0, 0.05, -1), worldPoint(f, 0, STORY + 0.05, 4.5)],
    entrance: worldPoint(f, -1, 0, -9.5),
    footprint: footprint(f, { x0: -9, z0: -8, x1: 9, z1: 7 }),
  };
};

/** Building03 — Sniper Watchtower: slim 4-storey tower with an open firing deck and roof nest. */
export const Building03: BuildingFactory = (kit, f) => {
  const r: Rect = { x0: -3.6, z0: -3.6, x1: 3.6, z1: 3.6 };
  const stories = 4;
  const t = 0.3;
  const sw = 1.15;
  const run = 4.4;
  const z0 = r.z0 + t + 0.6;
  let side: 'e' | 'w' = 'e';
  const holes: Rect[][] = Array.from({ length: stories + 1 }, () => []);
  for (let k = 0; k < stories; k++) {
    const x = side === 'e' ? r.x1 - t - sw / 2 : r.x0 + t + sw / 2;
    kit.stairs(f, x, z0, '+z', sw, run, k * STORY, (k + 1) * STORY, { rails: [side === 'e' ? 'right' : 'left'], topGuard: true, color: 0x78716c });
    holes[k + 1].push({ x0: x - sw / 2 - 0.05, x1: x + sw / 2 + 0.05, z0: z0 - 0.05, z1: z0 + run });
    side = side === 'e' ? 'w' : 'e';
  }
  for (let k = 0; k < stories; k++) {
    const y = k * STORY;
    const top = k === stories - 1;
    const slit = (len: number) => (top ? [win(len / 2, len - 1.4, 1.0, 2.6)] : [win(len / 2, 0.5, 1.3, 2.0)]);
    kit.room(f, r, y, WALL_H, {
      key: 'brick',
      color: 0x9a6b4f,
      trim: 0x3f2a1d,
      n: k === 0 ? [door(3.6, 1.3, 2.3)] : slit(7.2),
      s: slit(7.2),
      w: slit(6.6),
      e: slit(6.6),
    });
    kit.slab(f, r, y + WALL_H, SLAB_T, { color: 0x8d6e63, holes: holes[k + 1] });
  }
  const roofY = stories * STORY;
  kit.parapet(f, r, roofY, { h: 1.15, color: 0x7c5b45 });
  // Beacon & sandbag nest
  kit.deco(f, 'emissive', 0xf97316, 2.8, roofY + 1.2, -2.8, 0.25, 0.25, 0.25, false);
  sandbagRow(kit, f, -2.5, -2.6, 0.5, -2.6, roofY);
  return {
    name: 'Sniper Watchtower',
    rooftops: [worldPoint(f, -1.5, roofY + 0.05, 1.5), worldPoint(f, 1.0, roofY + 0.05, -1.5)],
    interior: [worldPoint(f, 0, 0.05, 1.5), worldPoint(f, 0, 3 * STORY + 0.05, 1.5)],
    entrance: worldPoint(f, 0, 0, -5.5),
    footprint: footprint(f, { x0: -4, z0: -4, x1: 4, z1: 4 }),
  };
};

/** Building04 — Corner Commercial Block: glass storefronts, signage, 2 storeys + roof terrace. */
export const Building04: BuildingFactory = (kit, f) => {
  const r: Rect = { x0: -8, z0: -8, x1: 8, z1: 8 };
  buildStories(kit, f, r, {
    stories: 2,
    wallKey: 'brick',
    wallColor: 0xb45f3c,
    trim: 0x1f2937,
    doors: { n: [8], w: [7.7] },
    doorWidth: 2.0,
    windows: { n: 4, s: 4, w: 4, e: 4 },
    glassWindows: true,
    roofAccess: true,
  });
  // Shop awnings + neon signage on the two street faces
  kit.deco(f, 'trim', 0xdc2626, 0, 2.7, -8.6, 15, 0.12, 1.2, true);
  kit.deco(f, 'trim', 0x2563eb, -8.6, 2.7, 0, 1.2, 0.12, 15, true);
  kit.deco(f, 'emissive', 0xfef08a, 0, 3.4, -8.2, 6, 0.6, 0.08, false);
  kit.deco(f, 'emissive', 0x67e8f9, -8.2, 3.4, 0, 0.08, 0.6, 6, false);
  kit.solid(f, 'concrete', 0x9ca3af, 0, 0, -9.6, 4, 0.18, 2.4);
  // Rooftop AC units for cover
  kit.solid(f, 'metal', 0xd4d4d8, 3, 2 * STORY, 3, 2.0, 1.2, 1.4);
  kit.solid(f, 'metal', 0xd4d4d8, -3.5, 2 * STORY, -3, 1.6, 1.0, 1.6);
  const pts = standardPoints(f, r, 2, true);
  return { name: 'Corner Commercial Block', ...pts, entrance: worldPoint(f, 0, 0, -10.5), footprint: footprint(f, { x0: -9, z0: -11, x1: 8, z1: 8 }) };
};

/** Building05 — Tech Research Lab: white modular lab, neon strips, rooftop solar array. */
export const Building05: BuildingFactory = (kit, f) => {
  const r: Rect = { x0: -9, z0: -7, x1: 9, z1: 7 };
  const { roofY } = buildStories(kit, f, r, {
    stories: 2,
    wallKey: 'plaster',
    wallColor: 0xf1f5f9,
    trim: 0x0ea5e9,
    doors: { n: [9], e: [7] },
    doorWidth: 2.0,
    windows: { n: 6, s: 6, w: 4, e: 4 },
    glassWindows: false,
    roofAccess: true,
  });
  kit.deco(f, 'emissive', 0x22d3ee, 0, WALL_H + 0.05, -7.08, 18, 0.12, 0.06, false);
  kit.deco(f, 'emissive', 0x22d3ee, 0, roofY - 0.4, -7.08, 18, 0.12, 0.06, false);
  kit.solid(f, 'concrete', 0xe2e8f0, 0, 2.8, -8.6, 5, 0.2, 3.2);
  for (let i = 0; i < 4; i++) {
    const g = new THREE.BoxGeometry(2.6, 0.08, 1.6);
    g.rotateX(-0.35);
    kit.geometry(f, 'metal', 0x1e3a8a, g, -5.5 + i * 3.2, roofY + 0.7, 3.5);
    kit.solid(f, 'metal', 0x94a3b8, -5.5 + i * 3.2, roofY, 3.5, 2.4, 0.6, 0.2, { walkable: false });
  }
  kit.solid(f, 'metal', 0xcbd5e1, 6, roofY, -3.5, 1.8, 1.3, 1.8);
  const pts = standardPoints(f, r, 2, true);
  return { name: 'Tech Research Lab', ...pts, entrance: worldPoint(f, 0, 0, -10.5), footprint: footprint(f, { x0: -9, z0: -10, x1: 9, z1: 7 }) };
};

/** Building06 — Apartment Complex: 4 storeys, brick, front balconies on every floor. */
export const Building06: BuildingFactory = (kit, f) => {
  const r: Rect = { x0: -7, z0: -8, x1: 7, z1: 8 };
  const upperDoors: Record<number, { n?: number[] }> = { 1: { n: [3.5, 10.5] }, 2: { n: [3.5, 10.5] }, 3: { n: [3.5, 10.5] } };
  const { roofY } = buildStories(kit, f, r, {
    stories: 4,
    wallKey: 'brick',
    wallColor: 0xa0522d,
    trim: 0xf5f5f4,
    doors: { n: [7] },
    doorWidth: 1.8,
    upperDoors,
    windows: { n: 4, s: 4, w: 4, e: 4 },
    roofAccess: true,
    stairStartInset: 1.6,
  });
  for (let k = 1; k < 4; k++) {
    const y = k * STORY;
    for (const bx of [-3.5, 3.5]) {
      kit.solid(f, 'concrete', 0xd6d3d1, bx, y - SLAB_T, -9.1, 4.2, SLAB_T, 2.2);
      kit.railing(f, bx - 2.1, -10.15, bx + 2.1, -10.15, y);
      kit.railing(f, bx - 2.05, -10.15, bx - 2.05, -8.05, y);
      kit.railing(f, bx + 2.05, -10.15, bx + 2.05, -8.05, y);
    }
  }
  kit.solid(f, 'concrete', 0xd6d3d1, 0, WALL_H - 0.1, -9.0, 3, 0.2, 2);
  kit.solid(f, 'metal', 0x78716c, -4, roofY, 4.5, 2.4, 2.0, 2.4);
  kit.deco(f, 'metal', 0x57534e, 4, roofY, 5, 0.8, 1.6, 0.8);
  const pts = standardPoints(f, r, 4, true);
  pts.interior.push(worldPoint(f, -3.5, 2 * STORY + 0.05, -9.2));
  return { name: 'Apartment Complex', ...pts, entrance: worldPoint(f, 0, 0, -11.5), footprint: footprint(f, { x0: -7, z0: -10.5, x1: 7, z1: 8 }) };
};

/** Building07 — Fortified Bunker: thick low walls, firing slits, ramp to a sandbagged roof. */
export const Building07: BuildingFactory = (kit, f) => {
  const r: Rect = { x0: -7, z0: -6, x1: 7, z1: 6 };
  const h = 2.6;
  const slits = (len: number, n: number) => windowsAlong(len, n, { width: 0.9, sill: 1.35, top: 1.75 });
  kit.room(f, r, 0, h, {
    t: 0.7,
    key: 'concrete',
    color: 0x6b6f62,
    trim: 0x1c1917,
    n: [door(7, 1.4, 2.2), ...slits(14, 4).filter((o) => Math.abs(o.at - 7) > 1.5)],
    s: [door(3, 1.2, 2.2), ...slits(14, 4).filter((o) => Math.abs(o.at - 3) > 1.5)],
    w: slits(12 - 1.4, 3),
    e: slits(12 - 1.4, 3),
  });
  kit.slab(f, r, h, 0.4, { color: 0x57534e });
  const roofY = h + 0.4;
  // Earthen ramp on the west side up to the roof
  kit.stairs(f, -8.0, 5.5, '-z', 1.8, 9.5, 0, roofY, { key: 'concrete', color: 0x78716c, rails: [] });
  kit.solid(f, 'concrete', 0x57534e, -8.0, 0, -4.8, 1.8, roofY, 1.6, { walkable: true });
  sandbagRow(kit, f, -5.5, -5.6, 5.5, -5.6, roofY);
  sandbagRow(kit, f, 6.6, -4, 6.6, 4, roofY);
  sandbagRow(kit, f, -3, 5.6, 5, 5.6, roofY);
  // Camo net poles
  kit.deco(f, 'fabric', 0x4d5b3a, 0, roofY + 2.3, 0, 9, 0.05, 7);
  for (const [px, pz] of [[-4.2, -3.2], [4.2, -3.2], [-4.2, 3.2], [4.2, 3.2]]) kit.solid(f, 'metal', 0x3f3f46, px, roofY, pz, 0.12, 2.3, 0.12, { walkable: false });
  return {
    name: 'Fortified Bunker',
    rooftops: [worldPoint(f, 0, roofY + 0.05, -3.5), worldPoint(f, 3.5, roofY + 0.05, 2.5)],
    interior: [worldPoint(f, 0, 0.05, 0)],
    entrance: worldPoint(f, 0, 0, -8),
    footprint: footprint(f, { x0: -9, z0: -7, x1: 7, z1: 7 }),
  };
};

/** Building08 — Garage Hangar: vaulted roof, huge front opening, interior catwalk with stairs. */
export const Building08: BuildingFactory = (kit, f) => {
  const r: Rect = { x0: -9.5, z0: -8, x1: 9.5, z1: 8 };
  const h = 6.0;
  kit.room(f, r, 0, h, {
    key: 'metal',
    color: 0x9ca3af,
    trim: 0x111827,
    n: [door(9.5, 10, 5.0)],
    s: [door(15, 1.4, 2.3)],
    w: windowsAlong(15.4, 4, { sill: 3.6, top: 4.8 }),
    e: [door(3, 1.4, 2.3), ...windowsAlong(15.4, 4, { sill: 3.6, top: 4.8 })],
  });
  kit.slab(f, r, h, 0.2, { color: 0x6b7280 });
  // Vaulted roof shell (visual)
  const vault = new THREE.CylinderGeometry(9.8, 9.8, 16.4, 24, 1, true, -Math.PI / 2, Math.PI);
  vault.rotateX(-Math.PI / 2);
  vault.scale(1, 0.32, 1);
  kit.geometry(f, 'metal', 0x6b7280, vault, 0, h + 0.15, 0);
  // Catwalk along the back wall
  kit.slab(f, { x0: -9.2, z0: 5.2, x1: 9.2, z1: 7.7 }, 3.4 - 0.2, 0.2, { color: 0x52525b });
  kit.railing(f, -7.4, 5.25, 9.2, 5.25, 3.4);
  kit.stairs(f, -8.4, -0.8, '+z', 1.4, 6.0, 0, 3.4, { key: 'metal', color: 0x52525b, rails: ['left'] });
  // Parked vehicles / tool benches for cover
  kit.solid(f, 'metal', 0x1d4ed8, 2.5, 0.35, -1, 2.2, 1.3, 4.6);
  kit.solid(f, 'glass', 0x93c5fd, 2.5, 1.65, -0.5, 1.9, 0.6, 2.2, { blocksMovement: false, blocksBullets: false, walkable: false });
  kit.solid(f, 'metal', 0x111827, 2.5, 0, -1, 2.3, 0.35, 4.0, { walkable: false });
  kit.solid(f, 'wood', 0x92400e, 6.8, 0, 3, 3.2, 0.95, 1.0);
  kit.solid(f, 'metal', 0xb91c1c, -3, 0, 3, 1.0, 1.6, 0.8);
  kit.deco(f, 'trim', 0xfacc15, 0, 5.05, -8.08, 10.4, 0.25, 0.1, false);
  return {
    name: 'Garage Hangar',
    rooftops: [],
    interior: [worldPoint(f, 0, 0.05, 2), worldPoint(f, 2, 3.45, 6.4)],
    entrance: worldPoint(f, 0, 0, -10.5),
    footprint: footprint(f, { x0: -10, z0: -8.5, x1: 10, z1: 8.5 }),
  };
};

/** Building09 — Plaza Tower: 5-storey glass-banded tower with a helipad roof. */
export const Building09: BuildingFactory = (kit, f) => {
  const r: Rect = { x0: -6.5, z0: -6.5, x1: 6.5, z1: 6.5 };
  const { roofY } = buildStories(kit, f, r, {
    stories: 5,
    wallKey: 'concrete',
    wallColor: 0x94a3b8,
    trim: 0x0f172a,
    doors: { n: [6.5], s: [6.5] },
    doorWidth: 2.4,
    windows: { n: 4, s: 4, w: 4, e: 4 },
    roofAccess: true,
    stairRun: 5.0,
    stairStartInset: 0.9,
  });
  for (let k = 0; k < 5; k++) {
    const y = k * STORY + 2.35;
    kit.deco(f, 'glass', 0x60a5fa, 0, y, -6.55, 13, 0.55, 0.06, false);
    kit.deco(f, 'glass', 0x60a5fa, 0, y, 6.55, 13, 0.55, 0.06, false);
    kit.deco(f, 'glass', 0x60a5fa, -6.55, y, 0, 0.06, 0.55, 13, false);
    kit.deco(f, 'glass', 0x60a5fa, 6.55, y, 0, 0.06, 0.55, 13, false);
  }
  // Helipad marking
  kit.deco(f, 'emissive', 0xfacc15, 0, roofY + 0.01, 1.5, 0.5, 0.02, 3.2, false);
  kit.deco(f, 'emissive', 0xfacc15, -1.0, roofY + 0.01, 1.5, 0.5, 0.02, 3.2, false);
  kit.deco(f, 'emissive', 0xfacc15, -0.5, roofY + 0.01, 1.5, 1.5, 0.02, 0.4, false);
  for (const [cx, cz] of [[-5.8, -5.8], [5.8, -5.8], [-5.8, 5.8], [5.8, 5.8]]) kit.deco(f, 'emissive', 0xef4444, cx, roofY + 1.15, cz, 0.18, 0.18, 0.18, false);
  const pts = standardPoints(f, r, 5, true);
  return { name: 'Plaza Tower', ...pts, entrance: worldPoint(f, 0, 0, -8.5), footprint: footprint(f, r) };
};

/** Building10 — Courtyard Complex: 2-storey ring of wings around an open courtyard. */
export const Building10: BuildingFactory = (kit, f) => {
  const outer: Rect = { x0: -9.5, z0: -9.5, x1: 9.5, z1: 9.5 };
  const inner: Rect = { x0: -4.5, z0: -4.5, x1: 4.5, z1: 4.5 };
  const t = 0.3;
  const wallColor = 0xd6b98c;
  for (let k = 0; k < 2; k++) {
    const y = k * STORY;
    const g = k === 0;
    kit.room(f, outer, y, WALL_H, {
      key: 'plaster',
      color: wallColor,
      trim: 0x7c2d12,
      n: g ? [door(9.5, 3.0, 2.8), ...windowsAlong(19, 6, { avoid: [[7.5, 11.5]] })] : windowsAlong(19, 6),
      s: g ? [door(9.5, 1.6, 2.4), ...windowsAlong(19, 6, { avoid: [[8.3, 10.7]] })] : windowsAlong(19, 6),
      w: windowsAlong(18.4, 5),
      e: g ? [door(9.2, 1.6, 2.4), ...windowsAlong(18.4, 5, { avoid: [[8, 10.4]] })] : windowsAlong(18.4, 5),
    });
    kit.room(f, inner, y, WALL_H, {
      key: 'plaster',
      color: 0xe7d3b0,
      trim: 0x7c2d12,
      n: g ? [door(4.5, 3.0, 2.8)] : windowsAlong(9, 2),
      s: g ? [door(4.5, 1.6, 2.4)] : [door(4.5, 1.6, 2.4)],
      w: g ? [door(4.2, 1.6, 2.4)] : windowsAlong(8.4, 2),
      e: g ? [door(4.2, 1.6, 2.4)] : windowsAlong(8.4, 2),
    });
  }
  // Entrance passage side walls (north wing) so the arch reads as a tunnel
  kit.wall(f, -1.5, -9.2, -1.5, -4.8, 0, WALL_H, { t: 0.25, color: 0xcfb07c });
  kit.wall(f, 1.5, -9.2, 1.5, -4.8, 0, WALL_H, { t: 0.25, color: 0xcfb07c });
  // Stairs inside the west wing to the 2nd floor; 2nd-floor balcony overlooks the courtyard
  const holeW: Rect = { x0: -8.95, x1: -7.45, z0: -2.55, z1: 2.55 };
  kit.stairs(f, -8.2, -2.5, '+z', 1.4, 5.0, 0, STORY, { rails: ['left'], topGuard: true });
  const floorRing: Rect[] = [inner, holeW];
  kit.slab(f, outer, WALL_H, SLAB_T, { color: 0xa8a29e, holes: floorRing });
  // Roof with a second stair in the east wing
  const holeE: Rect = { x0: 7.45, x1: 8.95, z0: -2.55, z1: 2.55 };
  kit.stairs(f, 8.2, -2.5, '+z', 1.4, 5.0, STORY, 2 * STORY, { rails: ['right'], topGuard: true });
  kit.slab(f, outer, STORY + WALL_H, SLAB_T, { color: 0x8d7b68, holes: [inner, holeE] });
  kit.parapet(f, outer, 2 * STORY, { h: 1.1, color: 0xb59c72 });
  kit.parapet(f, { x0: inner.x0 - 0.25, z0: inner.z0 - 0.25, x1: inner.x1 + 0.25, z1: inner.z1 + 0.25 }, 2 * STORY, { h: 1.0, color: 0xb59c72 });
  // Courtyard fountain
  kit.solid(f, 'concrete', 0xd6d3d1, 0, 0, 0, 3.2, 0.6, 3.2);
  kit.deco(f, 'glass', 0x38bdf8, 0, 0.6, 0, 2.6, 0.02, 2.6, false);
  kit.solid(f, 'concrete', 0xd6d3d1, 0, 0.6, 0, 0.5, 1.2, 0.5, { walkable: false });
  void t;
  return {
    name: 'Courtyard Complex',
    rooftops: [worldPoint(f, -7, 2 * STORY + 0.05, -7), worldPoint(f, 7, 2 * STORY + 0.05, 7), worldPoint(f, 0, 2 * STORY + 0.05, -7)],
    interior: [worldPoint(f, 0, 0.05, -3.2), worldPoint(f, -7, STORY + 0.05, 6), worldPoint(f, 6.5, 0.05, -6.5)],
    entrance: worldPoint(f, 0, 0, -11.5),
    footprint: footprint(f, outer),
  };
};

export const BUILDINGS: BuildingFactory[] = [
  Building01,
  Building02,
  Building03,
  Building04,
  Building05,
  Building06,
  Building07,
  Building08,
  Building09,
  Building10,
];
