import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  LARGE_MAP_HALF,
  LARGE_MAP_SIZE,
  LARGE_MAP_SPAWN_POINTS,
  LARGE_MOUNTAINS,
  LARGE_PLAY_HALF,
  LARGE_ROAD_LINES,
  LARGE_ROAD_WIDTH,
  LARGE_SETTLEMENTS,
  largeMapTerrainHeight,
  type LargeSettlement,
} from '@mwar/shared';
import { Frame, Kit, StaticBatcher } from '../assets/kit';
import { MaterialLibrary, makeAsphaltTexture, makeRoadTexture, textureFactories } from '../assets/materials';
import { CollisionWorld } from '../physics/collision';
import { splitTile, unionRoadTiles, type RoadRect, type RoadTile } from './roadGeometry';
import { BUILDINGS, type BuildingFactory } from '../assets/buildings';
import { SINGLE_HOUSES, TWO_STORY_HOUSES, type HouseFactory } from '../assets/houses';
import { StructureInfo, Vec3 } from '../assets/structure';
import { placeBarrels, placeBench, placeCrateStack, placeJerseyBarrier, placeSandbagBunker, placeStreetlight, placeVehicle } from '../assets/props';
import { addTree, broadleafGeometry, buildSkyAndTerrain, pineGeometry } from '../assets/skyAndTerrain';
import { MAP2D, map2dTree } from '../assets/map2d';
import type { ArenaLayout, NavNode } from '../assets/mapLayout';
import { populateLargeMapStreetProps, type OpenLotInfo, type PlazaInfo } from '../assets/streetProps';

/**
 * Large open-world map (960 m × 960 m) for 100-Player Warzone and 30-Player Skirmish.
 * Layout comes from @mwar/shared (LARGE_SETTLEMENTS / LARGE_MOUNTAINS / highway grid) so the game
 * server uses the same bounds, terrain height and spawn points.
 *
 *  · 2 major cities (NW / SE), each a full 240 m street grid: 10 buildings + 20 houses + parks,
 *    yards, parking, streetlights, parked cars and barriers
 *  · 2 climbable mountains (height-field terrain with solid collision, pine forest, rocks)
 *  · 5 small towns (8–12 commercial buildings / 2-story houses on highway junctions)
 *  · 10 villages (5–10 houses on a lane) linked to the highway grid by side roads
 *  · Street population (assets/streetProps.ts): real Prop-Hunt disguise props (benches, bins, dumpsters, hydrants,
 *    utility boxes, planters, cones, bollards, pallets, crates, drums, tyres...) along streets, corners, plazas, lots,
 *    building exteriors, village lanes and highway shoulders
 *
 * Performance: geometry is batched per 120 m chunk (frustum + distance culling per chunk), trees and
 * rocks are InstancedMeshes, and collision / ground queries go through the spatial hash grid.
 */

export const LARGE_CHUNK_SIZE = 120;
/** Debug / test hook: the disjoint road tiles of the last build. */
export const roadDebug: { tiles: RoadTile[] } = { tiles: [] };
const ROAD_HW = LARGE_ROAD_WIDTH / 2;

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Quarter turns so the front door (local -z) faces the direction (dx, dz). */
function turnsToward(dx: number, dz: number) {
  if (Math.abs(dz) >= Math.abs(dx)) return dz < 0 ? 0 : 2;
  return dx < 0 ? 1 : 3;
}

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

export function buildLargeArena(scene: THREE.Scene, world: CollisionWorld, lib: MaterialLibrary): ArenaLayout {
  MAP2D.reset();
  MAP2D.playHalf = LARGE_PLAY_HALF;
  MAP2D.mapHalf = LARGE_MAP_HALF;
  const batcher = new StaticBatcher(LARGE_CHUNK_SIZE);
  const kit = new Kit(batcher, world);
  const rand = seeded(96024);
  const disposables: { dispose(): void }[] = [];
  const extraObjects: THREE.Object3D[] = [];

  const sky = buildSkyAndTerrain(scene, kit, lib, [], {
    playHalf: LARGE_PLAY_HALF,
    mapHalf: LARGE_MAP_HALF,
    ground: false,
    ringScale: 1.9,
    fogNear: 110,
    fogFar: 640,
    forestStep: 8.5,
  });

  // ---- Ground: grass plane + height-field mountains -----------------------------------------
  const grassTex = textureFactories.grass();
  grassTex.repeat.set(LARGE_MAP_SIZE / 8, LARGE_MAP_SIZE / 8);
  const grassMat = new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 });
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(LARGE_MAP_SIZE + 160, LARGE_MAP_SIZE + 160), grassMat);
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = true;
  scene.add(grass);
  extraObjects.push(grass);
  disposables.push(grassTex, grassMat, grass.geometry);

  const rockTex = textureFactories.rock();
  const mountainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, map: rockTex, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  disposables.push(rockTex, mountainMat);
  const low = new THREE.Color(0x4f7a3f);
  const mid = new THREE.Color(0x6b6f55);
  const high = new THREE.Color(0x9a9a92);
  const tmpC = new THREE.Color();
  for (const m of LARGE_MOUNTAINS) {
    const size = m.r * 2 + 8;
    const seg = 72;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const colors: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + m.x;
      const z = pos.getZ(i) + m.z;
      const h = largeMapTerrainHeight(x, z);
      // Foot of the mountain (V1.1 R4): never a flat flange resting on the grass plane (y = 0). Flat outer
      // vertices are tucked 0.6 m BELOW the grass and the first rising ring is lifted a few cm, so the
      // mesh meets the grass along a clean sloped skirt instead of running coplanar with it.
      const lift = 0.14 * (1 - Math.min(1, h / 2.5));
      pos.setXYZ(i, x, h > 0.005 ? h + lift : -0.6, z);
      const t = h / m.peak;
      if (t < 0.45) tmpC.copy(low).lerp(mid, t / 0.45);
      else tmpC.copy(mid).lerp(high, Math.min(1, (t - 0.45) / 0.4));
      colors.push(tmpC.r, tmpC.g, tmpC.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mountainMat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    scene.add(mesh);
    extraObjects.push(mesh);
    disposables.push(geo);
    MAP2D.hills.push({ x: m.x, z: m.z, r: m.r, peak: m.peak });
  }

  // ---- Roads -------------------------------------------------------------------------------------
  const roadTex = makeRoadTexture();
  const plainRoadTex = makeAsphaltTexture();
  // Road surface sits 5 cm above the grass plane (a 2.5 cm gap z-fights at 300 m+ with a 24-bit depth buffer).
  const ROAD_Y = 0.05;
  const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const plainRoadMat = new THREE.MeshStandardMaterial({ map: plainRoadTex, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  disposables.push(roadTex, plainRoadTex, roadMat, plainRoadMat);
  // Roads are collected as overlapping rectangles, then cut into DISJOINT tiles (see roadGeometry.ts) so
  // intersections never have coplanar overlapping triangles (z-fighting). Straight stretches keep the
  // lane-marked road texture; junction areas get plain asphalt.
  const roadRects: RoadRect[] = [];
  /** Axis-aligned road from a to b. */
  const road = (x0: number, z0: number, x1: number, z1: number, width = LARGE_ROAD_WIDTH) => {
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    const a = alongX ? Math.min(x0, x1) : Math.min(z0, z1);
    const b = alongX ? Math.max(x0, x1) : Math.max(z0, z1);
    const fixed = alongX ? z0 : x0;
    roadRects.push(alongX ? { x0: a, x1: b, z0: fixed - width / 2, z1: fixed + width / 2, alongX } : { x0: fixed - width / 2, x1: fixed + width / 2, z0: a, z1: b, alongX });
    MAP2D.roads.push(alongX ? { x: (a + b) / 2, z: fixed, w: b - a, d: width } : { x: fixed, z: (a + b) / 2, w: width, d: b - a });
  };
  const dirtLane = (x0: number, z0: number, x1: number, z1: number, width: number) => {
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const w = Math.abs(x1 - x0) || width;
    const d = Math.abs(z1 - z0) || width;
    batcher.addBox('asphalt', 0x8b7355, cx, 0.015, cz, w, 0.03, d, false);
    MAP2D.roads.push({ x: cx, z: cz, w, d, dirt: true });
  };

  // Highway grid (full length)
  for (const line of LARGE_ROAD_LINES) {
    road(line, -LARGE_PLAY_HALF - 6, line, LARGE_PLAY_HALF + 6);
    road(-LARGE_PLAY_HALF - 6, line, LARGE_PLAY_HALF + 6, line);
  }

  const structures: StructureInfo[] = [];
  const chestSpots: THREE.Vector3[] = [];
  // Recorded for the street-prop pass (assets/streetProps.ts)
  const cityOpenLots: OpenLotInfo[] = [];
  const cityPlazas: PlazaInfo[] = [];
  const villageInfos: { x: number; z: number; halfLen: number }[] = [];
  const place = (factory: BuildingFactory | HouseFactory, x: number, z: number, turns: number, pullToStreet = 0) => {
    const f = new Frame(x, z, turns);
    const [fx, fz] = f.toWorld(0, -pullToStreet);
    const st = factory(kit, new Frame(fx, fz, turns));
    structures.push(st);
    return st;
  };

  const fillOpenLot = (x: number, z: number, turns: number, i: number) => {
    const f = new Frame(x, z, turns);
    const at = (lx: number, lz: number) => f.toWorld(lx, lz);
    const type = i % 4;
    if (type === 0 || type === 2) {
      const pts: [number, number][] = [];
      for (let k = 0; k < 18 && pts.length < 5; k++) {
        const lx = (rand() - 0.5) * 17;
        const lz = (rand() - 0.5) * 17;
        if (pts.some(([a, b]) => Math.hypot(a - lx, b - lz) < 5)) continue;
        pts.push([lx, lz]);
      }
      pts.forEach(([lx, lz], k) => {
        const [wx, wz] = at(lx, lz);
        addTree(kit, wx, wz, k % 3 === 0 ? 'pine' : 'broadleaf', 0.85 + rand() * 0.5);
      });
      const [bx, bz] = at(0, -7.5);
      placeBench(kit, bx, bz, turns);
    } else if (type === 1) {
      const [a, b] = at(-4, -3);
      placeSandbagBunker(kit, a, b, turns);
      const [c, d] = at(5, 3);
      placeCrateStack(kit, c, d, turns, rand() > 0.5);
      const [e, g] = at(-5, 6);
      placeBarrels(kit, e, g, 0x15803d);
    } else {
      const [a, b] = at(-3.5, 0);
      placeVehicle(kit, a, b, turns, [0xdc2626, 0x2563eb, 0xf8fafc, 0x16a34a][i % 4], 'sedan');
      const [c, d] = at(3.5, 1);
      placeVehicle(kit, c, d, turns, 0x1f2937, i % 2 ? 'suv' : 'truck');
    }
    cityOpenLots.push({ x, z, turns, type });
    chestSpots.push(new THREE.Vector3(x, 0, z));
  };

  // ---- Major cities: full 240 m street grid -------------------------------------------------------
  const CITY_BLOCKS = [-90, -30, 30, 90];
  const CITY_LINES = [-60, 0, 60];
  const CITY_BUILDING_LOTS: [number, number][] = [
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
  const cityTurns = (lx: number, lz: number) => {
    let best = Infinity;
    let dx = 0;
    let dz = 0;
    for (const l of CITY_LINES) {
      if (Math.abs(l - lz) < best) {
        best = Math.abs(l - lz);
        dx = 0;
        dz = l - lz;
      }
      if (Math.abs(l - lx) < best) {
        best = Math.abs(l - lx);
        dx = l - lx;
        dz = 0;
      }
    }
    return turnsToward(dx, dz);
  };
  const buildCity = (s: LargeSettlement, variant: number) => {
    for (const l of [-60, 60]) {
      road(s.x + l, s.z - 118, s.x + l, s.z + 118);
      road(s.x - 118, s.z + l, s.x + 118, s.z + l);
    }
    const lots: { x: number; z: number }[] = [];
    for (const bx of CITY_BLOCKS) for (const bz of CITY_BLOCKS) for (const qx of [-1, 1]) for (const qz of [-1, 1]) lots.push({ x: bx + qx * 11.25, z: bz + qz * 11.25 });
    const key = (x: number, z: number) => `${x.toFixed(2)},${z.toFixed(2)}`;
    const plaza = [
      [-18.75, -18.75],
      [18.75, -18.75],
      [-18.75, 18.75],
      [18.75, 18.75],
    ];
    const bLots = CITY_BUILDING_LOTS.map(([x, z]) => (variant ? [-x, -z] : [x, z]) as [number, number]);
    const used = new Set([...plaza, ...bLots].map(([x, z]) => key(x, z)));
    const free = lots.filter((l) => !used.has(key(l.x, l.z)));
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    bLots.forEach(([lx, lz], i) => place(BUILDINGS[(i + variant * 5) % BUILDINGS.length], s.x + lx, s.z + lz, cityTurns(lx, lz)));
    free.slice(0, 20).forEach((l, i) => {
      const factory = i < 10 ? SINGLE_HOUSES[(i + variant * 3) % SINGLE_HOUSES.length] : TWO_STORY_HOUSES[(i - 10 + variant * 3) % TWO_STORY_HOUSES.length];
      place(factory, s.x + l.x, s.z + l.z, cityTurns(l.x, l.z), 1.2);
    });
    free.slice(20).forEach((l, i) => fillOpenLot(s.x + l.x, s.z + l.z, cityTurns(l.x, l.z), i));
    // Central plaza
    for (const [px, pz] of plaza) {
      const x = s.x + px;
      const z = s.z + pz;
      const sx = Math.sign(px);
      const sz = Math.sign(pz);
      batcher.addBox('concrete', 0xcbd5e1, x, 0.03, z, 22.5, 0.06, 22.5, false);
      placeSandbagBunker(kit, x - sx * 3, z - sz * 3, sx > 0 ? (sz > 0 ? 2 : 3) : sz > 0 ? 1 : 0);
      placeCrateStack(kit, x + sx * 5, z - sz * 4, 0, true);
      placeBench(kit, x - sx * 6, z + sz * 6, sz > 0 ? 2 : 0);
      addTree(kit, x + sx * 8.5, z + sz * 8.5, 'broadleaf', 1.1);
      cityPlazas.push({ x, z, sx, sz });
      chestSpots.push(new THREE.Vector3(x, 0, z));
    }
    // Streetlights, parked cars and barrier chicanes
    for (const l of CITY_LINES) {
      for (let t = -110; t <= 110; t += 33) {
        if (CITY_LINES.some((c) => Math.abs(c - t) < 9)) continue;
        const side = Math.round(t / 33) % 2 === 0 ? 1 : -1;
        placeStreetlight(kit, s.x + l + side * 7, s.z + t, side > 0 ? 3 : 1);
        placeStreetlight(kit, s.x + t, s.z + l + side * 7, side > 0 ? 2 : 0);
      }
      for (const t of [-88, -38, 26, 82]) {
        const side = rand() < 0.5 ? 1 : -1;
        placeVehicle(kit, s.x + l + side * 3.3, s.z + t, side > 0 ? 0 : 2, [0xef4444, 0x3b82f6, 0xe5e7eb, 0x111827][Math.floor(rand() * 4)], rand() < 0.3 ? 'suv' : 'sedan');
        placeVehicle(kit, s.x + t + 10, s.z + l - side * 3.3, side > 0 ? 1 : 3, [0xf59e0b, 0x10b981, 0x6b7280, 0x7c3aed][Math.floor(rand() * 4)], rand() < 0.2 ? 'truck' : 'sedan');
      }
    }
    for (const ix of CITY_LINES) {
      for (const iz of CITY_LINES) {
        if (ix === 0 && iz === 0) continue;
        placeJerseyBarrier(kit, s.x + ix + 2.2, s.z + iz - 10, 0);
        placeJerseyBarrier(kit, s.x + ix - 10, s.z + iz - 2.2, 1);
      }
    }
  };

  // ---- Small towns on highway junctions -------------------------------------------------------------
  const TOWN_LOTS: [number, number][] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) TOWN_LOTS.push([sx * 19, sz * 19], [sx * 43, sz * 19], [sx * 19, sz * 43]);
  const buildTown = (s: LargeSettlement, ti: number) => {
    const lots = TOWN_LOTS.slice().sort(() => rand() - 0.5).slice(0, Math.min(12, Math.max(8, s.count)));
    lots.forEach(([lx, lz], i) => {
      const turns = Math.abs(lz) <= Math.abs(lx) ? turnsToward(0, -lz) : turnsToward(-lx, 0);
      const commercial = (i + ti) % 2 === 0;
      const factory = commercial ? BUILDINGS[(i * 3 + ti) % BUILDINGS.length] : TWO_STORY_HOUSES[(i + ti * 2) % TWO_STORY_HOUSES.length];
      place(factory, s.x + lx, s.z + lz, turns, commercial ? 0 : 1.2);
    });
    for (const [lx, lz] of [
      [8, -8],
      [-8, 8],
    ]) {
      placeStreetlight(kit, s.x + lx, s.z + lz - Math.sign(lz) * 0, lx > 0 ? 3 : 1);
    }
    placeVehicle(kit, s.x + 3.3, s.z + 28, 0, 0x2563eb, 'sedan');
    placeVehicle(kit, s.x - 28, s.z - 3.3, 1, 0xf8fafc, 'truck');
    placeJerseyBarrier(kit, s.x + 2.2, s.z - 12, 0);
    placeCrateStack(kit, s.x + 9, s.z + 9, 0, ti % 2 === 0);
    chestSpots.push(new THREE.Vector3(s.x + 9, 0, s.z - 9));
  };

  // ---- Villages: houses on a lane + side road to the highway grid ---------------------------------
  const buildVillage = (s: LargeSettlement, vi: number) => {
    const n = Math.max(5, Math.min(10, s.count));
    const perSide = Math.ceil(n / 2);
    const halfLen = (perSide / 2) * 24 + 14;
    villageInfos.push({ x: s.x, z: s.z, halfLen });
    dirtLane(s.x - halfLen, s.z, s.x + halfLen, s.z, 6);
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const slot = Math.floor(i / 2);
      const ox = (slot - (perSide - 1) / 2) * 24 + (perSide % 2 === 1 ? 12 : 0);
      const factory = (i + vi) % 3 === 0 ? TWO_STORY_HOUSES[(i + vi) % TWO_STORY_HOUSES.length] : SINGLE_HOUSES[(i * 2 + vi) % SINGLE_HOUSES.length];
      place(factory, s.x + ox, s.z + side * 15, turnsToward(0, -side), 1.2);
    }
    // Side road to the nearest highway (straight, axis-aligned)
    let bestD = Infinity;
    let conn: [number, number, number, number] = [s.x, s.z, s.x, s.z];
    for (const l of LARGE_ROAD_LINES) {
      if (Math.abs(l - s.x) < bestD) {
        bestD = Math.abs(l - s.x);
        conn = [s.x + Math.sign(l - s.x) * halfLen, s.z, l, s.z];
      }
      if (Math.abs(l - s.z) < bestD) {
        bestD = Math.abs(l - s.z);
        conn = [s.x, s.z + Math.sign(l - s.z) * 3, s.x, l];
      }
    }
    if (bestD > halfLen) road(conn[0], conn[1], conn[2], conn[3], 7);
    // Trees and a few props
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + rand();
      const r = halfLen + 6 + rand() * 10;
      addTree(kit, s.x + Math.cos(a) * r, s.z + Math.sin(a) * r * 0.6, k % 2 ? 'pine' : 'broadleaf', 0.9 + rand() * 0.4);
    }
    placeBarrels(kit, s.x - 4, s.z - 4.5, 0x1d4ed8);
    placeCrateStack(kit, s.x + 5, s.z + 4.5, 0, false);
    chestSpots.push(new THREE.Vector3(s.x, 0, s.z));
  };

  let ci = 0;
  let ti = 0;
  let vi = 0;
  for (const s of LARGE_SETTLEMENTS) {
    if (s.kind === 'city') buildCity(s, ci++);
    else if (s.kind === 'town') buildTown(s, ti++);
    else buildVillage(s, vi++);
  }

  // Road tiles → one mesh per 120 m chunk and material (strip / plain asphalt)
  const roadMeshes: THREE.Mesh[] = [];
  const roadTiles = unionRoadTiles(roadRects).flatMap((t) => splitTile(t, 60));
  roadDebug.tiles = roadTiles;
  const tileBuckets = new Map<string, { tiles: RoadTile[]; plain: boolean }>();
  for (const t of roadTiles) {
    const plain = t.kind === 'plain';
    const key = `${plain ? 'p' : 's'}|${Math.floor((t.x0 + t.x1) / 2 / LARGE_CHUNK_SIZE)},${Math.floor((t.z0 + t.z1) / 2 / LARGE_CHUNK_SIZE)}`;
    let e = tileBuckets.get(key);
    if (!e) tileBuckets.set(key, (e = { tiles: [], plain }));
    e.tiles.push(t);
  }
  tileBuckets.forEach(({ tiles, plain }) => {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (const t of tiles) {
      const base = pos.length / 3;
      const corners: [number, number][] = [[t.x0, t.z0], [t.x0, t.z1], [t.x1, t.z1], [t.x1, t.z0]];
      for (const [x, z] of corners) {
        pos.push(x, ROAD_Y, z);
        if (plain) uv.push(x / 10, z / 10);
        // Strip: u across the road (centre line = 0.5), v along it (world-aligned, so markings line up).
        else if (t.alongX) uv.push(0.5 + (z - t.centre) / LARGE_ROAD_WIDTH, x / 10);
        else uv.push(0.5 + (x - t.centre) / LARGE_ROAD_WIDTH, z / 10);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, plain ? plainRoadMat : roadMat);
    mesh.receiveShadow = true;
    mesh.userData.chunked = true;
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    roadMeshes.push(mesh);
    disposables.push(g);
  });

  // ---- Instanced countryside trees + mountain pines / rocks (trunk + canopy colliders) ------------
  const nearRoad = (x: number, z: number, pad: number) =>
    MAP2D.roads.some((r) => Math.abs(x - r.x) < r.w / 2 + pad && Math.abs(z - r.z) < r.d / 2 + pad);
  const nearStructure = (x: number, z: number, pad: number) =>
    structures.some((st) => x > st.footprint.minX - pad && x < st.footprint.maxX + pad && z > st.footprint.minZ - pad && z < st.footprint.maxZ + pad);
  const inSettlement = (x: number, z: number) =>
    LARGE_SETTLEMENTS.some((s) => {
      const r = s.kind === 'city' ? 125 : s.kind === 'town' ? 62 : 70;
      return Math.abs(x - s.x) < r && Math.abs(z - s.z) < r;
    });
  const treeSpots: { x: number; y: number; z: number; s: number; r: number; pine: boolean }[] = [];
  for (const m of LARGE_MOUNTAINS) {
    for (let k = 0; k < 340; k++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * m.r * 0.92;
      const x = m.x + Math.cos(a) * d;
      const z = m.z + Math.sin(a) * d;
      const h = largeMapTerrainHeight(x, z);
      if (h > m.peak * 0.82 || nearRoad(x, z, 4)) continue;
      treeSpots.push({ x, y: h - 0.3, z, s: 0.9 + rand() * 0.8, r: rand() * 6.28, pine: rand() < 0.85 });
    }
  }
  for (let k = 0; k < 900; k++) {
    const x = (rand() * 2 - 1) * (LARGE_PLAY_HALF - 6);
    const z = (rand() * 2 - 1) * (LARGE_PLAY_HALF - 6);
    if (largeMapTerrainHeight(x, z) > 0.2 || inSettlement(x, z) || nearRoad(x, z, 5) || nearStructure(x, z, 4)) continue;
    treeSpots.push({ x, y: 0, z, s: 0.85 + rand() * 0.7, r: rand() * 6.28, pine: rand() < 0.55 });
  }
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const pineGeo = pineGeometry();
  const broadGeo = broadleafGeometry();
  disposables.push(treeMat, pineGeo, broadGeo);
  const dummy = new THREE.Object3D();
  const instanced: THREE.InstancedMesh[] = [];
  // One InstancedMesh per chunk and kind so far chunks can be culled
  const treeChunks = new Map<string, typeof treeSpots>();
  for (const t of treeSpots) {
    const key = `${t.pine ? 'p' : 'b'}|${Math.floor(t.x / 240)},${Math.floor(t.z / 240)}`;
    let list = treeChunks.get(key);
    if (!list) treeChunks.set(key, (list = []));
    list.push(t);
    const trunkW = 0.55 * t.s;
    world.addBox({ minX: t.x - trunkW / 2, maxX: t.x + trunkW / 2, minY: t.y, maxY: t.y + 3 * t.s, minZ: t.z - trunkW / 2, maxZ: t.z + trunkW / 2 }, { walkable: false });
    const cw = (t.pine ? 2.2 : 2.6) * t.s;
    world.addBox(
      { minX: t.x - cw / 2, maxX: t.x + cw / 2, minY: t.y + 2.4 * t.s, maxY: t.y + 5.6 * t.s, minZ: t.z - cw / 2, maxZ: t.z + cw / 2 },
      { walkable: false, blocksMovement: false }
    );
    map2dTree(t.x, t.z, (t.pine ? 1.6 : 2.2) * t.s);
  }
  treeChunks.forEach((list, key) => {
    const im = new THREE.InstancedMesh(key.startsWith('p') ? pineGeo : broadGeo, treeMat, list.length);
    list.forEach((t, i) => {
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.set(0, t.r, 0);
      dummy.scale.setScalar(t.s);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = true;
    im.receiveShadow = true;
    im.userData.chunked = true;
    scene.add(im);
    instanced.push(im);
  });
  // Rocks on the slopes (visual cover; solid boulders)
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a8d91, roughness: 1, flatShading: true });
  disposables.push(rockGeo, rockMat);
  const rocks: THREE.Matrix4[] = [];
  for (const m of LARGE_MOUNTAINS) {
    for (let k = 0; k < 70; k++) {
      const a = rand() * Math.PI * 2;
      const d = (0.2 + rand() * 0.75) * m.r;
      const x = m.x + Math.cos(a) * d;
      const z = m.z + Math.sin(a) * d;
      const h = largeMapTerrainHeight(x, z);
      const s = 0.8 + rand() * 1.6;
      dummy.position.set(x, h + s * 0.25, z);
      dummy.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      dummy.scale.set(s * 1.2, s * 0.8, s);
      dummy.updateMatrix();
      rocks.push(dummy.matrix.clone());
      world.addBox({ minX: x - s * 0.7, maxX: x + s * 0.7, minY: h - 0.5, maxY: h + s * 0.75, minZ: z - s * 0.7, maxZ: z + s * 0.7 });
    }
  }
  const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, rocks.length);
  rocks.forEach((mm, i) => rockMesh.setMatrixAt(i, mm));
  rockMesh.computeBoundingSphere();
  rockMesh.castShadow = true;
  rockMesh.receiveShadow = true;
  scene.add(rockMesh);
  instanced.push(rockMesh);

  // ---- Street population with real disguise props (runs last so it sees every collider incl. the trees) ----
  populateLargeMapStreetProps({
    kit,
    world,
    structures,
    half: LARGE_PLAY_HALF,
    terrainHeight: largeMapTerrainHeight,
    roads: MAP2D.roads,
    plazas: cityPlazas,
    openLots: cityOpenLots,
    cities: LARGE_SETTLEMENTS.filter((s) => s.kind === 'city'),
    towns: LARGE_SETTLEMENTS.filter((s) => s.kind === 'town'),
    villages: villageInfos,
    highways: LARGE_ROAD_LINES,
    chestSpots,
  });

  const staticMeshes = [...batcher.build(lib, scene), ...roadMeshes];

  // ---- Navigation graph: highways, city streets, village lanes, entrances ----------------------------
  const nav: NavNode[] = [];
  const nodeAt = new Map<string, number>();
  const addNode = (x: number, z: number) => {
    const key = `${Math.round(x * 2) / 2},${Math.round(z * 2) / 2}`;
    const existing = nodeAt.get(key);
    if (existing !== undefined) return existing;
    const id = nav.length;
    nav.push({ id, p: new THREE.Vector3(x, largeMapTerrainHeight(x, z), z), links: [] });
    nodeAt.set(key, id);
    return id;
  };
  const link = (a: number, b: number) => {
    if (a === b) return;
    if (!nav[a].links.includes(b)) nav[a].links.push(b);
    if (!nav[b].links.includes(a)) nav[b].links.push(a);
  };
  const chain = (x0: number, z0: number, x1: number, z1: number, step: number, breaks: number[] = []) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ts = new Set<number>([0, len]);
    for (let t = step; t < len; t += step) ts.add(t);
    // Exact break points (intersections) so crossing roads share a node
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    for (const b of breaks) {
      const t = alongX ? (b - x0) / Math.sign(x1 - x0 || 1) : (b - z0) / Math.sign(z1 - z0 || 1);
      if (t > 0 && t < len) ts.add(t);
    }
    const sorted = Array.from(ts).sort((a, b) => a - b);
    let prev = -1;
    for (const t of sorted) {
      const id = addNode(x0 + ((x1 - x0) * t) / len, z0 + ((z1 - z0) * t) / len);
      if (prev >= 0) link(prev, id);
      prev = id;
    }
  };
  const cityLines = LARGE_SETTLEMENTS.filter((s) => s.kind === 'city').flatMap((s) => [s.x - 60, s.x, s.x + 60]);
  const cityLinesZ = LARGE_SETTLEMENTS.filter((s) => s.kind === 'city').flatMap((s) => [s.z - 60, s.z, s.z + 60]);
  const villageXs = LARGE_SETTLEMENTS.filter((s) => s.kind === 'village').map((s) => s.x);
  const villageZs = LARGE_SETTLEMENTS.filter((s) => s.kind === 'village').map((s) => s.z);
  const lim = LARGE_PLAY_HALF - 4;
  for (const l of LARGE_ROAD_LINES) {
    chain(l, -lim, l, lim, 30, [...LARGE_ROAD_LINES, ...cityLinesZ, ...villageZs]);
    chain(-lim, l, lim, l, 30, [...LARGE_ROAD_LINES, ...cityLines, ...villageXs]);
  }
  for (const s of LARGE_SETTLEMENTS) {
    if (s.kind === 'city') {
      for (const off of [-60, 60]) {
        chain(s.x + off, s.z - 118, s.x + off, s.z + 118, 15, [s.z - 60, s.z, s.z + 60]);
        chain(s.x - 118, s.z + off, s.x + 118, s.z + off, 15, [s.x - 60, s.x, s.x + 60]);
      }
    } else if (s.kind === 'village') {
      const perSide = Math.ceil(Math.max(5, Math.min(10, s.count)) / 2);
      const halfLen = (perSide / 2) * 24 + 14;
      chain(s.x - halfLen, s.z, s.x + halfLen, s.z, 12);
      // side road nodes
      let bestD = Infinity;
      let seg: [number, number, number, number] | null = null;
      for (const l of LARGE_ROAD_LINES) {
        if (Math.abs(l - s.x) < bestD) {
          bestD = Math.abs(l - s.x);
          seg = [s.x + Math.sign(l - s.x) * halfLen, s.z, l, s.z];
        }
        if (Math.abs(l - s.z) < bestD) {
          bestD = Math.abs(l - s.z);
          seg = [s.x, s.z, s.x, l];
        }
      }
      if (seg) chain(seg[0], seg[1], seg[2], seg[3], 20);
    }
  }
  const nearestNode = (x: number, z: number) => {
    let best = -1;
    let bd = 45 * 45;
    for (const n of nav) {
      const d = (n.p.x - x) ** 2 + (n.p.z - z) ** 2;
      if (d < bd && world.lineOfSight(x, 1.2, z, n.p.x, n.p.y + 1.2, n.p.z)) {
        bd = d;
        best = n.id;
      }
    }
    return best;
  };
  const connectPoint = (x: number, z: number) => {
    const near = nearestNode(x, z);
    if (near < 0) return -1;
    const id = addNode(x, z);
    link(id, near);
    return id;
  };
  chestSpots.forEach((c) => connectPoint(c.x, c.z));
  structures.forEach((st) => {
    const e = connectPoint(st.entrance[0], st.entrance[2]);
    if (e < 0) return;
    st.interior
      .filter((p) => p[1] < 0.5)
      .forEach((p) => {
        if (world.lineOfSight(st.entrance[0], 1.0, st.entrance[2], p[0], 1.0, p[2])) link(addNode(p[0], p[2]), e);
      });
  });
  // Mountain trails: spiral of nodes up each slope (bots and players can climb anywhere)
  for (const m of LARGE_MOUNTAINS) {
    let prev = -1;
    for (let k = 0; k <= 14; k++) {
      const a = k * 0.9;
      const r = m.r * (0.95 - k * 0.055);
      const id = addNode(m.x + Math.cos(a) * r, m.z + Math.sin(a) * r);
      if (prev >= 0) link(prev, id);
      else {
        const near = nearestNode(nav[id].p.x, nav[id].p.z);
        if (near >= 0 && near !== id) link(id, near);
      }
      prev = id;
    }
  }

  const posts: THREE.Vector3[] = [];
  structures.forEach((st) => {
    st.rooftops.forEach((p) => posts.push(v3(p)));
    st.interior.filter((p) => p[1] > 1).forEach((p) => posts.push(v3(p)));
  });
  for (const m of LARGE_MOUNTAINS) {
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.7;
      const x = m.x + Math.cos(a) * m.r * 0.35;
      const z = m.z + Math.sin(a) * m.r * 0.35;
      posts.push(new THREE.Vector3(x, largeMapTerrainHeight(x, z), z));
    }
  }

  // ---- Spawn pool -------------------------------------------------------------------------------------
  const spawnPoints: THREE.Vector3[] = [];
  const tryAdd = (x: number, y: number, z: number) => {
    if (Math.abs(x) > LARGE_PLAY_HALF - 4 || Math.abs(z) > LARGE_PLAY_HALF - 4) return;
    const g = world.groundHeightAt(x, z, 0.4, y + 0.6);
    if (Math.abs(g - y) > 0.8) return;
    for (const h of [0.5, 1.2, 1.7]) if (world.pointInSolid(x, g + h, z)) return;
    for (const [ox, oz] of [[0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]]) if (world.pointInSolid(x + ox, g + 1.0, z + oz)) return;
    if (spawnPoints.some((q) => q.distanceToSquared(new THREE.Vector3(x, g, z)) < 16)) return;
    spawnPoints.push(new THREE.Vector3(x, g, z));
  };
  LARGE_MAP_SPAWN_POINTS.forEach((p) => tryAdd(p.x, p.y, p.z));
  nav.forEach((n, i) => {
    if (i % 3 === 0) tryAdd(n.p.x, n.p.y, n.p.z);
  });
  structures.forEach((st) => {
    st.interior.forEach((p) => tryAdd(p[0], p[1] - 0.05, p[2]));
    st.rooftops.forEach((p) => tryAdd(p[0], p[1] - 0.05, p[2]));
  });

  for (const st of structures) {
    const f = st.footprint;
    MAP2D.rects.push({ x: (f.minX + f.maxX) / 2, z: (f.minZ + f.maxZ) / 2, w: f.maxX - f.minX, d: f.maxZ - f.minZ, kind: /house/i.test(st.name) ? 'house' : 'building' });
  }

  const playerSpawns = LARGE_MAP_SPAWN_POINTS.slice(0, 12).map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const terrain = {
    sun: sky.sun,
    update: sky.update,
    dispose() {
      sky.dispose();
      extraObjects.forEach((o) => o.parent?.remove(o));
      instanced.forEach((im) => {
        im.parent?.remove(im);
        im.dispose();
      });
      disposables.forEach((d) => d.dispose());
    },
  };
  return { structures, nav, posts, playerSpawns, chestSpots, spawnPoints, terrain, staticMeshes: [...staticMeshes, ...(instanced as unknown as THREE.Mesh[])] };
}
