/**
 * Builds the real client maps (small Metro Block + 960 m Grand Valley) in plain Node, with a fake DOM
 * canvas, so geometry tests and the stair-data generator run against the exact same builders the game
 * uses. Nothing is rendered.
 */
import * as THREE from 'three';

function installFakeDom() {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.document) return;
  const gradient = () => ({ addColorStop() {} });
  const ctx: unknown = new Proxy(function () {}, {
    get: (_t, k) => {
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return gradient;
      if (k === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (k === 'measureText') return () => ({ width: 0 });
      return () => undefined;
    },
    set: () => true,
    apply: () => undefined,
  });
  const el = () => ({ width: 0, height: 0, getContext: () => ctx, style: {}, addEventListener() {}, removeEventListener() {} });
  g.document = { createElement: el, createElementNS: el };
}

export async function buildMaps() {
  installFakeDom();
  const { CollisionWorld } = await import('../src/game/physics/collision');
  const { MaterialLibrary } = await import('../src/game/assets/materials');
  const { buildArena } = await import('../src/game/assets/mapLayout');
  const { buildLargeArena } = await import('../src/game/maps/largeMap');
  const { largeMapTerrainHeight, LARGE_TERRAIN_BOUNDS, LARGE_PLAY_HALF } = await import('@mwar/shared');
  const { PLAY_HALF } = await import('../src/game/assets/skyAndTerrain');

  const smallWorld = new CollisionWorld({ halfSize: PLAY_HALF });
  const smallScene = new THREE.Scene();
  buildArena(smallScene, smallWorld, new MaterialLibrary());

  const largeWorld = new CollisionWorld({ halfSize: LARGE_PLAY_HALF, terrain: { height: largeMapTerrainHeight, bounds: LARGE_TERRAIN_BOUNDS } });
  const largeScene = new THREE.Scene();
  buildLargeArena(largeScene, largeWorld, new MaterialLibrary());
  return { smallWorld, smallScene, largeWorld, largeScene };
}
