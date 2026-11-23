import * as THREE from 'three';
import { Frame, Kit, StaticBatcher } from './kit';
import { MaterialLibrary } from './materials';
import { CollisionWorld } from '../physics/collision';
import { BUILDINGS } from './buildings';
import { SINGLE_HOUSES, TWO_STORY_HOUSES } from './houses';
import { StructureInfo, Vec3 } from './structure';
import {
  placeBarrels,
  placeBench,
  placeCrateStack,
  placeJerseyBarrier,
  placeSandbagBunker,
  placeStreetlight,
  placeVehicle,
} from './props';
import { PLAY_HALF, ROAD_LINES, ROAD_WIDTH, SIDEWALK_WIDTH, addTree, buildSkyAndTerrain, SkyAndTerrain } from './skyAndTerrain';
import { MAP2D } from './map2d';

/**
 * City layout for the 240 m × 240 m arena:
 *  - 3×3 road grid (x/z = -60, 0, 60) → 16 blocks, each split into 4 lots (22.5 m)
 *  - Central 4-lot concrete plaza around the (0,0) intersection
 *  - 10 buildings + 20 houses on lots facing the nearest street, remaining lots are parks /
 *    tactical yards with trees, crates and sandbags
 *  - Street props: streetlights, parked vehicles, Jersey barriers
 * Also produces navigation data for AI bots (street graph, rooftop posts, chest spawns).
 */

const BLOCK_CENTERS = [-90, -30, 30, 90];
const LOT_OFFSET = 11.25;

export interface NavNode {
  id: number;
  p: THREE.Vector3;
  links: number[];
}

export interface ArenaLayout {
  structures: StructureInfo[];
  nav: NavNode[];
  /** Elevated / interior posts for overwatch bots. */
  posts: THREE.Vector3[];
  playerSpawns: THREE.Vector3[];
  chestSpots: THREE.Vector3[];
  /** 35+ validated spawn points (streets, courtyards, house interiors, rooftops). */
  spawnPoints: THREE.Vector3[];
  terrain: SkyAndTerrain;
  staticMeshes: THREE.Mesh[];
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function lotKey(x: number, z: number) {
  return `${x.toFixed(2)},${z.toFixed(2)}`;
}

/** Quarter turns so that local -z (front door) faces the nearest road. */
function facingTurns(x: number, z: number) {
  let best = Infinity;
  let turns = 0;
  for (const line of ROAD_LINES) {
    const dx = line - x;
    const dz = line - z;
    if (Math.abs(dz) < best) {
      best = Math.abs(dz);
      turns = dz < 0 ? 0 : 2; // road at smaller z → face -z
    }
    if (Math.abs(dx) < best) {
      best = Math.abs(dx);
      turns = dx < 0 ? 1 : 3;
    }
  }
  return turns;
}

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

export function buildArena(scene: THREE.Scene, world: CollisionWorld, lib: MaterialLibrary): ArenaLayout {
  MAP2D.reset(); // minimap footprints are re-collected for every build
  const batcher = new StaticBatcher();
  const kit = new Kit(batcher, world);
  const rand = seeded(9001);

  // ---- Lots ------------------------------------------------------------------------------
  const lots: { x: number; z: number }[] = [];
  for (const bx of BLOCK_CENTERS) for (const bz of BLOCK_CENTERS) for (const qx of [-1, 1]) for (const qz of [-1, 1]) lots.push({ x: bx + qx * LOT_OFFSET, z: bz + qz * LOT_OFFSET });

  const plazaLots = [
    { x: -18.75, z: -18.75 },
    { x: 18.75, z: -18.75 },
    { x: -18.75, z: 18.75 },
    { x: 18.75, z: 18.75 },
  ];
  const buildingLots: [number, number][] = [
    [-41.25, -41.25],
    [41.25, -78.75],
    [78.75, 78.75],
    [18.75, -41.25],
    [-78.75, 41.25],
    [41.25, 41.25],
    [-78.75, -78.75],
    [-41.25, 78.75],
    [78.75, -18.75],
    [-18.75, 41.25],
  ];
  const used = new Set<string>([...plazaLots.map((p) => lotKey(p.x, p.z)), ...buildingLots.map(([x, z]) => lotKey(x, z))]);
  const free = lots.filter((l) => !used.has(lotKey(l.x, l.z)));
  // Deterministic shuffle
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [free[i], free[j]] = [free[j], free[i]];
  }
  const houseLots = free.slice(0, 20);
  const openLots = free.slice(20);

  const plazas = plazaLots.map((p) => ({ x: p.x, z: p.z, w: 22.5, d: 22.5 }));
  const terrain = buildSkyAndTerrain(scene, kit, lib, plazas);

  const structures: StructureInfo[] = [];
  BUILDINGS.forEach((factory, i) => {
    const [x, z] = buildingLots[i];
    structures.push(factory(kit, new Frame(x, z, facingTurns(x, z))));
  });
  houseLots.forEach((lot, i) => {
    const factory = i < 10 ? SINGLE_HOUSES[i] : TWO_STORY_HOUSES[i - 10];
    // Pull houses slightly toward their street so the back yard stays open.
    const turns = facingTurns(lot.x, lot.z);
    const f = new Frame(lot.x, lot.z, turns);
    const [fx, fz] = f.toWorld(0, -1.2);
    structures.push(factory(kit, new Frame(fx, fz, turns)));
  });

  // ---- Central plaza ----------------------------------------------------------------------
  const chestSpots: THREE.Vector3[] = [];
  for (const p of plazaLots) {
    const sx = Math.sign(p.x);
    const sz = Math.sign(p.z);
    placeSandbagBunker(kit, p.x - sx * 3, p.z - sz * 3, sx > 0 ? (sz > 0 ? 2 : 3) : sz > 0 ? 1 : 0);
    placeCrateStack(kit, p.x + sx * 5, p.z - sz * 4, 0, true);
    placeBench(kit, p.x - sx * 6, p.z + sz * 6, sz > 0 ? 2 : 0);
    placeBarrels(kit, p.x + sx * 6, p.z + sz * 5, sx > 0 ? 0xb91c1c : 0x1d4ed8);
    placeJerseyBarrier(kit, p.x + sx * 1, p.z + sz * 8, 0);
    addTree(kit, p.x + sx * 8.5, p.z + sz * 8.5, 'broadleaf', 1.1);
    addTree(kit, p.x - sx * 8.5, p.z + sz * 8.5, 'broadleaf', 0.9);
    chestSpots.push(new THREE.Vector3(p.x, 0, p.z), new THREE.Vector3(p.x - sx * 7, 0, p.z - sz * 7));
  }
  // Monument at the centre intersection is avoided (traffic) — use a roundabout planter instead.
  kit.solid(new Frame(0, 0, 0), 'concrete', 0x9ca3af, 0, 0, 0, 3, 0.5, 3);
  addTree(kit, 0, 0, 'pine', 0.8);

  // ---- Open lots: parks & tactical yards -----------------------------------------------------
  openLots.forEach((lot, i) => {
    const type = i % 4;
    const f = new Frame(lot.x, lot.z, facingTurns(lot.x, lot.z));
    const place = (lx: number, lz: number) => f.toWorld(lx, lz);
    if (type === 0 || type === 2) {
      // Park: trees + benches
      const n = 4 + Math.floor(rand() * 3);
      const pts: [number, number][] = [];
      for (let k = 0; k < n * 3 && pts.length < n; k++) {
        const lx = (rand() - 0.5) * 17;
        const lz = (rand() - 0.5) * 17;
        if (pts.some(([a, b]) => Math.hypot(a - lx, b - lz) < 5)) continue;
        pts.push([lx, lz]);
      }
      pts.forEach(([lx, lz], k) => {
        const [wx, wz] = place(lx, lz);
        addTree(kit, wx, wz, k % 3 === 0 ? 'pine' : 'broadleaf', 0.85 + rand() * 0.5);
      });
      const [bx, bz] = place(0, -7.5);
      placeBench(kit, bx, bz, f.quarterTurns);
    } else if (type === 1) {
      // Tactical yard: sandbags, crates, barrels
      const [a, b] = place(-4, -3);
      placeSandbagBunker(kit, a, b, f.quarterTurns);
      const [c, d] = place(5, 3);
      placeCrateStack(kit, c, d, f.quarterTurns, rand() > 0.5);
      const [e, g] = place(-5, 6);
      placeBarrels(kit, e, g, 0x15803d);
      const [h, k] = place(4, -6);
      placeJerseyBarrier(kit, h, k, f.quarterTurns + 1);
    } else {
      // Parking lot: vehicles
      const [a, b] = place(-3.5, 0);
      placeVehicle(kit, a, b, f.quarterTurns, [0xdc2626, 0x2563eb, 0xf8fafc, 0x16a34a][i % 4], 'sedan');
      const [c, d] = place(3.5, 1);
      placeVehicle(kit, c, d, f.quarterTurns, 0x1f2937, i % 2 ? 'suv' : 'truck');
      const [e, g] = place(0, 7);
      addTree(kit, e, g, 'broadleaf', 1);
    }
    chestSpots.push(new THREE.Vector3(lot.x, 0, lot.z));
  });

  // ---- Street furniture -----------------------------------------------------------------------
  const hw = ROAD_WIDTH / 2;
  const lightOff = hw + SIDEWALK_WIDTH - 0.5;
  for (const line of ROAD_LINES) {
    for (let t = -100; t <= 100; t += 22) {
      if (ROAD_LINES.some((l) => Math.abs(l - t) < 9)) continue;
      const side = Math.round(t / 22) % 2 === 0 ? 1 : -1;
      // N-S road at x = line: light on the sidewalk, arm reaching over the road
      placeStreetlight(kit, line + side * lightOff, t, side > 0 ? 3 : 1);
      placeStreetlight(kit, t, line + side * lightOff, side > 0 ? 2 : 0);
    }
  }
  // Parked vehicles along curbs
  const carColors = [0xef4444, 0x3b82f6, 0xe5e7eb, 0x111827, 0xf59e0b, 0x10b981, 0x6b7280, 0x7c3aed];
  let ci = 0;
  for (const line of ROAD_LINES) {
    for (const t of [-88, -38, 26, 82]) {
      const side = ci % 2 ? 1 : -1;
      placeVehicle(kit, line + side * 3.3, t + (rand() - 0.5) * 6, side > 0 ? 0 : 2, carColors[ci++ % carColors.length], ci % 3 === 0 ? 'suv' : 'sedan');
      placeVehicle(kit, t + 10 + (rand() - 0.5) * 6, line - side * 3.3, side > 0 ? 1 : 3, carColors[ci++ % carColors.length], ci % 5 === 0 ? 'truck' : 'sedan');
    }
  }
  // Jersey barrier chicanes near intersections
  for (const ix of ROAD_LINES) {
    for (const iz of ROAD_LINES) {
      if (ix === 0 && iz === 0) continue;
      placeJerseyBarrier(kit, ix + 2.2, iz - 10, 0);
      placeJerseyBarrier(kit, ix - 10, iz - 2.2, 1);
    }
  }

  const staticMeshes = batcher.build(lib, scene);

  // ---- Navigation graph (streets) -------------------------------------------------------------
  const nav: NavNode[] = [];
  const nodeAt = new Map<string, number>();
  const addNode = (x: number, z: number) => {
    const key = lotKey(x, z);
    const existing = nodeAt.get(key);
    if (existing !== undefined) return existing;
    const id = nav.length;
    nav.push({ id, p: new THREE.Vector3(x, 0, z), links: [] });
    nodeAt.set(key, id);
    return id;
  };
  const link = (a: number, b: number) => {
    if (a === b) return;
    if (!nav[a].links.includes(b)) nav[a].links.push(b);
    if (!nav[b].links.includes(a)) nav[b].links.push(a);
  };
  const stops = [-105, -82.5, -60, -45, -30, -15, 0, 15, 30, 45, 60, 82.5, 105];
  for (const line of ROAD_LINES) {
    let prevA = -1;
    let prevB = -1;
    for (const t of stops) {
      // Walk slightly off the road centre (lanes) so bots don't stack on markings.
      const a = addNode(line, t);
      const b = addNode(t, line);
      if (prevA >= 0) link(prevA, a);
      if (prevB >= 0) link(prevB, b);
      prevA = a;
      prevB = b;
    }
  }
  // Connect lots (open lots, plazas, building/house entrances) to the nearest street node.
  const nearestNode = (x: number, z: number) => {
    let best = 0;
    let bd = Infinity;
    nav.forEach((n, i) => {
      const d = (n.p.x - x) ** 2 + (n.p.z - z) ** 2;
      if (d < bd && world.lineOfSight(x, 1.2, z, n.p.x, 1.2, n.p.z)) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const connectPoint = (x: number, z: number) => {
    const id = addNode(x, z);
    link(id, nearestNode(x, z));
    return id;
  };
  [...openLots, ...plazaLots].forEach((l) => connectPoint(l.x, l.z));
  structures.forEach((s) => {
    const e = connectPoint(s.entrance[0], s.entrance[2]);
    // Ground-floor interior points reachable straight from the entrance
    s.interior
      .filter((p) => p[1] < 0.5)
      .forEach((p) => {
        if (world.lineOfSight(s.entrance[0], 1.0, s.entrance[2], p[0], 1.0, p[2])) {
          const id = addNode(p[0], p[2]);
          link(id, e);
        }
      });
  });

  const posts: THREE.Vector3[] = [];
  structures.forEach((s) => {
    s.rooftops.forEach((p) => posts.push(v3(p)));
    s.interior.filter((p) => p[1] > 1).forEach((p) => posts.push(v3(p)));
  });

  const playerSpawns = [
    new THREE.Vector3(-6, 0, -14),
    new THREE.Vector3(14, 0, 6),
    new THREE.Vector3(-30, 0, 2),
    new THREE.Vector3(2, 0, 34),
    new THREE.Vector3(32, 0, -2),
    new THREE.Vector3(-2, 0, -40),
  ];

  // Clamp everything inside the playable area
  chestSpots.forEach((c) => {
    c.x = THREE.MathUtils.clamp(c.x, -PLAY_HALF + 3, PLAY_HALF - 3);
    c.z = THREE.MathUtils.clamp(c.z, -PLAY_HALF + 3, PLAY_HALF - 3);
  });

  // ---- Randomised spawn pool: streets, courtyards / parks, building & house interiors, rooftops.
  const spawnPoints: THREE.Vector3[] = [];
  const tryAdd = (x: number, y: number, z: number) => {
    if (Math.abs(x) > PLAY_HALF - 3 || Math.abs(z) > PLAY_HALF - 3) return;
    const g = world.groundHeightAt(x, z, 0.4, y + 0.6);
    if (Math.abs(g - y) > 0.6) return;
    // Body must fit (no wall / prop overlapping a standing capsule)
    for (const h of [0.5, 1.2, 1.7]) if (world.pointInSolid(x, g + h, z)) return;
    for (const [ox, oz] of [[0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]]) if (world.pointInSolid(x + ox, g + 1.0, z + oz)) return;
    if (spawnPoints.some((q) => q.distanceToSquared(new THREE.Vector3(x, g, z)) < 9)) return;
    spawnPoints.push(new THREE.Vector3(x, g, z));
  };
  nav.forEach((n, i) => {
    if (i % 2 === 0) tryAdd(n.p.x, 0, n.p.z);
  });
  chestSpots.forEach((c) => tryAdd(c.x, 0, c.z));
  structures.forEach((s) => {
    s.interior.forEach((p) => tryAdd(p[0], p[1] - 0.05, p[2]));
    s.rooftops.forEach((p) => tryAdd(p[0], p[1] - 0.05, p[2]));
  });

  // Building / house roof footprints for the minimap
  for (const st of structures) {
    const f = st.footprint;
    MAP2D.rects.push({ x: (f.minX + f.maxX) / 2, z: (f.minZ + f.maxZ) / 2, w: f.maxX - f.minX, d: f.maxZ - f.minZ, kind: /house/i.test(st.name) ? 'house' : 'building' });
  }
  return { structures, nav, posts, playerSpawns, chestSpots, spawnPoints, terrain, staticMeshes };
}
