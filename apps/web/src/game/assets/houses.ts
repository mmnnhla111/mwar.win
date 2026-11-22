import * as THREE from 'three';
import { Frame, Kit, Rect, door, win } from './kit';
import { STORY, WALL_H, SLAB_T, StructureInfo, buildStories, worldPoint, windowsAlong, Vec3, GROUND_WINDOW } from './structure';
import { MaterialKey } from './materials';

/**
 * 20 distinct house designs:
 *   SingleHouse01 … SingleHouse10   — one storey, pitched/flat/shed roofs, porches, L-wings, garages
 *   TwoStoryHouse01 … TwoStoryHouse10 — open ground entrance, walkable stairs to the 2nd floor,
 *                                       balconies and street-facing windows
 * Built in local space around (0,0), front door on the -z side, each fits a ~20 m lot.
 */

export type HouseFactory = (kit: Kit, f: Frame) => StructureInfo;

type RoofType = 'gable-x' | 'gable-z' | 'flat' | 'shed';

interface SingleCfg {
  name: string;
  w: number;
  d: number;
  wall: THREE.ColorRepresentation;
  wallKey?: MaterialKey;
  trim: THREE.ColorRepresentation;
  roof: RoofType;
  roofColor: THREE.ColorRepresentation;
  porch?: 'front' | 'wide' | 'none';
  chimney?: boolean;
  wing?: { w: number; d: number };
  garage?: boolean;
  partition?: boolean;
  doorAt?: number;
  fence?: boolean;
}

function roofFor(kit: Kit, f: Frame, r: Rect, y: number, type: RoofType, color: THREE.ColorRepresentation, gable: THREE.ColorRepresentation) {
  const w = r.x1 - r.x0;
  const d = r.z1 - r.z0;
  if (type === 'gable-x') kit.pitchedRoof(f, r, y, Math.min(2.6, d * 0.32), 'x', color, 0.5, gable);
  else if (type === 'gable-z') kit.pitchedRoof(f, r, y, Math.min(2.6, w * 0.32), 'z', color, 0.5, gable);
  else if (type === 'shed') {
    const g = new THREE.BoxGeometry(w + 0.8, 0.2, d + 0.8);
    g.rotateX(-0.16);
    kit.geometry(f, 'roofTile', color, g, (r.x0 + r.x1) / 2, y + 0.75, (r.z0 + r.z1) / 2);
    // Fill the raised back strip
    kit.deco(f, 'plaster', gable, (r.x0 + r.x1) / 2, y, r.z1 - 0.15, w, 1.4, 0.3);
    kit.deco(f, 'plaster', gable, r.x0 + 0.15, y, (r.z0 + r.z1) / 2, 0.3, 0.7, d);
    kit.deco(f, 'plaster', gable, r.x1 - 0.15, y, (r.z0 + r.z1) / 2, 0.3, 0.7, d);
  } else {
    kit.parapet(f, { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1 }, y, { h: 0.5, t: 0.2, color: new THREE.Color(gable).multiplyScalar(0.9) });
  }
}

function fenceLine(kit: Kit, f: Frame, x0: number, x1: number, z: number, gapAt: number) {
  for (let x = x0; x < x1 - 0.01; x += 0.25) {
    if (Math.abs(x - gapAt) < 1.0) continue;
    kit.deco(f, 'wood', 0xf5f5f4, x, 0, z, 0.08, 0.9, 0.05, false);
  }
  kit.deco(f, 'wood', 0xe7e5e4, (x0 + gapAt - 1) / 2, 0.6, z, gapAt - 1 - x0, 0.08, 0.06, false);
  kit.deco(f, 'wood', 0xe7e5e4, (gapAt + 1 + x1) / 2, 0.6, z, x1 - gapAt - 1, 0.08, 0.06, false);
  kit.solid(f, 'wood', 0xffffff, (x0 + gapAt - 1) / 2, 0, z, gapAt - 1 - x0, 0.9, 0.1, { visual: false, walkable: false, blocksBullets: false });
  kit.solid(f, 'wood', 0xffffff, (gapAt + 1 + x1) / 2, 0, z, x1 - gapAt - 1, 0.9, 0.1, { visual: false, walkable: false, blocksBullets: false });
}

function buildSingle(cfg: SingleCfg): HouseFactory {
  return (kit, f) => {
    const r: Rect = { x0: -cfg.w / 2, z0: -cfg.d / 2, x1: cfg.w / 2, z1: cfg.d / 2 };
    const t = 0.25;
    const doorAt = cfg.doorAt ?? cfg.w / 2;
    const wingDoorAt = cfg.wing ? cfg.w - cfg.wing.w / 2 : -1;
    kit.room(f, r, 0, WALL_H, {
      t,
      key: cfg.wallKey ?? 'plaster',
      color: cfg.wall,
      trim: cfg.trim,
      n: [door(doorAt, 1.2, 2.3), ...windowsAlong(cfg.w, 3, { ...GROUND_WINDOW, avoid: [[doorAt - 1, doorAt + 1]] })],
      s: cfg.wing ? [door(wingDoorAt, 1.2, 2.3), ...windowsAlong(cfg.w, 2, { ...GROUND_WINDOW, avoid: [[wingDoorAt - 1.2, wingDoorAt + 1.2]] })] : [door(cfg.w * 0.75, 1.1, 2.2), ...windowsAlong(cfg.w, 2, { ...GROUND_WINDOW, avoid: [[cfg.w * 0.75 - 1, cfg.w * 0.75 + 1]] })],
      w: cfg.garage ? [door((cfg.d - 2 * t) / 2, 1.1, 2.2)] : windowsAlong(cfg.d - 2 * t, 2, GROUND_WINDOW),
      e: windowsAlong(cfg.d - 2 * t, 2, GROUND_WINDOW),
    });
    kit.slab(f, r, WALL_H, SLAB_T, { color: 0x9ca3af });
    kit.floorFinish(f, { x0: r.x0 + t, z0: r.z0 + t, x1: r.x1 - t, z1: r.z1 - t }, 0, [], 'wood', 0xb7926b);
    roofFor(kit, f, r, STORY, cfg.roof, cfg.roofColor, cfg.wall);
    if (cfg.partition) {
      const px = r.x0 + cfg.w * 0.45;
      kit.wall(f, px, r.z0 + t, px, r.z1 - t, 0, WALL_H, { t: 0.15, color: 0xf5f5f4, openings: [door((cfg.d - 2 * t) * 0.6, 1.0, 2.2)] });
    }
    // Porch
    if (cfg.porch && cfg.porch !== 'none') {
      const pw = cfg.porch === 'wide' ? cfg.w : 3.4;
      kit.porch(f, { x0: r.x0 + doorAt - pw / 2 + (cfg.porch === 'wide' ? cfg.w / 2 - doorAt : 0), z0: r.z0 - 1.8, x1: r.x0 + doorAt + pw / 2 + (cfg.porch === 'wide' ? cfg.w / 2 - doorAt : 0), z1: r.z0 }, 2.5);
    } else {
      kit.solid(f, 'concrete', 0xa8a29e, r.x0 + doorAt, 0, r.z0 - 0.5, 1.8, 0.15, 1.0);
    }
    if (cfg.chimney) kit.solid(f, 'brick', 0x7f1d1d, r.x1 - 1.4, STORY, r.z1 - 1.4, 0.8, 2.8, 0.8, { walkable: false });
    // L-shaped wing at the back-right
    const interior: Vec3[] = [worldPoint(f, 0, 0.05, 0.6)];
    if (cfg.wing) {
      const wr: Rect = { x0: r.x1 - cfg.wing.w, z0: r.z1, x1: r.x1, z1: r.z1 + cfg.wing.d };
      kit.wall(f, wr.x0 + t / 2, wr.z0, wr.x0 + t / 2, wr.z1 - t, 0, WALL_H, { t, color: cfg.wall, openings: windowsAlong(cfg.wing.d - t, 1, GROUND_WINDOW) });
      kit.wall(f, wr.x1 - t / 2, wr.z0, wr.x1 - t / 2, wr.z1 - t, 0, WALL_H, { t, color: cfg.wall, openings: windowsAlong(cfg.wing.d - t, 1, GROUND_WINDOW) });
      kit.wall(f, wr.x0, wr.z1 - t / 2, wr.x1, wr.z1 - t / 2, 0, WALL_H, { t, color: cfg.wall, openings: [door(cfg.wing.w / 2, 1.1, 2.2)] });
      kit.slab(f, wr, WALL_H, SLAB_T, { color: 0x9ca3af });
      roofFor(kit, f, wr, STORY, cfg.roof === 'gable-x' ? 'gable-z' : cfg.roof, cfg.roofColor, cfg.wall);
      interior.push(worldPoint(f, (wr.x0 + wr.x1) / 2, 0.05, (wr.z0 + wr.z1) / 2));
    }
    // Attached garage on the west side (open front)
    if (cfg.garage) {
      const gr: Rect = { x0: r.x0 - 4.2, z0: r.z0, x1: r.x0, z1: r.z0 + Math.min(cfg.d, 6.5) };
      kit.wall(f, gr.x0 + t / 2, gr.z0, gr.x0 + t / 2, gr.z1, 0, 2.8, { t, color: cfg.wall });
      kit.wall(f, gr.x0, gr.z1 - t / 2, gr.x1, gr.z1 - t / 2, 0, 2.8, { t, color: cfg.wall });
      kit.solid(f, 'concrete', 0x6b7280, (gr.x0 + gr.x1) / 2, 2.8, (gr.z0 + gr.z1) / 2, 4.4, 0.2, gr.z1 - gr.z0 + 0.2);
      kit.deco(f, 'concrete', 0x9ca3af, (gr.x0 + gr.x1) / 2, 0.005, gr.z0 - 2, 3.6, 0.02, 4, false);
      // Parked hatchback inside
      kit.solid(f, 'metal', 0xdc2626, (gr.x0 + gr.x1) / 2, 0.3, gr.z0 + 3.2, 1.8, 0.8, 3.8);
      kit.solid(f, 'glass', 0x1e293b, (gr.x0 + gr.x1) / 2, 1.1, gr.z0 + 3.4, 1.6, 0.5, 2.0, { walkable: false });
    }
    if (cfg.fence) fenceLine(kit, f, r.x0 - 1.5, r.x1 + 1.5, r.z0 - 3.2, r.x0 + doorAt);
    // Mailbox & planters
    kit.solid(f, 'metal', 0x1e3a8a, r.x0 + doorAt + 2.2, 0, r.z0 - 2.6, 0.3, 1.1, 0.3, { walkable: false });
    kit.deco(f, 'foliage', 0x15803d, r.x0 + 0.8, 0, r.z0 - 0.5, 1.2, 0.7, 0.7);
    return {
      name: cfg.name,
      rooftops: [],
      interior,
      entrance: worldPoint(f, r.x0 + doorAt, 0, r.z0 - 3.0),
      footprint: f.rect(r.x0 - (cfg.garage ? 4.2 : 0), r.z0 - 2, r.x1, r.z1 + (cfg.wing?.d ?? 0)),
    };
  };
}

const SINGLE_CONFIGS: SingleCfg[] = [
  { name: 'SingleHouse01 Cottage', w: 9, d: 8, wall: 0xf3e8d2, trim: 0x7c2d12, roof: 'gable-x', roofColor: 0xb91c1c, porch: 'front', chimney: true, fence: true },
  { name: 'SingleHouse02 Ranch', w: 12, d: 8, wall: 0xdbeafe, trim: 0x1e3a8a, roof: 'gable-x', roofColor: 0x334155, porch: 'wide', partition: true },
  { name: 'SingleHouse03 Modern Flat', w: 10, d: 9, wall: 0xf8fafc, wallKey: 'concrete', trim: 0x0f172a, roof: 'flat', roofColor: 0x52525b, porch: 'none', partition: true },
  { name: 'SingleHouse04 L-Bungalow', w: 10, d: 7.5, wall: 0xfef3c7, trim: 0x92400e, roof: 'gable-x', roofColor: 0x78350f, porch: 'front', wing: { w: 4.5, d: 4.5 } },
  { name: 'SingleHouse05 Garage Home', w: 9, d: 8.5, wall: 0xe7e5e4, wallKey: 'brick', trim: 0x44403c, roof: 'gable-z', roofColor: 0x57534e, porch: 'none', garage: true },
  { name: 'SingleHouse06 Shed-Roof Studio', w: 8.5, d: 8, wall: 0xccfbf1, trim: 0x115e59, roof: 'shed', roofColor: 0x0f766e, porch: 'front', doorAt: 3 },
  { name: 'SingleHouse07 Brick Cabin', w: 8, d: 9, wall: 0xc2410c, wallKey: 'brick', trim: 0xfafaf9, roof: 'gable-z', roofColor: 0x1c1917, porch: 'front', chimney: true },
  { name: 'SingleHouse08 Farmhouse', w: 11, d: 9, wall: 0xfafaf9, wallKey: 'wood', trim: 0x166534, roof: 'gable-x', roofColor: 0x14532d, porch: 'wide', fence: true, partition: true },
  { name: 'SingleHouse09 Desert Adobe', w: 9.5, d: 9.5, wall: 0xe7c9a0, trim: 0x7c2d12, roof: 'flat', roofColor: 0x92400e, porch: 'none', wing: { w: 4, d: 4 } },
  { name: 'SingleHouse10 Suburban Duplex', w: 13, d: 8, wall: 0xede9fe, trim: 0x5b21b6, roof: 'gable-x', roofColor: 0x4c1d95, porch: 'front', partition: true, doorAt: 4.5, chimney: true },
];

export const SingleHouse01 = buildSingle(SINGLE_CONFIGS[0]);
export const SingleHouse02 = buildSingle(SINGLE_CONFIGS[1]);
export const SingleHouse03 = buildSingle(SINGLE_CONFIGS[2]);
export const SingleHouse04 = buildSingle(SINGLE_CONFIGS[3]);
export const SingleHouse05 = buildSingle(SINGLE_CONFIGS[4]);
export const SingleHouse06 = buildSingle(SINGLE_CONFIGS[5]);
export const SingleHouse07 = buildSingle(SINGLE_CONFIGS[6]);
export const SingleHouse08 = buildSingle(SINGLE_CONFIGS[7]);
export const SingleHouse09 = buildSingle(SINGLE_CONFIGS[8]);
export const SingleHouse10 = buildSingle(SINGLE_CONFIGS[9]);

// ---------------------------------------------------------------------------------------------
// Two-storey houses
// ---------------------------------------------------------------------------------------------

interface TwoCfg {
  name: string;
  w: number;
  d: number;
  wall: THREE.ColorRepresentation;
  wallKey?: MaterialKey;
  upperWall?: THREE.ColorRepresentation;
  trim: THREE.ColorRepresentation;
  roof: RoofType | 'terrace';
  roofColor: THREE.ColorRepresentation;
  balcony: 'front' | 'side' | 'back' | 'wrap' | 'twin';
  porch?: boolean;
  stairSide?: 'e' | 'w';
  garage?: boolean;
  bay?: boolean;
}

function balconyFront(kit: Kit, f: Frame, x: number, w: number, z: number, depth: number, dir: -1 | 1) {
  const y = STORY;
  const zc = z + (dir * depth) / 2;
  kit.solid(f, 'concrete', 0xd6d3d1, x, y - SLAB_T, zc, w, SLAB_T, depth);
  const zEdge = z + dir * (depth - 0.05);
  kit.railing(f, x - w / 2, zEdge, x + w / 2, zEdge, y);
  kit.railing(f, x - w / 2 + 0.03, z, x - w / 2 + 0.03, zEdge, y);
  kit.railing(f, x + w / 2 - 0.03, z, x + w / 2 - 0.03, zEdge, y);
}

function balconySide(kit: Kit, f: Frame, x: number, z: number, len: number, depth: number, dir: -1 | 1) {
  const y = STORY;
  const xc = x + (dir * depth) / 2;
  kit.solid(f, 'concrete', 0xd6d3d1, xc, y - SLAB_T, z, depth, SLAB_T, len);
  const xEdge = x + dir * (depth - 0.05);
  kit.railing(f, xEdge, z - len / 2, xEdge, z + len / 2, y);
  kit.railing(f, x, z - len / 2 + 0.03, xEdge, z - len / 2 + 0.03, y);
  kit.railing(f, x, z + len / 2 - 0.03, xEdge, z + len / 2 - 0.03, y);
}

function buildTwo(cfg: TwoCfg): HouseFactory {
  return (kit, f) => {
    const r: Rect = { x0: -cfg.w / 2, z0: -cfg.d / 2, x1: cfg.w / 2, z1: cfg.d / 2 };
    const t = 0.3;
    const sideLen = cfg.d - 2 * t;
    const upperDoors: { n?: number[]; s?: number[]; w?: number[]; e?: number[] } = {};
    if (cfg.balcony === 'front' || cfg.balcony === 'wrap') upperDoors.n = [cfg.w / 2];
    if (cfg.balcony === 'twin') upperDoors.n = [cfg.w * 0.25, cfg.w * 0.75];
    if (cfg.balcony === 'back') upperDoors.s = [cfg.w / 2];
    if (cfg.balcony === 'side' || cfg.balcony === 'wrap') {
      if ((cfg.stairSide ?? 'e') === 'e') upperDoors.w = [sideLen * 0.7];
      else upperDoors.e = [sideLen * 0.7];
    }
    const terrace = cfg.roof === 'terrace';
    const { roofY } = buildStories(kit, f, r, {
      stories: 2,
      wallKey: cfg.wallKey ?? 'plaster',
      wallColor: cfg.wall,
      trim: cfg.trim,
      doors: { n: [cfg.w / 2], s: [cfg.w * 0.3] },
      doorWidth: 1.4,
      upperDoors: { 1: upperDoors },
      windows: { n: Math.max(2, Math.round(cfg.w / 3)), s: 3, w: 2, e: 2 },
      roofAccess: terrace,
      parapetH: 1.0,
      firstStairSide: cfg.stairSide ?? 'e',
      stairStartInset: 1.0,
    });
    if (cfg.upperWall !== undefined) {
      // Contrasting upper siding band
      kit.deco(f, 'wood', cfg.upperWall, 0, STORY + 0.02, r.z0 - 0.02, cfg.w + 0.02, 0.2, 0.04, false);
      kit.deco(f, 'wood', cfg.upperWall, 0, STORY + 2.75, r.z0 - 0.02, cfg.w + 0.02, 0.25, 0.04, false);
    }
    if (!terrace) roofFor(kit, f, r, roofY, cfg.roof as RoofType, cfg.roofColor, cfg.wall);
    // Balconies
    if (cfg.balcony === 'front') balconyFront(kit, f, 0, Math.min(4.5, cfg.w - 2), r.z0, 1.6, -1);
    if (cfg.balcony === 'twin') {
      balconyFront(kit, f, r.x0 + cfg.w * 0.25, 2.6, r.z0, 1.4, -1);
      balconyFront(kit, f, r.x0 + cfg.w * 0.75, 2.6, r.z0, 1.4, -1);
    }
    if (cfg.balcony === 'back') balconyFront(kit, f, 0, Math.min(5, cfg.w - 2), r.z1, 1.8, 1);
    if (cfg.balcony === 'wrap') {
      balconyFront(kit, f, 0, cfg.w - 0.6, r.z0, 1.5, -1);
    }
    if (cfg.balcony === 'side' || cfg.balcony === 'wrap') {
      const east = (cfg.stairSide ?? 'e') !== 'e';
      const zc = r.z0 + t + sideLen * 0.7;
      balconySide(kit, f, east ? r.x1 : r.x0, zc, 3.2, 1.5, east ? 1 : -1);
    }
    if (cfg.porch) kit.porch(f, { x0: -1.8, z0: r.z0 - 1.6, x1: 1.8, z1: r.z0 }, 2.6, 0x78716c);
    else kit.solid(f, 'concrete', 0xa8a29e, 0, 0, r.z0 - 0.5, 2.2, 0.15, 1.0);
    if (cfg.bay) {
      kit.solid(f, 'plaster', cfg.wall, r.x0 + cfg.w * 0.8, 0.6, r.z0 - 0.45, 2.2, 1.8, 0.6);
      kit.deco(f, 'glass', 0x93c5fd, r.x0 + cfg.w * 0.8, 1.0, r.z0 - 0.77, 1.9, 1.1, 0.04, false);
      kit.deco(f, 'roofTile', cfg.roofColor, r.x0 + cfg.w * 0.8, 2.4, r.z0 - 0.45, 2.4, 0.15, 0.8);
    }
    if (cfg.garage) {
      const gr: Rect = { x0: r.x1, z0: r.z0, x1: r.x1 + 4.2, z1: r.z0 + 6.5 };
      kit.wall(f, gr.x1 - t / 2, gr.z0, gr.x1 - t / 2, gr.z1, 0, 2.8, { t, color: cfg.wall });
      kit.wall(f, gr.x0, gr.z1 - t / 2, gr.x1, gr.z1 - t / 2, 0, 2.8, { t, color: cfg.wall });
      kit.solid(f, 'concrete', 0x6b7280, (gr.x0 + gr.x1) / 2, 2.8, (gr.z0 + gr.z1) / 2, 4.4, 0.2, 6.7);
      kit.solid(f, 'metal', 0x2563eb, (gr.x0 + gr.x1) / 2, 0.3, gr.z0 + 3.2, 1.8, 0.8, 3.8);
      kit.solid(f, 'glass', 0x1e293b, (gr.x0 + gr.x1) / 2, 1.1, gr.z0 + 3.4, 1.6, 0.5, 2.0, { walkable: false });
    }
    kit.solid(f, 'metal', 0x991b1b, r.x0 - 0.9, 0, r.z0 - 2.4, 0.3, 1.1, 0.3, { walkable: false });
    const interior: Vec3[] = [worldPoint(f, 0, 0.05, 1.2), worldPoint(f, 0, STORY + 0.05, 1.2)];
    if (cfg.balcony !== 'side') interior.push(worldPoint(f, 0, STORY + 0.05, cfg.balcony === 'back' ? r.z1 + 1.0 : r.z0 - 0.8));
    return {
      name: cfg.name,
      rooftops: terrace ? [worldPoint(f, r.x0 + 1.5, roofY + 0.05, r.z0 + 1.5), worldPoint(f, r.x1 - 1.5, roofY + 0.05, r.z1 - 1.5)] : [],
      interior,
      entrance: worldPoint(f, 0, 0, r.z0 - 3.0),
      footprint: f.rect(r.x0 - (cfg.balcony === 'side' || cfg.balcony === 'wrap' ? 1.6 : 0), r.z0 - 2, r.x1 + (cfg.garage ? 4.2 : 1.6), r.z1 + 2),
    };
  };
}

const TWO_CONFIGS: TwoCfg[] = [
  { name: 'TwoStoryHouse01 Colonial', w: 10, d: 9, wall: 0xf5f5f4, trim: 0x1e3a8a, roof: 'gable-x', roofColor: 0x1f2937, balcony: 'front', porch: true },
  { name: 'TwoStoryHouse02 Modern Terrace', w: 10, d: 10, wall: 0xe5e7eb, wallKey: 'concrete', trim: 0x111827, roof: 'terrace', roofColor: 0x374151, balcony: 'side', stairSide: 'e' },
  { name: 'TwoStoryHouse03 Brick Townhouse', w: 9, d: 10, wall: 0xa0522d, wallKey: 'brick', trim: 0xfafaf9, roof: 'gable-z', roofColor: 0x292524, balcony: 'twin' },
  { name: 'TwoStoryHouse04 Craftsman', w: 11, d: 9.5, wall: 0xd9c5a0, wallKey: 'wood', upperWall: 0x7c2d12, trim: 0x422006, roof: 'gable-x', roofColor: 0x7c2d12, balcony: 'back', porch: true, bay: true },
  { name: 'TwoStoryHouse05 Coastal', w: 10, d: 9, wall: 0xe0f2fe, wallKey: 'wood', trim: 0x0369a1, roof: 'gable-x', roofColor: 0x0c4a6e, balcony: 'wrap', stairSide: 'e' },
  { name: 'TwoStoryHouse06 Mediterranean', w: 11, d: 10, wall: 0xfde7c4, trim: 0x9a3412, roof: 'flat', roofColor: 0xc2410c, balcony: 'front', stairSide: 'w', bay: true },
  { name: 'TwoStoryHouse07 Garage Loft', w: 9, d: 9.5, wall: 0xd4d4d8, trim: 0x18181b, roof: 'shed', roofColor: 0x3f3f46, balcony: 'side', stairSide: 'w', garage: true },
  { name: 'TwoStoryHouse08 Victorian', w: 10, d: 10.5, wall: 0xfbcfe8, wallKey: 'wood', upperWall: 0x831843, trim: 0x500724, roof: 'gable-z', roofColor: 0x4a044e, balcony: 'front', porch: true },
  { name: 'TwoStoryHouse09 Urban Box', w: 10, d: 10, wall: 0x64748b, wallKey: 'concrete', trim: 0xf97316, roof: 'terrace', roofColor: 0x1f2937, balcony: 'twin', stairSide: 'w' },
  { name: 'TwoStoryHouse10 Family Home', w: 12, d: 9.5, wall: 0xecfccb, trim: 0x3f6212, roof: 'gable-x', roofColor: 0x365314, balcony: 'back', garage: true, porch: true },
];

export const TwoStoryHouse01 = buildTwo(TWO_CONFIGS[0]);
export const TwoStoryHouse02 = buildTwo(TWO_CONFIGS[1]);
export const TwoStoryHouse03 = buildTwo(TWO_CONFIGS[2]);
export const TwoStoryHouse04 = buildTwo(TWO_CONFIGS[3]);
export const TwoStoryHouse05 = buildTwo(TWO_CONFIGS[4]);
export const TwoStoryHouse06 = buildTwo(TWO_CONFIGS[5]);
export const TwoStoryHouse07 = buildTwo(TWO_CONFIGS[6]);
export const TwoStoryHouse08 = buildTwo(TWO_CONFIGS[7]);
export const TwoStoryHouse09 = buildTwo(TWO_CONFIGS[8]);
export const TwoStoryHouse10 = buildTwo(TWO_CONFIGS[9]);

export const SINGLE_HOUSES: HouseFactory[] = [
  SingleHouse01,
  SingleHouse02,
  SingleHouse03,
  SingleHouse04,
  SingleHouse05,
  SingleHouse06,
  SingleHouse07,
  SingleHouse08,
  SingleHouse09,
  SingleHouse10,
];

export const TWO_STORY_HOUSES: HouseFactory[] = [
  TwoStoryHouse01,
  TwoStoryHouse02,
  TwoStoryHouse03,
  TwoStoryHouse04,
  TwoStoryHouse05,
  TwoStoryHouse06,
  TwoStoryHouse07,
  TwoStoryHouse08,
  TwoStoryHouse09,
  TwoStoryHouse10,
];

void win;
