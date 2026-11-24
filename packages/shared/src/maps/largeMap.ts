/**
 * Large open-world map (960 m × 960 m) — shared by the web client (3D build) and the game server
 * (bounds, terrain height, spawn points) so both sides agree on the exact layout.
 *
 * Layout (x = east, z = south; y = up):
 *  · Highway grid: x ∈ {-270, 0, 270} and z ∈ {-270, 0, 270}, full length
 *  · 2 major cities on the NW (-270,-270) and SE (270,270) intersections, each a full 240 m city
 *  · 2 climbable mountains on the NE–SW diagonal between the cities, leaving a central pass
 *  · 5 small towns on key junctions, 10 villages in the valleys / foothills linked by side roads
 */

export const LARGE_MAP_SIZE = 960;
export const LARGE_MAP_HALF = LARGE_MAP_SIZE / 2;
/** Playable half-size (hard boundary slightly inside the map edge). */
export const LARGE_PLAY_HALF = 470;
export const SMALL_MAP_SIZE = 240;
export const SMALL_PLAY_HALF = 112;

export type MapKind = 'small' | 'large';

/** Mode → map: Warzone (standard_100), 30P Skirmish (mini_30) and Ghost Spectator use the large map. */
export function mapKindForMode(mode: string | null | undefined): MapKind {
  return mode === 'standard_100' || mode === 'mini_30' || mode === 'spectator' ? 'large' : 'small';
}

export const LARGE_ROAD_LINES = [-270, 0, 270];
export const LARGE_ROAD_WIDTH = 10;

export interface LargeSettlement {
  id: string;
  kind: 'city' | 'town' | 'village';
  x: number;
  z: number;
  /** Village: number of houses (5–10). Town: number of structures (8–12). */
  count: number;
}

export const LARGE_SETTLEMENTS: LargeSettlement[] = [
  { id: 'nw_metropolis', kind: 'city', x: -270, z: -270, count: 30 },
  { id: 'se_metropolis', kind: 'city', x: 270, z: 270, count: 30 },
  { id: 'pass_town', kind: 'town', x: 0, z: 0, count: 10 },
  { id: 'west_town', kind: 'town', x: -270, z: 0, count: 9 },
  { id: 'east_town', kind: 'town', x: 270, z: 0, count: 11 },
  { id: 'north_town', kind: 'town', x: 0, z: -270, count: 12 },
  { id: 'south_town', kind: 'town', x: 0, z: 270, count: 8 },
  { id: 'ne_village', kind: 'village', x: 345, z: -345, count: 8 },
  { id: 'east_ridge_village', kind: 'village', x: 400, z: -140, count: 6 },
  { id: 'north_fields_village', kind: 'village', x: 175, z: -405, count: 7 },
  { id: 'sw_village', kind: 'village', x: -345, z: 345, count: 9 },
  { id: 'west_ridge_village', kind: 'village', x: -400, z: 140, count: 5 },
  { id: 'south_fields_village', kind: 'village', x: -175, z: 405, count: 10 },
  { id: 'far_west_village', kind: 'village', x: -415, z: -100, count: 6 },
  { id: 'north_woods_village', kind: 'village', x: -95, z: -420, count: 7 },
  { id: 'far_east_village', kind: 'village', x: 415, z: 100, count: 8 },
  { id: 'south_woods_village', kind: 'village', x: 95, z: 420, count: 6 },
];

export interface LargeMountain {
  x: number;
  z: number;
  /** Footprint radius (height reaches 0 at this distance). */
  r: number;
  peak: number;
}

export const LARGE_MOUNTAINS: LargeMountain[] = [
  { x: -150, z: 150, r: 112, peak: 72 },
  { x: 150, z: -150, r: 112, peak: 66 },
];

/** Terrain height (m) at (x, z): 0 everywhere except the two mountains (smooth slopes + ridges). */
export function largeMapTerrainHeight(x: number, z: number): number {
  let h = 0;
  for (const m of LARGE_MOUNTAINS) {
    const dx = x - m.x;
    const dz = z - m.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= m.r) continue;
    const t = 1 - d / m.r;
    const base = t * t * (3 - 2 * t); // smoothstep falloff
    // Ridges / gullies so the slopes are not a perfect cone
    const ridge = 1 + 0.14 * Math.sin(Math.atan2(dz, dx) * 5 + m.x * 0.01) * t + 0.06 * Math.sin(x * 0.09) * Math.cos(z * 0.08);
    h = Math.max(h, m.peak * base * ridge);
  }
  return h;
}

/** XZ bounds of every non-flat terrain area (lets collision skip terrain checks elsewhere). */
export const LARGE_TERRAIN_BOUNDS = LARGE_MOUNTAINS.map((m) => ({ minX: m.x - m.r, maxX: m.x + m.r, minZ: m.z - m.r, maxZ: m.z + m.r }));

/**
 * Server-side spawn pool: lane positions on the highways / settlement roads (always clear of
 * buildings, parked cars and barriers) plus mountain slope points, y from the terrain.
 */
export const LARGE_MAP_SPAWN_POINTS: Array<{ x: number; y: number; z: number }> = (() => {
  const pts: Array<{ x: number; y: number; z: number }> = [];
  const add = (x: number, z: number) => {
    if (Math.abs(x) > LARGE_PLAY_HALF - 5 || Math.abs(z) > LARGE_PLAY_HALF - 5) return;
    pts.push({ x, y: Math.round(largeMapTerrainHeight(x, z) * 100) / 100, z });
  };
  for (const s of LARGE_SETTLEMENTS) {
    const offsets = s.kind === 'city' ? [30, 52, 75, 98] : s.kind === 'town' ? [25, 48] : [15];
    for (const o of offsets) {
      add(s.x + o, s.z + 1.5);
      add(s.x - o, s.z - 1.5);
      if (s.kind !== 'village') {
        add(s.x + 1.5, s.z + o);
        add(s.x - 1.5, s.z - o);
      }
    }
  }
  for (const m of LARGE_MOUNTAINS) {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.3;
      add(Math.round(m.x + Math.cos(a) * m.r * 0.55), Math.round(m.z + Math.sin(a) * m.r * 0.55));
    }
  }
  return pts;
})();
